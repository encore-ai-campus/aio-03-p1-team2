// 개발 전용 fixture. 외부 API 호출과 실제 DM 발송을 하지 않습니다.
import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import DiscordLoginButton from './DiscordLoginButton.jsx'
import DiscordSettings from './DiscordSettings.jsx'
import '../../shared/styles/global.css'
import '../../app/AppLayout.css'

function Preview() {
  const [variant, setVariant] = useState('connected')
  const api = useMemo(() => {
    let data = {
      linked: variant !== 'unlinked',
      discord_name: '연결된 테스트 계정',
      notifications_enabled: false,
      dm_verified: false,
      can_unlink: variant !== 'only-login',
      auth_ready: true,
      bot_ready: true,
      last_error: null,
    }
    return {
      config: async () => ({ auth_ready: true }),
      connection: async () => {
        if (variant === 'error')
          throw new Error('연결 정보를 조회하지 못했습니다. 다시 시도해 주세요.')
        return data
      },
      test: async () => {
        if (variant === 'blocked')
          throw new Error('봇과 DM 가능한 연결 및 Discord의 DM 허용 설정을 확인하세요.')
        return (data = { ...data, dm_verified: true })
      },
      preference: async (enabled) => (data = { ...data, notifications_enabled: enabled }),
      unlink: async () => {
        data = { ...data, linked: false, notifications_enabled: false }
      },
      start: async () => {
        throw new Error('컴포넌트 검증 화면에서는 외부 로그인으로 이동하지 않습니다.')
      },
    }
  }, [variant])
  return (
    <main className="dashboard" style={{ minHeight: '100vh', padding: 20 }}>
      <div style={{ maxWidth: 680, margin: '0 auto', display: 'grid', gap: 20 }}>
        <header>
          <strong>NoteCam · 컴포넌트 검증</strong>
          <h1 style={{ fontSize: 24 }}>Discord 연결과 알림</h1>
        </header>
        <label>
          검증 상태{' '}
          <select value={variant} onChange={(event) => setVariant(event.target.value)}>
            <option value="connected">연결됨</option>
            <option value="unlinked">미연결</option>
            <option value="only-login">유일한 로그인 수단</option>
            <option value="blocked">DM 차단</option>
            <option value="error">조회 실패</option>
          </select>
        </label>
        <DiscordSettings api={api} />
        <section
          style={{ padding: 24, background: '#fff', border: '1px solid #dce5df', borderRadius: 12 }}
        >
          <h2 style={{ marginTop: 0, fontSize: 20 }}>로그인 버튼</h2>
          <DiscordLoginButton api={api} />
        </section>
      </div>
    </main>
  )
}
createRoot(document.getElementById('root')).render(<Preview />)
