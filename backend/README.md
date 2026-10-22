# NoteCam 웹 백엔드

공용 서버는 Supabase Auth와 SDK 연결을 사용합니다. 서버 기동 때 SQLite 파일이나 테이블을 생성하지 않습니다.
비전 API는 같은 공용 비동기 HTTP 연결 풀과 사용자 컨텍스트를 사용하며, 비전 설정은 별도로 관리합니다.

## 실행

프로젝트 루트에서 빌드하면 의존성 설치와 YOLO 모델 다운로드·검증을 함께 수행합니다.
개발 설정 파일 `.env.dev`를 사용하는 Mac/Linux 환경에서는 다음 순서로 실행합니다.

```sh
APP_ENV=dev sh scripts/build.sh
APP_ENV=dev uv run --no-sync uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
```

공통 `.env`만 사용하면 `APP_ENV=dev`를 생략합니다.
Render의 Build Command는 `sh scripts/build.sh --no-dev`로 지정합니다.
모델 준비가 실패하면 빌드도 실패하므로 모델 없이 배포를 진행하지 않습니다.

Windows PowerShell에서는 다음 명령을 사용합니다.

```powershell
Copy-Item .env.example .env
uv sync --frozen
uv run --no-sync python -m scripts.prepare_motion_model
uv run uvicorn backend.main:app --reload --no-access-log
```

이미 `.env`가 있으면 복사 명령은 생략합니다.
`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`와 프런트의
`CORS_ORIGINS`를 설정해야 합니다. 누락된 설정은 시작 시 오류로 알리며 SQLite로 대체하지 않습니다.
비전을 실행하지 않으려면 `VISION_ENABLED=false`로 설정합니다.
웹 API의 DB 준비는 [웹 API 계약](docs/API_CONTRACT.md)과 [적용 SQL](docs/web_supabase.sql)을 참고합니다.
비전 실행은 [비전 연결 안내](backend/vision/README.md)를 따릅니다.

- Swagger: http://127.0.0.1:8000/docs
- 서버 상태: http://127.0.0.1:8000/health

