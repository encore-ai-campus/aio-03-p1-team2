import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequest } from './request.js'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test('JSON 요청은 사용자 Bearer 토큰을 헤더로 전달한다', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'http://localhost:8000/api/motion/question')
    assert.equal(options.headers.Authorization, 'Bearer test-token')
    assert.equal(options.headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(options.body), { question: '사람이 있나요?' })
    return Response.json({ question: '사람이 있나요?' })
  }
  await createRequest({ token: 'test-token' })('/api/motion/question', {
    method: 'PUT',
    body: { question: '사람이 있나요?' },
  })
})

test('multipart 경계는 브라우저가 설정하고 사진은 Blob으로 받는다', async () => {
  const body = new FormData()
  body.append('file', new Blob(['jpeg']), 'frame.jpg')
  globalThis.fetch = async (path, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-token')
    assert.equal(options.headers['Content-Type'], undefined)
    if (path.endsWith('/frames')) {
      assert.equal(options.body, body)
      return Response.json({ accepted: true, reason: 'accepted' }, { status: 202 })
    }
    assert.equal(options.method, 'GET')
    return new Response('photo', { headers: { 'Content-Type': 'image/jpeg' } })
  }
  const request = createRequest({ token: 'test-token' })
  await request('/api/motion/runs/run/frames', { method: 'POST', body })
  const blob = await request('/api/motion/photos/photo/content', { responseType: 'blob' })
  assert.equal(await blob.text(), 'photo')
})

test('비전 오류와 인증 만료를 사용자에게 구분해서 전달한다', async () => {
  const request = createRequest({ token: 'test-token' })
  globalThis.fetch = async () =>
    Response.json({ error: { message: '카메라 실행 한도 초과' } }, { status: 503 })
  await assert.rejects(request('/api/motion/runs'), {
    message: '카메라 실행 한도 초과',
    status: 503,
  })
  globalThis.fetch = async () => Response.json({ detail: 'expired' }, { status: 401 })
  await assert.rejects(
    request('/api/motion/runs'),
    (error) => error.status === 401 && error.message.includes('다시 로그인'),
  )
})

test('상위 요청 취소를 전파하고 유료 요청을 자동 재시도하지 않는다', async () => {
  let calls = 0
  globalThis.fetch = async (_, { signal }) => {
    calls++
    return new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
        once: true,
      }),
    )
  }
  const controller = new AbortController()
  const pending = createRequest({ token: 'test-token' })('/api/motion/runs', {
    method: 'POST',
    signal: controller.signal,
  })
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(calls, 1)
})
