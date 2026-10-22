import { useEffect, useId, useRef, useState } from 'react'
import { formatDate } from '../../shared/utils/formatDate.js'

export default function NotificationsPanel({ resource, onSelect }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const trigger = useRef(null)
  const panelId = useId()
  const unread = resource?.items.filter((notice) => !notice.read).length ?? 0

  useEffect(() => {
    if (!open) return
    function outside(event) {
      if (!ref.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener?.('pointerdown', outside)
    return () => document.removeEventListener?.('pointerdown', outside)
  }, [open])

  if (!resource) return null
  return (
    <div
      className="notification-menu"
      ref={ref}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))
          setOpen(false)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          setOpen(false)
          trigger.current?.focus()
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="notification-toggle"
        aria-label="알림"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
          <path d="M10 21h4" />
        </svg>
        {unread > 0 && (
          <span className="notification-badge" aria-label={`읽지 않은 최근 알림 ${unread}개`}>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <section id={panelId} className="notification-dropdown" aria-label="알림 목록">
          <div className="page-toolbar">
            <h2>알림</h2>
            <button
              type="button"
              className="button"
              disabled={resource.loading}
              onClick={resource.refresh}
            >
              새로고침
            </button>
          </div>
          <div className="notification-list">
            <p className="muted" role="status">
              {resource.connected ? '실시간 알림 연결됨' : '주기적으로 새 알림을 확인하고 있어요.'}
            </p>
            {resource.error && (
              <p className="api-error" role="alert">
                {resource.error}
              </p>
            )}
            {resource.loading ? (
              <p role="status">알림 조회 중…</p>
            ) : !resource.items.length ? (
              <p>최근 알림이 없어요.</p>
            ) : (
              resource.items.map((notice) => (
                <button
                  className="notification-item"
                  type="button"
                  key={notice.id}
                  data-read={notice.read}
                  onClick={() => {
                    setOpen(false)
                    trigger.current?.focus()
                    onSelect(notice)
                  }}
                >
                  <span>
                    {!notice.read && <span className="notification-unread">새 알림 · </span>}
                    {notice.message}
                  </span>
                  <small>{formatDate(notice.created_at)}</small>
                </button>
              ))
            )}
          </div>
        </section>
      )}
    </div>
  )
}
