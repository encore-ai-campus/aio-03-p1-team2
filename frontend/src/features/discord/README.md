# Discord 로그인·프로필 연결

로그인 화면의 이메일 로그인 아래에 Discord 버튼을, 프로필 화면의 아바타 아래에 계정 연결·DM 수신 설정을 배치합니다.
새 의존성을 추가하지 않으며 HTTP는 기존 `shared/api/client.js`를 재사용합니다.

## App 연결

- `createDiscordApi(baseUrl, accessToken)` 인스턴스를 `useMemo`로 유지합니다. 로그인 전에는 빈 토큰을 사용합니다.
- `DiscordLoginButton`이 `api.config()`를 확인합니다. 준비 전에도 버튼을 표시하며 비활성화하고 안내합니다. `onBusyChange`로 이메일 로그인과 중복 실행을 막습니다.
- App이 `AuthPage.socialLogin`, `ProfilePage.connections` 슬롯에 Discord 컴포넌트를 전달합니다. auth/profile은 Discord feature를 직접 import하지 않습니다.
- App 최상단에서 기존 세션 복원 후 `/auth/discord/callback`의 `DiscordCallback`을 렌더합니다.
- `onComplete(result)`는 `useAuth.acceptSession`으로 기존 `/api/auth/me` 사용자 ID·권한·만료 검증과 세션 저장을 거칩니다. 계정 연결 후에는 프로필 화면으로 돌아옵니다.
- OAuth를 취소한 경우 기존 로그인은 유지하고 `onBack`에서 로그인/프로필로 돌아갑니다.
- DM의 `/?event=...`는 `readDiscordEventLink(location.href)`로 읽고, 로그인 전이면 보관했다가 로그인 후 기존 `EventDetailDialog`를 엽니다. API의 소유권 검사는 그대로 둡니다.

인증 진행 정보는 같은 탭의 sessionStorage에 보관합니다. 다른 탭·만료·저장소 차단 시 임의로 코드를 교환하지 않습니다.
code는 URL에서 지우며, 봇 토큰·OAuth Client Secret은 프론트 설정에 포함하지 않습니다.

## 검증

`frontend/`에서:

```sh
node --test src/features/discord/discord.test.mjs
npm run check:app
npm run build
```

기존 package.json의 scripts는 수정하지 않았으므로 신규 테스트는 위 명령으로 별도 실행합니다.
현재 Windows에서는 `discord.test.mjs`의 URL 경로 변환 문제로 실행이 실패할 수 있습니다. 테스트 코드의 별도 수정이 필요하며 실제 로그인 기능 오류를 뜻하지는 않습니다.
`preview.html`/`preview.jsx`는 가짜 API를 쓰는 컴포넌트 검증 화면입니다. 실제 로그인·DM 발송을 하지 않습니다.
Vite 개발 서버에서 `/src/features/discord/preview.html`로 열면 미연결/연결됨/DM 차단/조회 실패/유일한 로그인 수단 상태를 확인할 수 있습니다.
실제 App 빌드에는 import되지 않습니다.
