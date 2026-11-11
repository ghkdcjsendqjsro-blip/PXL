# 서버 API와 OpenAI 구현

이 문서는 SUMINPIXEL의 서버 계약이다. 브라우저의 검사는 사용자 편의용이며, 서버는 모든 값을 다시 검사한다. 비밀 키는 서버에만 둔다. 피드백 데이터 스키마·중복 처리·커서는 [Supabase 지침](05-supabase-feedback.md)을 따른다.

## 1. 구조와 공통 규칙

`api/generate.js`, `api/feedback.js`는 Vercel Node.js 24.x에서 Web Standard `Request`·`Response`를 사용하는 `export default { async fetch(request) { ... } }` 형태로 만든다. SDK·DB·검증 로직은 `server/`로 분리한다. 브라우저는 같은 출처의 `/api/*`만 호출한다.

- `POST /api/generate`, `GET/POST /api/feedback`만 제공한다. 지원하지 않는 메서드는 `405`와 정확한 `Allow` 헤더를 반환한다.
- POST의 `Origin`은 서버 `APP_ORIGIN`과 정확히 일치해야 한다. 없거나 다르면 `403`이다. GET은 Origin이 없거나 같을 때 허용하고 명시적인 다른 Origin은 거부한다. CORS 와일드카드를 넣지 않는다. 직접 호출 테스트도 허용 Origin을 넣는다.
- Origin 검사는 브라우저의 다른 사이트 호출을 줄이는 장치다. 로그인이나 봇 차단을 보장하지 않으므로 아래 DB 기반 요청 제한도 적용한다.
- JSON 응답은 `application/json; charset=utf-8`, API 캐시는 `Cache-Control: no-store`다. 모든 응답에 서버 UUID `requestId`를 `X-Request-Id`로 넣는다. 오류 JSON에도 같은 값을 넣는다.
- `Content-Length`만 믿지 않는다. `request.body` 스트림을 읽으며 누적 바이트를 세고 상한을 넘으면 취소한다. 읽기는 한 번만 한다. 읽은 Buffer로 새 Request를 만들어 `formData()` 또는 엄격한 UTF-8 디코더와 `JSON.parse`를 적용한다.
- 알 수 없는 필드, 중복 multipart/쿼리 필드, 잘못된 타입은 `400`으로 거부한다. 브라우저 파일명으로 서버 경로나 파일명을 만들지 않는다.
- 서버가 받는 URL로 외부 이미지를 다운로드하는 기능은 없다. 첨부 파일 바이트만 사용한다.

## 2. 이미지 생성 API

### 요청

`POST /api/generate` · `multipart/form-data` · 전체 최대 3 MiB

| 필드 | 타입 | 모드별 규칙 |
| --- | --- | --- |
| `mode` | 문자열 | 정확히 `image` 또는 `prompt` |
| `prompt` | 문자열 | prompt 모드: trim 후 1~1,000 코드포인트. image 모드: 0~1,000자, 생략 시 빈 값. |
| `image` | 파일 | image 모드: 한 장 필수. prompt 모드: 첨부 금지. |

격자·팔레트는 브라우저 처리 설정이므로 서버에 보내지 않는다. 이미지 모드 파일은 **실제 PNG, 1024×1024, 최대 2 MiB, 정적 한 프레임**이어야 한다. 클라이언트에서 원본을 정규화하는 규칙은 [프런트엔드 지침](03-frontend-features.md)에 있다. 서버의 `sharp`는 바이트 시그니처·형식·실제 크기·프레임 수를 확인하고 디코딩한다. MIME 문자열만 검사하지 않는다. 파일명 확장자가 png여도 JPEG나 HTML이면 거부한다.

`sharp`의 입력 픽셀 제한을 1,048,576으로 설정하고 메타데이터를 제거해 불투명 PNG로 다시 인코딩한다. 손상 파일, 여러 프레임, 요구 크기 불일치, 디코딩 실패는 `INVALID_IMAGE`다. 전체 multipart 필드는 최대 3개, 파일은 최대 1개다. 폼 파싱 실패·상한 위반을 반드시 잡는다.

### 처리 순서

