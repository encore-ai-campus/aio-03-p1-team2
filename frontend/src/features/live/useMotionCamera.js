import { useEffect, useRef, useState } from 'react'
import { createCameraSession } from './browserCamera'
import { registerBrowserCamera } from './registerCamera'

const isTerminal = (run) => !run || ['stopped', 'failed'].includes(run.status)

export function useMotionCamera(request) {
  const videoRef = useRef(null)
  const sessionRef = useRef(null)
  const latestRequest = useRef(request)
  latestRequest.current = request
  const mounted = useRef(true)
  const [device, setDevice] = useState(null)
  const [run, setRun] = useState(null)
  const [phase, setPhase] = useState('idle')
  const [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [cameraState, setCameraState] = useState({ status: 'off', label: '', message: '' })

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      void sessionRef.current?.stop().catch(() => {})
      sessionRef.current = null
    }
  }, [])

  async function stop() {
    const session = sessionRef.current
    if (!session) return
    setDevice(null)
    setPhase('stopping')
    setRun((previous) => previous && { ...previous, status: 'stopping' })
    try {
      // stop() releases the local stream synchronously, before any server wait.
      const next = await session.stop()
      if (!mounted.current || sessionRef.current !== session) return
      setRun(next || null)
      if (isTerminal(next)) {
        sessionRef.current = null
        setPhase('idle')
      }
      // A "stopping" response keeps the button disabled until polling confirms completion.
    } catch (cause) {
      if (!mounted.current || sessionRef.current !== session) return
      setError(cause.message)
      if (session.run) setRun({ ...session.run, status: 'stopping' })
      else {
        sessionRef.current = null
        setRun(null)
        setPhase('idle')
      }
    }
  }

  // [UI-CAM04] 기능·역할: 미리보기·녹화 시작과 전환. 수행 이유: 미리보기에서는 등록·실행 API를 호출하지 않고 녹화 시작 시 기존 연결을 이어 씁니다.
  async function activate(previewOnly) {
    const existing = sessionRef.current
    if (!request || (existing && (previewOnly || phase !== 'preview'))) return
    setPhase(previewOnly ? 'preview-starting' : 'starting')
    setRun(null)
    setError('')
    setStatusError('')
    const send = (...args) => latestRequest.current(...args)
    const session =
      existing ||
      createCameraSession({
        video: videoRef.current,
        request: send,
        // [UI-CAM01] 기능·역할: 카메라 트랙 상태 공유. 수행 이유: 운영현황에서도 같은 세션을 사용하고 중복 카메라 연결을 만들지 않습니다.
        onCameraStateChange: (next) => {
          if (mounted.current && sessionRef.current === session) setCameraState(next)
        },
        prepare: async (stream, signal) => {
          if (mounted.current && sessionRef.current === session) {
            setDevice({ label: stream.getVideoTracks()[0].label || '기본 웹캠' })
          }
          const camera = await registerBrowserCamera(send, stream, signal)
          return { camera_id: camera.id }
        },
        onStarted: (next) => {
          if (mounted.current && sessionRef.current === session) {
            setRun(next)
            if (isTerminal(next)) {
              session.close()
              sessionRef.current = null
              setDevice(null)
              setPhase('idle')
              if (next.status === 'failed')
                setError(next.error_message || '감지 실행이 실패했습니다.')
            } else setPhase('recording')
          }
        },
        onError: (cause) => {
          if (mounted.current && sessionRef.current === session) {
            setError(cause.message)
            void stop()
          }
        },
      })
    sessionRef.current = session
    try {
      if (previewOnly) {
        const stream = await session.preview()
        if (mounted.current && sessionRef.current === session && !session.stopped) {
          setDevice({ label: stream.getVideoTracks()[0].label || '기본 웹캠' })
          setPhase('preview')
        }
      } else await session.start()
    } catch (cause) {
      if (mounted.current && sessionRef.current === session) {
        setError(cause.message)
        await stop()
      }
    }
  }

  const runId = run?.id
  const terminal = isTerminal(run)
  useEffect(() => {
    if (!request || !runId || terminal) return
    const controller = new AbortController()
    let timer
    function finish() {
      sessionRef.current?.close()
      sessionRef.current = null
      setDevice(null)
      setPhase('idle')
    }
    async function poll() {
      try {
        const next = await request(`/api/motion/runs/${runId}`, { signal: controller.signal })
        if (controller.signal.aborted) return
        setRun(next)
        setStatusError('')
        if (isTerminal(next)) {
          finish()
          if (next.status === 'failed') setError(next.error_message || '감지 실행이 실패했습니다.')
          return
        }
      } catch (cause) {
        if (controller.signal.aborted) return
        setStatusError(cause.message)
        if ([401, 403].includes(cause.status)) {
          void sessionRef.current?.stop().catch(() => {})
          finish()
          setRun((previous) => previous && { ...previous, status: 'failed' })
          return
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 3000)
    }
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [request, runId, terminal])

  return {
    videoRef,
    device,
    cameraState,
    start: () => activate(false),
    startPreview: () => activate(true),
    stop,
    run,
    starting: phase === 'starting',
    previewStarting: phase === 'preview-starting',
    previewing: phase === 'preview',
    stopping: phase === 'stopping',
    active: phase === 'recording',
    error: error || statusError,
  }
}