모든 실행 환경은 원격 Supabase만 사용합니다. 기본 실행은 `.env`를 읽고,
`APP_ENV=dev`로 실행하면 `.env.dev`의 원격 설정을 추가로 읽습니다.
localhost·사설 IP와 기존 로컬 프로필은 시작 시 거부합니다.
설정 방법은 [비전 원격 환경 설정](backend/vision/README.md#원격-환경-설정)을 참고하세요.

## 제공 API

| 기능 | API |
| --- | --- |
| 이메일 회원가입 | POST /api/auth/register |
| 이메일 로그인 | POST /api/auth/login |
| 현재 사용자 | GET /api/auth/me |
| 움직임 알림 목록 | GET /api/notifications |
| 알림 읽음 처리 | PATCH /api/notifications/{notification_id}/read |
| 움직임 알림 SSE | GET /api/notifications/stream |
| 프로필 조회·수정 | GET/PATCH /api/users/me |
| 피드백 작성·조회 | POST/GET /api/feedback |
| 피드백 상세·수정·삭제 | GET/PATCH/DELETE /api/feedback/{id} |
| 관리자 피드백 목록 | GET /api/admin/feedback |
| 관리자 피드백 처리·삭제 | PATCH/DELETE /api/admin/feedback/{id} |
| 관리자 사용자 목록·수정 | GET /api/admin/users, PATCH /api/admin/users/{id} |
| 관리자 변경 이력 | GET /api/admin/audit-logs |
| 서버 상태 | GET /health |

분석 완료·실패 알림은 목록, SSE 및 읽음 처리 대상에서 제외합니다.
이벤트 생성과 알림 생성 API는 포함하지 않습니다. 피드백은 제목·분류·내용을 갖는 독립 문의입니다.
웹 저장소는 Supabase SDK를 사용하며 SQLite 실행 경로는 없습니다.
알림 API는 유지하지만 제공된 DB에는 notifications 테이블이 없어 연결 준비 전까지 503을 반환합니다.

## 기능별 코드

- `backend/login/`: Supabase Auth 로그인과 현재 사용자 API
- `backend/notifications/`: 움직임 알림 조회, 읽음 처리, SSE
- `backend/feedback/`: 본인 피드백 작성·조회·수정·논리 삭제
- `backend/admin/`: 관리자 권한, 사용자·피드백 관리, 감사 로그
- `backend/users/`: 내 프로필 조회·수정
- `backend/common/supabase.py`: 공용 HTTP 풀, 사용자용·서버 작업용 SDK 생성
- `backend/common/dependencies.py`: Supabase Auth 검증, 요청별 `UserContext`
- `backend/main.py`: 앱 생성, CORS, 기능별 라우터 등록
- `backend/config.py`: 공용 Supabase·CORS 설정과 개발 프로필 선택
- `backend/vision/config.py`: Gemini·모델·촬영·미리보기 설정

기존 DB 파일과 테이블을 삭제하거나 원격 DB 스키마를 변경하지 않습니다.
`main.py`는 `app.state.supabase`에 연결 자원만 보관합니다. 사용자 JWT를 적용한 SDK와 repository는 요청별로 구성합니다.

## 백엔드 회원가입·로그인

`POST /api/auth/login`에 기존 Supabase 사용자의 이메일·비밀번호를 보냅니다.

```json
{"email": "member@example.com", "password": "your-password"}
```

백엔드가 Supabase Auth에 로그인하고 `access_token`, `refresh_token`, `expires_in`, `token_type`을 반환합니다.
`/api/auth/me`와 비전 API에는 `Authorization: Bearer <access_token>`을 보냅니다.
`POST /api/auth/register`에도 같은 이메일·비밀번호를 보내 가입합니다(비밀번호 10~128자).
201 응답의 `user_id`는 Supabase 사용자 ID이고, `email_confirmation_required`가 `true`이면 이메일 인증 후 로그인합니다.
회원가입은 토큰을 반환하지 않으며, 가입 후 `/api/auth/login`을 호출합니다.
갱신·로그아웃 API는 별도 인증 담당자가 구현할 영역입니다.

## 공용 비동기 SDK 사용

`UserContext.client`는 현재 사용자 JWT가 설정된 Supabase `AsyncClient`입니다.
요청 의존성에서 받은 context를 각 기능 repository 생성자에 전달합니다.

```python
from backend.common.dependencies import UserContext

class CameraRepository:
    def __init__(self, context: UserContext):
        self.context = context
        self.client = context.client

    async def list(self):
        response = await (
            self.client.table("cameras")
            .select("id,name")
            .eq("owner_id", self.context.user_id)
            .execute()
        )
        return response.data
```

라우터·서비스도 `async def`를 사용하고 저장소 호출을 `await`합니다.
API는 `build_supabase()`의 `httpx.AsyncClient` 풀을 공유합니다.
감지·업로드·분석 스레드는 `build_worker_supabase()`의 별도 동기 풀을 사용합니다.
모델 로딩·JPEG 변환 등 CPU 작업은 스레드에서 수행합니다.

## 관리자 계정

Supabase의 `public.profiles.role`을 `admin`으로 설정합니다. `profiles.status=active`도 필요합니다.
`app_metadata.role`과 사용자 편집 가능한 `user_metadata`는 관리자 권한 기준으로 사용하지 않습니다. 기존 로컬 관리자 생성 스크립트는 공용 서버에서 사용하지 않습니다.

## 테스트

```powershell
uv sync --group dev
uv run pytest -q tests/test_api.py tests/test_auth_api.py tests/test_live_streams.py
```

웹 API의 인증·소유권 격리, 프로필 권한, 피드백, 관리자 RPC 요청과 알림 SSE를 검증합니다.
실제 Supabase나 유료 AI는 호출하지 않습니다. SQL의 실제 실행과 프런트 화면 연결은 별도 검증이 필요합니다.
