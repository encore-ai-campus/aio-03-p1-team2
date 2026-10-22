# API 설계서

> 기준: 백엔드 `main` 커밋 `70f023e` (2026-10-22), `docs/backend/API_CONTRACT.md`, `backend/vision/routers/*`, `backend/discord/router.py`, `backend/notifications/router.py`.

## 1. 공통 규칙

- API 서버: FastAPI. 기본 경로 `/api`; 서버 상태 `GET /health`, 문서 `GET /docs`.
- 보호 API는 `Authorization: Bearer <access_token>`을 사용합니다.
- 관리자 권한은 `profiles.role=admin` 및 `profiles.status=active`를 기준으로 판정합니다.
- 외부 서비스에 의존하는 기능은 연결 상태에 따라 `503 Service Unavailable`을 반환합니다.

## 2. 기능별 엔드포인트

### 서버 상태

| 메서드 | 경로 | 역할 |
|---|---|---|
| `GET` | `/health` | 서버 상태 조회 |

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
| `GET` | `/api/motion/photos/{photo_id}/content` | 소유권 확인 후 사진 원본 조회 |
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
| `GET` | `/api/feedback/{feedback_id}` | 피드백 상세 |
| `PATCH` | `/api/feedback/{feedback_id}` | 피드백 수정 |
| `DELETE` | `/api/feedback/{feedback_id}` | 논리 삭제 |

### 관리자

| 메서드 | 경로 | 역할 |
|---|---|---|
| `GET` | `/api/admin/users` | 사용자 목록 |
| `PATCH` | `/api/admin/users/{user_id}` | 역할·상태 수정 |
| `GET` | `/api/admin/feedback` | 전체 피드백 |
| `PATCH` | `/api/admin/feedback/{feedback_id}` | 피드백 처리 |
| `DELETE` | `/api/admin/feedback/{feedback_id}` | 피드백 논리 삭제 |
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

## 3. 주요 요청 형식

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

