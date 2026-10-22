import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { createApiClient, ApiError } from '../src/shared/api/client.js'
import { createFeedbackApi } from '../src/features/feedback/feedbackApi.js'

const lookupOffsets = []
const pagedFeedbackApi = createFeedbackApi(async (path) => {
  const offset = new URL(path, 'http://localhost').searchParams.get('offset')
  lookupOffsets.push(offset)
  return offset === '0'
    ? { items: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })), total: 101 }
    : { items: [{ id: 500, title: '오래된 의견' }], total: 101 }
})
assert.equal((await pagedFeedbackApi.getForAdmin(500)).title, '오래된 의견')
assert.deepEqual(lookupOffsets, ['0', '100'])
await assert.rejects(pagedFeedbackApi.getForAdmin(999), { status: 404 })

const require = createRequire(import.meta.url)
const output = await build({
  entryPoints: ['src/app/App.jsx'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.png': 'dataurl', '.css': 'empty' },
  define: { 'import.meta.env.VITE_API_BASE_URL': '"http://127.0.0.1:8000"' },
  external: ['react', 'react/*'],
})
const module = { exports: {} }
new Function('require', 'module', 'exports', output.outputFiles[0].text)(
  require,
  module,
  module.exports,
)
const App = module.exports.default

const user = {
  id: 'member-1',
  email: 'member@example.com',
  display_name: '회원',
  role: 'user',
  status: 'active',
  created_at: '2026-10-19T00:00:00Z',
}
const firstFeedback = {
  id: 1,
  user_id: user.id,
  title: '첫 의견',
  kind: 'suggestion',
  content: '개선해 주세요',
  status: 'pending',
  admin_note: null,
  created_at: '2026-10-19T00:00:00Z',
}
let calls = []
let overrides = {}
let feedback = []
let account = { ...user }
let currentRole = 'user'
let currentAccessToken = 'test-token'
let motionEvents = []
// [UI-OV06] 기능·역할: 본인 운영현황 API 모의 응답. 수행 이유: 실제 서버를 변경하지 않고 실행·카메라·최근 20건 범위를 검사합니다.
let overviewRuns = [],
  overviewCameras = []
let notices = [],
  notificationStreams = [],
  questionSettings
let discordConnection, discordReady
const sessionStorage = new Map()
const avatarStorage = new Map()
globalThis.window = {
  location: { href: 'http://127.0.0.1:5174/', pathname: '/', assign() {} },
  history: {
    replaceState(_state, _title, url) {
      const next = new URL(url, window.location.href)
      window.location.href = next.href
      window.location.pathname = next.pathname
    },
  },
  confirm: () => true,
  sessionStorage: {
    getItem: (key) => sessionStorage.get(key) ?? null,
    setItem: (key, value) => sessionStorage.set(key, value),
    removeItem: (key) => sessionStorage.delete(key),
  },
  localStorage: {
    getItem: (key) => avatarStorage.get(key) ?? null,
    setItem: (key, value) => avatarStorage.set(key, value),
    removeItem: (key) => avatarStorage.delete(key),
  },
}
globalThis.document = { hidden: false }
const windowEvents = new EventTarget()
window.addEventListener = windowEvents.addEventListener.bind(windowEvents)
window.removeEventListener = windowEvents.removeEventListener.bind(windowEvents)
const documentEvents = new EventTarget()
document.addEventListener = documentEvents.addEventListener.bind(documentEvents)
document.removeEventListener = documentEvents.removeEventListener.bind(documentEvents)

function mockApi(role = 'user') {
  sessionStorage.clear()
  calls = []
  overrides = {}
  feedback = [{ ...firstFeedback }]
  account = { ...user }
  currentRole = role
  currentAccessToken = 'test-token'
  motionEvents = []
  overviewRuns = []
  overviewCameras = []
  notices = [
    {
      id: 1,
      event_id: 'a'.repeat(32) + '_e000001',
      verdict: 'confirmed',
      message: '기존 알림',
      created_at: user.created_at,
      read: false,
    },
  ]
  notificationStreams = []
  discordReady = true
  discordConnection = { linked: false, auth_ready: true, bot_ready: true }
  window.history.replaceState(null, '', '/')
  questionSettings = {
    questions: [{ id: '11111111-1111-4111-8111-111111111111', question: '움직임이 있나요?' }],
    notify_on_uncertain: false,
  }
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url)
    const path = parsed.pathname
    const method = options.method || 'GET'
    calls.push({ path, method, options, query: parsed.searchParams })
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const custom = overrides[`${method} ${path}`]
    if (custom) return custom(options, parsed)
    const body = options.body ? JSON.parse(options.body) : null
    if (path === '/api/discord/config') return Response.json({ auth_ready: discordReady })
    if (path === '/api/auth/login')
      return Response.json({
        access_token: 'test-token',
        refresh_token: 'test-refresh-token',
        expires_in: 3600,
      })
    if (path === '/api/auth/register')
      return Response.json({ user_id: user.id, email_confirmation_required: true }, { status: 201 })
    if (path === '/api/auth/me') return Response.json({ id: user.id, role: currentRole })
    assert.equal(options.headers.Authorization, `Bearer ${currentAccessToken}`)
    if (path === '/api/discord/connection') {
      if (method === 'PATCH') discordConnection = { ...discordConnection, ...body }
      return Response.json(discordConnection)
    }
    if (path === '/api/users/me') {
      if (method === 'PATCH') account = { ...account, ...body }
      return Response.json(account)
    }
    if (path === '/api/motion/events')
      return Response.json(motionEvents.slice(0, Number(parsed.searchParams.get('limit') || 20)))
    if (/^\/api\/motion\/events\/[^/]+$/.test(path)) {
      const item = motionEvents.find((event) => event.id === path.split('/').at(-1))
      return item
        ? Response.json(item)
        : Response.json({ detail: '사건을 찾을 수 없습니다.' }, { status: 404 })
    }
    if (path === '/api/motion/runs')
      return Response.json(overviewRuns.slice(0, Number(parsed.searchParams.get('limit') || 20)))
    if (path === '/api/motion/cameras') return Response.json(overviewCameras)
    if (/^\/api\/motion\/runs\/[^/]+$/.test(path))
      return Response.json(overviewRuns.find((run) => run.id === path.split('/').at(-1)))
    if (path === '/api/motion/questions') {
      if (method === 'PUT') questionSettings = body
      return Response.json(questionSettings)
    }
    if (/^\/api\/motion\/events\/[^/]+\/analysis$/.test(path)) {
      const event = motionEvents.find((item) => item.id === path.split('/').at(-2))
      return Response.json({ status: 'succeeded', questions: [], result: { items: [] }, ...event })
    }
    if (/^\/api\/motion\/events\/[^/]+\/parts$/.test(path)) return Response.json([])
    if (path === '/api/notifications/stream') {
      const body = new ReadableStream({
        start(controller) {
          notificationStreams.push(controller)
          controller.enqueue(new TextEncoder().encode('event: ready\ndata: {}\n\n'))
          options.signal.addEventListener(
            'abort',
            () => {
              try {
                controller.error(new DOMException('Aborted', 'AbortError'))
              } catch {}
            },
            { once: true },
          )
        },
      })
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (/^\/api\/notifications\/\d+\/read$/.test(path)) {
      const id = Number(path.split('/').at(-2))
      notices = notices.map((notice) => (notice.id === id ? { ...notice, read: true } : notice))
      return Response.json(notices.find((notice) => notice.id === id))
    }
    if (path === '/api/notifications')
      return Response.json({
        items: notices,
        total: notices.length,
      })
    if (path === '/api/admin/users') return Response.json({ items: [account], total: 41 })
    if (path === `/api/admin/users/${user.id}` && method === 'PATCH') {
      account = { ...account, ...body }
      return Response.json(account)
    }
    if (path === '/api/admin/audit-logs')
      return Response.json({
        items: [
          {
            id: 11,
            actor_id: user.id,
            target_type: 'users',
            target_id: user.id,
            action: 'update',
            old_data: { display_name: '이전 이름', role: 'user', status: 'active' },
            new_data: { display_name: '회원', role: 'admin', status: 'active' },
            created_at: user.created_at,
          },
          {
            id: 10,
            actor_id: user.id,
            target_type: 'feedback',
            target_id: '1',
            action: 'update',
            old_data: { user_id: user.id, title: '첫 의견', status: 'pending' },
            new_data: { user_id: user.id, title: '첫 의견', status: 'resolved' },
            created_at: user.created_at,
          },
        ],
        total: 2,
      })
    if (/^\/api\/(admin\/)?feedback(?:\/\d+)?$/.test(path)) {
      const id = Number(path.split('/').at(-1))
      if (method === 'GET' && /\/\d+$/.test(path)) {
        if (path.startsWith('/api/admin/'))
          return Response.json({ detail: 'Not Found' }, { status: 404 })
        const item = feedback.find((entry) => entry.id === id)
        return item
          ? Response.json(item)
          : Response.json({ detail: '피드백을 찾을 수 없습니다.' }, { status: 404 })
      }
      if (method === 'POST') {
        const item = { ...firstFeedback, ...body, id: 2 }
        feedback.unshift(item)
        return Response.json(item, { status: 201 })
      }
      if (method === 'PATCH')
        feedback = feedback.map((item) => (item.id === id ? { ...item, ...body } : item))
      if (method === 'DELETE') {
        feedback = feedback.filter((item) => item.id !== id)
        return new Response(null, { status: 204 })
      }
      let items = feedback
      // [UI-FB03] 기능·역할: 서버 전체 검색·본인 범위 모의 응답. 수행 이유: 검색 후 페이지네이션 순서를 검사하고 다른 계정의 기록이 섞이지 않게 합니다.
      if (!path.startsWith('/api/admin/')) items = items.filter((item) => item.user_id === user.id)
      if (parsed.searchParams.get('q')) {
        const q = parsed.searchParams.get('q').toLocaleLowerCase()
        items = items.filter(
          (item) =>
            item.title.toLocaleLowerCase().includes(q) ||
            item.content.toLocaleLowerCase().includes(q),
        )
      }
      if (parsed.searchParams.get('feedback_id'))
        items = items.filter((item) => String(item.id) === parsed.searchParams.get('feedback_id'))
      if (parsed.searchParams.get('kind'))
        items = items.filter((item) => item.kind === parsed.searchParams.get('kind'))
      if (parsed.searchParams.get('status'))
        items = items.filter((item) => item.status === parsed.searchParams.get('status'))
      const total = items.length
      const limit = Number(parsed.searchParams.get('limit') || 20)
      const offset = Number(parsed.searchParams.get('offset') || 0)
      return Response.json({ items: items.slice(offset, offset + limit), total, limit, offset })
    }
    assert.fail(`Unexpected API: ${method} ${path}`)
  }
}

function text(node) {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  return text(node.children ?? node.props?.children)
}
const screen = (view) => text(view.toJSON())
const findButton = (view, label) => {
  const node = view.root
    .findAllByType('button')
    .find((button) => (button.props['aria-label'] || text(button.props.children)) === label)
  assert.ok(node, `Missing button: ${label}`)
  return node
}
async function click(view, label) {
  await act(async () => {
    findButton(view, label).props.onClick?.()
  })
}
async function clickHome(view) {
  await act(async () => {
    view.root.findByProps({ 'aria-label': '홈으로 이동' }).props.onClick?.()
  })
}
async function change(view, props, value) {
  await act(async () => view.root.findByProps(props).props.onChange({ target: { value } }))
}
async function submit(view) {
  // [UI-FB03] 기능·역할: 편집 폼과 검색 폼 구분. 수행 이유: 검색창이 있는 화면에서도 기존 CRUD·프로필·인증 검사를 유지합니다.
  await act(async () =>
    view.root
      .findAllByType('form')
      .find((form) => form.props.role !== 'search')
      .props.onSubmit({ preventDefault() {} }),
  )
}
async function mount() {
  let view
  await act(async () => {
    view = create(createElement(App), {
      createNodeMock: (element) =>
        element.type === 'dialog'
          ? {
              open: false,
              showModal() {
                this.open = true
              },
              close() {
                this.open = false
              },
            }
          : element.type === 'video'
            ? {
                srcObject: null,
                videoWidth: 640,
                videoHeight: 480,
                play: async () => {},
                getAttribute: () => null,
              }
            : null,
    })
  })
  return view
}
async function unmount(view) {
  await act(async () => view.unmount())
}
async function login(role = 'user', initialEvents = []) {
  mockApi(role)
  motionEvents = initialEvents
  const view = await mount()
  assert.equal(calls.length, 0, 'Landing must not request protected data')
  await click(view, '로그인')
  await change(view, { id: 'login-email' }, user.email)
  await change(view, { id: 'login-password' }, 'password-for-test')
  await submit(view)
  assert.equal(
    calls.find((call) => call.path === '/api/auth/me').options.headers.Authorization,
    'Bearer test-token',
  )
  return view
}

mockApi()
const landingPreview = await mount()
await act(async () => landingPreview.root.findByType('video').props.onFocus())
assert.equal(landingPreview.root.findByType('video').props.controls, true)
await act(async () => landingPreview.root.findByType('video').props.onPlaying())
assert.equal(
  landingPreview.root.findAllByProps({ className: 'landing-visual-poster is-hidden' }).length,
  1,
  'Native video controls must reveal the video instead of leaving its poster on top',
)
await unmount(landingPreview)
console.log('PASS landing video poster clears when native playback starts')

let view = await login()
assert.ok(screen(view).includes('실시간 보기'))
assert.ok(screen(view).includes('회원'))
assert.equal(view.root.findAllByProps({ 'aria-label': '나의 프로필로 이동' }).length, 1)
assert.ok(screen(view).includes('미리보기 또는 녹화 버튼을 눌러 시작하세요.'))
assert.ok(screen(view).includes('최근 움직임'))
await click(view, '알림')
assert.ok(screen(view).includes('기존 알림'))
await click(view, '알림')
await click(view, '내 대시보드')
assert.ok(screen(view).includes('CAMERA OFF'))
assert.ok(screen(view).includes('최근 분석 처리 현황'))
assert.ok(!screen(view).includes('현재 분석 기준'))
assert.equal(calls.filter((call) => call.path.startsWith('/api/admin/')).length, 0)
await click(view, '고객 피드백')
assert.ok(screen(view).includes('첫 의견'))
// [UI-03] 기능·역할: 공통 닉네임 표시와 조회 권한 검사. 수행 이유: 일반 사용자도 닉네임을 확인하고 관리자 API는 호출하지 않아야 합니다.
assert.ok(screen(view).includes('닉네임: 회원'))
assert.ok(calls.some((call) => call.path === '/api/users/me' && call.method === 'GET'))
assert.ok(!calls.some((call) => call.path.startsWith('/api/admin/')))
assert.equal(
  view.root.findAllByProps({ className: 'dashboard-top' }).length,
  1,
  'Feedback must use the common header',
)
assert.equal(view.root.findAllByProps({ 'aria-label': '페이지 메뉴' }).length, 1)
await click(view, '+ 피드백 작성')
// [UI-05] 기능·역할: 정확한 감지 평가 선택·등록·수정 검사. 수행 이유: 새 글에서 선택할 수 있고 API에는 기존 accurate 값을 전송해야 합니다.
assert.equal(
  text(
    view.root.findByProps({ id: 'feedback-kind' }).findByProps({ value: 'accurate' }).props
      .children,
  ),
  '정확한 감지 평가',
)
await change(view, { id: 'feedback-kind' }, 'accurate')
await change(view, { id: 'feedback-title' }, '새 의견')
await change(view, { id: 'feedback-content' }, '새 내용')
await submit(view)
assert.ok(screen(view).includes('피드백을 등록했어요'))
assert.equal(feedback[0].title, '새 의견')
assert.equal(feedback[0].kind, 'accurate')
const createdFeedback = calls.find(
  (call) => call.path === '/api/feedback' && call.method === 'POST',
)
assert.equal(JSON.parse(createdFeedback.options.body).kind, 'accurate')
await change(view, { 'aria-label': '유형 필터' }, 'accurate')
assert.ok(screen(view).includes('새 의견'))
await click(view, '수정')
assert.equal(view.root.findByProps({ id: 'feedback-kind' }).props.value, 'accurate')
await change(view, { id: 'feedback-kind' }, 'suggestion')
assert.ok(view.root.findByProps({ id: 'feedback-kind' }).findByProps({ value: 'accurate' }))
await change(view, { id: 'feedback-kind' }, 'accurate')
await change(view, { id: 'feedback-title' }, '수정된 의견')
await submit(view)
assert.equal(feedback[0].title, '수정된 의견')
assert.equal(feedback[0].kind, 'accurate')
await click(view, '삭제')
assert.equal(feedback.length, 1)
await change(view, { 'aria-label': '유형 필터' }, 'false_negative')
assert.ok(screen(view).includes('조건에 맞는 피드백이 없어요'))
await click(view, '나의 프로필')
assert.ok(screen(view).includes(user.email), 'Profile summary shows the account email')
assert.ok(screen(view).includes('가입일'))
assert.equal(view.root.findAllByProps({ className: 'profile-avatar-option' }).length, 4)
assert.equal(
  view.root.findByProps({ 'aria-label': '부엉이 아바타 선택' }).props['aria-pressed'],
  true,
)
await act(async () => view.root.findByProps({ 'aria-label': '토끼 아바타 선택' }).props.onClick())
assert.equal(avatarStorage.get(`notecam:profile-avatar:${user.id}`), 'rabbit')
const selectedAvatarSrc = view.root
  .findByProps({ 'aria-label': '토끼 아바타 선택' })
  .findByType('img').props.src
