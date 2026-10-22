# 비전 Supabase 연결

비전 데이터는 PostgreSQL의 `motion_*` 테이블 7개(촬영·묶음 분석 기록 5개 + 사건 종합 분석 1개 + 사용자별 질문 1개), JPEG 원본은 private Storage의
`motion-evidence` bucket에 저장합니다. 질문 저장·감지 제어·사진 조회·분석·미리보기 API를 제공합니다.

## 팀 서버에 연결

1. `sh scripts/build.sh`로 의존성 설치와 모델 준비를 실행합니다. DB 접근에는 Supabase Python SDK를 사용합니다.
2. 팀 공용 `public.cameras(id UUID, owner_id UUID, name TEXT)`와 본인 카메라 조회 RLS를 먼저 준비합니다.
3. `repositories/schema.sql`을 해당 Supabase DB에 한 번 적용합니다.
   테이블·컬럼별 설명, 비전 RLS, private bucket 설정이 들어 있습니다.
   설치 후 `repositories/verify.sql`을 실행해 테이블 7개·RLS·읽기/쓰기 권한·버킷·서버 전용 RPC 8개를 확인합니다.
4. 서버 환경에 아래 값을 설정하고 기존 `backend.main:app`을 실행합니다.

```dotenv
AUTH_PROVIDER=supabase
SUPABASE_URL=https://프로젝트.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SECRET_KEY=sb_secret_...
VISION_ENABLED=true
```

프로젝트의 **Settings > API Keys**에서 publishable·secret 키를 복사합니다.
Publishable 키는 사용자 인증·조회에, Secret 키는 서버의 DB·Storage 요청에 사용합니다.
secret 키는 브라우저에 전달하지 않습니다. API 키는 `apikey` 헤더로 보내고,
로그인한 사용자의 access token만 `Authorization: Bearer`에 보냅니다.
기존 `SUPABASE_ANON_KEY`·`SUPABASE_SERVICE_ROLE_KEY` 환경 변수도 호환되지만,
새 변수에 값이 있으면 새 변수를 우선합니다. SQL의 `anon`·`service_role`은
키 종류가 아니라 DB 권한 역할 이름이므로 변경하지 않습니다.

`VISION_ENABLED=true`이면 비전 기능을 실행하며 설치된 테이블·RPC를 검사합니다.
`VISION_ENABLED=false`이면 비전 DB에 요청하지 않고 공용 서버만 실행합니다.
공용 서버의 Supabase URL·Publishable 키·Secret 키는 두 경우 모두 필요합니다.
앱 실행에는 PostgreSQL 연결 주소나 DB 비밀번호가 필요하지 않습니다.
스키마는 서버 기동 때 자동 변경하지 않습니다. 사용할 YOLO 가중치 파일의 경로는
`MOTION_MODEL_PATH`에 지정합니다. 가중치 파일은 저장소에 포함하지 않습니다.

비전은 **같은 Supabase DB의 `public.cameras`**에 등록된 카메라를 참조합니다.
비전 API의 `GET/POST /api/motion/cameras`로 본인 카메라를 조회·등록합니다.
인증은 `backend.common.dependencies.get_user`의 Supabase 검증을 사용합니다.
백엔드 `/api/auth/login`에 기존 Supabase 사용자의 이메일·비밀번호를 보내 로그인합니다. 반환된 access token을 비전 API에도 사용합니다.

공용 연결은 `backend/common/supabase.py`, 사용자 인증·요청별 SDK는
`backend/common/dependencies.py`의 `UserContext`를 사용합니다.
비전 설정은 `backend/vision/config.py`의 `VisionSettings`로 분리합니다.
`VISION_DATA_DIR`이 없으면 기존 `DATA_DIR`을 읽으며, 미리보기 서명 키는
`VISION_PREVIEW_SECRET`을 사용합니다. 기존 `JWT_SECRET`도 호환됩니다.
동시 카메라 한도는 `MOTION_MAX_ACTIVE_RUNS`로 지정하며 기본값은 **4대**입니다.
이는 서버 전체 한도이며, 같은 카메라의 중복 감지는 제한합니다.

## SDK·RPC 접근 범위

