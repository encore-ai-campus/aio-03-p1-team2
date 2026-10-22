# 웹 API 계약

현재 백엔드는 Supabase Auth와 Supabase PostgreSQL을 사용합니다. SQLite 연결이나 폴백은 없습니다.
카메라·Gemini·비전 구현 파일은 이번 변경 범위에서 제외했습니다.

## 적용 순서

1. 기존 profiles, feedback, admin_audit_logs 테이블이 있는 Supabase 프로젝트에서 [web_supabase.sql](web_supabase.sql)을 검토하고 SQL Editor로 적용합니다.
2. SQL은 false_negative 분류, 프로필 생성 트리거·기존 계정 프로필 보충, 이 세 테이블의 접근 권한, 관리자 전용 RPC 2개를 준비합니다. 카메라·motion 테이블과 Storage는 변경하지 않습니다.
3. .env의 Supabase URL, Publishable 키, Secret 키와 CORS_ORIGINS를 확인하고 서버를 재시작합니다.
4. Supabase에서 최초 관리자 계정의 profiles.role을 admin으로 설정합니다. app_metadata.role은 이제 권한 기준이 아닙니다.
5. /docs에서 테스트합니다. 원격 DB에는 이 파일을 자동 적용하지 않습니다.

SQL의 feedback_kind_check는 공유받은 스키마에서 자동 생성되는 제약 이름을 사용합니다. 실제 DB에서 이름을 바꿨다면 기존 kind CHECK 이름도 확인하세요.
기존 SQLite 데이터의 자동 이관·삭제는 수행하지 않습니다.

## 인증과 프로필

| 메서드 | 경로 | 요청 / 응답 |
| --- | --- | --- |
| POST | /api/auth/register | email, password(10~128자) → user_id, email_confirmation_required |
| POST | /api/auth/login | email, password → access_token, refresh_token, expires_in, token_type |
| GET | /api/auth/me | 기존 호환 응답 id, role |
| GET | /api/users/me | id, display_name, email, role, status, created_at, updated_at |
| PATCH | /api/users/me | display_name(공백 제외 1~40자) → 변경된 프로필 |

보호 API에는 Authorization: Bearer <access_token>을 보냅니다.
Supabase Auth로 토큰을 검증한 다음 profiles.role과 profiles.status를 서버에서 조회합니다.
inactive 계정은 기존 토큰이 남아 있어도 새로운 보호 API 요청에서 403입니다.
로그인 API 자체의 Supabase 토큰 발급과 계정 비활성화는 별개이며, 위 검사는 보호 API에서 적용됩니다.
프로필이 없는 기존 계정은 첫 보호 API 요청에서 기본 user/active 프로필을 생성합니다. 기존 행은 덮어쓰지 않습니다.
회원가입 시 프로필 생성은 SQL 트리거가 담당합니다.

이메일 인증 여부는 Supabase Confirm email 설정을 따릅니다.
토큰 갱신·로그아웃·비밀번호 변경 전용 백엔드 API는 이번 범위에 추가하지 않았습니다.
API가 아닌 Supabase Data API에 직접 연결하는 프런트 코드는 아래 접근 정책을 확인해야 합니다.

## 사용자 피드백

| 메서드 | 경로 | 처리 |
| --- | --- | --- |
| POST | /api/feedback | title, kind, content로 작성, 201 |
| GET | /api/feedback | 본인 목록 |
| GET | /api/feedback/{id} | 본인 상세 |
| PATCH | /api/feedback/{id} | title, kind, content 중 변경할 필드 |
| DELETE | /api/feedback/{id} | deleted_at을 설정하는 논리 삭제, 204 |

title은 1~100자, content는 1~1000자이며 공백만 입력할 수 없습니다.
id는 DB의 bigint에 맞춘 정수입니다. 프런트에서 임의 UUID를 생성하지 않습니다.
user_id는 서버가 결정합니다. 요청에 user_id, status, admin_note 등을 보내면 422입니다.
PATCH는 빈 객체와 null을 거부합니다.
삭제됐거나 다른 사용자의 피드백은 404입니다. 사용자는 처리 완료된 피드백도 수정할 수 있으며 처리 상태는 자동 초기화하지 않습니다.

