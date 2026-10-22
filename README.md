# NoteCam - AI 홈 CCTV 서비스

**NoteCam(노트캠)**은 별도의 CCTV 장비 없이 노트북이나 웹캠을 활용하여 집 안의 상황을 모니터링할 수 있는 AI 기반 홈 CCTV 서비스입니다.

OpenCV를 이용해 움직임을 감지하고, Gemini AI로 촬영된 이미지를 분석하여 사용자가 집 안에서 발생한 상황을 확인할 수 있도록 지원합니다.

React 기반 웹 인터페이스를 통해 실시간 카메라 화면, 이벤트 기록, AI 분석 결과 및 알림을 제공합니다.

## 1. 프로젝트 개요

### 개발 배경

기존 홈 CCTV는 별도의 카메라 장비 구매와 설치가 필요하며, 사용자가 직접 영상을 확인해야 하는 불편함이 있습니다.

이를 개선하기 위해 기존 웹캠을 활용하고, AI가 감지된 상황을 분석하여 사용자에게 전달하는 서비스를 기획했습니다.

### 프로젝트 목표

- 별도의 CCTV 장비 없이 웹캠을 활용한 모니터링 환경 제공
- 움직임 감지 및 AI 기반 상황 분석
- 외출 중 사람 감지 시 사용자 알림 제공
- 실시간 카메라 화면과 과거 이벤트 기록 조회
- 사용자 및 관리자 기능을 구분한 웹 서비스 구현

## 2. 주요 기능

| 기능 | 설명 |
|---|---|
| 회원가입 및 로그인 | Supabase Auth 기반 사용자 인증 |
| 실시간 모니터링 | 웹 브라우저를 통한 카메라 화면 확인 |
| 움직임 감지 | OpenCV 기반 움직임 탐지 및 이미지 수집 |
| AI 상황 분석 | Gemini API를 활용한 이미지 분석 |
| 이벤트 기록 | 감지된 움직임과 분석 결과 조회 |
| 실시간 알림 | 움직임 감지 알림 및 읽음 상태 관리 |
| 사용자 관리 | 프로필 조회 및 수정 |
| 피드백 | 사용자 문의 및 오탐·미탐 관련 피드백 |
| 관리자 기능 | 사용자, 피드백, 카메라 기록 및 감사 로그 관리 |
| Discord 연동 | Discord 계정 연결 및 DM 알림 설정 |

일부 기능은 서버 환경변수, 데이터베이스 및 외부 서비스 설정이 완료되어야 정상적으로 동작합니다.

## 3. 기술 스택

| 구분 | 기술 |
|---|---|
| Frontend | React, JavaScript, Vite, CSS |
| Backend | Python, FastAPI, Pydantic |
| Database | PostgreSQL, Supabase |
| Authentication | Supabase Auth, JWT |
| AI | Google Gemini API |
| Computer Vision | OpenCV, YOLO |
| Cache / Realtime | Redis, SSE |
| Deployment | Linux VM, GitHub |
| Collaboration | Git, GitHub |

## 4. 시스템 아키텍처

```text
사용자 웹 브라우저
       |
       v
React Frontend
       |
       | HTTP / REST API / SSE
       v
FastAPI Backend
       |
       +---- Supabase
       |       ├── 사용자 인증
       |       ├── 데이터베이스
       |       └── 이벤트 및 사용자 정보
       |
       +---- Motion Detection
       |       ├── 카메라 입력
       |       ├── 움직임 감지
       |       └── 이미지 수집
       |
       +---- Gemini AI
       |       └── 이미지 및 상황 분석
       |
       +---- Redis
       |       └── 실시간 알림 지원
       |
       +---- Discord
               └── DM 알림 연동
```

### 주요 동작 흐름

1. 사용자가 로그인하고 카메라 모니터링을 시작합니다.
2. 움직임 감지 모듈이 카메라 프레임을 분석합니다.
3. 움직임이 감지되면 관련 이미지를 수집합니다.
4. 수집된 이미지를 Gemini AI에 전달하여 상황을 분석합니다.
5. 분석 결과와 이벤트 정보를 저장합니다.
6. 사용자는 웹 화면에서 이벤트 기록과 알림을 확인합니다.