assert.equal(
  view.root.findByProps({ className: 'profile-shortcut-avatar' }).props.src,
  selectedAvatarSrc,
)
await click(view, '고객 피드백')
await click(view, '나의 프로필')
assert.equal(
  view.root.findByProps({ 'aria-label': '토끼 아바타 선택' }).props['aria-pressed'],
  true,
)
assert.equal(view.root.findAllByProps({ id: 'profile-nickname' }).length, 0)
await act(async () => view.root.findByProps({ 'aria-label': '닉네임 수정' }).props.onClick())
await change(view, { id: 'profile-nickname' }, '취소할 이름')
await act(async () => view.root.findByProps({ className: 'profile-edit-cancel' }).props.onClick())
assert.equal(view.root.findAllByProps({ id: 'profile-nickname' }).length, 0)
assert.equal(account.display_name, '회원')
await act(async () => view.root.findByProps({ 'aria-label': '닉네임 수정' }).props.onClick())
await change(view, { id: 'profile-nickname' }, '변경 이름')
overrides['PATCH /api/users/me'] = () =>
  Response.json({ detail: [{ msg: '저장 검증 오류' }] }, { status: 422 })
await submit(view)
assert.ok(screen(view).includes('저장 검증 오류'))
delete overrides['PATCH /api/users/me']
await submit(view)
assert.equal(account.display_name, '변경 이름')
assert.ok(screen(view).includes('변경 이름'))
assert.equal(
  view.root.findByProps({ 'aria-label': '나의 프로필로 이동' }).findByType('span').props.children,
  '변경 이름',
)
assert.equal(view.root.findAllByProps({ id: 'profile-nickname' }).length, 0)
await click(view, '고객 피드백')
assert.ok(screen(view).includes('닉네임: 변경 이름'))
assert.ok(!calls.some((call) => call.path.startsWith('/api/admin/')))
await click(view, '모니터링현황')
assert.ok(screen(view).includes('표시할 이벤트가 없어요.'))
const eventRequestsBeforeRefresh = calls.filter((call) => call.path === '/api/motion/events').length
await click(view, '모니터링현황')
assert.ok(
  calls.filter((call) => call.path === '/api/motion/events').length > eventRequestsBeforeRefresh,
)
await act(async () => view.root.findByProps({ 'aria-label': '나의 프로필로 이동' }).props.onClick())
assert.equal(findButton(view, '나의 프로필').props['aria-current'], 'page')
await clickHome(view)
assert.equal(
  view.root.findByProps({ 'aria-label': '나의 프로필로 이동' }).findByType('span').props.children,
  '변경 이름',
)
assert.equal(
  view.root.findByProps({ className: 'profile-shortcut-avatar' }).props.src,
  selectedAvatarSrc,
)
await act(async () => view.root.findByProps({ 'aria-label': '나의 프로필로 이동' }).props.onClick())
assert.equal(findButton(view, '나의 프로필').props['aria-current'], 'page')
await click(view, '로그아웃')
assert.ok(screen(view).includes('내 카메라 확인하기'))
await unmount(view)
console.log(
  'PASS user login, feedback CRUD/filtering, shared navigation and profile errors/success',
)

// [UI-NAV03] 기능·역할: 변경된 사용자 명칭·기존 관리자 명칭으로 메뉴 재클릭 검사. 수행 이유: 대상 화면은 다시 조회하고 제외 메뉴·입력·필터·조회 권한은 유지하는지 확인합니다.
for (const role of ['user', 'admin']) {
  view = await login(role)
  overrides['GET /api/admin/cameras'] = () => Response.json([])
  const menus =
    role === 'admin'
      ? [
          ['카메라 기록', ['/api/admin/cameras', '/api/admin/users']],
          ['운영현황', ['/api/admin/users', '/api/admin/feedback', '/api/admin/audit-logs']],
          ['감사 로그', ['/api/admin/audit-logs']],
          ['고객 피드백 관리', ['/api/admin/feedback']],
          ['계정 관리', ['/api/admin/users']],
        ]
      : [
          ['내 대시보드', ['/api/motion/events', '/api/feedback', '/api/notifications']],
          ['모니터링현황', ['/api/motion/events']],
          ['고객 피드백', ['/api/feedback']],
        ]
  for (const [label, paths] of menus) {
    await click(view, label)
    const before = calls.length
    await click(view, label)
    for (const path of paths)
      assert.ok(
        calls.slice(before).some((call) => call.path === path && call.method === 'GET'),
        label,
      )
    const refreshedQueries = calls.slice(before).map((call) => `${call.path}?${call.query}`)
    assert.equal(
      new Set(refreshedQueries).size,
      refreshedQueries.length,
      `${label}: a menu reselect must request each query only once`,
    )
    assert.ok(calls.slice(before).every((call) => call.method === 'GET'))
  }

  const feedbackMenu = role === 'admin' ? '고객 피드백 관리' : '고객 피드백'
  feedback = Array.from({ length: 25 }, (_, index) => ({ ...firstFeedback, id: index + 1 }))
  await click(view, feedbackMenu)
  if (role === 'admin') await click(view, '내 피드백')
  await change(view, { id: 'feedback-query' }, '첫 의견')
  await act(async () =>
    view.root.findByProps({ role: 'search' }).props.onSubmit({ preventDefault() {} }),
  )
  await change(view, { 'aria-label': '유형 필터' }, 'suggestion')
  await change(view, { 'aria-label': '상태 필터' }, 'pending')
  await click(view, '다음')
  await click(view, '+ 피드백 작성')
  await change(view, { id: 'feedback-title' }, '작성 중인 제목')
  await change(view, { id: 'feedback-content' }, '작성 중인 내용')
  const beforeRefresh = calls.length
  feedback[24].title = '첫 의견 최신 제목'
  await click(view, feedbackMenu)
  const refreshed = calls.slice(beforeRefresh).find((call) => call.path === '/api/feedback')
  assert.equal(refreshed.query.get('q'), '첫 의견')
  assert.equal(refreshed.query.get('kind'), 'suggestion')
  assert.equal(refreshed.query.get('status'), 'pending')
  assert.equal(refreshed.query.get('offset'), '20')
  assert.ok(!calls.slice(beforeRefresh).some((call) => call.path.startsWith('/api/admin/')))
  assert.ok(screen(view).includes('첫 의견 최신 제목'))
  assert.equal(view.root.findByProps({ id: 'feedback-title' }).props.value, '작성 중인 제목')
  assert.equal(view.root.findByProps({ id: 'feedback-content' }).props.value, '작성 중인 내용')

  await click(view, '나의 프로필')
  await click(view, '닉네임 수정')
  await change(view, { id: 'profile-nickname' }, '저장 전 이름')
  const beforeProfile = calls.length
  await click(view, '나의 프로필')
  assert.equal(calls.length, beforeProfile)
  assert.equal(view.root.findByProps({ id: 'profile-nickname' }).props.value, '저장 전 이름')
  await click(view, '실시간 보기')
  const beforeLive = calls.length
  await click(view, '실시간 보기')
  assert.equal(calls.length, beforeLive)
  const beforeHome = calls.length
  await clickHome(view)
  assert.equal(calls.length, beforeHome)
  await unmount(view)
}
console.log(
  'PASS menu reselect refresh, own/admin scopes, preserved drafts/filters/pages and home/live/profile exclusions',
)

// [UI-NAV02] 기능·역할: 이벤트 메뉴의 실제 재조회와 진행 표시 검사. 수행 이유: 기존 기록이 있어도 조회 중 상태·최신 응답 반영·연속 클릭 취소를 검증합니다.
const originalEvent = { id: 'e'.repeat(32) + '_e000001', detected_at: user.created_at }
view = await login('user', [originalEvent])
await click(view, '모니터링현황')
const eventStatus = () => text(view.root.findByProps({ 'aria-label': '이벤트 조회 상태' }))
assert.ok(eventStatus().includes('조회 완료'))
const pendingEventReads = []
overrides['GET /api/motion/events'] = (options, url) => {
  assert.equal(url.searchParams.get('finished_only'), 'true')
  return new Promise((resolve) => pendingEventReads.push({ resolve, signal: options.signal }))
}
await click(view, '모니터링현황')
assert.equal(pendingEventReads.length, 1)
assert.equal(eventStatus(), '이벤트 조회 중…')
assert.equal(findButton(view, '조회 중…').props.disabled, true)
assert.equal(
  view.root.findByProps({ className: 'event-date' }).findByType('time').props.dateTime,
  user.created_at,
)
await click(view, '모니터링현황')
assert.equal(pendingEventReads.length, 2)
assert.equal(pendingEventReads[0].signal.aborted, true)
await act(async () => pendingEventReads[0].resolve(Response.json([])))
assert.equal(eventStatus(), '이벤트 조회 중…')
const latestEvent = { ...originalEvent, detected_at: '2026-10-21T06:00:00Z' }
await act(async () => pendingEventReads[1].resolve(Response.json([latestEvent])))
assert.ok(eventStatus().includes('조회 완료'))
assert.equal(
  view.root.findByProps({ className: 'event-date' }).findByType('time').props.dateTime,
  latestEvent.detected_at,
)
await click(view, '새로고침')
assert.equal(pendingEventReads.length, 3)
await act(async () =>
  pendingEventReads[2].resolve(Response.json({ detail: '이벤트 조회 실패' }, { status: 503 })),
)
assert.equal(eventStatus(), '이벤트 조회 실패')
assert.ok(
  view.root.findAllByProps({ role: 'alert' }).some((node) => text(node) === '이벤트 조회 실패'),
)
// 명시적 메뉴 클릭은 자동 조회의 비활성 탭 조건과 분리합니다.
document.hidden = true
await click(view, '모니터링현황')
document.hidden = false
assert.equal(pendingEventReads.length, 4)
await act(async () => pendingEventReads[3].resolve(Response.json([])))
assert.ok(eventStatus().includes('조회 완료'))
assert.ok(screen(view).includes('표시할 이벤트가 없어요.'))
assert.ok(!calls.some((call) => call.path.startsWith('/api/admin/')))
await unmount(view)
console.log(
  'PASS event menu/button refresh, visible progress with existing rows, latest data, cancelled stale reads and failure recovery',
)

// [UI-FB03] 기능·역할: 사용자·관리자 공통 번호·서버 전체 검색 검사. 수행 이유: 첫 페이지 밖의 기록, 소유권, 필터·페이지·번호·특수문자를 함께 확인합니다.
async function searchFeedback(view, query, field = 'text') {
  await change(view, { 'aria-label': '검색 기준' }, field)
  await change(view, { id: 'feedback-query' }, query)
  await act(async () =>
    view.root.findByProps({ role: 'search' }).props.onSubmit({ preventDefault() {} }),
  )
}
const feedbackCards = (view) => view.root.findAllByProps({ className: 'feedback-item' })
for (const role of ['user', 'admin']) {
  view = await login(role)
  feedback = Array.from({ length: 46 }, (_, index) => ({
    ...firstFeedback,
    id: 100 + index,
    title: `점검 의견 ${index + 1}`,
    content: index === 45 ? '유일한 마지막 기록' : index % 2 === 0 ? '현관 감지 의견' : '기타 의견',
  }))
  feedback.push({
    ...firstFeedback,
    id: 999,
    user_id: 'other-account',
    title: '다른 계정의 비공개 의견',
    content: '현관',
  })
  await click(view, role === 'admin' ? '고객 피드백 관리' : '고객 피드백')
  assert.equal(
    view.root.findAllByProps({ 'aria-label': '피드백 조회 범위' }).length,
    role === 'admin' ? 1 : 0,
  )
  assert.equal(feedbackCards(view).length, 20)
  assert.ok(!screen(view).includes('유일한 마지막 기록'))
  await searchFeedback(view, '  유일한 마지막 기록  ')
  assert.equal(feedbackCards(view).length, 1)
  assert.ok(screen(view).includes('#145'))
  assert.ok(view.root.findAllByType('mark').some((mark) => text(mark) === '유일한 마지막 기록'))
  const path = role === 'admin' ? '/api/admin/feedback' : '/api/feedback'
  assert.ok(
    calls.some(
      (call) =>
        call.path === path &&
        call.query.get('q') === '유일한 마지막 기록' &&
        call.query.get('limit') === '20',
    ),
  )
  await searchFeedback(view, '점검 의견 44')
  assert.equal(feedbackCards(view).length, 1)
  assert.ok(screen(view).includes('#143'))
  await searchFeedback(view, '현관')
  assert.ok(
    text(view.root.findByProps({ className: 'feedback-results' })).includes(
      `${role === 'admin' ? 24 : 23}건`,
    ),
  )
  await click(view, '다음')
  assert.equal(feedbackCards(view).length, role === 'admin' ? 4 : 3)
  assert.ok(
    calls.some(
      (call) =>
        call.path === path && call.query.get('q') === '현관' && call.query.get('offset') === '20',
    ),
  )
  await change(view, { 'aria-label': '유형 필터' }, 'false_positive')
  assert.equal(feedbackCards(view).length, 0)
  assert.ok(screen(view).includes('조건에 맞는 피드백이 없어요.'))
  await click(view, '검색·필터 초기화')
  assert.equal(view.root.findByProps({ id: 'feedback-query' }).props.value, '')
  // [UI-FB04] 기능·역할: 검색 입력 삭제 회귀 검사. 수행 이유: X 버튼과 글자 삭제가 검색·필터·페이지를 초기화하고 역할별 조회 범위를 유지하는지 확인합니다.
  await searchFeedback(view, '현관')
  await change(view, { 'aria-label': '유형 필터' }, 'suggestion')
  await change(view, { 'aria-label': '상태 필터' }, 'pending')
  await click(view, '다음')
  await change(view, { id: 'feedback-query' }, '')
  assert.equal(feedbackCards(view).length, 20)
  assert.equal(view.root.findByProps({ 'aria-label': '유형 필터' }).props.value, '')
  assert.equal(view.root.findByProps({ 'aria-label': '상태 필터' }).props.value, '')
  assert.equal(view.root.findAllByType('mark').length, 0)
  assert.ok(
    text(view.root.findByProps({ className: 'feedback-results' })).includes(
      `${role === 'admin' ? 47 : 46}건`,
    ),
  )
  const clearedQuery = calls
    .filter((call) => call.path === path && call.method === 'GET')
    .at(-1).query
  assert.equal(clearedQuery.get('offset'), '0')
  for (const key of ['q', 'feedback_id', 'kind', 'status'])
    assert.equal(clearedQuery.has(key), false)
  await searchFeedback(view, '#00142', 'id')
  assert.equal(feedbackCards(view).length, 1)
  assert.ok(screen(view).includes('#142'))
  assert.ok(
    calls.some(
      (call) =>
        call.path === path && call.query.get('feedback_id') === '142' && !call.query.has('q'),
    ),
  )
  const requestsBeforeDeletion = calls.length
  await change(view, { id: 'feedback-query' }, '#0014')
  assert.equal(calls.length, requestsBeforeDeletion)
  assert.equal(feedbackCards(view).length, 1)
  await change(view, { id: 'feedback-query' }, '')
  assert.equal(feedbackCards(view).length, 20)
  assert.equal(view.root.findByProps({ 'aria-label': '검색 기준' }).props.value, 'text')
  for (const invalid of ['#', 'abc', '0', '-1', '1.5', '9223372036854775808']) {
    const previousRequests = calls.length
    await searchFeedback(view, invalid, 'id')
    assert.ok(screen(view).includes('올바른 피드백 번호를 입력해 주세요.'))
    assert.equal(calls.length, previousRequests)
  }
  await change(view, { id: 'feedback-query' }, '   ')
  assert.equal(view.root.findByProps({ id: 'feedback-query' }).props.value, '')
  assert.equal(view.root.findAllByProps({ id: 'feedback-search-error' }).length, 0)
  assert.equal(feedbackCards(view).length, 20)
  await searchFeedback(view, '#9223372036854775807', 'id')
  assert.equal(view.root.findAllByProps({ id: 'feedback-search-error' }).length, 0)
  await searchFeedback(view, 'x'.repeat(101))
  assert.ok(screen(view).includes('검색어는 100자 이내'))
  const literal = 'A%_*.,()"\\<script>'
  feedback[45].content = literal
  await searchFeedback(view, literal)
  assert.equal(feedbackCards(view).length, 1)
  assert.ok(view.root.findAllByType('mark').some((mark) => text(mark) === literal))
  assert.equal(view.root.findAllByType('script').length, 0)
  await searchFeedback(view, '다른 계정의 비공개 의견')
  assert.equal(feedbackCards(view).length, role === 'admin' ? 1 : 0)
  if (role === 'admin') {
    const adminRequests = calls.filter((call) => call.path.startsWith('/api/admin/')).length
    await click(view, '내 피드백')
    assert.equal(view.root.findByProps({ id: 'feedback-query' }).props.value, '')
    await searchFeedback(view, '다른 계정의 비공개 의견')
    assert.equal(feedbackCards(view).length, 0)
    await change(view, { id: 'feedback-query' }, '')
    assert.equal(feedbackCards(view).length, 20)
    assert.ok(text(view.root.findByProps({ className: 'feedback-results' })).includes('46건'))
    assert.equal(calls.filter((call) => call.path.startsWith('/api/admin/')).length, adminRequests)
  } else assert.ok(!calls.some((call) => call.path.startsWith('/api/admin/')))
  await unmount(view)
}

