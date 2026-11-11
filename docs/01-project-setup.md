# 프로젝트 생성과 실행

## 1. 시작점

이 문서는 SUMINPIXEL의 프로젝트 구조와 실행 환경을 설명한다. 바로 실행하려면 [README.md](../README.md)를 확인한다. 먼저 루트 [AGENTS.md](../AGENTS.md), [PRD.md](../PRD.md)를 읽는다.

PowerShell에서 다음처럼 작업 경로를 지정한다.

```powershell
Set-Location -LiteralPath 'C:\Users\smhrd\Desktop\황수민'
Get-Location
```

기존 파일을 확인한 뒤 필요한 폴더만 추가한다. 루트에 이미 있는 문서 8개를 유지한다.

## 2. 생성할 폴더와 파일

```text
황수민/
  AGENTS.md
  PRD.md
  docs/                         # 이 문서 포함 지침 6개
  public/
    index.html                  # 한 페이지 전체 구조
    styles.css                  # 디자인 토큰·반응형·상태
    js/
      app.js                    # 이벤트 연결과 화면 상태
      api.js                    # 같은 출처 fetch와 오류 정규화
      image-input.js            # 파일 확인·정규화·미리보기
      pixelate.js               # 격자·팔레트·PNG 변환
      feedback.js               # 피드백 폼과 목록
    assets/                     # 직접 만든 아이콘·자체 호스팅 글꼴
  api/
    generate.js                 # POST /api/generate
    feedback.js                 # GET/POST /api/feedback
  server/
    env.js                      # 설정 검사, 브라우저에 제공 금지
    openai.js                   # AI 생성·편집
    supabase.js                 # 서버 전용 DB 클라이언트
    rate-limit.js               # HMAC·DB RPC 호출
    validation.js               # 입력 검사
    errors.js                   # 안전한 오류 응답
  supabase/
    migrations/
      001_feedback.sql          # docs05의 초기 스키마
      002_rate_limits.sql       # docs04의 카운터·함수
  tests/                        # 핵심 로직·API 테스트
  package.json
  package-lock.json
  vercel.json
  .env.example
  .env.local                    # Git·배포물에서 제외
  .gitignore
```

`public/`만 정적 배포 대상이다. `server/`, 문서, 환경 파일을 그 안에 복사하지 않는다. API에서 `server/` 코드를 import한다.

## 3. 실행 환경과 패키지

Vercel의 Node.js는 24.x로 설정한다. 로컬은 Node.js 24–26을 지원하며 `package.json`의 `type: module`로 ES Modules를 사용한다. npm 잠금 파일을 사용해 설치 버전을 맞춘다.

| 종류 | 패키지 | 역할 |
| --- | --- | --- |
| 운영 | `openai` | 서버의 공식 OpenAI SDK |
| 운영 | `@supabase/supabase-js` | 서버 DB 접근 |
| 운영 | `sharp` | 서버에서 실제 이미지 판독·메타데이터 제거·크기 정규화 |
| 로컬 | Node 내장 HTTP 서버 | Vercel과 같은 API 핸들러 및 정적 화면 실행 |
| 테스트 | Node 내장 `node:test`, 필요 시 `@playwright/test` | 핵심 함수·브라우저 통합 검증 |

브라우저 모듈은 CDN으로 서버 SDK를 로드하지 않는다. Vercel 함수는 Web Standard `fetch(request)` 핸들러를 쓰고, 전체 바이트 제한을 먼저 적용한 뒤 Node 내장 `Request.formData()`로 multipart를 해석한다. `npm run dev`는 `scripts/dev-server.mjs`에서 같은 핸들러를 실행한다. `npm test`는 Node 테스트, `npm run test:e2e`는 Playwright 브라우저 테스트를 실행한다.

```powershell
npm ci
npm run dev
```

브라우저에서 `http://localhost:3000`으로 접근한다. `index.html`을 더블클릭하는 `file://` 방식이나 정적 Live Server만으로는 `/api/*`가 실행되지 않는다. 로컬 실행에는 Vercel 계정이 필요 없다. Preview·Production 배포에는 계정 연결이 필요하다.

## 4. 환경변수