일반 조회·저장은 `.table()`을 사용합니다. 묶음·사진 등록, 분석 접수·선점,
종료·재시작 복구와 조건부 시작 상태 변경은 설치 SQL의 RPC 8개로 처리합니다.
재시작 복구 RPC는 서버 시작 시 자동 호출하지 않습니다.
RPC는 `SECURITY INVOKER`이며 `service_role`만 실행할 수 있습니다.
사용자 조회는 Publishable 키와 해당 요청의 사용자 JWT로 RLS를 적용합니다.
FastAPI가 인증·소유권을 확인한 저장 요청과 자동 작업은 서버 Secret 키를 사용합니다.
API는 `AsyncMotionRepository`와 비동기 SDK를 사용합니다. 라우터·서비스·저장소가
`async def`와 `await`로 연결되며, 사진 다운로드도 공용 비동기 풀에서 처리합니다.
SDK는 요청별 헤더를 사용하고 인증 정보가 없는 비동기 HTTP 연결 풀만 공유합니다.
감지·업로드·AI 분석 스레드는 `MotionRepository`와 별도 동기 풀을 사용합니다.
API용 AsyncClient는 서버 이벤트 루프에서 사용하고, 이미지 변환·모델 준비는 스레드에 맡깁니다.

**각 백엔드는 Uvicorn worker 1개로 실행합니다.** 감지 실행은 해당 프로세스가 소유합니다.
파일 잠금은 같은 `DATA_DIR`의 중복 실행만 막습니다. 개발 서버들은 서로 다른
`DATA_DIR`에서 같은 원격 DB를 공유할 수 있으며, 시작 시 다른 서버의 진행 상태를 변경하지 않습니다.
같은 카메라의 중복 실행은 DB에서 제한합니다.
이전 DB 세션 잠금은 HTTP 기반 SDK 연결에서는 사용하지 않습니다.

## 원격 환경 설정

모든 실행 환경은 원격 Supabase만 사용합니다. 로컬 프로필과 로컬 CLI 설정 생성 경로는 제거했습니다.
localhost·사설 IP와 HTTP Supabase 주소를 지정하면 서버 시작 시 오류가 발생합니다.

기본 실행은 `.env`를 읽습니다. 개발 설정을 나누려면 `.env.dev.example`을 `.env.dev`로 복사하고
같은 원격 프로젝트의 `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`를 설정합니다.
실제 키가 있는 `.env`와 `.env.dev`는 Git에서 제외됩니다.

```bash
APP_ENV=dev uv run uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload --no-access-log
```

설정 우선순위는 **실행 환경 변수 → `.env.dev`(dev 모드) → 공통 `.env` → 코드 기본값**입니다.
공통 `.env`의 Gemini 키는 개발 설정에서도 사용할 수 있습니다.
`APP_ENV` 기본값은 `production`이며 이때 `.env`와 실행 환경 변수만 읽습니다.
기존 `local`·`dev-local` 모드는 오류를 반환하며 원격 설정으로 자동 대체하지 않습니다.

백엔드·프런트는 개발 PC에서 실행해도 됩니다. Supabase DB·Auth·Storage만 원격 프로젝트를 사용합니다.
`DATA_DIR`·`VISION_DATA_DIR`에는 업로드 대기 사진 등 서버 임시 파일을 보관합니다.
기존 로컬 DB와 사진은 자동 삭제하거나 원격으로 이관하지 않습니다.
DB 스키마는 서버 시작 때 자동 변경하지 않으며, 원격 프로젝트에 설치 SQL이 적용되어 있어야 합니다.

## 카메라 등록·선택

`GET /api/motion/cameras`는 로그인한 사용자의 카메라를 이름순으로 최대 100개 반환합니다.
`POST /api/motion/cameras`에 `{"name": "거실"}`을 보내면 HTTP 201과
`{"id": "서버에서 생성한 UUID", "name": "거실"}`을 반환합니다.
이름은 공백을 제거한 뒤 1~80자여야 합니다. UUID와 소유자는 서버가 정하므로
요청에 `id`나 `owner_id`를 넣을 수 없습니다. 조회는 사용자 JWT·RLS와 소유자 조건을,
등록은 인증한 사용자 ID와 서버 전용 클라이언트를 사용합니다.

프런트에서는 사용자 토큰 입력 → 내 카메라 선택 또는 이름으로 새 카메라 등록 → 감지 시작 순서로 사용합니다.
등록 UUID는 DB의 카메라 정보를 구분하는 값이며, 실제 카메라 입력은 브라우저 권한으로 연결합니다.
기존 `cameras` 테이블을 사용하며 이 API가 테이블이나 스키마를 생성하지는 않습니다.

