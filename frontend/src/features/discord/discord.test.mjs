import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createElement as h } from 'react'
import { act, create } from 'react-test-renderer'
import { createDiscordApi, readDiscordEventLink } from './discordApi.js'

const root = new URL('../../..', import.meta.url).pathname
const require = createRequire(import.meta.url)
async function component(name) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [`src/features/discord/${name}.jsx`],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    external: ['react', 'react/*'],
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(
    require,
    module,
    module.exports,
  )
  return module.exports.default
}
const Login = await component('DiscordLoginButton'),
  Settings = await component('DiscordSettings'),
  Callback = await component('DiscordCallback')
const flowId = 'a'.repeat(43),
  eventId = 'b'.repeat(32) + '_e000001'
const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
function browser() {
  const storage = new Map(),
    redirects = [],
    histories = []
  return {
    storage: {
      getItem: (k) => storage.get(k) || null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
    location: {
      href: `https://app.example/?event=${eventId}`,
      assign: (url) => redirects.push(url),
    },
    history: { replaceState: (_s, _t, url) => histories.push(url) },
    storageMap: storage,
    redirects,
    histories,
  }
}

test('OAuth keeps tab proof, exchanges once, uses public login and scrubs code', async () => {
  const env = browser(),
    calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return Response.json(
      url.endsWith('/start')
        ? { flow_id: flowId, url: 'https://project.supabase.co/auth/v1/authorize', expires_in: 300 }
        : {
            intent: 'login',
            user_id: 'owner',
            tokens: { access_token: 'new-token', expires_in: 3600 },
          },
    )
  }
  const api = createDiscordApi('https://api.example', 'old-token', env)
  await api.start('login')
  assert.equal(env.redirects.length, 1)
  assert.equal(calls[0].options.headers.Authorization, undefined)
  const callback = `https://app.example/auth/discord/callback?code=private-code`
  const [first, second] = await Promise.all([api.complete(callback), api.complete(callback)])
  assert.deepEqual(first, second)
  assert.equal(first.eventId, eventId)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].options.headers.Authorization, undefined)
  assert.equal(JSON.parse(calls[1].options.body).flow_id, flowId)
  assert.equal(env.storageMap.size, 0)
  assert.deepEqual(env.histories, ['https://app.example/auth/discord/callback'])
  assert.equal(readDiscordEventLink('https://app.example/?event=javascript:alert(1)'), null)
})

test('linking requires current session and uses its authorization', async () => {
  const env = browser(),
    calls = []
  globalThis.fetch = async (url, options) => {
    calls.push(options)
    return Response.json(
      url.endsWith('/start')
        ? { flow_id: flowId, url: 'https://discord.com/oauth2/authorize', expires_in: 300 }
        : { intent: 'link', tokens: { access_token: 'linked-token' } },
    )
  }
  await assert.rejects(createDiscordApi('https://api.example', '', env).start('link'), /로그인 후/)
  const api = createDiscordApi('https://api.example', 'owner-token', env)
  await api.start('link')
  await api.complete('https://app.example/auth/discord/callback?code=code')
  assert.equal(calls[0].headers.Authorization, 'Bearer owner-token')
  assert.equal(calls[1].headers.Authorization, 'Bearer owner-token')
})

test('unbound, expired and cancelled OAuth never accepts a session', async () => {
  const env = browser()
  let exchanges = 0
  globalThis.fetch = async (url) => {
    if (url.endsWith('/complete')) exchanges++
    return Response.json({
      flow_id: flowId,
      url: 'https://project.supabase.co/auth/v1/authorize',
      expires_in: 300,
    })
  }
  await assert.rejects(
    createDiscordApi('https://api.example', '', env).complete(
      'https://app.example/auth/discord/callback?code=code',
    ),
    /같은 브라우저/,
  )
  let api = createDiscordApi('https://api.example', '', env)
  await api.start()
  await assert.rejects(
    api.complete(
      'https://app.example/auth/discord/callback?error=access_denied&error_description=private',
    ),
    /취소/,
  )
  assert.equal(env.storageMap.size, 0)
  api = createDiscordApi('https://api.example', '', env)
  await api.start()
  const [key, value] = [...env.storageMap.entries()][0]
  env.storage.setItem(key, JSON.stringify({ ...JSON.parse(value), expiresAt: 0 }))
  await assert.rejects(
    api.complete('https://app.example/auth/discord/callback?code=code'),
    /같은 브라우저/,
  )
  assert.equal(exchanges, 0)
})

test('blocked storage and unsafe provider redirects prevent navigation', async () => {
  const env = browser()
  globalThis.fetch = async () =>
    Response.json({
      flow_id: flowId,
      url: 'https://project.supabase.co/auth/v1/authorize',
      expires_in: 300,
    })
  env.storage.setItem = () => {
    throw new Error('blocked')
  }
  await assert.rejects(createDiscordApi('https://api.example', '', env).start(), /사이트 저장소/)
  globalThis.fetch = async () =>
    Response.json({ flow_id: flowId, url: 'javascript:alert(1)', expires_in: 300 })
  await assert.rejects(createDiscordApi('https://api.example', '', env).start(), /인증 응답/)
  assert.equal(env.redirects.length, 0)
})

test('cancelled OAuth start cannot redirect after logout or account change', async () => {
  const env = browser(),
    wait = deferred(),
    controller = new AbortController()
  globalThis.fetch = async () => wait.promise
  const api = createDiscordApi('https://api.example', 'owner-token', env)
  const starting = api.start('link', controller.signal)
  controller.abort()
  wait.resolve(
    Response.json({
      flow_id: flowId,
      url: 'https://project.supabase.co/auth/v1/authorize',
      expires_in: 300,
    }),
  )
  await assert.rejects(starting)
  assert.equal(env.redirects.length, 0)
  assert.equal(env.storageMap.size, 0)
})