1. 메서드·Origin·Content-Type·설정을 확인한다. `GENERATION_ENABLED=false`이면 `503`으로 중단한다.
2. 요청을 바이트 상한 내에서 읽고 필드·이미지를 검증한다. 잘못된 입력은 AI 호출을 하지 않는다.
3. 클라이언트 HMAC을 계산하고 `consume_quota('generation', ...)` RPC를 한 번 호출한다. 거부 또는 DB 오류면 AI 호출 없이 종료한다.
4. mode에 따라 OpenAI 생성 또는 편집을 **한 번만** 호출한다.
5. 결과 `data[0].b64_json`을 확인한다. 없거나 잘못된 바이트면 `502`다. 서버 디코딩 결과가 10 MiB를 넘으면 응답 이상으로 처리한다.
6. 결과 이미지를 `sharp`로 읽고 비율을 유지해 512×512 정사각형에 맞춘다. 흰 여백·흰 배경으로 합성하고 sRGB 8-bit RGB PNG로 저장한다. 메타데이터를 제거한다. API 원본은 픽셀 격자 처리 전의 소스다.
7. PNG 최대 2 MiB와 **최종 JSON UTF-8 최대 3 MiB**를 검사해 응답한다. 초과하면 크기 오류로 종료하며 AI를 다시 호출하지 않는다.

512 소스는 최종 최대 128×128 논리 격자를 만들기에 충분하도록 선택한 MVP 규격이다. 사용자가 저장하는 최종 파일은 1024×1024다. 내부 소스 크기와 다운로드 크기를 혼동하지 않는다.

### 성공 응답

`200 OK`

```json
{
  "requestId": "4fcddae1-84a6-45f7-a748-b6e287c93a63",
  "imageBase64": "PNG바이트의base64문자열",
  "mimeType": "image/png",
  "width": 512,
  "height": 512
}
```

base64에는 `data:image/png;base64,` 접두어를 붙이지 않는다. `url` 필드나 만료되는 외부 링크로 결과를 반환하지 않는다. 응답 본문·이미지 바이트를 로그에 남기지 않는다.

## 3. OpenAI 호출 정책