## 브라우저 카메라 입력(React·휴대폰)

서버가 웹캠을 여는 방식 대신 브라우저에서 JPEG를 보냅니다. 기존 모션 패키지는 수정하지 않았습니다.

```text
getUserMedia → 원본 해상도 JPEG, 10fps 목표 → 실행별 최신 1장 대기
→ FrameProcessor → 감지 전 3초 / 마지막 움직임 후 3초 사진 묶음
→ 기존 Supabase 저장 → 분석 대기열 → Gemini의 질문별 verdict·summary
```

- `POST /api/motion/runs`에 `camera_id`와 감지 설정을 보냅니다. 서버 웹캠 번호인 `camera`는 제거했습니다.
- `POST /api/motion/runs/{run_id}/frames`에 로그인 Bearer 토큰과 multipart를 보냅니다.
  `file`: JPEG, `sequence_no`: 0부터 증가하는 번호, `timestamp_sec`: 촬영 시작 후 상대 초입니다.
  원본 해상도는 유지하며 프레임당 5 MiB·1,600만 픽셀까지 받습니다. 서버 분석은 기존 가로 최대 960을 유지합니다.
- 응답은 HTTP 202와 `{ "sequence_no": 0, "accepted": true, "reason": "accepted" }`입니다.
  입력이 10fps를 초과하면 `accepted: false, reason: "rate_limited"`로 버립니다. 새 프레임을 계속 보내면 됩니다.
- 같은 실행의 번호·촬영 시간은 증가해야 합니다. 409 응답은 순서 오류·해상도 변경·종료된 실행을 뜻합니다.
  첫 촬영 상대 시간은 0부터 시작하고, 이후 서버 시간 흐름과 5초 이상 어긋난 프레임은 거절합니다.
- 한 요청이 끝난 후 다음 프레임을 전송합니다. 서버가 느리면 실제 처리 fps는 낮아지고, 대기 중인 오래된 프레임은 최신 1장으로 교체합니다.
  전체 원본 영상은 저장하지 않으며, 사진 묶음에 선정된 사진만 기존 방식으로 저장합니다.
- 모델 준비 후 입력이 10초간 없으면 실패로 종료합니다. 첫 처리 프레임부터 촬영 시간을 세어 모델 준비 시간이 워밍업 시간을 소진하지 않게 합니다. 입력 중단·중지 시 마지막 묶음은 확보된 사진만 저장하고 이후 문맥은 불완전으로 표시합니다.
- 카메라별 활성 실행 1개, 서버 프로세스당 동시 카메라는 `MOTION_MAX_ACTIVE_RUNS`(기본 4대)로 제한합니다. 감지기·추적·3초 버퍼는 실행별로 분리합니다.
  Redis 없이 **Uvicorn worker 1개**를 사용합니다. Gemini는 기존 단일 작업자가 순서대로 분석합니다.
- 사용자·카메라 컬럼은 중복 추가하지 않습니다. `motion_runs.camera_id → cameras.owner_id`로 모든 조회·제어·프레임 입력의 권한을 확인합니다.
- 기존 DB에도 수정된 `repositories/schema.sql`을 다시 적용해야 카메라별 활성 실행 인덱스가 반영됩니다. 자동 적용하지 않습니다.

휴대폰도 가능합니다. 개발 PC의 `http://192.168...` 주소는 카메라 보안 조건을 충족하지 않으므로
휴대폰이 접근할 수 있는 HTTPS 주소가 필요합니다. 휴대폰의 로그인 요청도 백엔드 인증 API로 보냅니다. 프론트와 API를 같은 HTTPS 출처로 연결하면 공용 CORS 수정이 필요 없습니다.
카메라 권한을 허용해야 하며 탭 종료·새로고침·화면 잠금·절전·백그라운드 제한으로 입력이 끊길 수 있습니다.
브라우저 입력은 창을 닫아도 유지되는 24시간 촬영을 보장하지 않습니다.

### 다른 기기에서 보기