view = await login()
feedback = Array.from({ length: 46 }, (_, index) => ({
  ...firstFeedback,
  id: 200 + index,
  title: `검색용 의견 ${index + 1}`,
  content: index < 41 ? '페이지 보정' : '다른 내용',
}))
await click(view, '고객 피드백')
await searchFeedback(view, '페이지 보정')
await click(view, '다음')
await click(view, '다음')
assert.equal(feedbackCards(view).length, 1)
assert.ok(screen(view).includes('#240'))
await click(view, '수정')
await change(view, { id: 'feedback-content' }, '검색에서 제외되는 내용')
overrides['PATCH /api/feedback/240'] = () =>
  Response.json({ detail: '검색 결과 수정 실패' }, { status: 503 })
await submit(view)
assert.ok(screen(view).includes('검색 결과 수정 실패'))
assert.equal(
  view.root.findByProps({ id: 'feedback-content' }).props.value,
  '검색에서 제외되는 내용',
)
delete overrides['PATCH /api/feedback/240']
await submit(view)
assert.equal(text(view.root.findByProps({ 'aria-label': '목록 페이지' })).includes('2 / 2'), true)
assert.equal(feedbackCards(view).length, 20)
assert.ok(!screen(view).includes('#240'))
feedback = Array.from({ length: 21 }, (_, index) => ({
  ...firstFeedback,
  id: 300 + index,
  content: '삭제 페이지',
}))
await searchFeedback(view, '삭제 페이지')
await click(view, '다음')
assert.equal(feedbackCards(view).length, 1)
window.confirm = () => false
await click(view, '삭제')
assert.equal(feedback.length, 21)
window.confirm = () => true
overrides['DELETE /api/feedback/320'] = () =>
  Response.json({ detail: '검색 결과 삭제 실패' }, { status: 503 })
await click(view, '삭제')
assert.ok(screen(view).includes('검색 결과 삭제 실패'))
assert.equal(feedback.length, 21)
delete overrides['DELETE /api/feedback/320']
await click(view, '삭제')
assert.equal(feedbackCards(view).length, 20)
assert.ok(text(view.root.findByProps({ 'aria-label': '목록 페이지' })).includes('1 / 1'))
let slowSearchSignal, finishSlowSearch
overrides['GET /api/feedback'] = (options, url) => {
  if (url.searchParams.get('q') === '느린 검색') {
    slowSearchSignal = options.signal
    return new Promise((resolve) => {
      finishSlowSearch = resolve
    })
  }
  return Response.json({ items: [feedback[0]], total: 1, limit: 20, offset: 0 })
}
await searchFeedback(view, '느린 검색')
await change(view, { id: 'feedback-query' }, '')
assert.equal(slowSearchSignal.aborted, true)
await act(async () =>
  finishSlowSearch(Response.json({ items: [], total: 999, limit: 20, offset: 0 })),
)
assert.equal(feedbackCards(view).length, 1)
assert.ok(!text(view.root.findByProps({ className: 'feedback-results' })).includes('999건'))
overrides['GET /api/feedback'] = () => Response.json({ detail: '검색 조회 실패' }, { status: 503 })
await searchFeedback(view, '실패 검사')
assert.ok(screen(view).includes('검색 조회 실패'))
assert.ok(!text(view.root.findByProps({ className: 'feedback-results' })).includes('0건'))
overrides['GET /api/feedback'] = () => Response.json({ detail: 'Expired' }, { status: 401 })
await searchFeedback(view, '만료 검사')
assert.ok(screen(view).includes('로그인이 만료되었습니다'))
await unmount(view)
console.log(
  'PASS feedback full search, clear input reset, stable IDs, own/admin scopes, literal queries, boundaries, last valid page after edit/delete, failures and cancellation',
)

view = await login('admin')
assert.ok(screen(view).includes('41명'), 'Overview uses the API total')
feedback = [
  firstFeedback,
  { ...firstFeedback, id: 2, title: '확인 중인 의견', status: 'in_progress', kind: 'accurate' },
  { ...firstFeedback, id: 3, title: '완료된 의견', status: 'resolved', kind: 'accurate' },
  { ...firstFeedback, id: 4, title: '오탐 의견', status: 'resolved', kind: 'false_positive' },
  { ...firstFeedback, id: 5, title: '미탐 의견', status: 'resolved', kind: 'false_negative' },
  { ...firstFeedback, id: 6, title: '다른 대기 의견', status: 'pending', kind: 'suggestion' },
]
const overviewRequestsBeforeRefresh = calls.filter(
  (call) => call.path === '/api/admin/audit-logs',
).length
let finishOverviewRefresh
overrides['GET /api/admin/users'] = () =>
  new Promise((resolve) => {
    finishOverviewRefresh = () => resolve(Response.json({ items: [account], total: 41 }))
  })
await act(async () => {
  findButton(view, '운영현황').props.onClick()
  await Promise.resolve()
})
assert.ok(screen(view).includes('전체 피드백1건'))
assert.ok(screen(view).includes('최신 내용 확인 중…'))
assert.ok(!screen(view).includes('불러오는 중…'))
await act(async () => finishOverviewRefresh())
delete overrides['GET /api/admin/users']
assert.ok(
  calls.filter((call) => call.path === '/api/admin/audit-logs').length >
    overviewRequestsBeforeRefresh,
)
assert.ok(screen(view).includes('전체 피드백6건'))
assert.deepEqual(
  view.root
    .findByProps({ className: 'overview-status-legend' })
    .findAllByType('strong')
    .map((node) => text(node)),
  ['2건', '1건', '3건'],
)
assert.deepEqual(
  view.root
    .findByProps({ className: 'overview-kind-chart' })
    .findAllByType('strong')
    .map((node) => text(node)),
  ['1건', '1건', '2건', '2건'],
)
assert.equal(
  view.root
    .findByProps({ 'aria-labelledby': 'overview-feedback-title' })
    .findByProps({ className: 'overview-recent-list' })
    .findAllByType('li').length,
  5,
)
await click(view, '첫 의견 피드백 처리')
assert.equal(findButton(view, '운영현황').props['aria-current'], 'page')
assert.ok(screen(view).includes('피드백 처리'))
assert.equal(view.root.findByType('dialog').props['aria-label'], '피드백 처리')
assert.equal(view.root.findByProps({ id: 'process-status' }).props.value, 'pending')
assert.ok(!calls.some((call) => call.path === '/api/admin/feedback/1' && call.method === 'GET'))
await change(view, { id: 'process-status' }, 'in_progress')
await change(view, { id: 'admin-note' }, '운영현황에서 확인했어요')
overrides['PATCH /api/admin/feedback/1'] = () =>
  Response.json({ detail: '운영현황 저장 실패' }, { status: 503 })
await submit(view)
assert.ok(text(view.root.findByType('dialog')).includes('운영현황 저장 실패'))
delete overrides['PATCH /api/admin/feedback/1']
const overviewRequestsBeforeSave = calls.filter(
  (call) => call.path === '/api/admin/audit-logs',
).length
await submit(view)
assert.equal(view.root.findAllByType('dialog').length, 0)
assert.equal(findButton(view, '운영현황').props['aria-current'], 'page')
assert.equal(feedback[0].status, 'in_progress')
assert.equal(feedback[0].admin_note, '운영현황에서 확인했어요')
assert.ok(screen(view).includes('처리 상태와 답변을 저장했어요'))
assert.ok(
  calls.filter((call) => call.path === '/api/admin/audit-logs').length > overviewRequestsBeforeSave,
)
assert.deepEqual(
  view.root
    .findByProps({ className: 'overview-status-legend' })
    .findAllByType('strong')
    .map((node) => text(node)),
  ['1건', '2건', '3건'],
)
await click(view, '피드백 #1 처리 팝업 열기')
assert.equal(findButton(view, '운영현황').props['aria-current'], 'page')
assert.ok(screen(view).includes('피드백 처리'))
assert.equal(view.root.findByType('dialog').props['aria-label'], '피드백 처리')
assert.equal(view.root.findByProps({ id: 'process-status' }).props.value, 'in_progress')
await click(view, '창 닫기')
await click(view, '계정 관리 페이지로 이동')
assert.equal(findButton(view, '계정 관리').props['aria-current'], 'page')
await click(view, '운영현황')
await act(async () =>
  view.root
    .findByProps({ 'aria-labelledby': 'overview-feedback-title' })
    .findByProps({ className: 'overview-list-heading' })
    .findByType('button')
    .props.onClick(),
)
assert.equal(findButton(view, '고객 피드백 관리').props['aria-current'], 'page')
await click(view, '운영현황')
assert.equal(
  view.root.findByProps({ 'aria-label': '나의 프로필로 이동' }).findByType('span').props.children,
  '회원',
)
await click(view, '계정 관리')
assert.ok(screen(view).includes(user.email))
await change(view, { 'aria-label': `${user.email} 상태` }, 'inactive')
assert.equal(account.status, 'inactive')
assert.ok(screen(view).includes('사용자 정보를 저장했어요'))
await click(view, '다음')
assert.ok(
  calls.some((call) => call.path === '/api/admin/users' && call.query.get('offset') === '20'),
)
const accountRequestsBeforeRefresh = calls.filter(
  (call) => call.path === '/api/admin/users' && call.query.get('offset') === '20',
).length
await click(view, '계정 관리')
assert.ok(
  calls.filter((call) => call.path === '/api/admin/users' && call.query.get('offset') === '20')
    .length > accountRequestsBeforeRefresh,
)
const usersRequestsBeforeFeedback = calls.filter((call) => call.path === '/api/admin/users').length
await click(view, '고객 피드백 관리')
assert.ok(calls.some((call) => call.path === '/api/admin/feedback'))
const feedbackRequestsBeforeRefresh = calls.filter(
  (call) => call.path === '/api/admin/feedback',
).length
let finishFeedbackRefresh
overrides['GET /api/admin/feedback'] = () =>
  new Promise((resolve) => {
    finishFeedbackRefresh = () =>
      resolve(Response.json({ items: feedback, total: feedback.length, limit: 20, offset: 0 }))
  })
await act(async () => {
  findButton(view, '고객 피드백 관리').props.onClick()
  await Promise.resolve()
})
assert.ok(screen(view).includes('닉네임: 회원'))
assert.ok(screen(view).includes('최신 내용 확인 중…'))
await act(async () => finishFeedbackRefresh())
delete overrides['GET /api/admin/feedback']
assert.ok(
  calls.filter((call) => call.path === '/api/admin/feedback').length >
    feedbackRequestsBeforeRefresh,
)
assert.ok(
  calls.filter((call) => call.path === '/api/admin/users').length > usersRequestsBeforeFeedback,
)
assert.ok(screen(view).includes('닉네임: 회원'))
await click(view, '첫 의견 피드백 처리')
assert.equal(view.root.findByType('dialog').props['aria-label'], '피드백 처리')
await change(view, { id: 'process-status' }, 'resolved')
await change(view, { id: 'admin-note' }, '확인했습니다')
overrides['PATCH /api/admin/feedback/1'] = () =>
  Response.json({ detail: '저장 실패' }, { status: 503 })
await submit(view)
assert.ok(text(view.root.findByType('dialog')).includes('저장 실패'))
delete overrides['PATCH /api/admin/feedback/1']
await submit(view)
assert.equal(view.root.findAllByType('dialog').length, 0)
assert.equal(feedback[0].status, 'resolved')
assert.equal(feedback[0].admin_note, '확인했습니다')
const adminRequestsBeforeOwnFeedback = calls.filter((call) =>
  call.path.startsWith('/api/admin/'),
).length
await click(view, '내 피드백')
assert.ok(findButton(view, '+ 피드백 작성'))
assert.ok(screen(view).includes('닉네임: 회원'))
assert.equal(
  calls.filter((call) => call.path.startsWith('/api/admin/')).length,
  adminRequestsBeforeOwnFeedback,
)
await click(view, '+ 피드백 작성')
assert.ok(view.root.findByProps({ id: 'feedback-kind' }).findByProps({ value: 'accurate' }))
await click(view, '취소')
await click(view, '전체 피드백')
await click(view, '감사 로그')
assert.ok(screen(view).includes('수행자'))
assert.ok(screen(view).includes('피드백 #1'))
assert.ok(screen(view).includes('작성자'))
assert.ok(screen(view).includes('첫 의견'))
assert.ok(screen(view).includes('권한: 일반 사용자 → 관리자'))
assert.ok(screen(view).includes('처리 상태: 처리 대기 → 처리 완료'))
const auditRows = view.root
  .findByProps({ className: 'dashboard-panel table-panel audit-panel' })
  .findByType('tbody')
  .findAllByType('tr')