다음은 `.env.example`의 설계 예시다. 비밀 값은 `.env.local`에만 입력한다. 운영에서는 Vercel 환경변수 UI에 따로 등록한다.

```dotenv
OPENAI_API_KEY=
OPENAI_IMAGE_MODEL=gpt-image-2.5-flare
SUPABASE_URL=
SUPABASE_SECRET_KEY=
RATE_LIMIT_SALT=
APP_ORIGIN=http://localhost:3000
GENERATION_ENABLED=true
GENERATION_DAILY_LIMIT=50
```

- `OPENAI_IMAGE_MODEL`: 생성과 편집을 모두 지원하는 모델 한 가지. 계정 접근 권한은 실제 소규모 호출로 확인한다. 자동 대체하지 않는다.
- `SUPABASE_URL`: 자신의 Supabase 프로젝트 URL.
- `SUPABASE_SECRET_KEY`: 서버 전용 secret key. 공개 publishable key와 혼동하지 않는다. 이 설계는 서버에서 `service_role` 권한으로 접근하므로 RLS만 믿지 말고 서버에서 검증한다.
- `RATE_LIMIT_SALT`: 암호학적으로 생성한 최소 32바이트 비밀 난수. 프로젝트 간 재사용하지 않는다.
- `APP_ORIGIN`: 현재 배포의 정확한 `https://도메인` 또는 로컬 주소. 끝 슬래시 없이 한 개 출처로 지정한다. Preview와 Production에 각각 설정한다.
- `GENERATION_ENABLED`: `false`이면 생성만 503으로 차단하며 피드백은 사용 가능하다.
- `GENERATION_DAILY_LIMIT`: 양의 정수, 기본 50. 비용에 맞춰 운영자가 낮출 수 있다.

운영 필수 변수 누락 시 해당 API는 `SERVICE_UNAVAILABLE`로 실패한다. 원본 비밀 값이나 키 접두어까지 오류 응답에 포함하지 않는다. 서버 시작 또는 함수 초기화 시 설정을 검사하되, AI 키 누락 때문에 피드백 API까지 중단시키지 않도록 의존 설정을 나눈다.

`.gitignore`에 `.env*`를 제외하고 `!.env.example`만 허용한다. `node_modules/`, `.vercel/`, 로그, 테스트 산출물도 제외한다.

## 5. Vercel 설정 기준

Framework Preset은 Other, Output Directory는 `public`, Node는 24.x로 설정한다. API 함수는 프로젝트 루트의 `api/`를 사용한다. 별도 프런트 빌드가 없으므로 Build Command에 프레임워크 빌드를 넣지 않는다. 설치는 잠금 파일 기반 `npm ci`를 사용한다.

```json
{
  "functions": {
    "api/generate.js": { "maxDuration": 120 },
    "api/feedback.js": { "maxDuration": 15 }
  }
}
```

정적 파일 전체를 `index.html`로 보내는 무조건적인 rewrite는 추가하지 않는다. API 요청이 HTML로 바뀌지 않아야 한다. 보안 헤더는 [검증과 배포](06-testing-deployment.md)를 따른다.

## 6. 실행 순서와 확인점

1. HTML·CSS와 빈 상태를 만들고 375px·1440px 화면을 확인한다.
2. 고정 샘플로 Canvas 픽셀 함수와 PNG 저장을 구현한다. 샘플임을 명시한다.
3. Supabase 개발 프로젝트에서 마이그레이션을 적용하고 피드백 API를 연결한다.
4. OpenAI 설정 후 생성·편집 API를 연결한다. 실제 과금 호출은 통합 확인에 필요한 소수만 사용한다.
5. 테스트와 비밀 키 노출 확인 후 Vercel Preview에서 외부 연동을 확인한다.
6. Production 환경변수와 DB를 지정하고 배포 후 같은 핵심 흐름을 점검한다.

## 7. 공식 참고

확인 기준일: 2026-11-11. 도구 버전·서비스 정책 변경 시 구현 시점의 공식 문서를 다시 확인한다.

- [Vercel Node.js 버전](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
- [Vercel 로컬 실행](https://vercel.com/docs/cli/dev)
- [Vercel 함수 시간 설정](https://vercel.com/docs/functions/configuring-functions/duration)