노트북에서 촬영한 뒤 휴대폰에서 같은 계정으로 로그인하고 **다른 기기 보기**를 선택합니다.
`GET /api/motion/runs?active_only=true`는 본인의 `starting`·`running` 실행을 DB에서 필터한 뒤 제한 건수만 반환합니다.
미리보기는 해당 촬영을 실행 중인 서버에 연결해야 합니다. DB 상태만 남은 실행이나 다른 서버의 실행은 영상 연결이 실패할 수 있습니다.
`POST /api/motion/runs/{run_id}/preview-ticket`에서 받은 `url`(MJPEG)과 `expires_in`으로 시청하고 만료 전에 주소를 갱신합니다.
주소는 해당 사용자·실행에만 유효하며 기본 60초, 최대 로그인 토큰의 남은 시간까지 사용할 수 있습니다.
시청 종료는 미리보기 연결만 닫습니다. 촬영 중지 API를 호출하지 않으며 노트북 촬영과 분석은 계속됩니다.

## 사건 목록

`GET /api/motion/events?limit=20&finished_only=true`는 촬영이 종료(`closed`)되거나
중단(`interrupted`)된 본인 사건만 조회합니다. 종료 필터를 적용한 뒤 최신순으로
`limit`건을 반환하며, 생략 시에는 촬영 중인 사건도 포함합니다.

목록은 `questions`(사건에 고정한 질문 목록), `analysis_status`, `result`를 함께 반환합니다.
`result.items`의 `question_id`를 `questions[].id`와 연결해 항목별 설명을 표시합니다.
묶음 1개는 자동 분석을 재사용하고 여러 묶음은 사건 종합 결과를 사용합니다.
완료 결과가 없으면 `result: null`이며 상태는 `analysis_status`로 구분합니다.
목록 조회는 한 번의 DB 조회로 기존 결과를 읽으며 Gemini를 추가 호출하지 않습니다.

## 사용자별 자동 분석 질문

`motion_analysis_questions(user_id, questions JSONB, updated_at)`에 사용자별 선택 질문을 저장합니다.
`GET /api/motion/questions`는 저장된 목록을 반환합니다. 첫 조회 또는 첫 사건 등록 때
서버 기본 질문과 UUID를 한 번 생성해 저장합니다.

`PUT /api/motion/questions`의 입력 예시는 다음과 같습니다.

```json
{"questions": [{"question": "물건 누가 가져갔는지 확인해줘"}]}
```

새 질문은 `id`를 생략하면 서버가 UUID를 발급합니다. 수정할 때는 기존 본인 질문의 `id`를 보냅니다.
요청 목록에서 빠진 질문은 현재 설정에서 제거됩니다. 질문은 1~5개, 전체 4,000자 이내이며
공백·중복 문장·중복 ID·다른 사용자의 ID는 거부합니다. 사용자 ID는 인증 정보에서 정합니다.

사건을 DB에 처음 등록하는 시점(첫 사진 묶음 등록)에 질문 ID와 실제 문장을 고정합니다.
사진 업로드 중 설정을 수정해도 같은 사건의 모든 자동 분석은 고정된 목록을 사용합니다.
분석 요청과 사건 종합에도 사용한 목록을 보관하므로 질문을 수정·삭제해도 과거 기록은 바뀌지 않습니다.
수동 분석 `POST /api/motion/parts/{part_id}/analyses`도 동일한 `questions` 형식이며 현재 설정을 변경하지 않습니다.

단일 질문 API와 이전 결과 형식은 지원하지 않습니다. 서버는 현재 비전 스키마와 RPC가
준비된 원격 Supabase에 연결하며, 기동 시 스키마를 검사합니다.
개발 저장소의 `main`에는 비전 초기화용 `schema.sql`과
`migrate_motion_questions.sql`이 포함되어 있지 않습니다. 기존 DB를 사용하거나
DB 관리자로부터 해당 버전의 스키마·마이그레이션을 별도로 제공받아야 합니다.
서버 기동은 데이터 초기화나 마이그레이션을 실행하지 않습니다.

## Gemini SDK 분석 설정

분석에는 공식 `google-genai` Python SDK를 사용합니다. 프로젝트 루트의 `.env`에
`GEMINI_API_KEY`를 입력하고 서버를 재시작합니다. `.env`는 Git에서 제외됩니다.

```dotenv
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.1-flash-lite
```

키가 비어 있으면 감지·사진 저장은 동작하고 분석은 queued 상태로 기다립니다.
키를 넣고 재시작하면 기존 대기 묶음부터 처리합니다. 각 분석에 저장된 모델 이름과
질문, 검증한 JPEG를 `generate_content`에 전달하고 JSON 결과를 검증한 뒤 DB에 저장합니다.
SDK의 유료 요청 자동 재시도는 끄며 실패는 기존 분석 이력에 남깁니다.