assert.deepEqual(
  view.root
    .findByProps({ className: 'dashboard-panel table-panel audit-panel' })
    .findByType('thead')
    .findAllByType('th')
    .map(text),
  ['활동', '수행자', '일시'],
)
assert.equal(auditRows[0].findAllByType('td').length, 3)
assert.ok(text(auditRows[0].findAllByType('td')[0]).includes('회원 계정 수정'))
assert.ok(!text(auditRows[0].findAllByType('td')[0]).includes('작성자'))
assert.ok(text(auditRows[1].findAllByType('td')[0]).includes('작성자 회원'))
assert.equal(text(auditRows[1].findAllByType('td')[1]), '회원')
assert.ok(
  !text(view.root.findByProps({ className: 'dashboard-panel table-panel audit-panel' })).includes(
    user.id,
  ),
)
assert.equal(
  view.root
    .findAllByProps({ className: 'audit-person' })
    .filter((node) => text(node).includes('회원')).length,
  4,
)
await act(async () => auditRows[0].findByProps({ className: 'audit-link' }).props.onClick())
assert.equal(findButton(view, '계정 관리').props['aria-current'], 'page')
await click(view, '감사 로그')
await act(async () =>
  view.root
    .findByProps({ className: 'dashboard-panel table-panel audit-panel' })
    .findByType('tbody')
    .findAllByType('tr')[1]
    .findByProps({ className: 'audit-link' })
    .props.onClick(),
)
assert.equal(findButton(view, '고객 피드백 관리').props['aria-current'], 'page')
assert.ok(screen(view).includes('피드백 처리'))
assert.equal(view.root.findByType('dialog').props['aria-label'], '피드백 처리')
await click(view, '창 닫기')
await click(view, '감사 로그')
assert.ok(
  calls.some(
    (call) =>
      call.path === '/api/admin/users' &&
      call.query.get('limit') === '100' &&
      call.query.get('offset') === '0',
  ),
)
overrides['GET /api/admin/audit-logs'] = () =>
  Response.json({
    items: [
      {
        id: 12,
        actor_id: 'admin-1',
        target_type: 'feedback',
        target_id: '12',
        action: 'delete',
        old_data: { user_id: 'writer-101', title: '두 번째 페이지의 작성자' },
        new_data: { user_id: 'writer-101', title: '두 번째 페이지의 작성자' },
        created_at: user.created_at,
      },
    ],
    total: 1,
  })
overrides['GET /api/admin/users'] = (_options, parsed) => {
  const offset = Number(parsed.searchParams.get('offset'))
  const items =
    offset === 0
      ? [
          { id: 'admin-1', display_name: '담당 관리자' },
          ...Array.from({ length: 99 }, (_, index) => ({
            id: `other-${index}`,
            display_name: `다른 사용자 ${index}`,
          })),
        ]
      : [{ id: 'writer-101', display_name: '피드백 작성자' }]
  return Response.json({ items, total: 101, limit: 100, offset })
}
await click(view, '감사 로그')
assert.ok(screen(view).includes('담당 관리자'))
assert.ok(screen(view).includes('피드백 작성자'))
assert.ok(screen(view).includes('피드백 삭제'))
await act(async () =>
  view.root
    .findByProps({ className: 'dashboard-panel table-panel audit-panel' })
    .findByType('tbody')
    .findByProps({ className: 'audit-link' })
    .props.onClick(),
)
assert.equal(findButton(view, '고객 피드백 관리').props['aria-current'], 'page')
assert.ok(screen(view).includes('이 피드백은 삭제되었거나 더 이상 조회할 수 없어요.'))
await click(view, '감사 로그')
assert.ok(
  !text(view.root.findByProps({ className: 'dashboard-panel table-panel audit-panel' })).includes(
    'writer-101',
  ),
)
assert.ok(
  calls.some((call) => call.path === '/api/admin/users' && call.query.get('offset') === '100'),
)
await unmount(view)
console.log('PASS admin user updates/pagination, feedback processing/scope and audit logs')

// [UI-03] 기능·역할: 닉네임 미등록 안내 검사. 수행 이유: 두 역할 모두 빈 이름을 같은 문구로 표시해야 합니다.
for (const role of ['user', 'admin']) {
  view = await login(role)
  account.display_name = '   '
  await click(view, role === 'admin' ? '고객 피드백 관리' : '고객 피드백')
  assert.ok(screen(view).includes('닉네임: 닉네임 없음'))
  await unmount(view)
}
console.log(
  'PASS shared feedback nicknames, own-profile lookup, updated names and empty-name fallback',
)

mockApi()
view = await mount()
await click(view, '로그인')
await click(view, '회원가입')
await change(view, { id: 'login-email' }, user.email)
await change(view, { id: 'login-password' }, 'password-for-test')
await change(view, { id: 'login-password-confirm' }, 'different-password')
await submit(view)
assert.ok(screen(view).includes('서로 일치하지 않습니다'))
assert.ok(!calls.some((call) => call.path === '/api/auth/register'))
await change(view, { id: 'login-password-confirm' }, 'password-for-test')
await submit(view)
assert.ok(screen(view).includes('이메일 인증 후 로그인'))
await unmount(view)

view = await login()
overrides['GET /api/feedback'] = () => Response.json({ detail: 'Expired' }, { status: 401 })
await click(view, '고객 피드백')
assert.ok(screen(view).includes('로그인이 만료되었습니다'))
assert.equal(sessionStorage.size, 0)
assert.ok(view.root.findByProps({ id: 'login-email' }))
await unmount(view)
console.log('PASS registration validation/confirmation and protected API expiry')

mockApi()
view = await mount()
await click(view, '로그인')
await click(view, '회원가입')
await change(view, { id: 'login-password' }, 'private-password')
assert.equal(view.root.findAllByProps({ className: 'login-home' }).length, 0)
await act(async () => view.root.findByProps({ className: 'login-brand' }).props.onClick())
assert.ok(screen(view).includes('내 카메라 확인하기'))
await click(view, '로그인')
assert.equal(view.root.findByProps({ id: 'login-password' }).props.value, '')
assert.ok(screen(view).includes('계정으로 로그인하고'))
await unmount(view)

view = await login()
await click(view, '고객 피드백')
const loginCount = calls.filter((call) => call.path === '/api/auth/login').length
await clickHome(view)
assert.ok(screen(view).includes('서비스 화면으로 돌아가기'))
assert.ok(findButton(view, '로그아웃'))
assert.equal(
  view.root.findByProps({ 'aria-label': '나의 프로필로 이동' }).findByType('span').props.children,
  '회원',
)
await act(async () => view.root.findByProps({ 'aria-label': '나의 프로필로 이동' }).props.onClick())
assert.equal(findButton(view, '나의 프로필').props['aria-current'], 'page')
await clickHome(view)
await act(async () => view.root.findByProps({ className: 'landing-cta' }).props.onClick())
assert.equal(view.root.findByProps({ 'aria-label': '실시간 카메라' }).props.hidden, false)
assert.equal(findButton(view, '실시간 보기').props['aria-current'], 'page')
assert.equal(calls.filter((call) => call.path === '/api/auth/login').length, loginCount)
await clickHome(view)
await click(view, '로그아웃')
assert.ok(findButton(view, '로그인'))
assert.ok(screen(view).includes('내 카메라 확인하기'))
await unmount(view)
console.log('PASS NoteCam home button, authenticated home round trip and landing logout')

mockApi()
let pendingSignal
let finishProfile
// Header profile data remains active across pages, then aborts on logout.
overrides['GET /api/users/me'] = (options) => {
  pendingSignal = options.signal
  return new Promise((resolve) => {
    finishProfile = resolve
  })
}
view = await mount()
await click(view, '로그인')
await change(view, { id: 'login-email' }, user.email)
await change(view, { id: 'login-password' }, 'password-for-test')
await submit(view)
await click(view, '고객 피드백')
assert.equal(pendingSignal.aborted, false)
await click(view, '로그아웃')
assert.equal(pendingSignal.aborted, true)
await act(async () => finishProfile(Response.json(user)))
assert.ok(screen(view).includes('내 카메라 확인하기'))
await unmount(view)
console.log('PASS shared profile request stays active across pages and cancels on logout')

const sessionKey = 'notecam:session:v1:http://127.0.0.1:8000'
const seedSession = () =>
  sessionStorage.set(
    sessionKey,
    JSON.stringify({
      accessToken: 'test-token',
      expiresAt: Date.now() + 3600000,
    }),
  )

for (const role of ['user', 'admin']) {
  view = await login(role)
  const saved = JSON.parse(sessionStorage.get(sessionKey))
  assert.deepEqual(Object.keys(saved).sort(), ['accessToken', 'expiresAt', 'refreshToken'])
  assert.ok(saved.expiresAt > Date.now())
  assert.equal(saved.refreshToken, 'test-refresh-token')
  assert.ok(!sessionStorage.get(sessionKey).includes('password-for-test'))
  await unmount(view)
  calls = []
  view = await mount()
  assert.equal(calls.filter((call) => call.path === '/api/auth/login').length, 0)
  assert.equal(
    calls.find((call) => call.path === '/api/auth/me').options.headers.Authorization,
    'Bearer test-token',
  )
  assert.equal(view.root.findAllByProps({ className: 'dashboard-top' }).length, 1)
  assert.equal(
    view.root.findAllByType('button').some((node) => text(node.props.children) === '계정 관리'),
    role === 'admin',
  )
  await click(view, '로그아웃')
  assert.equal(sessionStorage.size, 0)
  await unmount(view)
}
console.log('PASS user/admin reload restoration, token-only storage and logout cleanup')

mockApi()
seedSession()
// Even an old or tampered role in storage must not grant administrator UI access.
sessionStorage.set(
  sessionKey,
  JSON.stringify({ ...JSON.parse(sessionStorage.get(sessionKey)), role: 'admin' }),
)
let finishRestore
overrides['GET /api/auth/me'] = () =>
  new Promise((resolve) => {
    finishRestore = resolve
  })
view = await mount()
assert.ok(screen(view).includes('로그인 상태를 확인하고 있어요'))
assert.deepEqual(
  calls.map((call) => call.path),
  ['/api/auth/me'],
)
await act(async () => finishRestore(Response.json({ id: user.id, role: 'user' })))
assert.equal(
  view.root.findAllByType('button').some((node) => text(node.props.children) === '계정 관리'),
  false,
)
await unmount(view)
console.log('PASS server role verification before rendering protected pages')

mockApi()
seedSession()
let restoreSignal
overrides['GET /api/auth/me'] = (options) => {
  restoreSignal = options.signal
  return new Promise((resolve) => {
    finishRestore = resolve
  })
}
view = await mount()
await unmount(view)
assert.equal(restoreSignal.aborted, true)
await act(async () => finishRestore(Response.json({ detail: 'Late rejection' }, { status: 401 })))
assert.ok(sessionStorage.has(sessionKey), 'A cancelled restore must not clear a subsequent session')
console.log('PASS cancelled restoration ignores late authentication responses')

for (const status of [401, 403]) {
  mockApi()
  seedSession()
  overrides['GET /api/auth/me'] = () => Response.json({ detail: 'Rejected' }, { status })
  view = await mount()
  assert.equal(sessionStorage.size, 0)
  assert.ok(view.root.findByProps({ id: 'login-email' }))
  assert.ok(screen(view).includes('로그인이 만료되었습니다'))
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/api/auth/me', '/api/discord/config'],
  )
  await unmount(view)
}

for (const value of [
  'broken-json',
  JSON.stringify({ accessToken: 'test-token', expiresAt: Date.now() - 1 }),
]) {
  mockApi()
  sessionStorage.set(sessionKey, value)
  view = await mount()
  assert.equal(sessionStorage.size, 0)
  assert.equal(calls.length, 0)
  assert.ok(screen(view).includes('내 카메라 확인하기'))
  await unmount(view)
}
console.log('PASS unauthorized, expired and malformed saved-session cleanup')

mockApi()
seedSession()
overrides['GET /api/auth/me'] = () => Response.json({ detail: 'Unavailable' }, { status: 503 })
view = await mount()
assert.ok(screen(view).includes('로그인 상태를 확인하지 못했어요'))
assert.ok(sessionStorage.has(sessionKey))
assert.deepEqual(
  calls.map((call) => call.path),
  ['/api/auth/me'],
)
delete overrides['GET /api/auth/me']
await click(view, '다시 시도')
assert.equal(view.root.findAllByProps({ className: 'dashboard-top' }).length, 1)
await unmount(view)

mockApi()
seedSession()
overrides['GET /api/auth/me'] = () => Response.json({ detail: 'Unavailable' }, { status: 503 })
view = await mount()
await click(view, '다시 로그인')
assert.equal(sessionStorage.size, 0)
assert.ok(view.root.findByProps({ id: 'login-email' }))
await unmount(view)
console.log('PASS temporary restoration failure retry and explicit sign-in fallback')

// Expired stored access tokens are restored with a rotated refresh token.
mockApi()
sessionStorage.set(
  sessionKey,
  JSON.stringify({
    accessToken: 'expired-token',
    refreshToken: 'stored-refresh',
    expiresAt: Date.now() - 1000,
  }),
)
overrides['POST /api/auth/refresh'] = (options) => {
  assert.equal(JSON.parse(options.body).refresh_token, 'stored-refresh')
  currentAccessToken = 'restored-token'
  return Response.json({
    access_token: currentAccessToken,
    refresh_token: 'next-refresh',
    expires_in: 30,
  })
}
view = await mount()
assert.ok(view.root.findByProps({ className: 'dashboard-top' }))
assert.equal(JSON.parse(sessionStorage.get(sessionKey)).refreshToken, 'next-refresh')
assert.equal(calls.filter((call) => call.path === '/api/auth/refresh').length, 1)
await unmount(view)

mockApi()
sessionStorage.set(
  sessionKey,
  JSON.stringify({
    accessToken: 'expired-token',
    refreshToken: 'revoked-refresh',
    expiresAt: Date.now() - 1000,
  }),
)
overrides['POST /api/auth/refresh'] = () => Response.json({ detail: 'Revoked' }, { status: 401 })
view = await mount()
assert.equal(sessionStorage.size, 0)
assert.ok(screen(view).includes('로그인이 만료되었습니다'))
await unmount(view)

view = await login()
const refreshNow = Date.now
Date.now = () => refreshNow() + 3570000
let resolveLateRefresh
overrides['POST /api/auth/refresh'] = () =>
  new Promise((resolve) => {
    resolveLateRefresh = resolve
  })
await act(async () => windowEvents.dispatchEvent(new Event('focus')))
await click(view, '로그아웃')
await act(async () =>
  resolveLateRefresh(
    Response.json({
      access_token: 'late-token',
      refresh_token: 'late-refresh',
      expires_in: 3600,
    }),
  ),
)
assert.equal(sessionStorage.size, 0)
assert.ok(screen(view).includes('내 카메라 확인하기'))
Date.now = refreshNow
await unmount(view)

view = await login()
Date.now = () => refreshNow() + 3570000
let verifyRenewedIdentity = false
overrides['POST /api/auth/refresh'] = () =>
  Response.json({
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    expires_in: 3600,
  })
overrides['GET /api/auth/me'] = () =>
  verifyRenewedIdentity
    ? Response.json({ id: user.id, role: 'user' })
    : Response.json({ detail: 'Temporary outage' }, { status: 503 })
await act(async () => windowEvents.dispatchEvent(new Event('focus')))
assert.equal(JSON.parse(sessionStorage.get(sessionKey)).refreshToken, 'new-refresh')
assert.ok(view.root.findByProps({ className: 'dashboard-top' }))
verifyRenewedIdentity = true
currentAccessToken = 'new-access'
await act(async () => windowEvents.dispatchEvent(new Event('focus')))
assert.equal(calls.filter((call) => call.path === '/api/auth/refresh').length, 1)
assert.equal(JSON.parse(sessionStorage.get(sessionKey)).accessToken, currentAccessToken)
Date.now = refreshNow
await unmount(view)
console.log(
  'PASS expired-session renewal, revoked credentials, late logout responses and identity retry after rotation',
)

const originalNow = Date.now
const originalAddEventListener = window.addEventListener
const originalRemoveEventListener = window.removeEventListener
let focusHandler
let clock = originalNow()
try {
  Date.now = () => clock
  window.addEventListener = (event, handler) => {
    if (event === 'focus') focusHandler = handler
  }
  window.removeEventListener = (event, handler) => {
    if (event === 'focus' && focusHandler === handler) focusHandler = null
  }
  view = await login()
  clock += 3600001
  await act(async () => focusHandler())
  assert.equal(sessionStorage.size, 0)
  assert.ok(screen(view).includes('로그인이 만료되었습니다'))
  await unmount(view)
} finally {
  Date.now = originalNow
  window.addEventListener = originalAddEventListener
  window.removeEventListener = originalRemoveEventListener
}

const originalStorage = window.sessionStorage
try {
  window.sessionStorage = {
    getItem() {
      throw new Error('Storage blocked')
    },
    setItem() {
      throw new Error('Storage blocked')
    },
    removeItem() {
      throw new Error('Storage blocked')
    },
  }
  view = await login()
  assert.equal(view.root.findAllByProps({ className: 'dashboard-top' }).length, 1)
  await unmount(view)
} finally {
  window.sessionStorage = originalStorage
}
console.log('PASS active-session expiry and memory-only login when storage is blocked')

