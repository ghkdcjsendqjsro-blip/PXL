# SUMINPIXEL Supabase와 익명 피드백 구현

이 문서는 로그인 없이 피드백을 남기고, 화면 아래에서 최신순으로 모든 피드백을 찾아볼 수 있게 만드는 기준이다. Supabase는 온라인 데이터 저장소이고, RLS는 데이터에 접근할 수 있는 행을 제한하는 데이터베이스 규칙이다. 이 서비스에서는 브라우저가 Supabase에 직접 접근하지 않고 Node.js API가 입력을 검증한 뒤 저장한다.

## 1. 처리 경로와 범위

```text
브라우저 → 같은 사이트의 /api/feedback → Node.js 검증·요청 횟수 제한 → Supabase
브라우저 ← 공개 필드만 포함한 JSON 응답 ← Node.js
```

- 피드백 작성·조회 모두 회원가입, 로그인, Supabase Auth를 사용하지 않는다.
- 브라우저에 Supabase SDK와 데이터베이스 키를 넣지 않는다.
- 서버 환경변수는 `SUPABASE_URL`, `SUPABASE_SECRET_KEY`다. 새 secret key는 `sb_secret_...` 형태이며 데이터베이스에서는 `service_role` 권한으로 동작한다. 키의 전체 값을 코드, 로그, 문서에 기록하지 않는다.
- 서버용 클라이언트는 세션 저장과 토큰 자동 갱신을 끄고, 사용자 Authorization 헤더를 전달하지 않는다.
- 공개 수정·삭제 API, 로그인, 관리자 화면, 댓글, 별점, 일반 파일 첨부, 실시간 구독은 이번 범위에 없다.
- 공개에 동의한 사용자가 피드백으로 제출한 AI 픽셀 결과와 해당 프롬프트를 피드백 행에 함께 저장한다. 원본 업로드는 피드백에 첨부하지 않는다.

