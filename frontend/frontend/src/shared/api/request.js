export const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL || 'http://localhost:8000'

export function createRequest({ baseUrl = API_BASE_URL, token }) {
  const base = baseUrl.replace(/\/+$/, '')
  return async function request(
    path,
    { method = 'GET', body, signal, responseType = 'json', timeout = 15000 } = {},
  ) {
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal?.aborted) abort()
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, timeout)
    const multipart = body instanceof FormData
    try {
      const response = await fetch(base + path, {
        method,
        signal: controller.signal,
        cache: 'no-store',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(!multipart && body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        const detail = payload?.error?.message || payload?.detail
        const message =
          typeof detail === 'string'
            ? detail
            : Array.isArray(detail)
              ? detail.map((item) => item.msg).join(', ')
              : `요청을 처리하지 못했습니다. (HTTP ${response.status})`
        const error = new Error(
          response.status === 401
            ? '로그인이 만료되었거나 유효하지 않습니다. 다시 로그인해 주세요.'
            : message,
        )
        error.status = response.status
        throw error
      }
      return responseType === 'blob' ? await response.blob() : await response.json()
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted)
        throw new Error('서버 응답이 지연됩니다. 연결을 확인하고 다시 시도해 주세요.')
      if (error instanceof TypeError)
        throw new Error('API 서버에 연결할 수 없습니다. 서버 주소와 실행 상태를 확인해 주세요.')
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
}