| 프런트 표시 | DB/API kind |
| --- | --- |
| 오탐지 신고 | false_positive |
| 미탐 신고 | false_negative |
| 개선 의견 | suggestion |
| 정확한 감지 평가(기존 값 유지) | accurate |

| 프런트 표시 | DB/API status |
| --- | --- |
| 처리 대기 | pending |
| 확인 중 | in_progress |
| 처리 완료 | resolved |

목록 공통 응답은 {items, total, limit, offset}입니다. limit 기본 20(1~100), offset 기본 0입니다.
피드백 목록에는 status, kind 필터를 사용할 수 있습니다.
날짜는 created_at ISO 문자열을 프런트에서 한국어로 표시합니다.
기존 /api/events/{event_id}/feedback은 제거했습니다. 새 DB에는 피드백과 사건 사이의 FK가 없습니다.
admin_note는 작성자에게도 표시되는 처리 답변으로 취급합니다. 내부 비공개 메모가 필요하면 별도 필드를 설계해야 합니다.

## 관리자

| 메서드 | 경로 | 처리 |
| --- | --- | --- |
| GET | /api/admin/users | 사용자 프로필과 auth.users의 email, last_sign_in_at |
| PATCH | /api/admin/users/{uuid} | display_name, role(user/admin), status(active/inactive) |
| GET | /api/admin/feedback | 삭제되지 않은 전체 피드백, status/kind 필터 |
| PATCH | /api/admin/feedback/{id} | status, admin_note 변경 |
| DELETE | /api/admin/feedback/{id} | 논리 삭제, 204 |
| GET | /api/admin/audit-logs | 관리자 변경 이력 |

세 목록 API는 limit, offset과 공통 페이지 응답을 사용합니다.
profiles.role=admin AND status=active인 사용자만 접근합니다.
admin_note: null은 기존 메모 삭제를 뜻합니다.
관리자의 사용자 수정·피드백 처리·피드백 삭제는 web_admin_change RPC에서 감사 로그와 같은 트랜잭션으로 저장합니다.
RPC는 서버 전용 키로만 실행할 수 있고 내부에서도 관리자의 현재 역할과 상태를 확인합니다.
관리자 동시 변경은 직렬화하며 본인 강등·비활성화와 마지막 활성 관리자 제거는 409로 거절합니다.

프런트 계정 추가 폼에는 비밀번호 입력이 없습니다. 관리자 초대 이메일/초기 비밀번호 정책이 정해지지 않아 계정 생성 API는 추가하지 않았습니다.
계정의 물리 삭제와 이메일 변경도 미구현입니다. 일반 사용자의 이용 차단에는 PATCH의 status=inactive를 사용합니다.
auth.users 삭제는 카메라·비전 기록 등 FK와 보존 정책을 먼저 합의해야 합니다.
last_sign_in_at은 마지막 로그인 시각이며 실시간 온라인 여부가 아닙니다.

## 관리자 비전 조회

아래 GET API는 활성 관리자만 사용할 수 있습니다. 인증 누락은 401, 일반 사용자는 403,
비전 비활성 상태에서는 503을 반환합니다. 일반 비전 API의 본인 소유권 검사는 유지합니다.
관리자 조회는 서버 전용 SDK로 처리하며 DB 스키마나 RLS 변경이 필요하지 않습니다.

