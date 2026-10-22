# API 설계서

> 기준: 백엔드 `main` 최신 확인 커밋 `70f023e` (2026-10-22), `docs/API_CONTRACT.md`, `backend/vision/routers/*`, `backend/discord/router.py`, `backend/notifications/router.py`.

## 1. 공통 규칙

- API 서버: FastAPI. 기본 경로 `/api`; 서버 상태 `GET /health`, 문서 `GET /docs`.
- 보호 API는 `Authorization: Bearer <access_token>`을 사용합니다.
- 관리자 권한은 `profiles.role=admin` 및 `profiles.status=active`를 기준으로 판정합니다.
- 실제 배포 설정·외부 API 연결 여부에 따라 일부 기능은 503을 반환할 수 있습니다.
- 아래 목록은 **코드/문서에 정의된 API**이며 모든 엔드포인트의 운영 환경 통합 테스트 완료를 의미하지 않습니다.

## 2. 기능별 엔드포인트

### 인증 및 프로필

| 메서드 | 경로 | 역할 |
|---|---|---|
| `POST` | `/api/auth/register` | 회원가입 |
| `POST` | `/api/auth/login` | 로그인 및 토큰 발급 |
| `POST` | `/api/auth/refresh` | 토큰 갱신 |
| `GET` | `/api/auth/me` | 현재 인증 사용자 |
| `GET` | `/api/users/me` | 내 프로필 |
| `PATCH` | `/api/users/me` | 닉네임 수정 |

### 감지 및 카메라

| 메서드 | 경로 | 역할 |
|---|---|---|
| `GET` | `/api/motion/cameras` | 내 카메라 목록 |
| `POST` | `/api/motion/cameras` | 카메라 등록 |
| `POST` | `/api/motion/runs` | 감지 시작 |
| `GET` | `/api/motion/runs` | 감지 실행 목록 |
| `GET` | `/api/motion/runs/{run_id}` | 실행 상태 |
| `POST` | `/api/motion/runs/{run_id}/frames` | 브라우저 JPEG 프레임 전송 |
| `POST` | `/api/motion/runs/{run_id}/stop` | 감지 중지 |
| `POST` | `/api/motion/runs/{run_id}/preview-ticket` | 다른 기기 보기용 티켓 |
| `GET` | `/api/motion/runs/{run_id}/preview.jpg` | 미리보기 이미지 |
| `GET` | `/api/motion/runs/{run_id}/preview.mjpg` | MJPEG 미리보기 |

### 이벤트 및 AI

| 메서드 | 경로 | 역할 |
|---|---|---|
| `GET` | `/api/motion/events` | 이벤트 목록 |
| `GET` | `/api/motion/events/{event_id}` | 이벤트 상세 |
| `GET` | `/api/motion/events/{event_id}/parts` | 사진 묶음 목록 |
| `GET` | `/api/motion/parts/{part_id}` | 묶음 상세 |
| `GET` | `/api/motion/questions` | AI 질문 설정 조회 |
| `PUT` | `/api/motion/questions` | AI 질문 설정 변경 |
| `POST` | `/api/motion/parts/{part_id}/analyses` | 수동 분석 요청 |
| `GET` | `/api/motion/parts/{part_id}/analyses` | 묶음 분석 이력 |
| `GET` | `/api/motion/analyses/{analysis_id}` | 분석 상세 |
| `GET` | `/api/motion/events/{event_id}/analysis` | 사건 종합 분석 |

### 알림

| 메서드 | 경로 | 역할 |
|---|---|---|
| `GET` | `/api/notifications` | 알림 목록 |
| `PATCH` | `/api/notifications/{notification_id}/read` | 읽음 처리 |
| `GET` | `/api/notifications/stream` | Redis Pub/Sub 기반 SSE |

### 피드백