view = await login()
assert.equal(view.root.findAllByProps({ className: 'notification-dropdown' }).length, 0)
assert.equal(
  view.root.findAllByProps({ className: 'dashboard-panel notice-panel' }).length,
  0,
  'The live page must not retain the old notifications panel',
)
await click(view, '알림')
assert.equal(view.root.findByProps({ 'aria-label': '알림' }).props['aria-expanded'], true)
assert.ok(view.root.findAllByProps({ className: 'notification-badge' }).length > 0)
assert.ok(
  view.root
    .findByProps({ className: 'dashboard-top' })
    .findByProps({ className: 'notification-dropdown' }),
)
await act(async () =>
  view.root
    .findByProps({ className: 'notification-menu' })
    .props.onKeyDown({ key: 'Escape', preventDefault() {} }),
)
assert.equal(view.root.findAllByProps({ className: 'notification-dropdown' }).length, 0)
await click(view, '알림')
await click(view, '알림')
assert.equal(view.root.findAllByProps({ className: 'notification-dropdown' }).length, 0)
await click(view, '알림')
await act(async () =>
  view.root.findByProps({ className: 'notification-menu' }).props.onBlur({
    currentTarget: { contains: () => false },
    relatedTarget: null,
  }),
)
assert.equal(
  view.root.findAllByProps({ className: 'notification-dropdown' }).length,
  1,
  'Clicking non-focusable content inside the panel must keep it open',
)
await act(async () =>
  view.root.findByProps({ className: 'notification-menu' }).props.onBlur({
    currentTarget: { contains: () => false },
    relatedTarget: {},
  }),
)
assert.equal(view.root.findAllByProps({ className: 'notification-dropdown' }).length, 0)
assert.equal(
  view.root.findAllByProps({ className: 'notification-toast' }).length,
  0,
  'Existing notifications must not pop up on login',
)
await click(view, '분석 설정')
assert.equal(view.root.findByProps({ type: 'checkbox' }).props.checked, false)
await act(async () =>
  view.root.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: true } }),
)
await submit(view)
assert.equal(questionSettings.notify_on_uncertain, true)
await act(async () => view.root.findByProps({ 'aria-label': '창 닫기' }).props.onClick())
await click(view, '나의 프로필')
const streamCount = calls.filter((call) => call.path === '/api/notifications/stream').length
notices.unshift({
  id: 2,
  event_id: 'b'.repeat(32) + '_e000001',
  verdict: 'uncertain',
  message: '새 사건을 확인해 주세요.',
  read: false,
  created_at: user.created_at,
})
const signal = new TextEncoder().encode(
  'event: notification.created\r\ndata: {"notification_id":2,"event_id":"' +
    notices[0].event_id +
    '"}\r\n\r\n',
)
await act(async () => {
  notificationStreams.at(-1).enqueue(signal.slice(0, 30))
  notificationStreams.at(-1).enqueue(signal.slice(30))
})
assert.ok(
  text(view.root.findByProps({ className: 'notification-toast' }).props.children).includes(
    '판단 어려움',
  ),
)
assert.equal(
  calls.filter((call) => call.path === '/api/notifications/stream').length,
  streamCount,
  'Page navigation must preserve the subscription',
)
await act(async () => view.root.findByProps({ 'aria-label': '알림 팝업 닫기' }).props.onClick())
await act(async () => notificationStreams.at(-1).enqueue(signal))
assert.equal(
  view.root.findAllByProps({ className: 'notification-toast' }).length,
  0,
  'Duplicate signals must not repeat a dismissed popup',
)
await click(view, '실시간 보기')
await click(view, '알림')
await act(async () =>
  view.root
    .findAllByProps({ className: 'notification-item' })
    .find((node) => text(node.props.children).includes('새 사건'))
    .props.onClick(),
)
assert.ok(screen(view).includes('사건 상세'))
assert.equal(notices[0].read, true)
assert.equal(
  view.root.findAllByProps({ className: 'notification-dropdown' }).length,
  0,
  'Selecting a notification must close the dropdown',
)
const activeStream = calls.findLast((call) => call.path === '/api/notifications/stream')
await act(async () => view.root.findByProps({ 'aria-label': '창 닫기' }).props.onClick())
await click(view, '로그아웃')
assert.equal(activeStream.options.signal.aborted, true)
await unmount(view)
console.log(
  'PASS notification setting, SSE chunk parsing, global popup, deduplication, event/read action and logout cleanup',
)

view = await login('user')
assert.equal(
  view.root.findAllByType('button').filter((node) => text(node.props.children) === '카메라 기록')
    .length,
  0,
)
await unmount(view)

view = await login('admin')
const cameraId = '11111111-1111-4111-8111-111111111111'
const ownerId = '22222222-2222-4222-8222-222222222222'
overrides['GET /api/admin/users'] = (_options, url) =>
  Response.json({
    items:
      url.searchParams.get('offset') === '0'
        ? [{ ...user }]
        : [{ id: ownerId, email: 'camera-owner@example.com' }],
    total: 101,
  })
const adminEventId = 'c'.repeat(32) + '_e000001'
const partId = '33333333-3333-4333-8333-333333333333'
const photoId = '44444444-4444-4444-8444-444444444444'
const analysisId = '55555555-5555-4555-8555-555555555555'
const adminQuestions = [
  { id: '66666666-6666-4666-8666-666666666666', question: '다른 사용자 카메라에 사람이 있나요?' },
]
const adminResult = {
  items: [
    {
      question_id: adminQuestions[0].id,
      verdict: 'confirmed',
      summary: '사람이 들어오는 모습이 확인됩니다.',
    },
  ],
}
const adminRecord = {
  id: analysisId,
  part_id: partId,
  origin: 'auto',
  model_name: 'gemini-test',
  status: 'succeeded',
  questions: adminQuestions,
  result: adminResult,
  created_at: user.created_at,
  finished_at: user.created_at,
  latency_ms: 1200,
}
overrides['GET /api/admin/cameras'] = (_options, url) =>
  Response.json(
    url.searchParams.get('offset') === '20'
      ? []
      : url.searchParams.get('user_id')
        ? [{ id: cameraId, owner_id: ownerId, name: '다른 사용자의 거실' }]
        : Array.from({ length: 20 }, (_, index) => ({
            id: index === 0 ? cameraId : `camera-${index}`,
            owner_id: ownerId,
            name: `사용자 카메라 ${index}`,
          })),
  )
overrides[`GET /api/admin/cameras/${cameraId}/events`] = () =>
  Response.json([
    {
      id: adminEventId,
      detected_at: user.created_at,
      analysis_status: 'succeeded',
      questions: adminQuestions,
      result: adminResult,
    },
  ])
overrides[`GET /api/admin/events/${adminEventId}/analysis`] = () =>
  Response.json({ ...adminRecord, event_id: adminEventId })
overrides[`GET /api/admin/events/${adminEventId}/parts`] = () =>
  Response.json([{ id: partId, part_index: 1 }])
overrides[`GET /api/admin/parts/${partId}`] = () =>
  Response.json({
    metadata: { start_sec: 0, end_sec: 5, context_complete: true, evidence_complete: true },
    photos: [{ id: photoId, sequence_no: 1, timestamp_sec: 1, upload_status: 'ready' }],
  })
overrides[`GET /api/admin/photos/${photoId}/content`] = () =>
  new Response(new Blob(['photo'], { type: 'image/jpeg' }))
overrides[`GET /api/admin/parts/${partId}/analyses`] = () => Response.json([adminRecord])
overrides[`GET /api/admin/analyses/${analysisId}`] = () => Response.json(adminRecord)
await click(view, '카메라 기록')
assert.ok(screen(view).includes('사용자 카메라 0'))
assert.ok(
  text(view.root.findByProps({ 'aria-label': '카메라 소유 사용자 선택' })).includes(
    `camera-owner@example.com · ${ownerId}`,
  ),
)
assert.ok(
  calls.some((call) => call.path === '/api/admin/users' && call.query.get('offset') === '100'),
)
assert.ok(
  view.root
    .findByProps({ 'aria-label': '관리자 카메라 목록' })
    .findAllByType('td')
    .some((cell) => text(cell) === 'camera-owner@example.com'),
)
await click(view, '다음 카메라')
assert.ok(screen(view).includes('조회된 카메라가 없습니다.'))
assert.ok(
  calls.some((call) => call.path === '/api/admin/cameras' && call.query.get('offset') === '20'),
)
await click(view, '이전 카메라')
await change(view, { 'aria-label': '카메라 소유 사용자 선택' }, ownerId)
await submit(view)
assert.ok(
  calls.some((call) => call.path === '/api/admin/cameras' && call.query.get('user_id') === ownerId),
)
await click(view, '다른 사용자의 거실 기록 보기')
assert.ok(screen(view).includes(adminResult.items[0].summary))
await click(view, `${adminEventId} 사건 상세 보기`)
assert.ok(screen(view).includes(adminQuestions[0].question))
assert.equal(view.root.findAllByProps({ 'aria-label': '사건 평가·피드백' }).length, 0)
assert.ok(
  view.root
    .findAllByType('img')
    .some((node) => node.props.alt === '감지 사진 1' && node.props.src.startsWith('blob:')),
)
assert.ok(
  calls.some(
    (call) =>
      call.path === `/api/admin/photos/${photoId}/content` &&
      call.options.headers.Authorization === 'Bearer test-token',
  ),
)
const history = view.root.findByProps({ 'aria-label': 'Gemini 분석 이력' })
await act(async () =>
  history
    .findAllByType('button')
    .find((node) => text(node.props.children).startsWith('자동'))
    .props.onClick(),
)
assert.ok(screen(view).includes('gemini-test'))
assert.ok(calls.some((call) => call.path === `/api/admin/analyses/${analysisId}`))
assert.ok(
  !calls.some(
    (call) =>
      call.path.startsWith('/api/motion/photos/') ||
      call.path.startsWith(`/api/motion/events/${adminEventId}`),
  ),
  'Other users evidence must use admin endpoints',
)
await act(async () => view.root.findByProps({ 'aria-label': '창 닫기' }).props.onClick())
overrides['GET /api/admin/cameras'] = () =>
  Response.json({ detail: '관리자 권한이 필요합니다.' }, { status: 403 })
await submit(view)
assert.ok(screen(view).includes('관리자 권한이 필요합니다.'))
overrides['GET /api/admin/cameras'] = () => Response.json({ detail: 'Expired' }, { status: 401 })
await click(view, '다시 시도')
assert.ok(screen(view).includes('로그인이 만료되었습니다'))
await unmount(view)
console.log(
  'PASS admin camera pagination/owner filter, other-user events/photos/analysis history and authorization errors',
)

// [UI-OV06] 기능·역할: 운영현황 실사용 흐름·집계·부분 오류 검사. 수행 이유: 예시 수치 없이 본인 API와 공통 알림만 사용하는지 확인합니다.
const overviewRunId = '6'.repeat(32)
const overviewCameraId = '66666666-6666-4666-8666-666666666666'
const overviewQuestionId = '77777777-7777-4777-8777-777777777777'
const overviewNow = Date.now()
const overviewEvents = Array.from({ length: 21 }, (_, index) => ({
  id: overviewRunId + `_e${String(index + 1).padStart(6, '0')}`,
  run_id: overviewRunId,
  detected_at: new Date(overviewNow - (index + 3) * 60000).toISOString(),
  capture_state: index === 4 ? 'collecting' : index === 3 ? 'interrupted' : 'closed',
  questions: [{ id: overviewQuestionId, question: '운영현황 상세 질문' }],
  analysis_status:
    index === 20
      ? 'failed'
      : ['succeeded', 'succeeded', 'failed', 'interrupted', 'collecting', 'waiting', 'running'][
          index
        ] || 'succeeded',
  result:
    index === 1
      ? {
          items: [
            {
              question_id: overviewQuestionId,
              verdict: 'uncertain',
              summary: '운영현황 판단 어려움 설명',
            },
            {
              question_id: '88888888-8888-4888-8888-888888888888',
              verdict: 'uncertain',
              summary: '같은 사건의 두 번째 판단 어려움',
            },
          ],
        }
      : index === 0 || (index > 6 && index < 20)
        ? {
            items: [
              {
                question_id: overviewQuestionId,
                verdict: index === 7 ? 'not_confirmed' : 'confirmed',
                summary: `운영현황 기록 ${index + 1}`,
              },
            ],
          }
        : null,
}))
view = await login('user', overviewEvents)
overviewRuns = [
  {
    id: overviewRunId,
    camera_id: overviewCameraId,
    status: 'starting',
    requested_at: user.created_at,
    started_at: user.created_at,
    finished_at: null,
  },
]
overviewCameras = [{ id: overviewCameraId, name: '내 거실 카메라' }]
overrides[`GET /api/motion/runs/${overviewRunId}`] = () =>
  Response.json({ ...overviewRuns[0], status: 'running' })
feedback = Array.from({ length: 25 }, (_, index) => ({
  ...firstFeedback,
  id: index + 1,
  status: index < 23 ? 'pending' : 'resolved',
}))
notices = Array.from({ length: 6 }, (_, index) => ({
  id: index + 10,
  event_id: overviewEvents[0].id,
  message: `운영현황 알림 ${index + 1}`,
  verdict: 'confirmed',
  created_at: user.created_at,
  read: ![0, 1, 5].includes(index),
}))
const overviewStreamsBefore = calls.filter(
  (call) => call.path === '/api/notifications/stream',
).length
await click(view, '내 대시보드')
await click(view, '내 대시보드 새로고침')
const overviewRoot = () => view.root.findByProps({ className: 'user-overview' })
const overviewCardText = (label) => text(overviewRoot().findByProps({ 'aria-label': label }))
// [UI-CAM03] 기능·역할: 과거 실행과 현재 카메라 상태 분리 검사. 수행 이유: 서버의 최근 작업이 running이어도 이 브라우저가 촬영하지 않으면 OFF여야 합니다.
assert.ok(overviewCardText('현재 카메라 상태').includes('CAMERA OFF'))
assert.ok(overviewCardText('현재 카메라 상태').includes('현재 브라우저의 카메라 사용 기준'))
assert.ok(!calls.some((call) => call.path === '/api/motion/runs'))
assert.ok(!calls.some((call) => call.path === '/api/motion/cameras'))
assert.ok(overviewCardText('마지막 움직임').includes('3분 전'))
assert.ok(
  overviewCardText('확인이 필요한 기록').includes('3건'),
  'Count each uncertain event once and exclude the 21st event',
)
assert.ok(
  overviewCardText('처리 대기 내 피드백').includes('23건'),
  'Use total, not the one returned feedback row',
)
assert.deepEqual(
  overviewRoot()
    .findByProps({ className: 'user-overview-status-legend' })
    .findAllByType('strong')
    .map(text),
  ['15건', '1건', '1건', '1건', '1건', '1건'],
)
assert.ok(text(overviewRoot()).includes('최근 20건 기준'))
assert.ok(
  text(overviewRoot()).includes('최근 5건 중 미확인 2건'),
  'Unread count must match only the five displayed notifications',
)
assert.equal(
  overviewRoot()
    .findByProps({ 'aria-labelledby': 'user-overview-events-title' })
    .findAllByType('li').length,
  5,
)
assert.equal(
  overviewRoot()
    .findByProps({ 'aria-labelledby': 'user-overview-notifications-title' })
    .findAllByType('li').length,
  5,
)
assert.equal(
  calls.filter((call) => call.path === '/api/notifications/stream').length,
  overviewStreamsBefore,
)
assert.ok(!calls.some((call) => call.path.startsWith('/api/admin/')))
assert.ok(!calls.some((call) => call.path === '/api/motion/questions'))
assert.ok(
  calls.some(
    (call) =>
      call.path === '/api/feedback' &&
      call.query.get('status') === 'pending' &&
      call.query.get('limit') === '1',
  ),
)
await click(view, '최근 20건 보기 →')
assert.equal(
  overviewRoot()
    .findByProps({ 'aria-labelledby': 'user-overview-events-title' })
    .findAllByType('li').length,
  20,
)
// [UI-OV08] 기능·역할: 실제 상태별 배지 구분 검사. 수행 이유: 확인됨·판단 어려움·실패·중단·진행·미확인이 시안의 다른 색상으로 연결되는지 확인합니다.
const overviewBadges = overviewRoot().findAll(
  (node) => node.type === 'span' && node.props.className?.startsWith('user-overview-pill '),
)
assert.deepEqual(
  overviewBadges.slice(0, 8).map((badge) => [text(badge), badge.props.className.split('-').at(-1)]),
  [
    ['확인됨', 'good'],
    ['판단 어려움', 'warn'],
    ['분석 실패', 'error'],
    ['촬영 중단', 'warn'],
    ['촬영 중', 'neutral'],
    ['분석 대기', 'neutral'],
    ['분석 중', 'neutral'],
    ['미확인', 'neutral'],
  ],
)
await click(view, '최근 5건 보기 →')
await click(view, '최근 20건 중 · 기록 확인 →')
assert.equal(view.root.findByType('dialog').findAllByType('li').length, 3)
await click(view, '창 닫기')
await click(view, `${overviewEvents[1].id} 내 대시보드 사건 상세 보기`)
assert.ok(screen(view).includes('운영현황 상세 질문'))
assert.ok(screen(view).includes('운영현황 판단 어려움 설명'))
await click(view, '창 닫기')
await click(view, '10 내 대시보드 알림 확인')
assert.equal(notices[0].read, true)
assert.ok(text(overviewRoot()).includes('최근 5건 중 미확인 1건'))
assert.equal(
  view.root.findAllByProps({ className: 'notification-badge' }).length,
  1,
  'The shared header still reflects unread notifications',
)
await click(view, '창 닫기')
overrides['GET /api/motion/events'] = () =>
  Response.json({ detail: '움직임 조회 실패 검사' }, { status: 503 })
