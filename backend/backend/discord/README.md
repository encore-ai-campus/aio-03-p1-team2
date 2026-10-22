# Discord 로그인·알림

`backend/main.py`에 API와 lifespan을 연결했습니다. 로그인·자동 발송은 환경 변수로 활성화하며 기본값은 false입니다.
원격 SQL 적용·프로바이더 설정·봇 설치가 필요합니다. 코드 통합만으로 실제 DM을 발송하거나 배포하지 않습니다.

## 계약

| 메서드 | 경로 | 인증/내용 |
|---|---|---|
| GET | `/api/discord/config` | 공개, `auth_ready`만 반환 |
| POST | `/api/discord/start` | `{intent: "login" 또는 "link"}`. link는 기존 Bearer 토큰 필수 |
| POST | `/api/discord/complete` | `{flow_id, code}`. link는 시작한 사용자의 Bearer 토큰 필수 |
| GET | `/api/discord/connection` | 본인 연결 상태·설정 |
| PATCH | `/api/discord/connection` | `{notifications_enabled: bool}`. 테스트 DM 성공 후에만 활성화 |
| POST | `/api/discord/connection/test` | 본인의 연결된 Discord에 테스트 DM, 사용자당 30초 제한 |
| DELETE | `/api/discord/connection` | 다른 로그인 identity가 있을 때만 해제 |

OAuth complete 결과는 `{intent,user_id,tokens:{access_token,refresh_token,expires_in,token_type}}`입니다.
App 통합 시 기존 `/api/auth/me` 검증과 세션 저장 과정을 거쳐 로그인 상태에 반영합니다.
공유 `AsyncClient`에 사용자 세션/헤더를 저장하지 않습니다.
Supabase의 검증된 `identities[].id`만 Discord ID로 사용하며 수정 가능한 `user_metadata`를 신원으로 쓰지 않습니다.

## 환경·Supabase 설정 (통합 단계)

1. `docs/discord.sql`을 원격 SQL Editor에 적용합니다. 기존 알림 RPC는 그대로 두고 전용 연결/발송 테이블과 INSERT 트리거를 추가합니다.
2. Discord 애플리케이션의 OAuth redirect는 **Supabase의 `/auth/v1/callback`** 주소로 등록합니다.
3. Supabase Discord provider에 Client ID/Client Secret을 설정하고 Enable Manual Linking을 켭니다.
4. Supabase redirect allow list에 `DISCORD_APP_URL/auth/discord/callback`을 등록합니다.
5. 이 폴더의 `.env.example` 항목을 환경 파일에 추가합니다. OAuth/발송은 기본 false입니다.
6. 프론트와 백엔드를 같은 환경으로 실행합니다. 로컬 개발에서는 `DISCORD_APP_URL`과 CORS 허용 주소를 실행 중인 프론트 origin에 맞춥니다.

Discord 로그인 설정은 Supabase가 관리하므로 OAuth Client Secret을 프론트에 전달하지 않습니다.
봇 토큰은 서버 환경 변수에만 둡니다. DM을 위해 Message Content Intent나 Gateway 연결은 필요하지 않습니다.
로그인만으로 DM이 허용되는 것은 아닙니다. 봇과 DM 가능한 관계/설치를 준비하고 사용자가 테스트 DM 버튼으로 확인합니다.

## 발송 동작과 한계

- 수신 설정 이후 생성된 기존 `notifications`만 트리거가 발송 건으로 등록합니다. 과거 알림은 채우지 않습니다.
- 설정을 껐다 켜도 예전 알림을 보내지 않으며, 발송 직전에 현재 연결·수신 설정·active 프로필·Auth identity를 확인합니다.
- Redis의 `notecam:notifications:*` 신호로 깨우고, 신호 누락/연결 실패 시에도 10초 간격으로 DB를 확인합니다.
- DB `FOR UPDATE SKIP LOCKED`와 claim token으로 여러 발송 프로세스의 선점/완료 경합을 제어합니다.
- 강제 종료된 작업은 2분 lease 만료 후 회수하고, 일시적 오류/429는 최대 5번 시도합니다. 마지막 시도의 프로세스가 죽은 경우도 failed로 종료합니다.
- 403은 수신 설정을 끄고 오류를 표시합니다. 기존 사건/분석/앱 내 알림에는 영향을 주지 않습니다.
- `notification_id`를 Discord nonce로 보내 단기 중복을 막습니다. API 수신 후 DB 기록 전에 서버가 죽는 경우 등, Discord nonce 보관 시간을 넘는 장애에서 정확히 한 번 발송까지 보장하지는 않습니다.
- 끄기/해제 전에 이미 Discord로 전송 중인 요청은 회수할 수 없습니다.
- DM 링크는 `/?event=<event_id>`입니다. App에서 로그인 완료 후 기존 사건 상세 창을 열며 사건 API 소유권 검사를 유지합니다.

## 실행 가능한 검증

저장소 루트에서:

```sh
.venv/bin/python -m pytest -q backend/discord/tests/test_discord.py
PGLITE_MODULE=/tmp/notecam-notification-sql-test/node_modules/@electric-sql/pglite/dist/index.js \
  node backend/discord/tests/check_sql.mjs
```

SQL 검증은 PGlite의 일회성 DB만 사용합니다. 의존성이 없다면 `/tmp` 아래 별도 폴더에 `@electric-sql/pglite`를 설치하고 그 `dist/index.js` 경로를 지정합니다.
HTTP 테스트는 실제 auth/token/DM 요청을 모두 가짜 transport로 대체합니다.

공식 참고: [Discord provider](https://supabase.com/docs/guides/auth/social-login/auth-discord),
[계정 연결](https://supabase.com/docs/guides/auth/auth-identity-linking),
[메시지 API](https://docs.discord.com/developers/resources/message#create-message).