2026-11-11 확인한 공식 가이드는 한 번의 생성·편집에 Image API를 안내한다. 서버 모델 초기 설정은 `gpt-image-2.5-flare`이고 `OPENAI_IMAGE_MODEL`로 관리한다. 구현 시 해당 계정의 접근 권한과 설치 SDK 필드를 확인한다. 다른 모델로 자동 전환하지 않는다. [공식 이미지 생성 가이드](https://developers.openai.com/api/docs/guides/image-generation)

| 항목 | 고정값 |
| --- | --- |
| 모델 | 서버 `OPENAI_IMAGE_MODEL` |
| 생성 | `openai.images.generate` → `/v1/images/generations` |
| 첨부 편집 | `openai.images.edit` → `/v1/images/edits` |
| 이미지 수 | `n: 1` |
| 생성 규격 | `size: "1024x1024"`, `quality: "medium"`, `output_format: "png"`, `background: "opaque"` |
| SDK 요청 타임아웃 | 80,000ms |
| SDK 자동 재시도 | `maxRetries: 0` |
| 함수 최대 시간 | 120초 |
| 브라우저 대기 | 110초 |

이미지 편집에는 검증한 PNG Buffer를 SDK의 `toFile(buffer, 'input.png', {type:'image/png'})`로 전달한다. mask·멀티턴·마크업 기능은 사용하지 않는다. GPT Image 결과는 `b64_json`으로 처리하며 구형 모델 전용 `response_format` 옵션을 임의로 추가하지 않는다. [공식 이미지 편집 SDK 계약](https://developers.openai.com/api/reference/typescript/resources/images/methods/edit)

서버에서 붙일 스타일 지침은 다음 의도를 고정한다. 사용자 문장은 아래 별도 구획으로 붙이며 서버 비밀·내부 오류는 프롬프트에 넣지 않는다.

```text
Create one square pixel-art image with clear block shapes, readable silhouettes,
limited harmonious colors, and a clean game-art look. Avoid photorealism, gradients,
blur, watermark, and added text unless the user explicitly asks for text.
```

이미지 모드는 `Edit the supplied image into pixel art. Preserve the main subject, composition, recognizable features, and major colors as closely as possible.`를 추가한다. 프롬프트 모드는 `Create the subject described below as a new image.`를 추가한다. 마지막에 사용자 설명을 `User description:` 구획으로 붙인다. AI 지침은 스타일 요청이며 완전한 원본 보존이나 출력 격자를 보장하지 않는다. 실제 격자·색상 상한은 브라우저 처리에서 보장한다.

키가 없거나 모델 권한이 없으면 준비되지 않았다는 오류를 반환한다. 샘플 이미지를 실제 성공처럼 반환하지 않는다. 생성 지연 시 자동 재호출하지 않고 타임아웃을 알려 준다. 타임아웃과 브라우저 취소 후에도 외부 처리 비용이 발생할 수 있다.

## 4. 피드백 API 계약

| 요청 | 입력 | 성공 |
| --- | --- | --- |
| `POST /api/feedback` | JSON `{clientRequestId,nickname,content,consent:true,website:""}`와 선택 `attachment: {imageBase64,prompt}`. 본문은 텍스트만 최대 8 KiB, 첨부 포함 최대 `4 × ceil(1 MiB / 3) + 24 KiB` | 최초 `201 {item}`, 같은 요청 재전송 `200 {item}` |
| `GET /api/feedback` | 커서 생략 또는 `?cursor=...`, 커서 최대 512바이트 | `200 {items,nextCursor}`; 고정 20개 |
| `GET /api/feedback-image` | `?id=<피드백 UUID>` | `200 image/png`. 이미지가 없으면 `404`. 피드백 조회 한도를 공유한다. |

POST의 필수·선택 필드, DB 제약과 UUID 재전송 규칙은 [피드백 상세](05-supabase-feedback.md)를 따른다. 본문이나 첨부를 수정한 뒤 같은 UUID를 재사용하면 `409 CONFLICT`다. 피드백 목록 GET은 `cursor` 외 쿼리와 중복 파라미터를 거부한다. POST와 목록 GET의 `item`은 공개 필드와 `attachment: null` 또는 `{imageUrl,prompt}`를 반환한다. GET은 `{items:[],nextCursor:null}`로 정상 빈 목록을 표현한다. DB 장애를 빈 목록으로 위장하지 않는다.

## 5. 공통 오류

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "요청이 많아요. 잠시 후 다시 시도해 주세요.",
    "requestId": "4fcddae1-84a6-45f7-a748-b6e287c93a63",
    "retryAfterSeconds": 120
  }
}
```

`retryAfterSeconds`는 429일 때만 넣고 HTTP `Retry-After`에도 같은 정수(최소 1초)를 넣는다. 프런트는 코드에 따라 문구를 정하고 원본 provider 응답을 그대로 출력하지 않는다.

| HTTP | 코드 | 원인과 처리 |
| --- | --- | --- |
| 400 | `INVALID_INPUT`, `INVALID_IMAGE`, `INVALID_CURSOR` | 잘못된 필드·이미지·커서. 입력 수정 안내. |
| 403 | `FORBIDDEN` | Origin 불일치, 공개 피드백 동의 누락·false. 동의 필드 타입 오류는 400. |
| 405 | `METHOD_NOT_ALLOWED` | API별 허용 메서드 안내. |
| 409 | `CONFLICT` | 같은 피드백 UUID에 다른 본문. 새 제출 ID 필요. |
| 413 | `PAYLOAD_TOO_LARGE` | 전체 본문 또는 파일 상한 초과. 작은 파일 선택. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 잘못된 Content-Type·지원하지 않는 파일 유형. |
| 422 | `CONTENT_REJECTED` | AI가 콘텐츠 요청을 거절. 설명 변경 안내. |
| 429 | `RATE_LIMITED`, `DAILY_LIMIT` | 사용자 또는 서비스 전체 요청 한도 초과. 재시도 시간 제공. |
| 502 | `UPSTREAM_ERROR` | 외부 AI 응답 이상·실패. 입력 유지. |
| 503 | `SERVICE_UNAVAILABLE` | 설정 누락·생성 중지·모델 권한 문제·외부 한도·DB/제한 검사 장애. |
| 504 | `GENERATION_TIMEOUT` | 80초 AI 대기 초과. 자동 재시도 없음. |
| 500 | `INTERNAL_ERROR` | 분류되지 않은 내부 실패. 안전한 메시지와 요청 ID만 공개. |

provider의 인증·모델 설정 오류를 사용자 입력 오류로 오인하지 않는다. provider 429는 우리 사용자별 한도와 다르므로 `503`으로 매핑한다. 네트워크·일시적인 provider 5xx는 `502`다. 피드백 입력의 공개 동의 누락은 docs05의 필수 검증과 위 403 규칙을 함께 따른다.

## 6. 영속 요청 제한

인스턴스가 여러 개 생기는 Vercel에서는 메모리 카운터가 공유되지 않는다. Supabase DB 함수에서 검사·차감을 한 트랜잭션으로 수행한다. 호출 가능한 비밀 키는 서버에만 둔다.

| scope | 클라이언트 고정 구간 | 별도 전역 한도 |
| --- | --- | --- |
| `generation` | 600초에 3회 | UTC 하루 `GENERATION_DAILY_LIMIT`, 기본 50회 |
| `feedback_write` | 600초에 10회 | 없음 |
| `feedback_read` | 60초에 60회 | 없음 |

`고정 구간`은 매 정시 기준으로 나눈 시간칸이다. 이동 구간이 아니므로 경계 전후에는 두 구간의 요청이 짧은 시간에 모일 수 있다. 제한은 성공 수가 아니라 **정상 검증 후 허용된 시도 수**다. AI 실패·피드백 재전송도 차감하고 환불하지 않는다. 거부된 요청은 카운터를 올리지 않는다. 잘못된 입력은 차감하지 않는다.

운영에서는 Vercel이 설정한 `x-vercel-forwarded-for`의 유효 IP를 사용한다. 임의 클라이언트 헤더·쿼리의 IP를 신뢰하지 않는다. IPv4/IPv6를 일관되게 정규화하고 `HMAC-SHA256(RATE_LIMIT_SALT, UTC날짜 + ':' + IP)`의 64자리 hex만 DB로 보낸다. 원본 IP는 잠시 메모리에서만 쓰고 로그에 남기지 않는다. 로컬에서는 고정 개발 IP를 사용해 한 클라이언트로 제한한다. 운영 IP를 확인할 수 없으면 요청을 503으로 거부한다. 같은 네트워크의 사용자가 한도를 공유할 수 있다. [Vercel 요청 헤더](https://vercel.com/docs/headers/request-headers)

### 최초 요청 제한 SQL

새 프로젝트의 `supabase/migrations/002_rate_limits.sql`로 저장한다. 이 함수는 프로토타입의 작은 트래픽을 전제로 한 잠금 방식이다. 함수 실행 권한도 반드시 제한한다.

```sql
begin;

