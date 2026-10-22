import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createCameraSession, openDefaultCamera } from './browserCamera.js'

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  else delete globalThis.navigator
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  else delete globalThis.document
})
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setup(getUserMedia) {
  let stops = 0
  const track = Object.assign(new EventTarget(), {
    label: '테스트 웹캠',
    readyState: 'live',
    enabled: true,
    muted: false,
    stop() {
      stops++
      this.readyState = 'ended'
    },
  })
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: getUserMedia || (async () => stream) } },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => ({
        getContext: () => ({ drawImage() {} }),
        toBlob: (callback) => callback(new Blob(['jpeg'], { type: 'image/jpeg' })),
      }),
    },
  })
  return {
    track,
    stream,
    video: { srcObject: null, videoWidth: 640, videoHeight: 480, play: async () => {} },
    get stops() {
      return stops
    },
  }
}

test('카메라 등록은 장치 선택 없이 브라우저 기본 웹캠을 연다', async () => {
  const media = setup(async (constraints) => {
    assert.deepEqual(constraints, { video: true, audio: false })
    return media.stream
  })
  assert.equal(await openDefaultCamera(media.video), media.stream)
  assert.equal(media.video.srcObject, media.stream)
})

// [UI-CAM04] 기능·역할: 미리보기의 로컬 동작·녹화 전환 검사. 수행 이유: 미리보기에서는 전송하지 않고 녹화 전환 시 한 번 연 카메라만 사용하는지 검증합니다.
test('미리보기는 서버 등록·실행·프레임 생성 없이 카메라만 열고 종료한다', async () => {
  const media = setup()
  document.createElement = () => assert.fail('미리보기에서 프레임을 만들면 안 됩니다.')
  const states = []
  const session = createCameraSession({
    video: media.video,
    request: async () => assert.fail('미리보기에서 서버를 호출하면 안 됩니다.'),
    prepare: async () => assert.fail('미리보기에서 카메라를 등록하면 안 됩니다.'),
    onStarted: () => assert.fail('미리보기에서 실행을 시작하면 안 됩니다.'),
    onError: (error) => assert.fail(error.message),
    onCameraStateChange: (next) => states.push(next.status),
  })
  assert.equal(await session.preview(), media.stream)
  assert.equal(media.video.srcObject, media.stream)
  assert.equal(session.run, undefined)
  media.track.muted = true
  media.track.dispatchEvent(new Event('mute'))
  assert.equal(states.at(-1), 'error')
  media.track.muted = false
  media.track.dispatchEvent(new Event('unmute'))
  assert.equal(states.at(-1), 'on')
  await session.stop()
  assert.equal(media.video.srcObject, null)
  assert.equal(media.stops, 1)
  assert.equal(states.at(-1), 'off')
})

test('미리보기에서 녹화로 전환해도 웹캠·등록·실행은 한 번만 시작한다', async () => {
  let opens = 0,
    registrations = 0,
    starts = 0
  const media = setup(async () => {
    opens++
    return media.stream
  })
  const paths = []
  const session = createCameraSession({
    video: media.video,
    request: async (path) => {
      paths.push(path)
      return path === '/api/motion/runs' ? { id: 'preview-run' } : {}
    },
    prepare: async () => {
      registrations++
      return { camera_id: 'camera' }
    },
    onStarted: () => starts++,
    onError: (error) => assert.fail(error.message),
  })
  await Promise.all([session.preview(), session.preview()])
  assert.equal(paths.length, 0)
  assert.equal(registrations, 0)
  await Promise.all([session.start(), session.start()])
  assert.equal(opens, 1)
  assert.equal(registrations, 1)
  assert.equal(starts, 1)
  assert.equal(paths.filter((path) => path === '/api/motion/runs').length, 1)
  assert.ok(paths.some((path) => path.endsWith('/frames')))
  await session.stop()
  assert.equal(media.video.srcObject, null)
  assert.equal(paths.filter((path) => path.endsWith('/stop')).length, 1)
})

