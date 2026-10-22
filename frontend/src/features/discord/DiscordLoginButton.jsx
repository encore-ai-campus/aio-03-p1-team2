import { useEffect, useRef, useState } from 'react'
import { useNavigationLock } from '../../shared/hooks/useNavigationLock.js'
import './discord.css'

export default function DiscordLoginButton({
  api,
  intent = 'login',
  disabled = false,
  onBusyChange,
}) {
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(null)
  const [error, setError] = useState('')
  const active = useRef(null)
  useNavigationLock(busy, onBusyChange)

  useEffect(() => {
    const context = { controller: new AbortController(), pending: false }
    active.current = context
    setBusy(false)
    setError('')
    setReady(intent === 'link' ? true : null)
    if (intent === 'login') {
      api
        .config(context.controller.signal)
        .then((value) => {
          if (!context.controller.signal.aborted) setReady(value.auth_ready)
        })
        .catch((cause) => {
          if (!context.controller.signal.aborted)
            setError(cause.message || 'Discord 설정을 확인하지 못했습니다.')
        })
    }
    return () => context.controller.abort()
  }, [api, intent])

  async function start() {
    const context = active.current
    if (disabled || !ready || !context || context.pending || context.controller.signal.aborted)
      return
    context.pending = true
    setBusy(true)
    setError('')
    try {
      await api.start(intent, context.controller.signal)
    } catch (cause) {
      if (!context.controller.signal.aborted)
        setError(cause.message || 'Discord 인증을 시작하지 못했습니다.')
    } finally {
      context.pending = false
      if (!context.controller.signal.aborted) setBusy(false)
    }
  }

  return (
    <div className="discord-login">
      <button
        type="button"
        className="discord-login-button"
        disabled={disabled || busy || !ready}
        onClick={start}
      >
        {busy ? 'Discord로 이동 중…' : intent === 'link' ? 'Discord 연결' : 'Discord로 로그인'}
      </button>
      {intent === 'login' && !ready && !error && (
        <p className="discord-caption">
          {ready === null
            ? 'Discord 로그인을 확인하고 있습니다.'
            : 'Discord 로그인은 준비 중입니다.'}
        </p>
      )}
      {error && (
        <p className="discord-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
