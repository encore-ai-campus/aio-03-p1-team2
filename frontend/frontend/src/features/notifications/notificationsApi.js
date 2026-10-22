import { ApiError } from '../../shared/api/client.js'

export function createNotificationsApi(request) {
  return {
    list: (signal) => request('/api/notifications?limit=20&offset=0', { signal }),
    markRead: (id, signal) => request(`/api/notifications/${id}/read`, { method: 'PATCH', signal }),
  }
}

// JSON API의 20초 제한을 적용하지 않는 인증 스트림입니다.
export async function watchNotifications(baseUrl, token, signal, onEvent) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/notifications/stream`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    signal,
  })
  if (!response.ok) throw new ApiError('실시간 알림에 연결하지 못했어요.', response.status)
  if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body)
    throw new ApiError('실시간 알림 응답을 확인하지 못했어요.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = '',
    event = '',
    data = []
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let end
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, '')
        buffer = buffer.slice(end + 1)
        if (line === '') {
          if (data.length) onEvent(event, JSON.parse(data.join('\n')))
          event = ''
          data = []
        } else if (line.startsWith('event:')) event = line.slice(6).trimStart()
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
      }
      if (buffer.length > 65536) throw new ApiError('실시간 알림 응답이 너무 큽니다.')
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