test('미리보기에서 녹화로 전환 중 등록에 실패하면 카메라를 정리한다', async () => {
  const media = setup()
  const session = createCameraSession({
    video: media.video,
    request: async () => assert.fail('등록 실패 후 실행을 만들면 안 됩니다.'),
    prepare: async () => {
      throw new Error('카메라 등록 실패')
    },
  })
  await session.preview()
  await assert.rejects(session.start(), /카메라 등록 실패/)
  assert.equal(media.track.readyState, 'ended')
  assert.equal(media.video.srcObject, null)
})

test('미리보기 준비 중 취소하면 늦게 허용된 카메라도 해제한다', async () => {
  const permission = deferred()
  const media = setup(() => permission.promise)
  const session = createCameraSession({
    video: media.video,
    request: async () => assert.fail('취소한 미리보기에서 서버를 호출하면 안 됩니다.'),
  })
  const opening = session.preview()
  await session.stop()
  permission.resolve(media.stream)
  assert.equal(await opening, null)
  assert.equal(media.track.readyState, 'ended')
  assert.equal(media.video.srcObject, null)
})

test('중지하면 등록된 웹캠도 해제하고 서버 실행을 종료한다', async () => {
  const media = setup(() => assert.fail('이미 열린 웹캠을 다시 요청하면 안 됩니다.'))
  media.video.srcObject = media.stream
  let stopRequests = 0
  const session = createCameraSession({
    video: media.video,
    stream: media.stream,
    request: async (path) => {
      if (path === '/api/motion/runs') return { id: 'run' }
      if (path.endsWith('/stop')) stopRequests++
      return {}
    },
    onStarted() {},
    onError(error) {
      assert.fail(error.message)
    },
  })
  await session.start()
  await session.stop()
  assert.equal(stopRequests, 1)
  assert.equal(media.stops, 1)
  assert.equal(media.video.srcObject, null)
})

test('권한 요청 중 중지하면 늦게 열린 카메라를 닫고 실행을 만들지 않는다', async () => {
  const permission = deferred()
  const media = setup(() => permission.promise)
  let requests = 0
  const cameraStates = []
  const session = createCameraSession({
    video: media.video,
    request: async () => {
      requests++
    },
    onStarted() {},
    onError() {},
    onCameraStateChange: (next) => cameraStates.push(next.status),
  })
  const opening = session.start()
  await session.stop()
  permission.resolve(media.stream)
  assert.equal(await opening, null)
  assert.ok(media.stops > 0)
  assert.equal(requests, 0)
  assert.deepEqual(cameraStates, ['preparing', 'off'])
})

test('실행 생성 중 중지해도 응답 ID를 받아 서버 실행을 한 번만 종료한다', async () => {
  const created = deferred()
  const creating = deferred()
  const media = setup()
  const paths = []
  const session = createCameraSession({
    video: media.video,
    payload: { camera_id: 'camera' },
    request: async (path) => {
      paths.push(path)
      if (path === '/api/motion/runs') {
        creating.resolve()
        return created.promise
      }
      return { status: 'stopping' }
    },
    onStarted() {
      assert.fail('취소한 실행을 활성화하면 안 됩니다.')
    },
    onError() {},
  })
  const opening = session.start()
  await creating.promise
  const stopping = session.stop()
  assert.ok(media.stops > 0)
  assert.equal(media.video.srcObject, null)
  created.resolve({ id: 'late-run' })
  await stopping
  assert.equal(await opening, null)
  await session.stop()
  assert.deepEqual(paths, ['/api/motion/runs', '/api/motion/runs/late-run/stop'])
  assert.equal(media.video.srcObject, null)
})

