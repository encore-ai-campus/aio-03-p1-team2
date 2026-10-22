import { useEffect, useRef, useState } from 'react'
import './discord.css'

export default function DiscordCallback({ api, onComplete, onBack }) {
  const [error, setError] = useState('')
  const started = useRef(null)
  const delivered = useRef(false)

  useEffect(() => {
    let cancelled = false
    started.current ??= Promise.resolve().then(() => api.complete())
    started.current
      .then(async (result) => {
        if (cancelled || delivered.current) return
        delivered.current = true
        await onComplete(result)
      })
      .catch((cause) => {
        if (!cancelled) setError(cause.message || 'Discord 인증을 완료하지 못했습니다.')
      })
    return () => {
      cancelled = true
    }
  }, [api, onComplete])

  return (
    <section className="discord-callback" aria-labelledby="discord-callback-title">
      <h1 id="discord-callback-title">Discord 계정 확인</h1>
      {error ? (
        <>
          <p className="discord-error" role="alert">
            {error}
          </p>
          <button type="button" className="discord-action" onClick={onBack}>
            돌아가기
          </button>
        </>
      ) : (
        <p role="status">계정을 확인하고 있습니다. 잠시 기다려 주세요.</p>
      )}
    </section>
  )
}
