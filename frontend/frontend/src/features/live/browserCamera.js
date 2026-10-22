function abortable(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('Cancelled', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
  })
}

export async function openDefaultCamera(video, { signal } = {}) {
  let stream
  try {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error('카메라를 사용하려면 HTTPS 또는 localhost로 접속해 주세요.')
    signal?.throwIfAborted()
    const opening = navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    // Browser permission prompts cannot be cancelled; release a late stream without displaying it.
    opening.then(
      (next) => {
        if (signal?.aborted) next.getTracks().forEach((track) => track.stop())
      },
      () => {},
    )
    stream = await abortable(opening, signal)
    signal?.throwIfAborted()
    video.srcObject = stream
    await abortable(video.play(), signal)
    signal?.throwIfAborted()
    if (!video.videoWidth || !video.videoHeight)
      throw new Error('카메라에서 영상을 받지 못했습니다.')
    return stream
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop())
    if (stream && video.srcObject === stream) video.srcObject = null
    if (error.name === 'NotAllowedError')
      throw new Error('카메라 권한이 거부되었습니다. 브라우저에서 카메라 사용을 허용해 주세요.')
    if (error.name === 'NotFoundError')
      throw new Error('사용 가능한 카메라가 없습니다. 카메라 연결을 확인해 주세요.')
    throw error
  }
}

// 세션이 웹캠을 소유합니다. 중지 시 트랙을 먼저 해제하고 서버 종료는 별도로 기다립니다.
export function createCameraSession({
  video,
  stream: previewStream,
  request,
  payload,
  prepare,
  onStarted,
  onError,
  onCameraStateChange,
}) {
  const controller = new AbortController()
  let stream = previewStream,
    run,
    stopped = false,
    runRequest,
    stopRequest,
    timer,
    wake

  // [UI-CAM01] 기능·역할: 현재 브라우저의 카메라 상태 전달. 수행 이유: 서버 실행 기록과 별개로 실제 영상 트랙의 사용 여부를 표시합니다.
  function reportCamera(status, message = '') {
    onCameraStateChange?.({ status, label: stream?.getVideoTracks()[0]?.label || '', message })
  }

  function updateTrackStatus() {
    if (stopped) return
    const track = stream.getVideoTracks()[0]
    const receiving = track.readyState === 'live' && track.enabled && !track.muted
    reportCamera(receiving ? 'on' : 'error', receiving ? '' : '카메라 영상 수신이 중단됐어요.')
  }

  function trackEnded() {
    fail(new Error('카메라 연결이 끊겼습니다. 카메라 녹화를 다시 시작해 주세요.'))
  }

  function close() {
    if (stopped) return
    stopped = true
    controller.abort()
    clearTimeout(timer)
    wake?.()
    const track = stream?.getVideoTracks()[0]
    track?.removeEventListener('ended', trackEnded)
    track?.removeEventListener('mute', updateTrackStatus)
    track?.removeEventListener('unmute', updateTrackStatus)
    stream?.getTracks().forEach((track) => track.stop())
    if (stream && video.srcObject === stream) video.srcObject = null
    reportCamera('off')
  }

  async function stop() {
    close()
    if (runRequest && !run) await runRequest.catch(() => {})
    if (run && !stopRequest)
      stopRequest = request(`/api/motion/runs/${run.id}/stop`, { method: 'POST' })
    return stopRequest
  }

  function fail(error) {
    if (stopped) return
    onError(error)
    void stop().catch(() => {})
    reportCamera('error', error.message)
  }

  async function start() {
    try {
      reportCamera('preparing')
      if (!stream) stream = await openDefaultCamera(video, { signal: controller.signal })
      if (stopped) {
        await stop()
        return null
      }
      if (!video.videoWidth || !video.videoHeight)
        throw new Error('카메라에서 영상을 받지 못했습니다.')
      const track = stream.getVideoTracks()[0]
      if (!track || track.readyState !== 'live') throw new Error('카메라 연결이 끊겼습니다.')
      track.addEventListener('ended', trackEnded, { once: true })
      track.addEventListener('mute', updateTrackStatus)
      track.addEventListener('unmute', updateTrackStatus)
      updateTrackStatus()
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('이 브라우저에서 영상 프레임을 만들 수 없습니다.')
      // 응답을 기다려 취소 중 생성된 실행도 ID를 받아 종료합니다.
      const body = prepare ? await prepare(stream, controller.signal) : payload
      if (stopped) return null
      runRequest = request('/api/motion/runs', { method: 'POST', body })
      run = await runRequest
      if (stopped) {
        await stop()
        return null
      }
      onStarted(run)
      const started = performance.now()
      let sequence = 0
      async function pump() {
        while (!stopped) {
          if (video.videoWidth !== canvas.width || video.videoHeight !== canvas.height)
            throw new Error('카메라 해상도가 바뀌었습니다. 감지를 다시 시작해 주세요.')
          const captured = performance.now()
          context.drawImage(video, 0, 0, canvas.width, canvas.height)
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
          if (stopped) return
          if (!blob || blob.size > 5 * 1024 * 1024)
            throw new Error(
              '영상 프레임을 5 MiB 이하의 JPEG로 만들 수 없습니다. 카메라 해상도를 낮춰 주세요.',
            )
          const body = new FormData()
          body.append('file', blob, 'frame.jpg')
          body.append('sequence_no', String(sequence++))
          body.append('timestamp_sec', String((captured - started) / 1000))
          await request(`/api/motion/runs/${run.id}/frames`, {
            method: 'POST',
            body,
            signal: controller.signal,
            timeout: 5000,
          })
          if (!stopped)
            await new Promise((resolve) => {
              wake = resolve
              timer = setTimeout(resolve, Math.max(0, 100 - (performance.now() - captured)))
            })
        }
      }
      void pump().catch(fail)
      return run
    } catch (error) {
      const cancelled = stopped
      await stop().catch(() => {})
      if (cancelled) return null
      reportCamera('error', error.message)
      throw error
    }
  }
  return {
    start,
    stop,
    close,
    get run() {
      return run
    },
    get stopped() {
      return stopped
    },
  }
}