| 경로 | 처리 |
| --- | --- |
| /api/admin/cameras | 전체 카메라. user_id(UUID) 필터, limit(기본 20, 최대 100), offset 지원 |
| /api/admin/cameras/{camera_id}/events | 카메라 사건·분석 요약. limit, finished_only 지원 |
| /api/admin/events/{event_id} | 사건 상세 |
| /api/admin/events/{event_id}/parts | 사진 묶음 목록. after(묶음 순번), limit 지원 |
| /api/admin/parts/{part_id} | 묶음 상세·사진 목록. content_url은 관리자 사진 경로 |
| /api/admin/photos/{photo_id}/content | JPEG 원본. Bearer 인증 필요, private/no-store |
| /api/admin/parts/{part_id}/analyses | 자동·수동 Gemini 분석 이력. limit 지원 |
| /api/admin/analyses/{analysis_id} | 질문·모델·분석 상태·결과·오류 상세 |
| /api/admin/events/{event_id}/analysis | 사건 전체 분석 결과 |

목록은 배열을 반환합니다. 존재하지 않는 카메라·사건·묶음·사진·분석은 404입니다.
사진 업로드가 pending이면 원본 조회는 409입니다. 분석 조회는 저장된 기록만 읽으며
Gemini 호출이나 유료 재분석을 실행하지 않습니다. API 키는 응답에 포함하지 않습니다.

Swagger의 '관리자 비전'에서 관리자 로그인 토큰으로 카메라 → 사건 → 묶음 → 사진/분석
순서로 조회합니다. 프론트 호출 예시는 frontend_api.js의 adminCameras 등이며,
adminPhoto는 인증 헤더를 포함해 JPEG를 Blob으로 반환합니다.

## 알림 유지

GET /api/notifications, PATCH /api/notifications/{id}/read, GET /api/notifications/stream은 유지했습니다.
SQLite 대신 Supabase notifications 테이블을 조회합니다. 현재 제공받은 스키마에는 이 테이블이 없어 503을 반환합니다.
빈 목록으로 성공 처리하지 않으며, SSE도 테이블 확인 실패 시 스트림 시작 전에 503을 반환합니다.
기대 컬럼은 id(증가 정수), owner_id(UUID), event_id, camera_id, kind(motion), message, created_at, read(boolean)입니다.
알림 생성·RLS·실제 테이블 계약은 담당자와 합의 후 별도로 적용해야 합니다. 이번 SQL에는 알림 테이블을 추가하지 않았습니다.

## 접근 권한과 프런트 연결 상태

웹 프로필·피드백·관리자 API는 서버 Secret SDK를 사용하며 서버가 사용자 ID·권한·소유권을 검사합니다.
제공 SQL은 이 세 테이블에 대해 브라우저 직접 변경 권한을 제거합니다. authenticated의 직접 읽기는 본인 프로필·삭제되지 않은 본인 피드백만 허용합니다.
비전의 요청별 JWT 클라이언트와 접근 방식은 유지합니다.

확인한 프런트: C:/Notecam_Project/aio-03-p1-team2-Front/frontend.
현재 ProfilePage, FeedbackPage, AccountsPage는 localStorage 기반 미리보기이며 로그인 화면과 실제 API 호출이 연결돼 있지 않습니다.
[frontend_api.js](frontend_api.js)는 기존 화면 필드(name, kind, status, date, user, lastSeen)와 API의 변환 예제입니다.
프런트 원본은 이번 작업에서 수정하지 않았습니다. 역할 미리보기 버튼은 실제 관리자 권한으로 사용할 수 없으며, /api/auth/me 결과로 화면 권한을 결정해야 합니다.
이메일 변경, 관리자 계정 추가·물리 삭제 버튼은 해당 정책/API가 준비되기 전에는 활성화하지 마세요.

## 검증 범위

HTTP MockTransport로 실제 Supabase SDK의 Auth/PostgREST 요청, 소유권 필터, 권한 거부, RPC 인자와 오류 처리, 실제 로컬 HTTP SSE를 검증합니다.
테스트는 실제 Supabase 계정을 만들거나 원격 DB에 쓰지 않습니다.
SQL 함수의 실제 PostgreSQL 실행과 실제 프런트 화면 연결은 별도 통합 검증이 필요합니다.
