export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export function createApiClient(baseUrl, accessToken = '') {
  const base = baseUrl.replace(/\/+$/, '')

  async function request(path, { method = 'GET', body, signal } = {}) {
    const controller = new AbortController()
    let timedOut = false

    const abort = () => controller.abort()

    signal?.addEventListener('abort', abort, { once: true })

    if (signal?.aborted) {
      abort()
    }

    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 20000)

    try {
      const response = await fetch(base + path, {
        method,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })

      if (response.status === 204 && response.ok) {
        return null
      }

      const data = await response.json().catch(() => null)

      if (!response.ok) {
        const detail = data?.detail

        const validation = Array.isArray(detail) ? detail.map((item) => item.msg).join(' / ') : ''

        const message = typeof detail === 'string' ? detail : validation || data?.error?.message

        throw new ApiError(
          message || `요청을 처리하지 못했어요. (${response.status})`,
          response.status,
        )
      }

      if (data === null) {
        throw new ApiError('서버 응답을 확인할 수 없어요.')
      }

      return data
    } catch (error) {
      if (signal?.aborted) {
        throw error
      }

      if (error instanceof ApiError) {
        throw error
      }

      if (timedOut) {
        throw new ApiError('응답이 지연되고 있어요. 잠시 후 다시 시도해 주세요.')
      }

      throw new ApiError('서버에 연결할 수 없어요. 연결 상태를 확인해 주세요.')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  return request
}
