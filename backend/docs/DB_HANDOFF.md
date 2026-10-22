# Supabase 웹 데이터 연결

현재 적용 계약은 [API_CONTRACT.md](API_CONTRACT.md), 적용 SQL은 [web_supabase.sql](web_supabase.sql)입니다.

- 인증: Supabase Auth.
- 프로필·권한·이용 상태: public.profiles.
- 피드백: public.feedback. 사건 FK 없이 독립적인 문의로 처리.
- 관리자 변경 기록: public.admin_audit_logs.
- 관리자 변경과 이력 저장: 서버 전용 RPC에서 같은 트랜잭션으로 처리.
- 미탐 신고: 기존 kind CHECK에 false_negative 추가, accurate 값 유지.
- 알림: API 유지. 제공된 DB에 notifications가 없어 현재는 503, 후속 테이블 합의 필요.
- SQLite 실행 코드와 레거시 사건 피드백 저장소는 제거. 기존 SQLite 파일은 삭제하거나 자동 이관하지 않음.
- cameras, motion_* 테이블과 비전·Gemini 파일은 변경하지 않음.
- SQL은 준비된 상태이며 원격 DB에 자동 적용하지 않음.

관리자 역할의 기준은 profiles.role입니다. 기존 app_metadata.role만 설정한 계정은 profiles에서도 명시적으로 권한을 부여해야 합니다.
최초 관리자 지정은 신뢰할 수 있는 운영자가 Supabase에서 수행합니다.