Supabase 공식 문서는 서버 secret key가 RLS를 우회하므로 서버에서만 사용하도록 안내한다. 따라서 이 API의 검증과 응답 필드 제한이 반드시 필요하다. [공식 API key 지침](https://supabase.com/docs/guides/getting-started/api-keys)

## 2. 입력과 공개 범위

| 항목 | 규칙 |
| --- | --- |
| `clientRequestId` | 브라우저 `crypto.randomUUID()`로 만든 UUID. 한 번의 전송 시도와 재전송에서 같은 값을 유지한다. 공개 목록에는 넣지 않는다. |
| `nickname` | 선택 입력. 문자열 앞뒤 공백 제거 후 빈 값이면 `익명`. 최대 20자. 필드 생략도 빈 값과 같다. |
| `content` | 필수 문자열. 앞뒤 공백 제거 후 1~500자. 줄바꿈 허용. |
| `consent` | 반드시 JSON boolean `true`. 공개 게시 동의다. 문자열 `"true"`는 거부한다. |
| `website` | 스팸 탐지용 숨김 입력. 생략 또는 빈 문자열만 허용한다. 정상 사용자는 작성하지 않는다. |
| `attachment` | 선택 객체 `{imageBase64,prompt}`. 이미지는 디코딩 후 최대 1 MiB인 정적 1024×1024 PNG다. 프롬프트는 해당 생성 요청에 사용한 문자열이며, 최대 1,000자이고 이미지 편집에 설명을 생략했다면 빈 문자열이다. |

글자 수는 JavaScript 문자열의 UTF-16 길이 대신 `Array.from(value).length`로 센다. 예를 들어 이모지 하나를 서버·DB에서 같은 기준으로 처리한다. HTML은 입력 문자열로 저장할 수 있지만 실행하거나 HTML로 렌더링하지 않는다. NUL 문자, 잘못된 UTF-8, 배열·객체 등 문자열이 아닌 입력은 거부한다.

폼에 공개 동의 체크박스를 두고 처음에는 해제한다. 사용자가 `첨부하기`로 결과와 프롬프트를 선택하면 닉네임·피드백과 함께 이미지와 프롬프트도 공개된다고 명시한다. 사용자는 제출 전에 첨부를 제거할 수 있다. 폼 아래에 개인정보를 적지 말라고 안내한다.

공개 JSON 항목은 `id`, `nickname`, `content`, `createdAt`, `attachment`다. `attachment`는 `null` 또는 `{imageUrl,prompt}`다. `imageUrl`은 같은 출처의 `/api/feedback-image?id=<피드백 UUID>`이며 이미지 바이트는 해당 주소에서 받는다. `client_request_id`, `public_consent`, 요청 제한용 값, 데이터베이스 오류 상세는 공개하지 않는다.

## 3. 최초 데이터베이스 SQL

아래는 새 프로젝트의 최초 마이그레이션 기준이다. 구현 시 `supabase/migrations/001_feedback.sql`로 저장한다. 이미 같은 테이블이 있으면 SQL을 반복 실행해 덮어쓰지 말고 기존 구조를 확인해 별도 마이그레이션을 만든다. 다른 서비스 테이블의 권한을 일괄 변경하지 않는다.

```sql
begin;

create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  client_request_id uuid not null,
  nickname text not null default '익명',
  content text not null,
  public_consent boolean not null,
  created_at timestamptz not null default now(),
  constraint feedback_request_unique unique (client_request_id),
  constraint feedback_nickname_length
    check (char_length(nickname) between 1 and 20),
  constraint feedback_nickname_trimmed check (nickname = btrim(nickname)),
  constraint feedback_content_length
    check (char_length(content) between 1 and 500),
  constraint feedback_content_trimmed check (content = btrim(content)),
  constraint feedback_consent_required check (public_consent = true)
);

create index feedback_latest_idx
  on public.feedback (created_at desc, id desc);

alter table public.feedback enable row level security;

revoke all on table public.feedback
  from public, anon, authenticated, service_role;
grant select, insert on table public.feedback to service_role;

commit;
```

`id`는 각 피드백의 식별번호이고, `client_request_id`는 전송 재시도에 따른 중복 저장을 막는 번호다. 둘을 혼용하지 않는다. 날짜와 `id`는 서버/DB에서 생성하며 브라우저가 지정하게 하지 않는다. DB의 `char_length`는 코드포인트 기준 길이를 검사한다. 서버에서는 이보다 먼저 전체 앞뒤 공백을 제거한다.

`supabase/migrations/003_feedback_attachments.sql`은 `image_base64`와 `image_prompt`를 추가한다. 두 필드는 함께 저장하거나 함께 비워 둔다. 마이그레이션 전 작성한 피드백도 계속 조회할 수 있다.

RLS는 켜되 `anon`, `authenticated`용 허용 정책은 만들지 않는다. 해당 역할과 `PUBLIC`의 테이블 권한도 회수한다. 서비스의 익명 사용자는 Node API를 통해 공개 데이터를 받는다. `service_role`에는 이 테이블의 조회·삽입 권한만 부여한다. SQL Editor의 운영자 권한은 별개다. Supabase는 테이블 권한과 RLS가 서로 다른 검사라고 설명한다. [RLS 공식 설명](https://supabase.com/docs/guides/database/postgres/row-level-security), [Data API 보안](https://supabase.com/docs/guides/api/securing-your-api)

## 4. 저장과 재전송 처리

`POST /api/feedback`의 JSON 본문:

```json
{
  "clientRequestId": "0cd3032a-9ee8-4c47-9b43-b695f7384fe9",
  "nickname": "수민",
  "content": "픽셀 크기를 고를 수 있어서 좋아요.",
  "consent": true,
  "website": ""
}
```

서버 처리 순서는 다음과 같다.

1. 같은 사이트 요청인지, JSON 형식과 크기 제한이 맞는지 확인한다. 상세 제한은 [API 명세](04-backend-openai.md)를 따른다.
2. 타입, UUID, 글자 수, 공개 동의, 숨김 입력을 검증하고 닉네임·본문을 정규화한다. 첨부 PNG는 형식·크기·해상도를 확인하고 다시 인코딩한다.
3. [요청 제한 RPC](04-backend-openai.md)의 피드백 정책을 적용한다. HMAC 처리한 클라이언트 식별값별 고정 600초 구간에 최대 10회다. 저장소 오류로 검사할 수 없으면 `503`을 반환하고 삽입하지 않는다.
4. `client_request_id`, 정규화한 `nickname`, `content`, `public_consent:true`와 선택 이미지·프롬프트를 한 행에 삽입하고 필요한 필드를 명시적으로 선택한다. `select('*')`를 사용하지 않는다.
5. 최초 저장은 `201 {"item": ...}`를 반환한다.
6. `feedback_request_unique`의 중복 오류일 때만 해당 `client_request_id`로 기존 행을 조회한다. 정규화한 닉네임·본문·동의·첨부가 모두 같은 경우 `200 {"item": ...}`를 반환한다. 다른 입력이면 `409`로 거부한다. 다른 DB 제약 오류를 중복 성공으로 처리하지 않는다.

경쟁 요청이 동시에 도착해도 DB의 UNIQUE 제약이 중복을 막는다. 사전 조회만으로 중복 여부를 판단하지 않는다. UUID는 인증 수단으로 사용하지 않고, 기존 행의 비공개 필드를 응답하지 않는다. 충돌 응답에 기존 본문도 싣지 않는다.

성공 시 브라우저는 폼, 동의 상태, 첨부 선택을 초기화하고 다음 제출용 UUID를 만든다. 타임아웃이나 연결 끊김처럼 저장 여부가 불확실하면 입력과 UUID를 유지한다. 같은 내용을 다시 보내면 한 행만 남아야 한다. 사용자가 내용을 수정했다면 새 UUID로 새 전송을 시작한다. 전송 중 버튼을 비활성화한다. 저장 성공과 목록 갱신 실패를 구분해 `피드백은 저장했어요. 목록을 다시 불러와 주세요.`라고 알린다.

## 5. 최신순 목록과 모든 항목 보기

`GET /api/feedback`는 기본 20개를 반환한다. 크기는 서버에 고정하고 클라이언트가 무제한 크기를 요청하게 하지 않는다. 정렬은 `created_at DESC, id DESC`다. 동일 시각에 여러 행이 생성되어도 `id`가 순서를 결정한다.

```json
{
  "items": [
    {
      "id": "e4fef9f1-4a50-4404-a52d-bfd0f470752d",
      "nickname": "수민",
      "content": "픽셀 크기를 고를 수 있어서 좋아요.",
      "createdAt": "2026-11-11T03:00:00.123456+00:00",
      "attachment": {
        "imageUrl": "/api/feedback-image?id=e4fef9f1-4a50-4404-a52d-bfd0f470752d",
        "prompt": "별이 뜬 밤의 작은 정원"
      }
    }
  ],
  "nextCursor": null
}
```

조회는 21개를 읽어 앞의 20개만 응답한다. 21번째 행이 있으면 응답한 20번째 행의 시간·ID를 다음 커서로 만든다. 첫 조회에는 커서가 없다. 커서가 있으면 다음 조건을 추가한다.

```sql
-- $1, $2는 서버에서 검증한 커서 값으로 바인딩한다.
select id, nickname, content, created_at
from public.feedback
where (created_at, id) < ($1::timestamptz, $2::uuid)
order by created_at desc, id desc
limit 21;
```

Supabase JavaScript SDK에서는 같은 조건을 `created_at < t OR (created_at = t AND id < id)`로 구현한다. 문자열 필터를 만들기 전 시간값과 UUID를 엄격히 검증하며 원본 커서 문자열을 SQL에 직접 붙이지 않는다. 안전한 매개변수 RPC로 감싸도 된다. 그 경우 함수의 `EXECUTE` 권한은 `service_role`에만 부여한다.

커서는 base64url로 인코딩한 `{ "createdAt": "DB 원본 시간", "id": "UUID" }` JSON이다. 커서는 암호나 권한 증명서가 아니며 공개 정렬 위치다. 최대 길이를 512바이트로 제한하고, 잘못된 base64url·JSON·필드 타입·날짜·UUID는 `400`으로 거부한다. DB가 반환한 시간 문자열의 마이크로초를 그대로 보존한다. `new Date(...).toISOString()`로 커서 시간을 재생성해 밀리초로 자르지 않는다.

- 페이지 아래 목록의 `더 보기`는 받은 커서로 다음 20개를 뒤에 붙인다. `id`가 같은 항목은 화면에서 한 번만 표시한다.
- 모든 저장 항목에 도달할 수 있어야 한다. 총 20개만 보이고 끝나는 구현은 미완료다.
- `nextCursor:null`이면 더 보기 버튼을 숨기고 `모든 피드백을 확인했어요.`를 표시한다.
- 새 피드백 저장 또는 `새로고침`은 커서를 초기화하고 첫 페이지부터 다시 시작한다. 새 행을 중간에 끼워 넣어 기존 커서의 의미를 바꾸지 않는다.
- 더 보기가 실패하면 기존 목록을 유지하고 같은 커서로 재시도한다. 목록 조회는 클라이언트 식별값별 60초에 60회로 제한한다.
- 피드백과 프롬프트는 `textContent`로 렌더링하고 CSS `white-space: pre-wrap; overflow-wrap: anywhere`를 사용한다. 링크 자동 변환이나 `innerHTML`은 사용하지 않는다.
- 화면 날짜는 한국어로 표시한다. 공개 API는 UTC 오프셋이 포함된 DB 시간 문자열을 유지한다.

## 6. 운영 데이터와 장애 처리

| 데이터 | 보관 기준 |
| --- | --- |
| 공개 피드백 | 서비스 운영 중 보관. 운영자가 스팸·개인정보 포함 게시물을 수동 삭제할 수 있다. |
| 공개 동의 | 게시 행에 `true`를 보관. 별도의 개인 신원 수집은 하지 않는다. |
| 요청 제한 데이터 | [API 보안 문서](04-backend-openai.md)의 HMAC·구간값만 보관한다. 클라이언트 버킷은 시작 후 24시간에 만료하고 시간별 정리 작업으로 정상 운영 시 최대 약 25시간 내 제거한다. 원본 IP는 저장하지 않는다. |
| 공개 피드백 첨부 | 사용자 동의를 받아 제출한 픽셀 결과와 프롬프트를 피드백 행에 보관한다. 운영자가 행을 삭제하면 첨부도 함께 삭제된다. |

운영자는 Supabase Dashboard의 Table Editor에서 `feedback` 행의 `id`와 내용을 확인한 뒤 필요한 행만 삭제한다. 전체 비우기나 공개 삭제 API를 만들지 않는다. 삭제는 되돌리기 어려우므로 운영자가 대상을 확인한다. 서비스 화면의 피드백 공개 안내는 삭제 가능성을 포함하고, 별도의 연락 채널을 꾸며 넣지 않는다.

DB 장애 시 목록은 빈 목록으로 위장하지 않는다. 기존 목록을 유지하거나 `피드백을 불러오지 못했어요. 다시 시도해 주세요.`를 표시한다. 저장 실패 시 입력을 보존한다. 로그에는 요청 ID, 상태코드, 처리 시간, 오류 분류만 남기고 피드백 전문, API 키, IP, 요청 본문을 기록하지 않는다. 설정 오류는 사용자에게 키를 입력하라고 요구하지 말고 운영 오류 `503`으로 응답한다.

## 7. 설정과 완료 검증

1. 개발용 Supabase 프로젝트를 만들고 SQL Editor에서 `001_feedback.sql`, `002_rate_limits.sql`, `003_feedback_attachments.sql`을 순서대로 적용한다. 기존 프로젝트에는 아직 적용하지 않은 마이그레이션을 적용한다. 테이블, 제약, 인덱스와 첨부 열을 확인한다.
2. 서버 환경변수를 설정한다. 키는 `.env.local`과 Vercel 서버 환경에만 두고 Git에서 제외한다.
3. `pg_tables.rowsecurity`가 `true`인지, `pg_policies`의 `feedback` 정책이 0개인지 확인한다.
4. `has_table_privilege('anon','public.feedback','SELECT')`와 INSERT 결과, `authenticated`의 같은 결과가 모두 `false`인지 확인한다. `service_role`의 SELECT·INSERT는 `true`, UPDATE·DELETE는 `false`여야 한다.
5. 별도의 서버 없는 공개키 테스트에서 직접 조회·삽입을 시도해 거부되는지 확인한다. SQL Editor 운영자 계정의 조회 성공으로 공개 접근 가능 여부를 판단하지 않는다.
6. 실제 Node API에서 피드백을 저장한 뒤 새로고침·다른 브라우저에서 조회해 같은 행이 보이는지 확인한다. 브라우저 저장소만 사용하는 구현은 실패다.
7. 같은 UUID·같은 본문을 두 번 보내 행 1개와 `201 → 200`을 확인한다. 같은 UUID·다른 본문은 `409`이고 기존 행이 변경되지 않아야 한다.
8. 개발 DB에 동일 생성시각을 포함한 45개를 넣어 `20 → 20 → 5`개로 모두 읽히는지, 중복·누락이 없는지 확인한다. 마이크로초가 다른 경계도 포함한다.
9. 공백 본문, 501자, 이모지 경계, 동의 누락, 스팸 숨김 입력, 잘못된 커서를 각각 거부한다. `<img src=x onerror=alert(1)>`가 글자로만 표시되는지 확인한다.
10. DB 연결 실패와 요청 제한 RPC 실패를 각각 재현해 저장되지 않는지 확인한다. 성공한 저장을 목록 오류 때문에 재삽입하지 않는지도 확인한다.

이 문서의 SQL과 검증 절차는 구현 기준이다. 실제 프로젝트 생성, SQL 실행, 연결 테스트를 수행하기 전에는 완료한 것으로 보고하지 않는다.
