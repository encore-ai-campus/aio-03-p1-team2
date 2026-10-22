import { useState } from 'react'
import AuthForm from './AuthForm.jsx'
import './Login.css'

export default function AuthPage({ auth, onHome, socialLogin }) {
  const { mode, busy, switchMode } = auth
  const [socialBusy, setSocialBusy] = useState(false)
  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <button
          type="button"
          className="login-brand"
          aria-label="NoteCam 홈으로 이동"
          onClick={onHome}
          disabled={busy || socialBusy}
        >
          NoteCam
        </button>

        <h1 id="login-title">{mode === 'login' ? '로그인' : '회원가입'}</h1>
        <p className="login-description">
          {mode === 'login'
            ? '계정으로 로그인하고 알림과 피드백을 확인하세요.'
            : 'NoteCam에서 사용할 계정을 만들어 주세요.'}
        </p>

        <AuthForm auth={auth} disabled={socialBusy} />
        {mode === 'login' && socialLogin && (
          <div className="login-social">
            <p className="login-divider">또는</p>
            {socialLogin({ disabled: busy, onBusyChange: setSocialBusy })}
          </div>
        )}
        <button
          type="button"
          className="login-switch"
          onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
          disabled={busy || socialBusy}
        >
          {mode === 'login' ? '회원가입' : '로그인으로 돌아가기'}
        </button>

        <p className="login-notice">관리자 계정은 로그인 후 관리 화면으로 이동합니다.</p>
      </section>
    </main>
  )
}