await click(view, '내 대시보드 새로고침')
assert.ok(overviewCardText('마지막 움직임').includes('조회 불가'))
assert.ok(overviewCardText('확인이 필요한 기록').includes('조회 불가'))
assert.ok(overviewCardText('현재 카메라 상태').includes('CAMERA OFF'))
assert.ok(overviewCardText('처리 대기 내 피드백').includes('23건'))
assert.ok(
  !text(overviewRoot().findByProps({ 'aria-labelledby': 'user-overview-events-title' })).includes(
    '최근 0건',
  ),
  'Failed reads must not be described as an empty result',
)
delete overrides['GET /api/motion/events']
overrides[`GET /api/motion/runs/${overviewRunId}`] = () =>
  Response.json({ detail: '실행 조회 실패 검사' }, { status: 503 })
overrides['GET /api/feedback'] = () =>
  Response.json({ detail: '피드백 조회 실패 검사' }, { status: 503 })
overrides['GET /api/notifications'] = () =>
  Response.json({ detail: '알림 조회 실패 검사' }, { status: 503 })
await click(view, '내 대시보드 새로고침')
assert.ok(overviewCardText('현재 카메라 상태').includes('CAMERA OFF'))
assert.ok(overviewCardText('처리 대기 내 피드백').includes('조회 불가'))
assert.ok(!overviewCardText('처리 대기 내 피드백').includes('0건'))
assert.ok(
  text(
    overviewRoot().findByProps({ 'aria-labelledby': 'user-overview-notifications-title' }),
  ).includes('알림 조회 실패 검사'),
)
assert.ok(!text(overviewRoot()).includes('최근 5건 중 미확인 0건'))
assert.equal(
  overviewRoot().findByProps({ className: 'user-overview-status-legend' }).findAllByType('li')
    .length,
  6,
)
delete overrides[`GET /api/motion/runs/${overviewRunId}`]
delete overrides['GET /api/feedback']
delete overrides['GET /api/notifications']
motionEvents = []
overviewRuns = []
feedback = []
notices = []
await click(view, '내 대시보드 새로고침')
assert.ok(overviewCardText('현재 카메라 상태').includes('CAMERA OFF'))
assert.ok(overviewCardText('마지막 움직임').includes('기록 없음'))
assert.ok(overviewCardText('확인이 필요한 기록').includes('0건'))
assert.ok(overviewCardText('처리 대기 내 피드백').includes('0건'))
assert.ok(text(overviewRoot()).includes('아직 분석할 기록이 없어요.'))
assert.ok(text(overviewRoot()).includes('아직 받은 알림이 없어요.'))
assert.ok(!text(overviewRoot()).includes('현재 분석 기준'))
await click(view, '내 피드백 상태 보기 →')
assert.equal(findButton(view, '고객 피드백').props['aria-current'], 'page')
overrides['GET /api/motion/events'] = () => Response.json({ detail: 'Expired' }, { status: 401 })
await click(view, '내 대시보드')
assert.ok(screen(view).includes('로그인이 만료되었습니다'))
await unmount(view)
console.log(
  'PASS user overview: real API scopes, local camera state, bounded counts, shared notification reads, partial errors, empty state and expiry',
)

view = await login()
let overviewPendingSignal, finishOverview
overrides['GET /api/motion/events'] = (options) => {
  overviewPendingSignal = options.signal
  return new Promise((resolve) => {
    finishOverview = resolve
  })
}
await click(view, '내 대시보드')
delete overrides['GET /api/motion/events']
await click(view, '고객 피드백')
assert.equal(overviewPendingSignal.aborted, true)
await act(async () => finishOverview(Response.json([])))
assert.ok(screen(view).includes('첫 의견'))
await unmount(view)
console.log('PASS user overview cancels pending reads on navigation')

// [UI-CAM03] 기능·역할: 실시간 보기와 운영현황의 카메라 상태 통합 검사. 수행 이유: 실제 장치 대신 트랙 신호로 메뉴 이동·권한 거부·중지·로그아웃 동작을 확인합니다.
const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const savedCreateElement = document.createElement
let allowCamera, denyCamera, completeCameraStop
let cameraOpenRequests = 0
let slowCameraStop = false
const cameraTracks = []
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia: () => {
        cameraOpenRequests++
        return new Promise((resolve, reject) => {
          allowCamera = resolve
          denyCamera = reject
        })
      },
    },
  },
})
document.createElement = () => ({
  getContext: () => ({ drawImage() {} }),
  toBlob: (callback) => callback(new Blob(['jpeg'], { type: 'image/jpeg' })),
})
async function allowTestCamera() {
  const track = Object.assign(new EventTarget(), {
    label: '현재 브라우저 웹캠',
    readyState: 'live',
    enabled: true,
    muted: false,
    getSettings: () => ({ deviceId: 'camera-status-check' }),
    stop() {
      this.readyState = 'ended'
    },
  })
  cameraTracks.push(track)
  await act(async () => allowCamera({ getVideoTracks: () => [track], getTracks: () => [track] }))
  return track
}
view = await login()
const cameraRun = { id: '9'.repeat(32), status: 'running', camera_id: overviewCameraId }
overviewCameras = [{ id: overviewCameraId, name: '현재 브라우저 웹캠' }]
overrides['POST /api/motion/cameras'] = () => Response.json(overviewCameras[0])
overrides['POST /api/motion/runs'] = () => Response.json(cameraRun)
overrides[`GET /api/motion/runs/${cameraRun.id}`] = () => Response.json(cameraRun)
overrides[`POST /api/motion/runs/${cameraRun.id}/frames`] = () => Response.json({ accepted: true })
overrides[`POST /api/motion/runs/${cameraRun.id}/stop`] = () =>
  slowCameraStop
    ? new Promise((resolve) => {
        completeCameraStop = resolve
      })
    : Response.json({ ...cameraRun, status: 'stopped' })
await click(view, '내 대시보드')
assert.ok(overviewCardText('현재 카메라 상태').includes('CAMERA OFF'))
assert.equal(cameraOpenRequests, 0, 'Opening overview must not request camera permission')
await click(view, '실시간 보기')
await click(view, '카메라 녹화')
await click(view, '내 대시보드')
assert.ok(overviewCardText('현재 카메라 상태').includes('연결 중'))
const activeTrack = await allowTestCamera()
assert.ok(overviewCardText('현재 카메라 상태').includes('CAMERA ON'))
assert.ok(overviewCardText('현재 카메라 상태').includes(activeTrack.label))
await click(view, '고객 피드백')
await click(view, '내 대시보드')
assert.ok(overviewCardText('현재 카메라 상태').includes('CAMERA ON'))
assert.equal(cameraOpenRequests, 1, 'Navigation must reuse the existing camera stream')
await act(async () => {
  activeTrack.muted = true
  activeTrack.dispatchEvent(new Event('mute'))
})
assert.ok(overviewCardText('현재 카메라 상태').includes('연결 오류'))
await act(async () => {
  activeTrack.muted = false
  activeTrack.dispatchEvent(new Event('unmute'))
})
assert.ok(overviewCardText('현재 카메라 상태').includes('CAMERA ON'))
await act(async () => {
  activeTrack.readyState = 'ended'
  activeTrack.dispatchEvent(new Event('ended'))
})
assert.ok(overviewCardText('현재 카메라 상태').includes('연결 오류'))
assert.ok(overviewCardText('현재 카메라 상태').includes('연결이 끊겼'))
await click(view, '실시간 보기')
await click(view, '카메라 녹화')
await act(async () => denyCamera(new DOMException('Denied', 'NotAllowedError')))
await click(view, '내 대시보드')
assert.ok(overviewCardText('현재 카메라 상태').includes('카메라 권한이 거부'))
await click(view, '실시간 보기')
await click(view, '카메라 녹화')
await allowTestCamera()
slowCameraStop = true
await click(view, '녹화 중지')
await click(view, '내 대시보드')
assert.ok(overviewCardText('현재 카메라 상태').includes('CAMERA OFF'))
assert.equal(cameraTracks.at(-1).readyState, 'ended')
await act(async () => completeCameraStop(Response.json({ ...cameraRun, status: 'stopped' })))
slowCameraStop = false
await click(view, '실시간 보기')
await click(view, '카메라 녹화')
await allowTestCamera()
await click(view, '내 대시보드')
assert.ok(overviewCardText('현재 카메라 상태').includes('CAMERA ON'))
// Refresh twice concurrently while the same camera session continues uploading frames.
const realNow = Date.now
let completeRefresh
overrides['POST /api/auth/refresh'] = (options) => {
  assert.equal(JSON.parse(options.body).refresh_token, 'test-refresh-token')
  return new Promise((resolve) => {
    completeRefresh = resolve
  })
}
Date.now = () => realNow() + 3570000
await act(async () => {
  windowEvents.dispatchEvent(new Event('focus'))
  windowEvents.dispatchEvent(new Event('focus'))
})
assert.equal(calls.filter((call) => call.path === '/api/auth/refresh').length, 1)
const cameraStartsBeforeRefresh = calls.filter(
  (call) => call.path === '/api/motion/runs' && call.method === 'POST',
).length
const framesBeforeRefresh = calls.filter((call) => call.path.endsWith('/frames')).length
await act(async () => {
  currentAccessToken = 'renewed-token'
  completeRefresh(
    Response.json({
      access_token: currentAccessToken,
      refresh_token: 'rotated-refresh',
      expires_in: 3600,
    }),
  )
})
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 150))
})
assert.ok(calls.filter((call) => call.path.endsWith('/frames')).length > framesBeforeRefresh)
const renewedFrame = calls.filter((call) => call.path.endsWith('/frames')).at(-1)
assert.equal(renewedFrame.options.headers.Authorization, 'Bearer renewed-token')
assert.equal(
  calls.filter((call) => call.path === '/api/motion/runs' && call.method === 'POST').length,
  cameraStartsBeforeRefresh,
)
assert.equal(cameraTracks.at(-1).readyState, 'live')
assert.equal(JSON.parse(sessionStorage.get(sessionKey)).refreshToken, 'rotated-refresh')
Date.now = realNow
const stopRequestsBeforeRemoteTab = calls.filter((call) => call.path.endsWith('/stop')).length
const cameraOpensBeforeRemoteTab = cameraOpenRequests
await click(view, '다른 기기 보기')
assert.equal(findButton(view, '다른 기기 보기').props['aria-current'], 'page')
assert.equal(cameraTracks.at(-1).readyState, 'live')
await click(view, '실시간 보기')
assert.equal(cameraOpenRequests, cameraOpensBeforeRemoteTab)
assert.equal(
  calls.filter((call) => call.path.endsWith('/stop')).length,
  stopRequestsBeforeRemoteTab,
)
await click(view, '로그아웃')
assert.ok(cameraTracks.every((track) => track.readyState === 'ended'))
assert.equal(view.root.findAllByProps({ className: 'user-overview' }).length, 0)
await unmount(view)
// [UI-CAM04] 기능·역할: 사용자·관리자 미리보기 화면 검사. 수행 이유: 서버 전송 없는 미리보기, 상태 공유, 녹화 전환, 취소·권한 오류·로그아웃 정리를 확인합니다.
for (const role of ['user', 'admin']) {
  view = await login(role)
  overviewCameras = [{ id: overviewCameraId, name: '현재 브라우저 웹캠' }]
  overrides['POST /api/motion/cameras'] = () => Response.json(overviewCameras[0])
  overrides['POST /api/motion/runs'] = () => Response.json(cameraRun)
  overrides[`GET /api/motion/runs/${cameraRun.id}`] = () => Response.json(cameraRun)
  overrides[`POST /api/motion/runs/${cameraRun.id}/frames`] = () =>
    Response.json({ accepted: true })
  overrides[`POST /api/motion/runs/${cameraRun.id}/stop`] = () =>
    Response.json({ ...cameraRun, status: 'stopped' })
  await click(view, '실시간 보기')
  const motionWrites = () =>
    calls.filter((call) => call.path.startsWith('/api/motion/') && call.method !== 'GET')
  await click(view, '미리보기 켜기')
  assert.equal(findButton(view, '카메라 녹화').props.disabled, true)
  const localTrack = await allowTestCamera()
  assert.ok(text(view.root.findByProps({ className: 'camera-live' })).includes('미리보기 중'))
  assert.equal(motionWrites().length, 0)
  const opensBeforeNavigation = cameraOpenRequests
  await click(view, role === 'admin' ? '운영현황' : '내 대시보드')
  if (role === 'user') assert.ok(overviewCardText('현재 카메라 상태').includes('CAMERA ON'))
  assert.equal(localTrack.readyState, 'live')
  await click(view, '실시간 보기')
  assert.equal(cameraOpenRequests, opensBeforeNavigation)
  await click(view, '미리보기 끄기')
  assert.equal(localTrack.readyState, 'ended')
  assert.equal(motionWrites().length, 0)

  await click(view, '미리보기 켜기')
  const recordingTrack = await allowTestCamera()
  const opensBeforeRecording = cameraOpenRequests
  await click(view, '카메라 녹화')
  assert.equal(cameraOpenRequests, opensBeforeRecording)
  assert.ok(motionWrites().some((call) => call.path === '/api/motion/runs'))
  assert.ok(motionWrites().some((call) => call.path.endsWith('/frames')))
  assert.ok(text(view.root.findByProps({ className: 'camera-live' })).includes('녹화 중'))
  assert.equal(findButton(view, '미리보기 켜기').props.disabled, true)
  await click(view, '녹화 중지')
  assert.equal(recordingTrack.readyState, 'ended')

  await click(view, '미리보기 켜기')
  await click(view, '미리보기 준비 취소')
  const cancelledTrack = await allowTestCamera()
  assert.equal(cancelledTrack.readyState, 'ended')
  assert.equal(findButton(view, '미리보기 켜기').props['aria-pressed'], false)
  await click(view, '미리보기 켜기')
  await act(async () => denyCamera(new DOMException('Denied', 'NotAllowedError')))
  assert.ok(screen(view).includes('카메라 권한이 거부'))
  await click(view, '미리보기 켜기')
  const disconnectedTrack = await allowTestCamera()
  await act(async () => {
    disconnectedTrack.readyState = 'ended'
    disconnectedTrack.dispatchEvent(new Event('ended'))
  })
  assert.ok(screen(view).includes('카메라 연결이 끊겼'))
  await click(view, '미리보기 켜기')
  const logoutTrack = await allowTestCamera()
  const writesBeforeLogout = motionWrites().length
  await click(view, '로그아웃')
  assert.equal(logoutTrack.readyState, 'ended')
  assert.equal(motionWrites().length, writesBeforeLogout)
  await unmount(view)
}
if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator)
else delete globalThis.navigator
if (savedCreateElement) document.createElement = savedCreateElement
else delete document.createElement
console.log(
  'PASS shared camera controls, token rotation without capture restart, latest upload credentials and logout cleanup',
)

