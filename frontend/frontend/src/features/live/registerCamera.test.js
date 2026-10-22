import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerBrowserCamera } from './registerCamera.js'

const stream = {
  getVideoTracks: () => [
    { label: 'Default Webcam', getSettings: () => ({ deviceId: 'browser-device' }) },
  ],
}
const signal = () => new AbortController().signal

test('처음 연결한 웹캠은 서버에서 UUID를 발급받고 UUID만 저장한다', async () => {
  const saved = []
  const camera = await registerBrowserCamera(
    async (path, options) => {
      assert.equal(path, '/api/motion/cameras')
      assert.equal(options.method, 'POST')
      assert.deepEqual(options.body, { name: 'Default Webcam' })
      return { id: 'server-uuid', name: 'Default Webcam' }
    },
    stream,
    signal(),
    { getItem: () => null, setItem: (...args) => saved.push(args) },
  )
  assert.equal(camera.id, 'server-uuid')
  assert.deepEqual(saved, [['notecam:camera:v1:browser-device', 'server-uuid']])
})

test('재연결은 현재 사용자 목록에서 확인된 카메라만 재사용한다', async () => {
  const camera = await registerBrowserCamera(
    async (_, options) => {
      assert.equal(options.method, undefined)
      return [{ id: 'owned-camera', name: '기존 카메라' }]
    },
    stream,
    signal(),
    { getItem: () => 'owned-camera', setItem: () => assert.fail('재사용 시 등록하지 않습니다.') },
  )
  assert.equal(camera.id, 'owned-camera')
})

test('다른 사용자 또는 삭제된 카메라 UUID가 남아 있으면 새로 등록한다', async () => {
  const methods = []
  const camera = await registerBrowserCamera(
    async (_, options) => {
      methods.push(options.method || 'GET')
      return options.method === 'POST' ? { id: 'new-owned-camera' } : [{ id: 'another-camera' }]
    },
    stream,
    signal(),
    { getItem: () => 'old-camera', setItem() {} },
  )
  assert.deepEqual(methods, ['GET', 'POST'])
  assert.equal(camera.id, 'new-owned-camera')
})

test('저장소를 차단한 브라우저에서도 카메라를 등록할 수 있다', async () => {
  const denied = () => {
    throw new Error('Storage blocked')
  }
  const camera = await registerBrowserCamera(async () => ({ id: 'new-camera' }), stream, signal(), {
    getItem: denied,
    setItem: denied,
  })
  assert.equal(camera.id, 'new-camera')
})

test('취소 후 늦은 카메라 목록 응답으로 등록을 이어가지 않는다', async () => {
  const controller = new AbortController()
  let calls = 0
  await assert.rejects(
    registerBrowserCamera(
      async () => {
        calls++
        controller.abort()
        return []
      },
      stream,
      controller.signal,
      { getItem: () => 'cached', setItem() {} },
    ),
    { name: 'AbortError' },
  )
  assert.equal(calls, 1)
})