{"camera_id":"<camera-uuid>","objects":["person"],"capture":{"max_images":6,"sample_interval_sec":0.5}}
```

> 감지 실행 요청은 `RunCreate` 모델을 따르며, `camera_id`와 선택적인 `objects`, `capture`, `analysis_roi`, `duration_sec`, `preview_mirror`, `preview_overlay`로 구성됩니다.

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

## 6. 요청·응답 상세 명세

아래 요청·응답 JSON의 식별자와 날짜는 명세를 설명하기 위한 샘플 값입니다. 필드 및 유효성 규칙은 백엔드 Pydantic 모델을 따릅니다.

### 6.1 인증 및 프로필

| API | 요청 필드 / 제약 | 성공 응답 주요 필드 |
|---|---|---|
| `POST /api/auth/register` | `email` 이메일 형식, `password` 10~128자 | `user_id` UUID, `email_confirmation_required` boolean |
| `POST /api/auth/login` | `email`, `password` 1~128자 | `access_token`, `refresh_token`, `expires_in`, `token_type` |
| `POST /api/auth/refresh` | `refresh_token` 1~8192자 | 갱신된 두 토큰과 만료 정보 |
| `GET /api/auth/me` | Bearer 토큰 | `id`, `role` (기존 호환 계약) |
| `GET /api/users/me` | Bearer 토큰 | `id`, `display_name`, `email`, `role`, `status`, `created_at`, `updated_at` |
| `PATCH /api/users/me` | `display_name` 1~40자 | 변경된 프로필 |

```json
{"email":"member@example.com","password":"example-password-123"}
```

로그인 응답 예시:

```json
{"access_token":"<jwt>","refresh_token":"<refresh-token>","expires_in":3600,"token_type":"bearer"}
```

### 6.2 카메라·감지 실행

`POST /api/motion/cameras`: `{"name":"거실"}` → `201`, 응답 `{"id":"<camera-uuid>","name":"거실"}`. 이름은 trim 후 1~80자입니다.

`POST /api/motion/runs`의 실제 `RunCreate` 모델:

```json
{
  "camera_id":"<camera-uuid>",
  "objects":["person"],
  "capture":{"pre_capture_sec":3,"quiet_sec":3,"max_duration_sec":10,"sample_interval_sec":0.5,"max_images":6},
  "analysis_roi":null,
  "duration_sec":null,
  "preview_mirror":true,
  "preview_overlay":false
}
```

- `objects`: 1~80개, 공백 제거·소문자 정규화·중복 제거. 기본값 `person`.
- `capture.pre_capture_sec` ≥ 0, `quiet_sec` > 0, `max_duration_sec` > 0 및 ≤ 10, `sample_interval_sec` > 0, `max_images` 2~6.
- `pre_capture_sec`는 `max_duration_sec`보다 작아야 하고 `quiet_sec`, `sample_interval_sec`는 각각 최대 지속 시간을 초과할 수 없습니다.
- `analysis_roi`: 선택값 `[x1,y1,x2,y2]`, 각 값 0~1이고 x1 < x2, y1 < y2.
- `duration_sec`: 선택값, 0초 초과 86400초 이하.
- 실행 조회 응답: `id`, `camera_id`, `config`, `status`, `requested_at`, `started_at`, `finished_at`, `error_message`, `progress`.
- `POST /api/motion/runs/{run_id}/frames`: `multipart/form-data`의 `file`(JPEG), `sequence_no`(0부터 증가), `timestamp_sec`(상대 초). 정상 수신 시 `202` 및 `{"sequence_no":0,"accepted":true,"reason":"accepted"}`. 전송 빈도가 빠르면 `accepted:false`, `reason:"rate_limited"`.
- 프레임은 5MiB/1600만 픽셀 이하, 입력은 10fps 목표. 실행별 최신 1장을 대기시켜 지연 누적을 제한합니다.
- `POST /api/motion/runs/{run_id}/preview-ticket`: 인증된 사용자에게 제한 시간 미리보기 URL을 발급합니다. 미리보기 종료는 촬영 중지를 의미하지 않습니다.

### 6.3 사건·Gemini 분석

| API | 요청 / 제약 | 응답 의미 |
|---|---|---|
| `GET /api/motion/events` | `limit`, `finished_only` | 본인 사건 목록, 분석 상태·결과 포함 |
| `GET /api/motion/events/{event_id}` | 사건 ID | 사건 상세 |
| `GET /api/motion/events/{event_id}/parts` | 사건 ID | 순서별 사진 묶음 |
| `GET /api/motion/parts/{part_id}` | 묶음 UUID | 묶음 및 사진 정보 |
| `GET /api/motion/questions` | 인증 | `questions`, `notify_on_uncertain`, `updated_at` |
| `PUT /api/motion/questions` | 질문 1~5개, 선택적 `notify_on_uncertain` | 저장된 질문 설정 |
| `POST /api/motion/parts/{part_id}/analyses` | 수동 질문 1~5개 | 분석 작업 접수/결과 식별 |
| `GET /api/motion/parts/{part_id}/analyses` | 묶음 UUID | 자동·수동 분석 이력 |
| `GET /api/motion/analyses/{analysis_id}` | 분석 UUID | 모델·질문·상태·결과·오류·지연 시간 |
| `GET /api/motion/events/{event_id}/analysis` | 사건 ID | 사건 전체 분석 및 근거 (`part`/`synthesis`) |

질문 저장 예시:

```json
{"questions":[{"question":"사진에서 사람이 움직이나요?"}],"notify_on_uncertain":false}
```

질문은 각 1~4000자, 전체 4000자 이하이며 문장·ID 중복이 불가합니다. 분석 결과 `items`는 `question_id`, `verdict` (`confirmed`/`not_confirmed`/`uncertain`), `summary`(1~500자)로 구성됩니다. 분석 상태는 `queued`/`running`/`succeeded`/`failed`입니다. `uncertain` 판단은 분석 실패와 다릅니다.

### 6.4 피드백

```json
{"title":"움직임 알림 확인","kind":"false_positive","content":"사람이 없는데 감지되었습니다."}
```

- `POST /api/feedback` → `201` 및 `FeedbackResponse` (`id`, `user_id`, `title`, `kind`, `content`, `status`, `created_at`, `updated_at`, `deleted_at`, `admin_note`).
- `PATCH /api/feedback/{feedback_id}`: `title`, `kind`, `content` 중 최소 한 필드; 빈 객체와 `null` 거절.
- `DELETE /api/feedback/{feedback_id}` → `204`, `deleted_at` 기록. 타인 소유 또는 삭제된 피드백은 404.
- 목록 `GET /api/feedback`: `limit` 기본 20(1~100), `offset` 기본 0, `status`, `kind`, `q`(최대 100자), `feedback_id` 필터. 반환 `{items,total,limit,offset}`.
- `kind`: `false_positive`, `false_negative`, `accurate`, `suggestion`; `status`: `pending`, `in_progress`, `resolved`.

### 6.5 관리자

| API | 요청 필드 / 조건 | 성공 결과 |
|---|---|---|
| `GET /api/admin/users` | `limit` 1~100, `offset` ≥ 0 | `{items,total,limit,offset}`; 각 항목에 `email`, `last_sign_in_at` 포함 |
| `PATCH /api/admin/users/{user_id}` | `display_name` 1~40자, `role` user/admin, `status` active/inactive 중 최소 하나 | 변경된 프로필 |
| `GET /api/admin/feedback` | `limit`, `offset`, `status`, `kind`, `q`, `feedback_id` | 페이지형 전체 피드백 |
| `PATCH /api/admin/feedback/{feedback_id}` | `status` 또는 `admin_note` 최대 1000자 | 변경된 피드백 |
| `DELETE /api/admin/feedback/{feedback_id}` | 피드백 ID | `204`, 논리 삭제 |
| `GET /api/admin/audit-logs` | `limit`, `offset` | `id`, `actor_id`, `action`, `target_type`, `target_id`, `old_data`, `new_data`, `created_at` 목록 |

관리자 카메라·사건·사진·분석 조회는 **읽기 전용**이며, JPEG 원본은 Bearer 인증 후 비공개 응답입니다. 관리자 변경 작업은 감사 로그 기록을 동반합니다. 본인 강등·비활성화 또는 마지막 활성 관리자 제거는 충돌(409)로 거절됩니다.

### 6.6 알림 및 Discord

- `GET /api/notifications?limit=20&offset=0`: `{items,total,limit,offset}`. 항목은 `id`, `event_id`, `camera_id`, `kind`, `verdict`, `message`, `created_at`, `read`.
- `PATCH /api/notifications/{notification_id}/read`: `NotificationResponse`.
- `GET /api/notifications/stream`: `text/event-stream`; `ready`, `notification.created`, `error`, heartbeat 사용. Redis 미연결 시 503이며 DB 목록 조회와는 별도입니다.
- Discord는 `/api/discord/config`, `/start`, `/complete`, `/connection`, `/connection/test`로 연결·알림 설정을 처리하며 외부 OAuth/봇/Redis 설정에 따라 사용 가능 여부가 달라집니다.

### 6.7 HTTP 상태 코드

| 상태 코드 | 의미 / 예 |
|---|---|
| `200` | 일반 조회·수정 성공 (엔드포인트별 응답 모델 우선) |
| `201` | 카메라·피드백 생성 |
| `202` | 프레임 접수 응답 |
| `204` | 삭제 성공, 응답 본문 없음 |
| `401` | 인증 누락·만료·유효하지 않은 토큰 |
| `403` | 일반 사용자의 관리자 접근, 비활성 계정 |
| `404` | 없는 리소스 또는 접근 불가한 소유 리소스 |
| `409` | 실행 순서 오류·사진 업로드 대기·관리자 상태 변경 충돌 등 |
| `422` | 요청 스키마·길이·범위 검증 실패 |
| `503` | 비전·Redis·Discord 등 필수 연동 준비 안 됨 |

상태 코드는 API별 응답 정책에 따라 적용되며, 엔드포인트별 상세 스키마는 FastAPI의 `/docs`에서 제공합니다.