// Remote viewers only read existing runs and preview tickets; they never own a camera session.
view = await login()
await click(view, '실시간 보기')
await click(view, '다른 기기 보기')
assert.ok(screen(view).includes('촬영 중인 카메라가 없습니다'))
assert.equal(
  view.root.findByProps({ className: 'remote-camera-placeholder' }).findAllByType('button').length,
  0,
)
const remoteRun = { id: '8'.repeat(32), camera_id: overviewCameraId, status: 'running' }
overviewRuns = [remoteRun]
overviewCameras = [{ id: overviewCameraId, name: '집 노트북' }]
let ticketNumber = 0
overrides[`POST /api/motion/runs/${remoteRun.id}/preview-ticket`] = () =>
  Response.json({
    url: `/api/motion/runs/${remoteRun.id}/preview.mjpg?ticket=${++ticketNumber}`,
    expires_in: 60,
  })
const originalSetTimeout = globalThis.setTimeout
let renewPreview
globalThis.setTimeout = (callback, delay, ...args) => {
  const id = originalSetTimeout(callback, delay, ...args)
  if (delay === 48000)
    renewPreview = () => {
      clearTimeout(id)
      callback()
    }
  return id
}
await click(view, '정지')
await click(view, '재생')
assert.ok(
  view.root.findByProps({ className: 'remote-camera-image' }).props.src.endsWith('ticket=1'),
)
assert.equal(findButton(view, '다른 기기 보기').props['aria-current'], 'page')
assert.equal(view.root.findAllByProps({ className: 'record-control' }).length, 0)
assert.equal(
  calls.findLast((call) => call.path === '/api/motion/runs').query.get('active_only'),
  'true',
)
await act(async () => renewPreview())
assert.ok(
  view.root.findByProps({ className: 'remote-camera-image' }).props.src.endsWith('ticket=2'),
)
await act(async () => {
  document.hidden = true
  documentEvents.dispatchEvent(new Event('visibilitychange'))
})
assert.equal(view.root.findAllByProps({ className: 'remote-camera-image' }).length, 0)
await act(async () => {
  document.hidden = false
  documentEvents.dispatchEvent(new Event('visibilitychange'))
})
assert.ok(view.root.findByProps({ className: 'remote-camera-image' }))
await act(async () => view.root.findByProps({ className: 'remote-camera-image' }).props.onError())
assert.equal(view.root.findAllByProps({ className: 'remote-camera-image' }).length, 0)
assert.ok(screen(view).includes('영상 연결이 끊겼습니다'))
await click(view, '정지')
await click(view, '재생')
remoteRun.status = 'stopped'
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 3100))
})
assert.ok(screen(view).includes('카메라 연결이 종료됐습니다'))
assert.equal(view.root.findAllByProps({ className: 'remote-camera-image' }).length, 0)
remoteRun.status = 'running'
await click(view, '정지')
await click(view, '재생')
await click(view, '고객 피드백')
assert.equal(view.root.findAllByProps({ className: 'remote-camera-image' }).length, 0)
await click(view, '다른 기기 보기')
assert.ok(view.root.findByProps({ className: 'remote-camera-image' }))
await click(view, '정지')
assert.equal(findButton(view, '다른 기기 보기').props['aria-current'], 'page')
assert.equal(view.root.findAllByProps({ className: 'remote-camera-image' }).length, 0)
assert.ok(screen(view).includes('영상 보기를 정지했습니다'))
const ticketsWhileStopped = ticketNumber
await act(async () => {
  document.hidden = true
  documentEvents.dispatchEvent(new Event('visibilitychange'))
})
await act(async () => {
  document.hidden = false
  documentEvents.dispatchEvent(new Event('visibilitychange'))
})
assert.equal(ticketNumber, ticketsWhileStopped)
await click(view, '재생')
assert.ok(view.root.findByProps({ className: 'remote-camera-image' }))
assert.ok(ticketNumber > ticketsWhileStopped)
await click(view, '정지')
assert.equal(view.root.findAllByProps({ className: 'remote-camera-image' }).length, 0)
assert.ok(findButton(view, '재생'))
assert.ok(!calls.some((call) => /\/(frames|stop)$/.test(call.path)))
assert.ok(
  !calls.some(
    (call) =>
      call.method === 'POST' && ['/api/motion/runs', '/api/motion/cameras'].includes(call.path),
  ),
)
await unmount(view)
globalThis.setTimeout = originalSetTimeout
console.log(
  'PASS remote camera discovery, ticket renewal, visibility/navigation cleanup, errors and viewer-only exit',
)

const previewItems = ['not_confirmed', 'uncertain', 'confirmed', 'confirmed'].map(
  (verdict, index) => ({
    question_id: `00000000-0000-4000-8000-00000000000${index}`,
    verdict,
    summary: `질문 ${index + 1}에 대한 전체 관찰 설명입니다.`,
  }),
)
const previewQuestions = previewItems.map((item, index) => ({
  id: item.question_id,
  question: `분석 질문 ${index + 1}의 원문`,
}))
const previewEvents = [previewItems, previewItems.slice(0, 2), previewItems.slice(0, 1), null].map(
  (items, index) => ({
    id: String(index + 1).repeat(32) + '_e000001',
    detected_at: user.created_at,
    questions: previewQuestions.slice(0, items?.length || 4),
    result: items ? { items } : null,
    analysis_status: items ? 'succeeded' : 'failed',
  }),
)
view = await login('user', previewEvents)
const summaries = view.root.findAllByProps({ className: 'event-summary' })
assert.equal(summaries.length, 4, 'Each event must have one summary, regardless of question count')
assert.equal(
  text(summaries[0].findByProps({ className: 'event-summary-text' })),
  previewItems[2].summary,
)
assert.equal(
  text(summaries[1].findByProps({ className: 'event-summary-text' })),
  previewItems[1].summary,
)
assert.equal(
  text(summaries[2].findByProps({ className: 'event-summary-text' })),
  previewItems[0].summary,
)
for (const label of ['확인됨 2개', '판단 어려움 1개', '미확인 1개', '질문 4개 분석'])
  assert.ok(text(summaries[0]).includes(label))
assert.ok(text(summaries[3]).includes('분석 실패'))
assert.equal(summaries[3].findAllByProps({ className: 'event-summary-text' }).length, 0)
assert.ok(
  !screen(view).includes(previewQuestions[0].question),
  'Question text belongs in event details',
)
await act(async () =>
  view.root.findAllByProps({ className: 'event motion-event' })[0].props.onClick(),
)
for (const question of previewQuestions) assert.ok(screen(view).includes(question.question))
for (const item of previewItems)
  assert.ok(screen(view).includes(item.summary), 'Event details must retain every answer')
await act(async () => view.root.findByProps({ 'aria-label': '창 닫기' }).props.onClick())
await click(view, '모니터링현황')
// [UI-EVT01] 기능·역할: 정상·실패 혼합 목록의 표 구조 검사. 수행 이유: 분석 결과 셀에 카드용 grid 클래스가 다시 적용되지 않고 상세 버튼을 포함한 세 열이 유지되는지 확인합니다.
const monitoringRows = view.root
  .findByProps({ className: 'dashboard-panel table-panel events-panel' })
  .findByType('tbody')
  .findAllByType('tr')
assert.equal(monitoringRows.length, 4)
for (const row of monitoringRows) {
  const cells = row.findAllByType('td')
  assert.equal(cells.length, 3)
  assert.ok(cells.every((cell) => !cell.props.className?.split(' ').includes('event-summary')))
  assert.equal(cells[2].findByType('button').props['aria-haspopup'], 'dialog')
}
assert.ok(text(monitoringRows[3]).includes('분석 실패'))
assert.ok(text(monitoringRows[0]).includes(previewItems[0].summary))
await unmount(view)
console.log(
  'PASS one preview per event, verdict counts and summary priority, failed state and full question/answer details',
)

// [UI-EVT02] 기능·역할: 사건 상세의 본인 피드백 등록 검사. 수행 이유: 사건 문맥·입력 제한·초안 보존·중복 전송 방지·실패 복구와 기존 고객 피드백 연결을 확인합니다.
async function submitEventFeedback(view) {
  await act(async () => {
    void view.root
      .findByProps({ id: 'event-feedback-form' })
      .props.onSubmit({ preventDefault() {} })
  })
}
for (const role of ['user', 'admin']) {
  view = await login(role, previewEvents)
  const openRecordedEvent = async (index = 0) => {
    await click(view, role === 'user' ? '모니터링현황' : '실시간 보기')
    await act(async () => {
      const button =
        role === 'user'
          ? view.root
              .findByProps({ className: 'dashboard-panel table-panel events-panel' })
              .findByType('tbody')
              .findAllByType('tr')
              [index].findByType('button')
          : view.root.findAllByProps({ className: 'event motion-event' })[index]
      button.props.onClick()
    })
  }
  const eventFeedbackPosts = () =>
    calls.filter((call) => call.path === '/api/feedback' && call.method === 'POST')
  await openRecordedEvent()
  await click(view, '이 사건 평가·피드백')
  assert.equal(view.root.findAllByType('dialog').length, 1)
  await submitEventFeedback(view)
  assert.equal(eventFeedbackPosts().length, 0)
  await change(view, { id: 'event-feedback-kind' }, 'false_positive')
  await change(view, { id: 'event-feedback-content' }, '   ')
  await submitEventFeedback(view)
  assert.equal(eventFeedbackPosts().length, 0)
  await change(view, { id: 'event-feedback-content' }, '작성 중인 사건 의견')
  await click(view, '접기')
  await click(view, '이 사건 평가·피드백')
  assert.equal(
    view.root.findByProps({ id: 'event-feedback-content' }).props.value,
    '작성 중인 사건 의견',
  )
  await click(view, '창 닫기')
  await openRecordedEvent(1)
  await click(view, '이 사건 평가·피드백')
  assert.equal(view.root.findByProps({ id: 'event-feedback-content' }).props.value, '')
  await click(view, '창 닫기')
  await openRecordedEvent()
  await click(view, '이 사건 평가·피드백')
  assert.equal(
    view.root.findByProps({ id: 'event-feedback-content' }).props.value,
    '작성 중인 사건 의견',
  )
  const limit = view.root.findByProps({ id: 'event-feedback-content' }).props.maxLength
  await change(view, { id: 'event-feedback-content' }, 'x'.repeat(limit + 1))
  await submitEventFeedback(view)
  assert.equal(eventFeedbackPosts().length, 0)
  assert.ok(screen(view).includes(`내용은 ${limit}자 이내`))
  await change(view, { id: 'event-feedback-content' }, 'x'.repeat(limit))
  overrides['POST /api/feedback'] = () =>
    Response.json({ detail: '사건 피드백 저장 실패' }, { status: 503 })
  await submitEventFeedback(view)
  assert.ok(screen(view).includes('사건 피드백 저장 실패'))
  assert.equal(view.root.findByProps({ id: 'event-feedback-content' }).props.value.length, limit)
  let completeEventFeedback
  overrides['POST /api/feedback'] = () =>
    new Promise((resolve) => {
      completeEventFeedback = resolve
    })
  const beforeDoubleSubmit = eventFeedbackPosts().length
  await act(async () => {
    const form = view.root.findByProps({ id: 'event-feedback-form' })
    void form.props.onSubmit({ preventDefault() {} })
    void form.props.onSubmit({ preventDefault() {} })
  })
  assert.equal(eventFeedbackPosts().length, beforeDoubleSubmit + 1)
  assert.equal(
    view.root.findByProps({ id: 'event-feedback-form' }).findByType('fieldset').props.disabled,
    true,
  )
  assert.equal(findButton(view, '로그아웃').props.disabled, true)
  await click(view, '창 닫기')
  assert.equal(view.root.findAllByType('dialog').length, 1)
  let prevented = false
  await act(async () =>
    view.root.findByType('dialog').props.onCancel({
      preventDefault() {
        prevented = true
      },
    }),
  )
  assert.equal(prevented, true)
  const savedBody = JSON.parse(eventFeedbackPosts().at(-1).options.body)
  assert.deepEqual(Object.keys(savedBody).sort(), ['content', 'kind', 'title'])
  assert.equal(savedBody.content.length, 1000)
  assert.ok(savedBody.content.includes(`이벤트 ID: ${previewEvents[0].id}`))
  const expectedTime = new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Asia/Seoul',
  }).format(new Date(previewEvents[0].detected_at))
  assert.ok(savedBody.content.includes(`감지 시각: ${expectedTime} (KST)`))
  assert.ok(savedBody.title.length <= 100)
  const savedEventFeedback = { ...firstFeedback, id: 70, ...savedBody }
  feedback.push(savedEventFeedback)
  await act(async () => completeEventFeedback(Response.json(savedEventFeedback, { status: 201 })))
  assert.ok(screen(view).includes('피드백 #70을 등록했습니다.'))
  assert.equal(view.root.findAllByType('dialog').length, 1)
  let nextFeedbackId = 71
  overrides['POST /api/feedback'] = (options) => {
    const item = { ...firstFeedback, id: nextFeedbackId++, ...JSON.parse(options.body) }
    feedback.push(item)
    return Response.json(item, { status: 201 })
  }
  for (const kind of ['false_negative', 'accurate', 'suggestion']) {
    await click(view, '이 사건 평가·피드백')
    assert.equal(view.root.findByProps({ id: 'event-feedback-content' }).props.value, '')
    await change(view, { id: 'event-feedback-kind' }, kind)
    await change(view, { id: 'event-feedback-content' }, `해당 사건의 ${kind} 의견`)
    await submitEventFeedback(view)
    assert.equal(JSON.parse(eventFeedbackPosts().at(-1).options.body).kind, kind)
  }
  await click(view, '창 닫기')
  await click(view, role === 'admin' ? '고객 피드백 관리' : '고객 피드백')
  if (role === 'admin') await click(view, '내 피드백')
  assert.ok(screen(view).includes(`사건 피드백 · ${previewEvents[0].id}`))
  assert.ok(screen(view).includes('해당 사건의 accurate 의견'))
  await click(view, '실시간 보기')
  overrides[`GET /api/motion/events/${previewEvents[3].id}/analysis`] = () =>
    Response.json({ status: 'failed', error_message: '사건 분석 실패' })
  await openRecordedEvent(3)
  assert.ok(screen(view).includes('사건 분석 실패'))
  await click(view, '이 사건 평가·피드백')
  await change(view, { id: 'event-feedback-kind' }, 'suggestion')
  await change(view, { id: 'event-feedback-content' }, '분석 실패에 대한 의견')
  overrides['POST /api/feedback'] = () => Response.json({ detail: 'Expired' }, { status: 401 })
  await submitEventFeedback(view)
  assert.ok(screen(view).includes('로그인이 만료되었습니다'))
  await unmount(view)
}
console.log(
  'PASS inline event feedback, own scope, event timestamps, all kinds, length boundaries, preserved drafts, failures, duplicate submit/close protection and expiry',
)

// Notifications and DM links contain event IDs without detection timestamps.
view = await login('user', previewEvents)
const linkedEvent = previewEvents[0]
notices = [{ ...notices[0], event_id: linkedEvent.id }]
await click(view, '알림')
await act(async () =>
  view.root
    .findByProps({ className: 'notification-dropdown' })
    .findAllByType('button')
    .find((button) => text(button) === '새로고침')
    .props.onClick(),
)
overrides[`GET /api/motion/events/${linkedEvent.id}`] = () =>
  Response.json({ detail: '시각 조회 실패 검사' }, { status: 503 })