| 메서드 | 경로 | 역할 |
|---|---|---|
| `POST` | `/api/feedback` | 피드백 등록 |
| `GET` | `/api/feedback` | 내 피드백 목록 |
| `GET` | `/api/feedback/{id}` | 피드백 상세 |
| `PATCH` | `/api/feedback/{id}` | 피드백 수정 |
| `DELETE` | `/api/feedback/{id}` | 논리 삭제 |

### 관리자

| 메서드 | 경로 | 역할 |
|---|---|---|
| `GET` | `/api/admin/users` | 사용자 목록 |
| `PATCH` | `/api/admin/users/{id}` | 역할·상태 수정 |
| `GET` | `/api/admin/feedback` | 전체 피드백 |
| `PATCH` | `/api/admin/feedback/{id}` | 피드백 처리 |
| `DELETE` | `/api/admin/feedback/{id}` | 피드백 논리 삭제 |
| `GET` | `/api/admin/audit-logs` | 관리자 감사 로그 |
| `GET` | `/api/admin/cameras` | 카메라 목록 |
| `GET` | `/api/admin/cameras/{camera_id}/events` | 카메라 사건 목록 |
| `GET` | `/api/admin/events/{event_id}` | 사건 상세 |
| `GET` | `/api/admin/events/{event_id}/parts` | 사진 묶음 |
| `GET` | `/api/admin/parts/{part_id}` | 사진 상세 |
| `GET` | `/api/admin/photos/{photo_id}/content` | JPEG 원본 |
| `GET` | `/api/admin/parts/{part_id}/analyses` | 묶음 분석 이력 |
| `GET` | `/api/admin/analyses/{analysis_id}` | 분석 상세 |
| `GET` | `/api/admin/events/{event_id}/analysis` | 사건 종합 분석 |

### Discord

| 메서드 | 경로 | 역할 |
|---|---|---|
| `GET` | `/api/discord/config` | 설정 상태 |
| `POST` | `/api/discord/start` | OAuth 시작 |
| `POST` | `/api/discord/complete` | OAuth 완료 |
| `GET` | `/api/discord/connection` | 연결 정보 |
| `PATCH` | `/api/discord/connection` | 알림 설정 |
| `POST` | `/api/discord/connection/test` | DM 테스트 |
| `DELETE` | `/api/discord/connection` | 연결 해제 |

## 3. 주요 요청 예시

**로그인**

```http
POST /api/auth/login
Content-Type: application/json

{"email":"member@example.com","password":"**********"}
```

**감지 시작**

```http
POST /api/motion/runs
Authorization: Bearer <access_token>
Content-Type: application/json

{"camera_id":"<camera-uuid>","config":{}}
```

> 감지 시작의 세부 `config` 검증 필드는 현재 백엔드 Pydantic 모델 및 `/docs`에서 확인해야 합니다. 위 JSON은 구조 설명용이며 그대로 성공한다고 보장하지 않습니다.

**이벤트 조회**

```http
GET /api/motion/events?limit=20&finished_only=true
Authorization: Bearer <access_token>
```

## 4. 처리 및 보안 정책

- 사용자 카메라·사건은 로그인한 사용자의 소유권을 검증합니다.
- 피드백은 독립 문의이며 사건과 직접 FK가 없습니다. 삭제는 `deleted_at`을 설정하는 논리 삭제입니다.
- 알림 SSE는 Redis가 준비되지 않으면 503을 반환할 수 있으며, DB 목록 조회와 분리되어 있습니다.
- 사진 원본은 비공개 저장소를 사용하며 인증된 API를 통해 조회합니다.
- 관리자 비전 조회는 읽기 전용입니다.
- Discord OAuth/DM은 환경 변수와 Redis·봇 설정에 따라 사용 가능 여부가 달라집니다.

## 5. 참고 코드

- [백엔드 API 계약](https://github.com/joel10195/aio-03-p1-team2-Back/blob/main/docs/API_CONTRACT.md)
- [비전 API 설명](https://github.com/joel10195/aio-03-p1-team2-Back/blob/main/backend/vision/README.md)
- [FastAPI 메인](https://github.com/joel10195/aio-03-p1-team2-Back/blob/main/backend/main.py)