## 5. 프로젝트 폴더 구조

```text
aio-03-p1-team2/
│
├── backend/
│   ├── backend/
│   │   ├── admin/
│   │   ├── common/
│   │   ├── discord/
│   │   ├── feedback/
│   │   ├── login/
│   │   ├── notifications/
│   │   ├── users/
│   │   ├── vision/
│   │   └── main.py
│   ├── motion_module/
│   ├── docs/
│   ├── tests/
│   ├── pyproject.toml
│   └── uv.lock
│
├── frontend/
│   ├── frontend/
│   │   ├── public/
│   │   ├── src/
│   │   │   ├── app/
│   │   │   ├── features/
│   │   │   ├── shared/
│   │   │   └── assets/
│   │   ├── package.json
│   │   └── vite.config.js
│   └── Image/
│
└── README.md
```

## 6. 로컬 실행 방법

### 6.1 저장소 Clone

```bash
git clone https://github.com/encore-ai-campus/aio-03-p1-team2.git
cd aio-03-p1-team2
```

### 6.2 Backend 실행

Python 3.12 이상과 uv가 필요합니다.

```powershell
cd backend
Copy-Item .env.example .env
```

`.env`에 Supabase 연결 정보와 필요한 API 키를 설정합니다.

```powershell
uv sync --frozen
uv run --no-sync python -m scripts.prepare_motion_model
uv run uvicorn backend.main:app --reload --no-access-log
```

- API 서버: http://localhost:8000
- Swagger API 문서: http://localhost:8000/docs
- Health Check: http://localhost:8000/health

비전 기능을 사용하려면 관련 데이터베이스 테이블과 모델 설정도 필요합니다.

### 6.3 Frontend 실행

별도의 터미널에서 통합 저장소의 `frontend/frontend` 폴더로 이동합니다.

```powershell
cd frontend/frontend
npm ci
```

필요한 경우 `.env.example`을 `.env`로 복사하고 백엔드 API 주소를 설정합니다.

```dotenv
VITE_API_BASE_URL=http://localhost:8000
```

프론트엔드 실행:

```powershell
npm run dev
```

- Frontend: http://localhost:5173

프론트엔드와 백엔드가 서로 통신할 수 있도록 백엔드의 `CORS_ORIGINS` 설정도 확인해야 합니다.

## 7. 사용자 및 관리자 기능

### 일반 사용자

- 회원가입 및 로그인
- 내 대시보드 확인
- 실시간 카메라 모니터링
- 움직임 감지 이벤트 및 AI 분석 결과 조회
- 알림 조회 및 읽음 처리
- 프로필 수정
- 피드백 등록 및 관리

### 관리자

- 운영현황 대시보드
- 사용자 계정 및 권한 관리
- 카메라 이벤트 및 분석 기록 조회
- 사용자 피드백 관리
- 관리자 작업 감사 로그 조회

관리자 권한은 Supabase의 `profiles.role` 정보를 기준으로 구분합니다.

## 8. API 및 상세 문서

백엔드는 FastAPI 기반 REST API를 제공합니다.

주요 API 영역은 다음과 같습니다.

- `/api/auth` : 사용자 인증
- `/api/users` : 사용자 프로필
- `/api/notifications` : 알림
- `/api/feedback` : 피드백
- `/api/admin` : 관리자 기능
- `/health` : 서버 상태 확인

상세 API 명세 및 실행 방법은 다음 문서를 참고합니다.

- [Backend README](backend/README.md)
- [Frontend README](frontend/README.md)
- [API Contract](backend/docs/API_CONTRACT.md)
- [Database Guide](backend/docs/DB_HANDOFF.md)

## 9. 개발 및 협업

본 프로젝트는 GitHub를 통해 프론트엔드와 백엔드 코드를 통합 관리합니다.

- Organization: `encore-ai-campus`
- Repository: `aio-03-p1-team2`
- Main Branch: `main`

프로젝트는 팀 단위로 개발되었으며, 기능별 역할을 분담하여 협업했습니다.

---

**NoteCam - 기존 웹캠을 활용한 AI 기반 스마트 홈 모니터링 서비스**

엔코아 AI 캠퍼스 팀 프로젝트