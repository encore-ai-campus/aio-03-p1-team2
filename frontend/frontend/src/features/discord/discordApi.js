import { createApiClient } from '../../shared/api/client.js'

const eventPattern = /^[0-9a-f]{32}_e[0-9]{6}$/
const flowPattern = /^[A-Za-z0-9_-]{32,128}$/
export const discordCallbackPath = '/auth/discord/callback'

export function readDiscordEventLink(url) {
  const event = new URL(url).searchParams.get('event')
  return event && eventPattern.test(event) ? event : null
}

export function createDiscordApi(baseUrl, token = '', environment = {}) {
  const request = createApiClient(baseUrl, token)
  const publicRequest = createApiClient(baseUrl)
  const browser = () => ({
    storage: environment.storage ?? window.sessionStorage,
    location: environment.location ?? window.location,
    history: environment.history ?? window.history,
  })
  const key = `notecam:discord:oauth:${baseUrl.replace(/\/+$/, '')}`
  let completion

  function pending() {
    try {
      const value = JSON.parse(browser().storage.getItem(key) || 'null')
      if (
        value &&
        flowPattern.test(value.flow_id) &&
        ['login', 'link'].includes(value.intent) &&
        Number.isFinite(value.expiresAt) &&
        value.expiresAt > Date.now()
      )
        return value
    } catch {
      // Same-tab proof must survive the provider redirect; never exchange an unbound code.
    }
    throw new Error('같은 브라우저 탭에서 Discord 인증을 다시 시작해 주세요.')
  }

  function clearPending(flowId) {
    try {
      if (JSON.parse(browser().storage.getItem(key) || 'null')?.flow_id === flowId)
        browser().storage.removeItem(key)
    } catch {
      /* Storage failures cannot authenticate a different session. */
    }
  }

  return {
    config: (signal) => publicRequest('/api/discord/config', { signal }),
    connection: (signal) => request('/api/discord/connection', { signal }),
    preference: (notifications_enabled, signal) =>
      request('/api/discord/connection', {
        method: 'PATCH',
        body: { notifications_enabled },
        signal,
      }),
    test: (signal) => request('/api/discord/connection/test', { method: 'POST', signal }),
    unlink: (signal) => request('/api/discord/connection', { method: 'DELETE', signal }),

    async start(intent = 'login', signal) {
      signal?.throwIfAborted()
      if (!['login', 'link'].includes(intent)) throw new Error('잘못된 Discord 인증 요청입니다.')
      if (intent === 'link' && !token) throw new Error('로그인 후 Discord를 연결하세요.')
      const data = await (intent === 'link' ? request : publicRequest)('/api/discord/start', {
        method: 'POST',
        body: { intent },
        signal,
      })
      signal?.throwIfAborted()
      const target = new URL(data.url)
      if (
        target.protocol !== 'https:' ||
        target.username ||
        target.password ||
        !flowPattern.test(data.flow_id) ||
        !Number.isFinite(data.expires_in) ||
        data.expires_in <= 0
      )
        throw new Error('Discord 인증 응답을 확인할 수 없습니다.')
      const { storage, location } = browser()
      try {
        storage.setItem(
          key,
          JSON.stringify({
            flow_id: data.flow_id,
            intent,
            expiresAt: Date.now() + Math.min(data.expires_in, 300) * 1000,
            eventId: readDiscordEventLink(location.href),
          }),
        )
      } catch {
        throw new Error('인증 정보를 보관할 수 없습니다. 브라우저의 사이트 저장소를 허용해 주세요.')
      }
      location.assign(target.href)
    },

    complete(url = browser().location.href) {
      // React StrictMode's effect replay shares this promise; the code is exchanged once.
      if (completion) return completion
      completion = (async () => {
        const current = new URL(url)
        const code = current.searchParams.get('code')
        browser().history.replaceState(null, '', current.origin + current.pathname)
        const flow = pending()
        try {
          if (
            current.pathname !== discordCallbackPath ||
            current.searchParams.has('error') ||
            !code
          )
            throw new Error('Discord 인증이 취소됐거나 완료되지 않았습니다. 다시 시작해 주세요.')
          if (flow.intent === 'link' && !token)
            throw new Error('연결을 시작한 계정으로 로그인한 후 다시 시도해 주세요.')
          const result = await (flow.intent === 'link' ? request : publicRequest)(
            '/api/discord/complete',
            {
              method: 'POST',
              body: { flow_id: flow.flow_id, code },
            },
          )
          if (result.intent !== flow.intent || !result.tokens?.access_token)
            throw new Error('Discord 로그인 결과를 확인할 수 없습니다.')
          return {
            ...result,
            eventId: flow.eventId && eventPattern.test(flow.eventId) ? flow.eventId : null,
          }
        } finally {
          clearPending(flow.flow_id)
        }
      })()
      return completion
    },
  }
}
