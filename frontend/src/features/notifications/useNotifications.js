import { useEffect, useRef, useState } from 'react'
import { createNotificationsApi, watchNotifications } from './notificationsApi.js'

export function useNotifications({ client, baseUrl, token, onUnauthorized }) {
  const [items, setItems] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [connected, setConnected] = useState(false)
  const [toast, setToast] = useState(null)
  const refreshRef = useRef(() => {})
  const requestRef = useRef(null)

  useEffect(() => {
    const controller = new AbortController()
    const api = createNotificationsApi(client)
    requestRef.current = { api, signal: controller.signal }
    const seen = new Set()
    let initialized = false,
      fetching = false,
      dirty = false,
      reconnectTimer
    setItems([])
    setToast(null)
    setError('')
    setConnected(false)
    setLoading(true)

    function failure(cause) {
      if (controller.signal.aborted) return
      if ([401, 403].includes(cause.status)) {
        controller.abort()
        onUnauthorized?.()
      } else setError(cause.message)
    }
    async function refresh() {
      if (controller.signal.aborted) return
      if (fetching) {
        dirty = true
        return
      }
      fetching = true
      try {
        const data = await api.list(controller.signal)
        if (controller.signal.aborted) return
        if (initialized) {
          const newest = data.items.find((notice) => !notice.read && !seen.has(notice.id))
          if (newest) setToast(newest)
        }
        data.items.forEach((notice) => seen.add(notice.id))
        initialized = true
        setItems(data.items)
        setError('')
      } catch (cause) {
        failure(cause)
      } finally {
        fetching = false
        if (!controller.signal.aborted) {
          setLoading(false)
          if (dirty) {
            dirty = false
            void refresh()
          }
        }
      }
    }
    async function connect() {
      try {
        await watchNotifications(baseUrl, token, controller.signal, (event) => {
          if (controller.signal.aborted) return
          if (event === 'error') throw new Error('알림 연결이 끊겼어요.')
          if (event === 'ready') setConnected(true)
          if (event === 'ready' || event === 'notification.created') void refresh()
        })
      } catch (cause) {
        if ([401, 403].includes(cause.status)) failure(cause)
      } finally {
        if (!controller.signal.aborted) {
          setConnected(false)
          reconnectTimer = setTimeout(connect, 5000)
        }
      }
    }
    refreshRef.current = refresh
    void refresh()
    void connect()
    const timer = setInterval(() => {
      if (!document.hidden) void refresh()
    }, 30000)
    const visible = () => {
      if (!document.hidden) void refresh()
    }
    document.addEventListener?.('visibilitychange', visible)
    return () => {
      controller.abort()
      clearInterval(timer)
      clearTimeout(reconnectTimer)
      document.removeEventListener?.('visibilitychange', visible)
    }
  }, [client, baseUrl, token, onUnauthorized])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(timer)
  }, [toast])

  async function markRead(notice) {
    const request = requestRef.current
    if (!request || request.signal.aborted) return
    setToast((current) => (current?.id === notice.id ? null : current))
    try {
      await request.api.markRead(notice.id, request.signal)
      if (!request.signal.aborted)
        setItems((current) =>
          current.map((item) => (item.id === notice.id ? { ...item, read: true } : item)),
        )
    } catch (cause) {
      if (request.signal.aborted) return
      if ([401, 403].includes(cause.status)) onUnauthorized?.()
      else setError(cause.message)
    }
  }
  return {
    items,
    loading,
    error,
    connected,
    toast,
    markRead,
    refresh: () => refreshRef.current(),
    dismiss: () => setToast(null),
  }
}