create table public.rate_limit_windows (
  scope text not null,
  subject text not null,
  bucket_start timestamptz not null,
  hits integer not null check (hits >= 0),
  expires_at timestamptz not null,
  primary key (scope, subject, bucket_start)
);
create index rate_limit_expiry_idx
  on public.rate_limit_windows (expires_at);
alter table public.rate_limit_windows enable row level security;
revoke all on public.rate_limit_windows
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.rate_limit_windows to service_role;

create function public.consume_quota(
  p_scope text,
  p_subject text,
  p_generation_daily_limit integer default 50
)
returns table (allowed boolean, retry_at timestamptz, reason text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_start timestamptz;
  v_day timestamptz;
  v_seconds integer;
  v_limit integer;
  v_hits integer;
  v_retry timestamptz := null;
  v_reason text := null;
begin
  if p_scope is null
    or p_scope not in ('generation','feedback_write','feedback_read')
    or p_subject is null or p_subject !~ '^[0-9a-f]{64}$'
    or p_generation_daily_limit is null
    or p_generation_daily_limit not between 1 and 1000 then
    raise exception 'invalid quota arguments';
  end if;

  -- 모든 API 인스턴스의 검사와 차감을 같은 DB 잠금으로 순서대로 처리한다.
  perform pg_catalog.pg_advisory_xact_lock(73641921::bigint);
  v_now := pg_catalog.clock_timestamp();
  v_seconds := case when p_scope = 'feedback_read' then 60 else 600 end;
  v_limit := case p_scope
    when 'generation' then 3 when 'feedback_write' then 10 else 60 end;
  v_start := pg_catalog.to_timestamp(
    floor(extract(epoch from v_now) / v_seconds) * v_seconds);
  v_day := date_trunc('day', v_now at time zone 'UTC') at time zone 'UTC';

  delete from public.rate_limit_windows where expires_at <= v_now;
  select coalesce((select b.hits from public.rate_limit_windows b
    where b.scope = p_scope and b.subject = p_subject
      and b.bucket_start = v_start), 0) into v_hits;
  if v_hits >= v_limit then
    v_retry := v_start + make_interval(secs => v_seconds);
    v_reason := 'client';
  end if;

  if p_scope = 'generation' then
    select coalesce((select b.hits from public.rate_limit_windows b
      where b.scope = 'generation_daily' and b.subject = 'global'
        and b.bucket_start = v_day), 0) into v_hits;
    if v_hits >= p_generation_daily_limit then
      v_retry := greatest(v_retry, v_day + interval '1 day');
      v_reason := 'global';
    end if;
  end if;

  if v_retry is not null then
    return query select false, v_retry, v_reason;
    return;
  end if;

  insert into public.rate_limit_windows as b
    (scope,subject,bucket_start,hits,expires_at)
  values (p_scope,p_subject,v_start,1,v_start + interval '24 hours')
  on conflict (scope,subject,bucket_start)
  do update set hits = b.hits + 1;

  if p_scope = 'generation' then
    insert into public.rate_limit_windows as b
      (scope,subject,bucket_start,hits,expires_at)
    values ('generation_daily','global',v_day,1,v_day + interval '1 day')
    on conflict (scope,subject,bucket_start)
    do update set hits = b.hits + 1;
  end if;
  return query select true, null::timestamptz, null::text;
end;
$$;

revoke all on function public.consume_quota(text,text,integer)
  from public, anon, authenticated;
grant execute on function public.consume_quota(text,text,integer) to service_role;
commit;
```

RPC는 `{p_scope,p_subject,p_generation_daily_limit}`를 전달하고 반환 행이 정확히 하나인지 확인한다. timeout·오류·빈 응답은 `503`으로 실패 처리한다. `allowed=false`일 때 reason `global`은 `DAILY_LIMIT`, 나머지는 `RATE_LIMITED`다. `retry_at`에서 남은 초를 올림한다. 두 생성 버킷은 하나의 잠금 안에서 모두 검사한 뒤 함께 차감한다.

이 SQL은 공개 트래픽 검증 전 개발 DB에서 실행·테스트해야 한다. 요청 제한 함수가 연결되지 않으면 생성 API를 공개하지 않는다. secret key에 의한 테이블 접근을 브라우저에 제공하지 않는다. [Supabase 함수와 권한](https://supabase.com/docs/guides/database/functions)

### 오래된 카운터 정리

클라이언트 버킷은 시작 후 24시간에 만료하며 일일 전체 버킷은 다음 UTC 자정에 만료한다. 만료 행은 다음 RPC 호출에서 제거한다. 트래픽이 없어도 정리되도록 Supabase Cron을 켜고 다음 작업을 한 번 등록한다. 현재 프로젝트에 같은 이름의 작업이 있으면 먼저 확인한다.

```sql
select cron.schedule(
  'suminpixel-prune-rate-limits',
  '7 * * * *',
  $$delete from public.rate_limit_windows where expires_at <= now()$$
);
```

시간마다 실행되므로 정상 운영 시 최대 약 25시간 내 정리된다. Cron 장애 시 지연될 수 있으므로 작업 이력을 확인한다. [Cron 설치](https://supabase.com/docs/guides/cron/install), [예약과 실행 이력](https://supabase.com/docs/guides/cron/quickstart)

## 7. 로그와 서버 완료 기준

로그는 요청 ID, 작업 분류, 상태, 소요 시간, 안전한 오류 코드만 남긴다. 요청 본문, 파일, 프롬프트, 피드백 전문, IP 원문, base64, 키는 남기지 않는다. 공급자가 자체 보관하는 데이터까지 `즉시 삭제`라고 약속하지 않는다.

- [ ] 유효하지 않은 요청·한도 초과·DB 제한 검사 실패는 OpenAI를 호출하지 않는다.
- [ ] 이미지 모드가 edit, 프롬프트 모드가 generate를 각각 한 번 호출한다.
- [ ] 파일 위장·크기 초과·중복 필드·외부 Origin·잘못된 Content-Type을 거부한다.
- [ ] 응답은 정해진 PNG 소스·크기·필드만 포함한다.
- [ ] 동시 요청으로 클라이언트·일일 전체 한도를 넘지 않는다.
- [ ] RLS·함수 EXECUTE·비밀 환경변수를 확인하고 정리 Cron이 실행된다.
- [ ] provider 거절·오류·시간 초과와 DB 장애를 사용자 오류로 구분한다.

Vercel의 일반 요청·응답은 각각 4.5MB 상한이 있으므로 위의 내부 제한을 더 작게 정했다. 시간 설정은 현재 프로젝트의 Fluid Compute와 플랜에서 120초가 허용되는지 확인한다. [Vercel 제한](https://vercel.com/docs/functions/limitations), [시간 설정](https://vercel.com/docs/functions/configuring-functions/duration), [Node 핸들러](https://vercel.com/docs/functions/runtimes/node-js)
