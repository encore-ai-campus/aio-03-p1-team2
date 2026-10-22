export default function AuthForm({ auth, disabled = false }) {
  const {
    mode,
    busy,
    email,
    setEmail,
    password,
    setPassword,
    passwordConfirm,
    setPasswordConfirm,
    error,
    notice,
    handleLogin,
    handleRegister,
  } = auth
  return (
    <form
      onSubmit={(event) => {
        if (disabled) event.preventDefault()
        else (mode === 'login' ? handleLogin : handleRegister)(event)
      }}
      aria-busy={busy || disabled}
    >
      <label htmlFor="login-email">이메일</label>
      <input
        id="login-email"
        type="email"
        autoComplete="username"
        placeholder="이메일을 입력하세요"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        disabled={busy || disabled}
        required
      />

      <label htmlFor="login-password">비밀번호</label>
      <input
        id="login-password"
        type="password"
        autoComplete="current-password"
        placeholder="비밀번호를 입력하세요"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        disabled={busy || disabled}
        required
      />

      {mode === 'register' && (
        <>
          <label htmlFor="login-password-confirm">비밀번호 확인</label>
          <input
            id="login-password-confirm"
            type="password"
            autoComplete="new-password"
            placeholder="비밀번호를 다시 입력하세요"
            value={passwordConfirm}
            onChange={(event) => setPasswordConfirm(event.target.value)}
            disabled={busy || disabled}
            required
          />
        </>
      )}

      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}

      {notice && (
        <p className="login-notice success" role="status">
          {notice}
        </p>
      )}

      <button type="submit" disabled={busy || disabled}>
        {busy
          ? mode === 'login'
            ? '로그인 중…'
            : '가입 중…'
          : mode === 'login'
            ? '로그인'
            : '회원가입'}
      </button>
    </form>
  )
}