test('프레임 응답을 기다리고 rate_limited 뒤에는 다음 순번을 전송한다', async () => {
  const media = setup()
  const first = deferred()
  const second = deferred()
  const sent = []
  let stopRequests = 0
  const session = createCameraSession({
    video: media.video,
    payload: { camera_id: 'camera' },
    request: async (path, options) => {
      if (path === '/api/motion/runs') return { id: 'run' }
      if (path.endsWith('/stop')) {
        stopRequests++
        return { status: 'stopping' }
      }
      sent.push({
        sequence: options.body.get('sequence_no'),
        time: Number(options.body.get('timestamp_sec')),
      })
      if (sent.length === 1) return first.promise
      second.resolve()
      return { accepted: true }
    },
    onStarted() {},
    onError(error) {
      assert.fail(error.message)
    },
  })
  await session.start()
  await new Promise(setImmediate)
  assert.equal(sent.length, 1)
  first.resolve({ accepted: false, reason: 'rate_limited' })
  await second.promise
  await session.stop()
  await session.stop()
  assert.deepEqual(
    sent.map((item) => item.sequence),
    ['0', '1'],
  )
  assert.ok(sent[1].time > sent[0].time)
  assert.equal(stopRequests, 1)
  assert.equal(media.video.srcObject, null)
})

test('프레임 전송 실패 시 카메라와 서버 실행을 정리한다', async () => {
  const media = setup()
  const failed = deferred()
  let stopRequests = 0
  const session = createCameraSession({
    video: media.video,
    request: async (path) => {
      if (path === '/api/motion/runs') return { id: 'run' }
      if (path.endsWith('/stop')) {
        stopRequests++
        return {}
      }
      throw new Error('연결 끊김')
    },
    onStarted() {},
    onError: failed.resolve,
  })
  await session.start()
  assert.equal((await failed.promise).message, '연결 끊김')
  await session.stop()
  assert.equal(stopRequests, 1)
  assert.ok(media.stops > 0)
})

test('서버 종료 응답이 느려도 웹캠 해제와 프레임 요청 취소는 먼저 끝난다', async () => {
  const media = setup()
  const serverStopped = deferred()
  const framePending = deferred()
  let frameSignal
  let stops = 0
  const cameraStates = []
  const session = createCameraSession({
    video: media.video,
    request: async (path, options) => {
      if (path === '/api/motion/runs') return { id: 'slow-stop' }
      if (path.endsWith('/stop')) {
        stops++
        return serverStopped.promise
      }
      frameSignal = options.signal
      framePending.resolve()
      return new Promise((resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        }),
      )
    },
    onStarted() {},
    onCameraStateChange: (next) => cameraStates.push(next.status),
    onError(error) {
      assert.fail(error.message)
    },
  })
  await session.start()
  await framePending.promise
  const stopping = session.stop()
  assert.equal(media.video.srcObject, null)
  assert.equal(media.stops, 1)
  assert.equal(frameSignal.aborted, true)
  assert.equal(stops, 1)
  assert.deepEqual(cameraStates, ['preparing', 'on', 'off'])
  serverStopped.resolve({ id: 'slow-stop', status: 'stopping' })
  assert.deepEqual(await stopping, { id: 'slow-stop', status: 'stopping' })
  await session.stop()
  assert.equal(stops, 1)
})