Gemini는 질문 목록과 실제 문장을 함께 받고 다음 JSON 구조로 답합니다.

```json
{"items": [{"question_id": "41bb91ec-74c6-4871-81c5-7df1b0541bfd", "verdict": "confirmed", "summary": "검은 상의를 입은 사람이 물건을 들고 나갔습니다."}]}
```

- `verdict`: `confirmed`(확인됨), `not_confirmed`(미확인), `uncertain`(판단 어려움).
- `summary`: 질문별 관찰과 판단 이유, 한국어 1~2문장·최대 500자.
- 서버가 JSON Schema·문자열 길이·판단 값을 검증하고 요청한 ID의 누락·중복·추가를 거부합니다.
  응답 순서는 ID로 정렬합니다. JSON 형식 준수가 시각적 판단의 정확성을 보장하지는 않습니다.
- 판단 어려움도 완료된 분석(`succeeded`)입니다. 통신·형식 오류는 `failed`, `result: null`입니다.
- 질문마다 따로 호출하지 않고 사진 묶음별 한 요청에 모두 넣습니다. 자동 재시도하지 않습니다.

## 사건 전체 분석

묶음별 자동 분석은 촬영 중에도 계속 실행합니다. 사건이 끝나고 마지막 순번까지
모든 묶음의 자동 분석이 확정되면 아래 규칙으로 사건 결과를 제공합니다.

- 묶음 1개: 해당 자동 분석 결과를 재사용합니다. 추가 Gemini 호출이나 종합 분석 행을 만들지 않습니다.
- 묶음 2개 이상: 시간순 묶음 정보와 각 자동 분석 결과를 Gemini에 한 번 보내 사건을 종합합니다.
  결과는 `motion_event_analyses`에 별도로 저장하며, 사용한 입력 기록도 고정 사본으로 보존합니다.
- 전체 분석은 **개별 분석 기록의 종합**입니다. 원본 사진 전체를 다시 보내는 방식이 아니므로
  사진 합계 12 MiB 제한과 별개입니다. 개별 분석이 놓친 행동은 종합에서도 놓칠 수 있습니다.
  종합 입력은 UTF-8 기준 512 KiB까지 허용하며 초과하면 일부 구간을 버리지 않고 실패로 기록합니다.
- 묶음 하나라도 실패하면 전체 결과도 실패로 기록하고 종합 Gemini 요청은 보내지 않습니다.
  수동 재분석 결과는 자동 종합의 입력을 대체하지 않습니다.
- 질문 ID·문장·모델이 다른 묶음은 섞어 종합하지 않습니다. 실패 사유를 남깁니다.
- 사건 종료 순번 `motion_events.final_part_index`를 저장해 마지막 묶음이 먼저 등록되어도
  누락된 앞 묶음과 분석 완료를 기다립니다. 사건당 종합 분석은 한 번만 접수하며 자동 재시도하지 않습니다.
- 종료 표시가 없는 중단 사건은 `interrupted`로 반환합니다. 확보한 묶음의 개별 결과는 계속 조회할 수 있습니다.

`GET /api/motion/events/{event_id}/analysis`는 로그인한 소유자의 사건 결과를 반환합니다.

```json
{
  "event_id": "실행ID_e000001",
  "status": "succeeded",
  "basis": "synthesis",
  "analysis_id": "종합분석UUID",
  "questions": [{"id": "41bb91ec-74c6-4871-81c5-7df1b0541bfd", "question": "물건 누가 가져갔는지 확인해줘"}],
  "model_name": "사건에 고정된 모델",
  "result": {"items": [{"question_id": "41bb91ec-74c6-4871-81c5-7df1b0541bfd", "verdict": "confirmed", "summary": "개별 기록을 종합한 사건 흐름과 판단 이유"}]}
}
```

`basis`는 단일 묶음 재사용이면 `part`, 여러 묶음의 종합이면 `synthesis`입니다.
`status`는 `collecting`(촬영 중), `waiting`(업로드·묶음 분석·종합 접수 대기),
`running`, `succeeded`, `failed`, `interrupted` 중 하나입니다.
`not_confirmed`·`uncertain`인 성공과 `result: null`인 실패를 구분해야 합니다.

