import { useEffect, useRef, useState } from 'react'
import { API_BASE_URL } from '../../shared/api/config.js'

const initial = { status: 'idle', url: '', name: '', message: '' }

export function useRemotePreview(request, enabled) {
  const [state, setState] = useState(initial)
  const [foreground, setForeground] = useState(() => !document.hidden)
  const failRef = useRef(null)

  useEffect(() => {
    const changed = () => setForeground(!document.hidden)
    document.addEventListener?.('visibilitychange', changed)
    return () => document.removeEventListener?.('visibilitychange', changed)
  }, [])

  useEffect(() => {
    if (!enabled || !request || !foreground) {
      setState({ ...initial, status: enabled ? 'paused' : 'idle' })
      return
    }
    const controller = new AbortController()
    const options = { signal: controller.signal }
    let pollTimer,
      ticketTimer,
      runId,
      name = ''
    const clear = () => {
      clearTimeout(pollTimer)
      clearTimeout(ticketTimer)
      controller.abort()
    }
    const finish = (status, message) => {
      clear()
      setState({ status, message, name, url: '' })
    }
    const fail = (error) => {
      if (!controller.signal.aborted) finish('error', error.message)
    }
    failRef.current = () => fail(new Error('영상 연결이 끊겼습니다. 다시 연결해 주세요.'))
    setState({ ...initial, status: 'loading', message: '촬영 중인 카메라를 찾고 있습니다.' })

    async function renew() {
      const ticket = await request(`/api/motion/runs/${runId}/preview-ticket`, {
        ...options,
        method: 'POST',
      })
      if (controller.signal.aborted) return
      const url = new URL(ticket.url, API_BASE_URL)
      if (
        url.origin !== new URL(API_BASE_URL).origin ||
        url.pathname !== `/api/motion/runs/${runId}/preview.mjpg` ||
        !Number.isFinite(ticket.expires_in) ||
        ticket.expires_in <= 0
      )
        throw new Error('영상 연결 주소를 확인하지 못했습니다.')
      setState({ status: 'watching', url: url.href, name, message: '' })
      ticketTimer = setTimeout(
        () => {
          void renew().catch(fail)
        },
        Math.max(500, ticket.expires_in * 800),
      )
    }

    async function poll() {
      const run = await request(`/api/motion/runs/${runId}`, options)
      if (controller.signal.aborted) return
      if (!['starting', 'running'].includes(run.status)) {
        finish('ended', '카메라 연결이 종료됐습니다.')
        return
      }
      if (run.status === 'running' && !ticketTimer) await renew()
      if (!controller.signal.aborted)
        pollTimer = setTimeout(() => {
          void poll().catch(fail)
        }, 3000)
    }

    async function connect() {
      const [runs, cameras] = await Promise.all([
        request('/api/motion/runs?active_only=true', options),
        request('/api/motion/cameras', options),
      ])
      if (controller.signal.aborted) return
      // ponytail: one selected camera; add a picker when simultaneous cameras are supported.
      const run = runs.find((item) => ['starting', 'running'].includes(item.status))
      if (!run) {
        finish('empty', '촬영 중인 카메라가 없습니다.')
        return
      }
      runId = run.id
      name = cameras.find((item) => item.id === run.camera_id)?.name || '원격 카메라'
      setState({ status: 'loading', url: '', name, message: '카메라 영상을 준비하고 있습니다.' })
      await poll()
    }
    void connect().catch(fail)
    return () => {
      failRef.current = null
      clear()
    }
  }, [request, enabled, foreground])

  return {
    ...state,
    onError: () => failRef.current?.(),
  }
}