const connected = {
  linked: true,
  discord_name: '연결 사용자',
  notifications_enabled: false,
  dm_verified: false,
  can_unlink: true,
  auth_ready: true,
  bot_ready: true,
  last_error: null,
}
const text = (tree) => JSON.stringify(tree.toJSON())
const button = (tree, label) =>
  tree.root.findAllByType('button').find((x) => x.children.join('') === label)

test('settings verify DM before opt-in; failures preserve preference; unlink refreshes', async () => {
  let state = { ...connected },
    sends = 0,
    preferences = []
  const api = {
    connection: async () => state,
    test: async () => {
      sends++
      return (state = { ...state, dm_verified: true })
    },
    preference: async (enabled) => {
      preferences.push(enabled)
      if (!enabled) throw new Error('서버 연결 오류')
      return (state = { ...state, notifications_enabled: enabled })
    },
    unlink: async () => {
      state = { ...state, linked: false }
    },
    start: async () => {},
  }
  let tree
  await act(async () => {
    tree = create(h(Settings, { api }))
    await flush()
  })
  assert.equal(tree.root.findByType('input').props.disabled, true)
  assert.equal(tree.root.findByType('details').props.open, true)
  const invite = new URL(tree.root.findAllByType('a')[0].props.href)
  assert.equal(invite.hostname, 'discord.com')
  assert.equal(invite.searchParams.get('client_id'), '1561992883345817622')
  assert.equal(invite.searchParams.get('permissions'), '0')
  await act(async () => {
    await button(tree, '테스트 DM 보내기').props.onClick()
    await flush()
  })
  assert.equal(sends, 1)
  assert.equal(tree.root.findByType('input').props.disabled, false)
  await act(async () => {
    tree.root.findByType('input').props.onChange({ target: { checked: true } })
    await flush()
  })
  assert.equal(tree.root.findByType('input').props.checked, true)
  assert.equal(tree.root.findByType('details').props.open, false)
  await act(async () => {
    tree.root.findByType('input').props.onChange({ target: { checked: false } })
    await flush()
  })
  assert.equal(tree.root.findByType('input').props.checked, true)
  assert.match(text(tree), /서버 연결 오류/)
  assert.deepEqual(preferences, [true, false])
  await act(async () => {
    await button(tree, '연결 해제').props.onClick()
    await flush()
  })
  assert.match(text(tree), /연결된 Discord 계정이 없습니다/)
  await act(async () => tree.unmount())
})

test('account change aborts old work and ignores its late response', async () => {
  const late = deferred()
  let oldSignal
  const oldApi = {
    connection: async () => ({ ...connected, dm_verified: true }),
    test: (signal) => {
      oldSignal = signal
      return late.promise
    },
  }
  const nextApi = { connection: async () => ({ ...connected, discord_name: '다음 계정' }) }
  let tree
  await act(async () => {
    tree = create(h(Settings, { api: oldApi }))
    await flush()
  })
  await act(async () => {
    button(tree, '테스트 DM 보내기').props.onClick()
    await flush()
  })
  await act(async () => {
    tree.update(h(Settings, { api: nextApi }))
    await flush()
  })
  assert.equal(oldSignal.aborted, true)
  await act(async () => {
    late.resolve({ ...connected, discord_name: '이전 계정' })
    await flush()
  })
  assert.match(text(tree), /다음 계정/)
  assert.doesNotMatch(text(tree), /이전 계정/)
  assert.equal(button(tree, '테스트 DM 보내기').props.disabled, false)
  await act(async () => tree.unmount())
})

test('only login provider cannot unlink; loading failure can retry', async () => {
  let attempts = 0
  const api = {
    connection: async () => {
      if (!attempts++) throw new Error('일시적 연결 오류')
      return { ...connected, can_unlink: false }
    },
  }
  let tree
  await act(async () => {
    tree = create(h(Settings, { api }))
    await flush()
  })
  assert.match(text(tree), /일시적 연결 오류/)
  await act(async () => {
    button(tree, '다시 조회').props.onClick()
    await flush()
  })
  assert.equal(button(tree, '연결 해제'), undefined)
  assert.match(text(tree), /유일한 로그인 수단/)
  await act(async () => tree.unmount())
})

test('login button suppresses double submission and callback finishes once', async () => {
  const wait = deferred()
  let starts = 0,
    completions = 0,
    accepted = 0
  let tree
  await act(async () => {
    tree = create(
      h(Login, {
        api: {
          config: async () => ({ auth_ready: true }),
          start: () => {
            starts++
            return wait.promise
          },
        },
      }),
    )
  })
  await act(async () => {
    const click = tree.root.findByType('button').props.onClick
    void click()
    void click()
    await flush()
  })
  assert.equal(starts, 1)
  await act(async () => {
    wait.resolve()
    await flush()
    tree.unmount()
  })
  const api = {
    complete: async () => {
      completions++
      return { intent: 'login', tokens: { access_token: 'token' } }
    },
  }
  const accept = async () => {
    accepted++
  }
  await act(async () => {
    tree = create(h(Callback, { api, onComplete: accept, onBack: () => {} }))
    await flush()
  })
  await act(async () => {
    tree.update(h(Callback, { api, onComplete: async (value) => accept(value), onBack: () => {} }))
    await flush()
  })
  assert.equal(completions, 1)
  assert.equal(accepted, 1)
  await act(async () => tree.unmount())
})