await act(async () => view.root.findByProps({ className: 'notification-item' }).props.onClick())
await click(view, '이 사건 평가·피드백')
await change(view, { id: 'event-feedback-kind' }, 'accurate')
await change(view, { id: 'event-feedback-content' }, '알림에서 작성한 의견')
assert.ok(screen(view).includes('감지 시각을 불러오지 못했어요.'))
assert.equal(findButton(view, '피드백 등록').props.disabled, true)
await submitEventFeedback(view)
assert.ok(!calls.some((call) => call.path === '/api/feedback' && call.method === 'POST'))
delete overrides[`GET /api/motion/events/${linkedEvent.id}`]
await click(view, '감지 시각 다시 조회')
assert.equal(findButton(view, '피드백 등록').props.disabled, false)
await submitEventFeedback(view)
const linkedContent = feedback.find((item) => item.id === 2).content
const linkedTimeLabel = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'Asia/Seoul',
}).format(new Date(linkedEvent.detected_at))
assert.ok(linkedContent.includes(`감지 시각: ${linkedTimeLabel} (KST)`))
assert.ok(!linkedContent.includes('확인할 수 없음'))
await click(view, '창 닫기')
await click(view, '고객 피드백')
await act(async () =>
  view.root
    .findByProps({ 'aria-label': '피드백 #2' })
    .findAllByType('button')
    .find((button) => text(button) === '수정')
    .props.onClick(),
)
assert.equal(view.root.findByProps({ id: 'feedback-content' }).props.value, '알림에서 작성한 의견')
assert.ok(
  text(view.root.findByProps({ 'aria-label': '연결된 사건 정보' })).includes(linkedEvent.id),
)
const opinionLimit = view.root.findByProps({ id: 'feedback-content' }).props.maxLength
await change(view, { id: 'feedback-content' }, 'x'.repeat(opinionLimit + 1))
await submit(view)
assert.ok(!calls.some((call) => call.path === '/api/feedback/2' && call.method === 'PATCH'))
await change(view, { id: 'feedback-title' }, '수정한 제목')
await change(view, { id: 'feedback-content' }, 'x'.repeat(opinionLimit))
await submit(view)
const updatedContent = feedback.find((item) => item.id === 2).content
assert.equal(updatedContent.length, 1000)
assert.equal(
  updatedContent.slice(0, linkedContent.indexOf('[사용자 의견]')),
  linkedContent.slice(0, linkedContent.indexOf('[사용자 의견]')),
)
await click(view, '모니터링현황')
await act(async () =>
  view.root
    .findByProps({ className: 'dashboard-panel table-panel events-panel' })
    .findByType('tbody')
    .findAllByType('tr')[0]
    .findByType('button')
    .props.onClick(),
)
assert.ok(findButton(view, '피드백 #2 보기'), 'Editing the opinion must preserve event history')
await unmount(view)

mockApi()
motionEvents = previewEvents
window.history.replaceState(null, '', '/?event=' + linkedEvent.id)
let finishEventTime, eventTimeSignal
overrides[`GET /api/motion/events/${linkedEvent.id}`] = (options) => {
  eventTimeSignal = options.signal
  return new Promise((resolve) => {
    finishEventTime = resolve
  })
}
view = await mount()
await change(view, { id: 'login-email' }, user.email)
await change(view, { id: 'login-password' }, 'password-for-test')
await submit(view)
await click(view, '이 사건 평가·피드백')
assert.equal(findButton(view, '피드백 등록').props.disabled, true)
await click(view, '창 닫기')
assert.equal(eventTimeSignal.aborted, true)
await act(async () => finishEventTime(Response.json(linkedEvent)))
assert.equal(view.root.findAllByType('dialog').length, 0)
await unmount(view)
console.log(
  'PASS notification timestamp lookup/retry, guarded submission, event reference preservation after editing and DM lookup cancellation',
)

// [UI-EVT03] 기능·역할: 최근 5개 피드백의 서버 조회·번호 이동 검사. 수행 이유: 사건·본인 범위, 등록 직후 갱신, 재접속 유지와 삭제·실패·취소를 검증합니다.
for (const role of ['user', 'admin']) {
  view = await login(role, previewEvents)
  const eventId = previewEvents[0].id
  feedback = [
    { ...firstFeedback, id: 900, content: `이벤트 ID: ${previewEvents[1].id}` },
    { ...firstFeedback, id: 901, user_id: 'other-account', content: `이벤트 ID: ${eventId}` },
    ...Array.from({ length: 8 }, (_, index) => ({
      ...firstFeedback,
      id: 207 - index,
      title: `기존 사건 의견 ${207 - index}`,
      content: `[대상 이벤트]\n이벤트 ID: ${eventId}\n\n[사용자 의견]\n의견 ${207 - index}`,
    })),
  ]
  const openHistoryEvent = async (index = 0) => {
    await click(view, role === 'user' ? '모니터링현황' : '실시간 보기')
    await act(async () => {
      const button =
        role === 'user'
          ? view.root
              .findByProps({ className: 'dashboard-panel table-panel events-panel' })
              .findByType('tbody')
              .findAllByType('tr')
              [index].findByType('button')
          : view.root.findAllByProps({ className: 'event motion-event' })[index]
      button.props.onClick()
    })
  }
  const historyIds = () =>
    view.root
      .findAllByProps({ 'aria-label': '이 사건의 최근 내 피드백' })
      .flatMap((list) => list.findAllByType('button').map(text))
  const beforeHistory = calls.length
  await openHistoryEvent()
  assert.deepEqual(historyIds(), ['#207', '#206', '#205', '#204', '#203'])
  const historyRead = calls.slice(beforeHistory).find((call) => call.path === '/api/feedback')
  assert.equal(historyRead.query.get('limit'), '5')
  assert.equal(historyRead.query.get('offset'), '0')
  assert.equal(historyRead.query.get('q'), `이벤트 ID: ${eventId}`)
  assert.ok(!calls.slice(beforeHistory).some((call) => call.path.startsWith('/api/admin/')))

  if (role === 'user') {
    await click(view, '창 닫기')
    overrides['GET /api/feedback'] = () =>
      Response.json({ detail: '이력 조회 실패 검사' }, { status: 503 })
    await openHistoryEvent()
    assert.ok(screen(view).includes('최근 피드백 이력을 불러오지 못했어요.'))
    assert.ok(!screen(view).includes('이 사건에 남긴 피드백이 없습니다.'))
    delete overrides['GET /api/feedback']
    await click(view, '이력 다시 조회')
    assert.deepEqual(historyIds(), ['#207', '#206', '#205', '#204', '#203'])
    await click(view, '창 닫기')
    let pendingHistorySignal, finishHistory
    overrides['GET /api/feedback'] = (options, url) => {
      if (url.searchParams.get('q') === `이벤트 ID: ${eventId}`) {
        pendingHistorySignal = options.signal
        return new Promise((resolve) => {
          finishHistory = resolve
        })
      }
      return Response.json({ items: [], total: 0, limit: 5, offset: 0 })
    }
    await openHistoryEvent()
    await click(view, '창 닫기')
    assert.equal(pendingHistorySignal.aborted, true)
    await openHistoryEvent(1)
    await act(async () =>
      finishHistory(Response.json({ items: [feedback[2]], total: 1, limit: 5, offset: 0 })),
    )
    assert.deepEqual(historyIds(), [])
    assert.ok(screen(view).includes('이 사건에 남긴 피드백이 없습니다.'))
    await click(view, '창 닫기')
    delete overrides['GET /api/feedback']
    await openHistoryEvent()
  }
  overrides['POST /api/feedback'] = (options) => {
    const item = { ...firstFeedback, id: 208, ...JSON.parse(options.body) }
    feedback.unshift(item)
    return Response.json(item, { status: 201 })
  }
  await click(view, '이 사건 평가·피드백')
  await change(view, { id: 'event-feedback-kind' }, 'accurate')
  await change(view, { id: 'event-feedback-content' }, '이번 사건은 정확하게 분석했습니다.')
  await submitEventFeedback(view)
  assert.deepEqual(historyIds(), ['#208', '#207', '#206', '#205', '#204'])
  await click(view, '창 닫기')
  await unmount(view)
  view = await mount()
  await openHistoryEvent()
  assert.deepEqual(historyIds(), ['#208', '#207', '#206', '#205', '#204'])
  const beforeLink = calls.length
  await click(view, '피드백 #207 보기')
  assert.equal(
    findButton(view, role === 'user' ? '고객 피드백' : '고객 피드백 관리').props['aria-current'],
    'page',
  )
  if (role === 'user') {
    assert.equal(feedbackCards(view).length, 1)
    assert.equal(feedbackCards(view)[0].props['aria-label'], '피드백 #207')
    assert.equal(view.root.findAllByProps({ id: 'process-status' }).length, 0)
    assert.ok(
      calls
        .slice(beforeLink)
        .some((call) => call.path === '/api/feedback' && call.query.get('feedback_id') === '207'),
    )
    assert.ok(!calls.slice(beforeLink).some((call) => call.path.startsWith('/api/admin/')))
    // 같은 번호 링크를 다시 눌러도 직전 검색·필터 대신 해당 건을 표시합니다.
    await searchFeedback(view, '존재하지 않는 검색')
    notices = [{ ...notices[0], event_id: eventId }]
    await click(view, '알림')
    await act(async () =>
      view.root
        .findByProps({ className: 'notification-dropdown' })
        .findAllByType('button')
        .find((button) => text(button) === '새로고침')
        .props.onClick(),
    )
    await act(async () => view.root.findByProps({ className: 'notification-item' }).props.onClick())
    await click(view, '피드백 #207 보기')
    assert.equal(feedbackCards(view).length, 1)
    assert.equal(feedbackCards(view)[0].props['aria-label'], '피드백 #207')
  } else {
    assert.equal(view.root.findByType('dialog').props['aria-label'], '피드백 처리')
    assert.ok(text(view.root.findByProps({ className: 'processing-copy' })).includes('의견 207'))
    await click(view, '창 닫기')
  }
  if (role === 'user') {
    // 선택한 사건을 다시 열어 같은 대상 번호로 이동합니다.
    if (view.root.findAllByType('dialog').length) await click(view, '창 닫기')
  }
  await openHistoryEvent()
  feedback = feedback.filter((item) => item.id !== 207)
  await click(view, '피드백 #207 보기')
  assert.ok(
    screen(view).includes(
      role === 'user' ? '선택한 피드백은 삭제되었거나' : '이 피드백은 삭제되었거나',
    ),
  )
  if (role === 'user') assert.equal(feedbackCards(view).length, 0)
  await unmount(view)
}
console.log(
  'PASS latest five event feedback IDs, own scope, immediate refresh, server restoration, linked user/admin views, history errors, stale-read cancellation and deleted targets',
)

// Actual App composition: both auth methods share pending state, and OAuth uses the existing session boundary.
mockApi()
view = await mount()
await click(view, '로그인')
assert.equal(findButton(view, 'Discord로 로그인').props.disabled, false)
let resolveDiscord
overrides['POST /api/discord/start'] = () =>
  new Promise((resolve) => {
    resolveDiscord = resolve
  })
await click(view, 'Discord로 로그인')
assert.equal(findButton(view, '로그인').props.disabled, true)
assert.equal(findButton(view, '회원가입').props.disabled, true)
await submit(view)
assert.ok(!calls.some((call) => call.path === '/api/auth/login'))
await act(async () =>
  resolveDiscord(Response.json({ detail: '인증 설정 확인 필요' }, { status: 503 })),
)
assert.ok(screen(view).includes('인증 설정 확인 필요'))
assert.equal(findButton(view, '로그인').props.disabled, false)
let resolvePassword
overrides['POST /api/auth/login'] = () =>
  new Promise((resolve) => {
    resolvePassword = resolve
  })
await act(async () => {
  void view.root.findByType('form').props.onSubmit({ preventDefault() {} })
})
assert.equal(findButton(view, 'Discord로 로그인').props.disabled, true)
await act(async () =>
  resolvePassword(Response.json({ detail: '잘못된 비밀번호' }, { status: 401 })),
)
await unmount(view)

mockApi()
discordReady = false
view = await mount()
await click(view, '로그인')
assert.equal(findButton(view, 'Discord로 로그인').props.disabled, true)
assert.ok(screen(view).includes('Discord 로그인은 준비 중'))
await unmount(view)

const oauthKey = 'notecam:discord:oauth:http://127.0.0.1:8000'
for (const intent of ['login', 'link']) {
  mockApi()
  if (intent === 'link')
    sessionStorage.set(
      sessionKey,
      JSON.stringify({ accessToken: 'test-token', expiresAt: Date.now() + 60000 }),
    )
  sessionStorage.set(
    oauthKey,
    JSON.stringify({ flow_id: 'x'.repeat(43), intent, expiresAt: Date.now() + 60000 }),
  )
  window.history.replaceState(null, '', '/auth/discord/callback?code=secret-code')
  overrides['POST /api/discord/complete'] = (options) => {
    assert.equal(options.headers.Authorization, intent === 'link' ? 'Bearer test-token' : undefined)
    return Response.json({
      intent,
      user_id: user.id,
      tokens: { access_token: 'test-token', expires_in: 3600 },
    })
  }
  view = await mount()
  assert.equal(calls.filter((call) => call.path === '/api/discord/complete').length, 1)
  assert.equal(window.location.pathname, '/')
  assert.equal(JSON.parse(sessionStorage.get(sessionKey)).accessToken, 'test-token')
  assert.ok(!sessionStorage.get(oauthKey))
  if (intent === 'login') await click(view, '나의 프로필')
  assert.ok(screen(view).includes('Discord 알림'))
  assert.ok(screen(view).includes('Discord 연결'))
  assert.equal(findButton(view, '나의 프로필').props['aria-current'], 'page')
  await unmount(view)
}
mockApi()
sessionStorage.set(
  oauthKey,
  JSON.stringify({ flow_id: 'x'.repeat(43), intent: 'login', expiresAt: Date.now() + 60000 }),
)
window.history.replaceState(null, '', '/auth/discord/callback?code=secret-code')
overrides['POST /api/discord/complete'] = () =>
  Response.json({
    intent: 'login',
    user_id: 'wrong-user',
    tokens: { access_token: 'test-token', expires_in: 3600 },
  })
view = await mount()
assert.ok(screen(view).includes('계정 권한을 확인하지 못했습니다'))
assert.ok(!sessionStorage.get(sessionKey))
await click(view, '돌아가기')
assert.ok(findButton(view, 'Discord로 로그인'))
await unmount(view)
console.log(
  'PASS Discord login/profile placement, auth interlock, disabled setup, OAuth login/link session validation and return path',
)

mockApi()
seedSession()
sessionStorage.set(
  oauthKey,
  JSON.stringify({ flow_id: 'x'.repeat(43), intent: 'link', expiresAt: Date.now() + 60000 }),
)
window.history.replaceState(null, '', '/auth/discord/callback?error=access_denied')
view = await mount()
assert.ok(screen(view).includes('인증이 취소'))
assert.ok(
  sessionStorage.has(sessionKey),
  'Cancelling Discord linking must preserve the email session',
)
await click(view, '돌아가기')
assert.equal(findButton(view, '나의 프로필').props['aria-current'], 'page')
assert.ok(!calls.some((call) => call.path === '/api/discord/complete'))
await unmount(view)

mockApi()
window.history.replaceState(null, '', '/?event=' + 'b'.repeat(32) + '_e000001')
view = await mount()
assert.ok(view.root.findByProps({ id: 'login-email' }))
await submit(view)
assert.ok(screen(view).includes('사건 상세'), 'A Discord DM event link must open after signing in')
await unmount(view)
console.log(
  'PASS cancelled linking preserves the current login and DM event links resume after login',
)

const request = createApiClient('http://127.0.0.1:8000/', 'test-token')
globalThis.fetch = async () =>
  Response.json({ error: { message: '서버 처리 오류' } }, { status: 503 })
await assert.rejects(
  request('/api/users/me'),
  (error) =>
    error instanceof ApiError && error.status === 503 && error.message === '서버 처리 오류',
)
globalThis.fetch = async () => {
  throw new TypeError('Failed to fetch')
}
await assert.rejects(request('/api/users/me'), /서버에 연결할 수 없어요/)
globalThis.fetch = async (_url, options) =>
  new Promise((_resolve, reject) => {
    options.signal.addEventListener(
      'abort',
      () => reject(new DOMException('Aborted', 'AbortError')),
      { once: true },
    )
  })
const controller = new AbortController()
const pending = request('/api/users/me', { signal: controller.signal })
controller.abort()
await assert.rejects(pending, (error) => error.name === 'AbortError')
console.log('PASS shared client error handling and cancellation')
console.log(
  'All production interaction checks passed. Live backend and browser layout are separate checks.',
)