## 사진 저장과 종료

```text
브라우저 프레임 → 로컬 JPEG + event.json 게시 → DB에 pending 사진 등록
     → private Storage 업로드 → 원본 크기·SHA-256 확인 → ready
     → 묶음 전체 ready 확인 → 자동 분석 queued 등록 → 로컬 묶음 삭제
```

- 사진에 추가한 필드는 `upload_status`, `byte_size`, `sha256` 세 개입니다.
  소유자는 기존 카메라에서 확인하며 비전 테이블에 owner_id를 반복 저장하지 않습니다.
- 업로드는 감지 스레드와 분리됩니다. 장애 때 촬영을 계속하고 파일을 보존합니다.
- 같은 경로에 다른 내용을 덮어쓰지 않습니다. 응답만 유실되면 기존 원본을 대조합니다.
- 서버 시작 때 완성된 `event.json`을 다시 접수합니다. 실패한 업로드는 기존 작업자가
  30초 간격으로 재확인합니다. 별도 테이블·스케줄러·메시지 브로커는 없습니다.
- pending 사진은 다운로드·분석할 수 없습니다. JPEG 다운로드와 Gemini 입력은
  Storage 원본의 크기·해시를 검사합니다. Gemini에는 JPEG 바이트만 전달합니다.
- 정상 종료 시 해당 서버의 감지 실행을 멈추고, 업로드하지 못한 로컬 묶음은 사건을
  `interrupted`로 표시한 뒤 버립니다. 남은 사진 전체를 올리기 위해 종료를 지연하지 않습니다.
  이 서버가 선점한 진행 중 분석만 실패로 기록하고, 이미 보낸 Gemini 요청의 늦은 응답은 반영하지 않습니다.
  완료된 DB 기록·Storage 사진과 다른 서버의 작업은 유지합니다. 강제 종료로 남은 진행 상태는
  재시작 시 자동 정리하지 않으므로 개발 중에는 필요할 때 해당 실행·분석을 직접 정리합니다.
- Storage 저장, DB의 ready 반영, 자동 분석 접수가 모두 성공한 뒤 로컬 JPEG·event.json을 삭제합니다.
  실행 중 업로드 실패는 재시도하며 감지와 유료 AI 호출을 자동 재실행하지 않습니다.

## 빌드 때 모델 준비

프로젝트 루트에서 다음 빌드 명령을 실행합니다. 의존성 설치 후 모델 준비 스크립트를 자동 실행합니다.

```sh
sh scripts/build.sh
```

`.env.dev`를 사용하는 로컬 개발에서는 `APP_ENV=dev sh scripts/build.sh`로 실행합니다.
빌드도 서버와 동일한 환경 설정을 읽습니다. Render에서는 개발용 패키지를 제외하는
`sh scripts/build.sh --no-dev`를 Build Command로 지정합니다.

공식 Ultralytics `v8.3.0`의 YOLO11n을 기본 경로
`data/motion_module/models/yolo11n.pt`에 받고 SHA-256을 검증합니다.
`MOTION_MODEL_PATH`를 지정했다면 빌드와 실행에 같은 환경 설정을 사용하세요.
기존 파일도 검증하며, 잘못된 파일을 덮어쓰거나 서버 실행 중 다운로드하지 않습니다.
다운로드·검증이 실패하면 빌드를 중단합니다.

운영은 인스턴스 1개·Uvicorn worker 1개를 사용합니다. 서버가 다시 뜨면 촬영을 새로 시작합니다.

상시 감지는 브라우저 토큰 만료 후에도 저장해야 하므로 서버 작업자는
DB와 Storage에 서버 전용 Secret 키를 사용합니다. 이 키의 `service_role` 권한은 RLS를 우회합니다.
따라서 FastAPI는 기존 인증 후 **모든 사용자 조회·시작·중지·재분석의 소유권을 검사**합니다.
사용자 JWT로 직접 접근하는 Data API/Storage에도 본인 자료 읽기 RLS를 적용합니다.
서버 Secret 키는 프런트·Git·API 응답·Gemini에 전달하지 않습니다.
수업의 사용자 토큰만 사용하는 업로드 방식과 이 서버 작업자 방식은 이 부분이 다릅니다.
관련 설명은 [Supabase Storage 접근 제어 공식 문서](https://supabase.com/docs/guides/storage/security/access-control)에 있습니다.
