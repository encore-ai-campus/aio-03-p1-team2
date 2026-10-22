import { useEffect, useRef, useState } from 'react'
import DiscordLoginButton from './DiscordLoginButton.jsx'
import './discord.css'

export default function DiscordSettings({ api, onUnauthorized }) {
  const [connection, setConnection] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [revision, setRevision] = useState(0)
  const active = useRef(null)

  useEffect(() => {
    const context = { controller: new AbortController(), pending: false }
    active.current = context
    setConnection(null)
    setLoading(true)
    setBusy(false)
    setError('')
    setMessage('')
    api
      .connection(context.controller.signal)
      .then((value) => {
        if (!context.controller.signal.aborted) setConnection(value)
      })
      .catch((cause) => {
        if (!context.controller.signal.aborted) {
          if (cause.status === 401 || cause.status === 403) onUnauthorized?.()
          else setError(cause.message)
        }
      })
      .finally(() => {
        if (!context.controller.signal.aborted) setLoading(false)
      })
    return () => context.controller.abort()
  }, [api, revision, onUnauthorized])

  async function run(action, success) {
    const context = active.current
    if (!context || context.pending || context.controller.signal.aborted) return
    context.pending = true
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const value = await action(context.controller.signal)
      if (!context.controller.signal.aborted) {
        setConnection(value)
        setMessage(success)
      }
    } catch (cause) {
      if (!context.controller.signal.aborted) {
        if (cause.status === 401 || cause.status === 403) onUnauthorized?.()
        else setError(cause.message || 'Discord 설정을 변경하지 못했습니다.')
      }
    } finally {
      context.pending = false
      if (!context.controller.signal.aborted) setBusy(false)
    }
  }

  return (
    <section
      className="discord-settings"
      aria-labelledby="discord-settings-title"
      aria-busy={loading || busy}
    >
      <div className="discord-settings-heading">
        <h2 id="discord-settings-title">Discord 알림</h2>
        <p>선택한 사건 알림을 NoteCam 봇의 개인 DM으로 받아보세요.</p>
      </div>
      {connection && (
        <details className="discord-setup" open={!connection.notifications_enabled}>
          <summary>Discord 알림 연결 방법</summary>
          <ol>
            <li>
              {connection.linked
                ? 'Discord 계정 연결이 완료됐습니다.'
                : '아래 ‘Discord 연결’을 눌러 계정을 연결하세요.'}
            </li>
            <li>
              <a
                href="https://discord.com/oauth2/authorize?client_id=1561992883345817622&scope=bot&permissions=0&integration_type=0"
                target="_blank"
                rel="noopener noreferrer"
              >
                NoteCam 봇 추가
              </a>
              를 눌러 관리할 수 있는 Discord 서버에 추가하세요.
            </li>
            <li>
              Discord 사용자 설정 → 콘텐츠 및 소셜에서 해당 서버의 다이렉트 메시지를 허용하세요.{' '}
              <a
                href="https://support.discord.com/hc/en-us/articles/217916488-Blocking-Privacy-Settings"
                target="_blank"
                rel="noopener noreferrer"
              >
                DM 설정 안내
              </a>
            </li>
            <li>
              아래 ‘테스트 DM 보내기’를 눌러 Discord 개인 메시지에서 수신을 확인한 뒤, ‘Discord 알림
              받기’를 켜세요.
            </li>
          </ol>
          <p>
            알림을 켠 뒤 생성된 새 알림부터 받습니다. 봇이 오프라인으로 표시돼도 DM을 받을 수
            있습니다.
          </p>
        </details>
      )}
      {loading && <p role="status">Discord 연결을 확인하고 있습니다.</p>}
      {error && (
        <p className="discord-error" role="alert">
          {error}
        </p>
      )}
      {!loading && !connection && (
        <button type="button" className="discord-action" onClick={() => setRevision((n) => n + 1)}>
          다시 조회
        </button>
      )}
      {connection &&
        (!connection.linked ? (
          <>
            <p>연결된 Discord 계정이 없습니다.</p>
            <DiscordLoginButton api={api} intent="link" disabled={!connection.auth_ready} />
            {!connection.auth_ready && (
              <p className="discord-caption">Discord 로그인이 아직 설정되지 않았습니다.</p>
            )}
          </>
        ) : (
          <>
            <dl className="discord-account">
              <dt>연결된 계정</dt>
              <dd>{connection.discord_name}</dd>
            </dl>
            <label className="discord-preference">
              <input
                type="checkbox"
                checked={connection.notifications_enabled}
                disabled={
                  busy ||
                  (!connection.notifications_enabled &&
                    (!connection.dm_verified || !connection.bot_ready))
                }
                onChange={(event) => {
                  const enabled = event.target.checked
                  void run(
                    (signal) => api.preference(enabled, signal),
                    enabled ? '새 사건의 Discord 알림을 켰습니다.' : 'Discord 알림을 껐습니다.',
                  )
                }}
              />
              <span>Discord 알림 받기</span>
            </label>
            <p className="discord-caption">
              질문 설정의 ‘확인됨만’ 또는 ‘확인됨 + 판단 어려움’ 조건을 따릅니다.
            </p>
            {!connection.dm_verified && (
              <p className="discord-caption">
                테스트 DM을 보낸 뒤 수신 여부를 확인하고 알림을 켜 주세요.
              </p>
            )}
            {!connection.bot_ready && (
              <p className="discord-caption">알림 봇 설정이 아직 준비되지 않았습니다.</p>
            )}
            {connection.last_error && <p className="discord-error">{connection.last_error}</p>}
            <div className="discord-actions">
              <button
                type="button"
                className="discord-action"
                disabled={busy || !connection.bot_ready}
                onClick={() =>
                  void run(
                    (signal) => api.test(signal),
                    '테스트 DM을 보냈습니다. Discord에서 수신 여부를 확인해 주세요.',
                  )
                }
              >
                테스트 DM 보내기
              </button>
              {connection.can_unlink && (
                <button
                  type="button"
                  className="discord-action discord-disconnect"
                  disabled={busy}
                  onClick={() =>
                    void run(async (signal) => {
                      await api.unlink(signal)
                      return api.connection(signal)
                    }, 'Discord 연결을 해제했습니다.')
                  }
                >
                  연결 해제
                </button>
              )}
            </div>
            {!connection.can_unlink && (
              <p className="discord-caption">
                Discord가 유일한 로그인 수단이면 연결을 유지하고 알림만 끌 수 있습니다.
              </p>
            )}
          </>
        ))}
      {message && (
        <p className="discord-message" role="status">
          {message}
        </p>
      )}
    </section>
  )
}