// [UI-CAM03] 기능·역할: 실제 트랙 신호와 상태 전달 검사. 수행 이유: 수신 중단·복구·장치 분리와 종료 후 늦은 이벤트를 구분합니다.
test('카메라 트랙의 수신 중단·복구·분리를 표시하고 종료 후 이벤트를 무시한다', async () => {
  const media = setup()
  const cameraStates = []
  const errors = []
  let stopRequests = 0
  const session = createCameraSession({
    video: media.video,
    request: async (path) => {
      if (path === '/api/motion/runs') return { id: 'run' }
      if (path.endsWith('/stop')) stopRequests++
      return {}
    },
    onStarted() {},
    onError: (error) => errors.push(error.message),
    onCameraStateChange: (next) => cameraStates.push(next),
  })
  await session.start()
  assert.equal(cameraStates.at(-1).status, 'on')
  assert.equal(cameraStates.at(-1).label, media.track.label)
  media.track.muted = true
  media.track.dispatchEvent(new Event('mute'))
  assert.equal(cameraStates.at(-1).status, 'error')
  assert.match(cameraStates.at(-1).message, /영상 수신/)
  media.track.muted = false
  media.track.dispatchEvent(new Event('unmute'))
  assert.equal(cameraStates.at(-1).status, 'on')
  media.track.readyState = 'ended'
  media.track.dispatchEvent(new Event('ended'))
  assert.equal(cameraStates.at(-1).status, 'error')
  assert.match(cameraStates.at(-1).message, /연결이 끊겼/)
  assert.equal(errors.length, 1)
  assert.equal(media.video.srcObject, null)
  assert.equal(media.stops, 1)
  const stateCount = cameraStates.length
  media.track.dispatchEvent(new Event('unmute'))
  await session.stop()
  assert.equal(cameraStates.length, stateCount)
  assert.equal(stopRequests, 1)
})

test('카메라 권한 거부는 OFF 대신 오류로 전달하고 서버 실행을 만들지 않는다', async () => {
  const media = setup(async () => {
    throw new DOMException('Denied', 'NotAllowedError')
  })
  const cameraStates = []
  const session = createCameraSession({
    video: media.video,
    request: async () => assert.fail('권한 거부 후 서버를 호출하면 안 됩니다.'),
    onStarted() {},
    onError() {},
    onCameraStateChange: (next) => cameraStates.push(next),
  })
  await assert.rejects(session.start(), /카메라 권한이 거부/)
  assert.equal(cameraStates[0].status, 'preparing')
  assert.equal(cameraStates.at(-1).status, 'error')
  assert.match(cameraStates.at(-1).message, /카메라 권한이 거부/)
})

test('카메라 등록 응답을 기다리는 중 취소해도 웹캠을 즉시 끄고 실행은 만들지 않는다', async () => {
  const media = setup()
  const registered = deferred()
  const registering = deferred()
  let requests = 0
  const session = createCameraSession({
    video: media.video,
    request: async () => {
      requests++
      return {}
    },
    prepare: async (stream, signal) => {
      registering.resolve(signal)
      return registered.promise
    },
    onStarted() {
      assert.fail('취소한 실행은 시작하면 안 됩니다.')
    },
    onError() {},
  })
  const opening = session.start()
  const registrationSignal = await registering.promise
  await session.stop()
  assert.equal(media.stops, 1)
  assert.equal(media.video.srcObject, null)
  assert.equal(registrationSignal.aborted, true)
  registered.resolve({ camera_id: 'late-camera' })
  assert.equal(await opening, null)
  assert.equal(requests, 0)
})

test('권한 응답을 기다리지 않고 준비를 취소하고 나중에 허용한 스트림도 해제한다', async () => {
  const permission = deferred()
  const media = setup(() => permission.promise)
  const session = createCameraSession({
    video: media.video,
    request: async () => assert.fail('서버 실행을 만들면 안 됩니다.'),
    onStarted() {},
    onError() {},
  })
  const opening = session.start()
  await session.stop()
  assert.equal(await opening, null)
  permission.resolve(media.stream)
  await new Promise(setImmediate)
  assert.ok(media.stops > 0)
  assert.equal(media.video.srcObject, null)
})

test('영상 준비가 멈춰 있어도 취소하면 웹캠을 해제한다', async () => {
  const media = setup()
  const playing = deferred()
  const playback = deferred()
  media.video.play = () => {
    playing.resolve()
    return playback.promise
  }
  const session = createCameraSession({
    video: media.video,
    request: async () => assert.fail('서버 실행을 만들면 안 됩니다.'),
    onStarted() {},
    onError() {},
  })
  const opening = session.start()
  await playing.promise
  await session.stop()
  assert.equal(await opening, null)
  assert.ok(media.stops > 0)
  assert.equal(media.video.srcObject, null)
  playback.resolve()
})
