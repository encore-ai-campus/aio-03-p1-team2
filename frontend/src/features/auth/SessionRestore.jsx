import './Login.css'

export default function SessionRestore({ auth }) {
  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="restore-title">
        <div className="login-brand">NoteCam</div>
        <h1 id="restore-title">로그인 확인</h1>
        {auth.restoring ? (
          <p role="status">로그인 상태를 확인하고 있어요…</p>
        ) : (
          <>
            <p className="login-error" role="alert">
              {auth.restoreError}
            </p>
            <button type="button" onClick={auth.retryRestore}>
              다시 시도
            </button>
            <button type="button" className="login-switch" onClick={auth.discardRestore}>
              다시 로그인
            </button>
          </>
        )}
      </section>
    </main>
  )
}
