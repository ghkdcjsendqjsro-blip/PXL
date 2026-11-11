# SUMINPIXEL

이미지를 첨부하거나 원하는 장면을 글로 써 픽셀 이미지를 만들고, 1024×1024 PNG로 내려받는 한국어 웹 스튜디오입니다. 로그인 없이 공개 피드백을 남길 수 있습니다. `첨부하기`를 누르면 AI로 만든 최신 픽셀 결과와 그때 사용한 프롬프트를 함께 첨부할 수 있습니다. 첨부는 제출 전에 뺄 수 있으며, 첨부를 유지하고 공개에 동의해 제출하면 이미지와 프롬프트도 목록에 공개됩니다.

## 로컬에서 실행

Node.js 24.x 이상(24–26)이 필요합니다. Windows에서 Node.js 26으로 확인했습니다.

```powershell
Set-Location -LiteralPath 'C:\Users\smhrd\Desktop\황수민'
npm ci
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000)을 열면 됩니다. 이미 의존성이 설치되어 있으면 `npm run dev`만 실행하세요. 종료는 `Ctrl+C`입니다. 로컬 서버는 이 컴퓨터에서만 접근할 수 있고 Vercel 계정이 필요하지 않습니다.

### 키 없이 바로 해 볼 수 있는 기능

- **데모 이미지로 체험**: 기본 픽셀 그림에 격자와 팔레트를 적용해 PNG를 저장합니다.
- **AI 없이 첨부 이미지 미리보기**: PNG, JPG, WebP를 골라 기기에서 바로 변환합니다. 파일은 서버에 보내지 않습니다.
- 32·64·128 격자, 원본 색상·최대 16·32색을 바꾸면 미리보기와 다운로드 파일에 적용됩니다. 업로드한 이미지는 원본과 결과를 비교할 수 있습니다.

## OpenAI와 Supabase 연결

로컬 미리보기와 별도로 실제 OpenAI 이미지 생성·편집과 Supabase 익명 피드백 API가 구현되어 있습니다. 연결 설정이 없으면 준비 중이라고 안내합니다. AI 생성의 요청 횟수 제한도 Supabase를 사용하므로 실제 AI 생성을 쓰려면 두 서비스 설정이 모두 필요합니다.

1. Supabase SQL Editor에서 `supabase/migrations`의 `001_feedback.sql`, `002_rate_limits.sql`, `003_feedback_attachments.sql`을 순서대로 적용합니다. 앞선 두 파일을 적용한 프로젝트에는 `003_feedback_attachments.sql`을 추가로 적용합니다. [Supabase 지침](docs/05-supabase-feedback.md)에서 테이블과 권한을 확인할 수 있습니다.
2. `.env.example`을 복사해 `.env.local`을 만듭니다. 이미 파일이 있다면 필요한 항목만 수정하세요.
3. `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `OPENAI_API_KEY`를 본인의 프로젝트 값으로 채웁니다. `RATE_LIMIT_SALT`에는 프로젝트 전용 난수를 넣습니다. 아래 명령은 32바이트 난수를 만드는 예시입니다.

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

4. `.env.local`을 저장한 뒤 로컬 서버를 다시 시작합니다. 브라우저에서 이미지 편집, 글로 생성, 피드백 전송 후 새로고침을 확인합니다. `.env.local`과 키는 공유하거나 커밋하지 마세요.

`APP_ORIGIN` 기본값은 `http://localhost:3000`입니다. 포트 3000을 다른 프로그램이 쓰고 있으면 `npm run dev -- --port 3001`로 시작하고, `.env.local`을 사용한다면 `APP_ORIGIN`도 `http://localhost:3001`로 맞추세요.

## 테스트

```powershell
npm run check
npm test
npx playwright install chromium
npm run test:e2e
```

단위 테스트는 이미지 검증과 색상 처리, API 요청 규격, 피드백 정렬과 중복 전송, 한도 오류를 확인합니다. 브라우저 테스트는 파일 첨부, 1024 PNG, 실제 픽셀 블록·색상 수, 모바일 레이아웃, 피드백의 결과·프롬프트 첨부와 공개 목록 표시를 확인합니다. 브라우저 테스트는 AI·피드백 API에 대체 응답을 사용합니다. 실제 OpenAI·Supabase 연결은 키를 설정한 뒤 따로 확인해야 합니다.

## 파일 구성

- `public/`: HTML·CSS·JavaScript 화면과 직접 만든 픽셀 일러스트
- `api/`, `server/`: Vercel에서 사용할 Node.js API와 연동 모듈
- `supabase/migrations/`: 익명 피드백 테이블, 접근 권한, 요청 제한 SQL
- `scripts/dev-server.mjs`: 같은 API를 실행하는 로컬 서버
- `docs/`, `PRD.md`, `AGENTS.md`: 제품과 구현 기준

Vercel 설정은 `vercel.json`에 있습니다. 배포하려면 [배포 지침](docs/06-testing-deployment.md)에 따라 실제 환경변수와 Supabase 정리 작업을 설정하세요.
