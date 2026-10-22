// UUID는 재사용 힌트일 뿐이며, 서버의 현재 사용자 카메라 목록으로 소유권을 확인합니다.
export async function registerBrowserCamera(request, stream, signal, storage) {
  const track = stream.getVideoTracks()[0]
  const name = track.label?.trim().slice(0, 80) || '기본 웹캠'
  const key = `notecam:camera:v1:${track.getSettings().deviceId || name}`
  let savedId
  try {
    storage ??= globalThis.localStorage
    savedId = storage?.getItem(key)
  } catch {
    /* 저장소 차단 시 새로 등록합니다. */
  }
  if (savedId) {
    const cameras = await request('/api/motion/cameras', { signal })
    signal.throwIfAborted()
    const existing = cameras.find((camera) => camera.id === savedId)
    if (existing) return existing
  }
  const camera = await request('/api/motion/cameras', { method: 'POST', body: { name }, signal })
  signal.throwIfAborted()
  try {
    storage?.setItem(key, camera.id)
  } catch {
    /* 카메라 사용은 계속 가능합니다. */
  }
  return camera
}
