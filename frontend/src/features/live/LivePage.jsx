import { useEffect, useState } from 'react'
import { AnalysisSummary } from '../../shared/components/AnalysisResults'
import PageHeading from '../../shared/components/PageHeading.jsx'
import QuestionSettingsDialog from './QuestionSettingsDialog'
import { useRemotePreview } from './useRemotePreview.js'
import './live.css'

// [UI-CAM01] 기능·역할: 앱에서 공유한 카메라 세션 표시·제어. 수행 이유: 운영현황과 별도 세션을 생성하지 않고 기존 녹화 동작을 유지합니다.
export default function LivePage({
  request = null,
  camera,
  visible = true,
  remoteMode = false,
  onSelectEvent,
}) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [events, setEvents] = useState([])
  const [eventsError, setEventsError] = useState('')
  const [eventsLoading, setEventsLoading] = useState(false)
  const [remotePlaying, setRemotePlaying] = useState(true)
  const remote = useRemotePreview(request, remoteMode && visible && remotePlaying)

  useEffect(() => {
    if (!visible || remoteMode) setSettingsOpen(false)
  }, [visible, remoteMode])

  useEffect(() => {
    if (!request || !visible) return
    const controller = new AbortController()
    let timer
    async function load() {
      if (document.hidden) {
        timer = setTimeout(load, 10000)
        return
      }
      setEventsLoading(true)
      try {
        const data = await request('/api/motion/events?limit=5', { signal: controller.signal })
        if (!controller.signal.aborted) {
          setEvents(data)
          setEventsError('')
        }
      } catch (error) {
        if (!controller.signal.aborted) setEventsError(error.message)
      } finally {
        if (!controller.signal.aborted) setEventsLoading(false)
      }
      if (!controller.signal.aborted)
        timer = setTimeout(load, camera.active || remoteMode ? 3000 : 10000)
    }
    void load()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [request, visible, camera.active, remoteMode])

  return (
    <section hidden={!visible} aria-label={remoteMode ? '다른 기기 카메라' : '실시간 카메라'}>
      <PageHeading
        title={remoteMode ? '다른 기기 보기' : '실시간 보기'}
        description={
          remoteMode
            ? '촬영 중인 다른 기기의 카메라 영상을 확인해요.'
            : '내 거실 카메라 화면과 최근 움직임을 확인해요.'
        }
      />
      <div
        className="live-toolbar"
        role="group"
        aria-label={remoteMode ? '원격 보기 제어' : '카메라 제어'}
      >
        {remoteMode ? (
          <button
            className="button remote-playback-control"
            type="button"
            aria-label={remotePlaying ? '정지' : '재생'}
            title={remotePlaying ? '정지' : '재생'}
            disabled={!request}
            onClick={() => setRemotePlaying((value) => !value)}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              {remotePlaying ? (
                <rect x="6" y="6" width="12" height="12" rx="1" />
              ) : (
                <path d="M8 5v14l11-7z" />
              )}
            </svg>
          </button>
        ) : (
          <>
            <button
              className="button"
              type="button"
              disabled={!request}
              onClick={() => setSettingsOpen(true)}
            >
              분석 설정
            </button>
            {/* [UI-CAM04] 기능·역할: 로컬 미리보기 전용 버튼. 수행 이유: 녹화와 구분해 화면만 확인하고 준비 중 취소·카메라 종료를 지원합니다. */}
            <button
              className="button"
              type="button"
              aria-pressed={camera.previewing}
              aria-busy={camera.previewStarting}
              disabled={!request || camera.active || camera.starting || camera.stopping}
              onClick={
                camera.previewing || camera.previewStarting ? camera.stop : camera.startPreview
              }
            >
              {camera.previewStarting
                ? '미리보기 준비 취소'
                : camera.previewing
                  ? '미리보기 끄기'
                  : '미리보기 켜기'}
            </button>
            {(camera.starting || camera.stopping) && (
              <span className="muted" role="status">
                {camera.stopping ? '종료 중…' : '준비 중…'}
              </span>
            )}
            <button
              className="record-control"
              type="button"
              aria-label={
                camera.stopping
                  ? '녹화 종료 중'
                  : camera.starting
                    ? '녹화 준비 취소'
                    : camera.active
                      ? '녹화 중지'
                      : '카메라 녹화'
              }
              title={
                camera.stopping
                  ? '녹화 종료 중'
                  : camera.starting
                    ? '녹화 준비 취소'
                    : camera.active
                      ? '녹화 중지'
                      : '카메라 녹화'
              }
              aria-busy={camera.starting || camera.stopping}
              data-recording={camera.active}
              disabled={!request || camera.stopping || camera.previewStarting}
              onClick={camera.active || camera.starting ? camera.stop : camera.start}
            >
              <span aria-hidden="true" />
            </button>
          </>
        )}
      </div>
      {!request && (
        <p className="admin-note">
          {remoteMode
            ? '로그인 후 원격 영상을 볼 수 있습니다.'
            : '로그인 후 카메라 녹화를 시작할 수 있습니다.'}
        </p>
      )}
      {!remoteMode && camera.error && (
        <p className="api-error" role="alert">
          {camera.error}
        </p>
      )}
      <div className="grid-live live-view">
        <section className="dashboard-panel live-camera-panel">
          <div className="camera-scene">
            <video
              ref={camera.videoRef}
              muted
              playsInline
              autoPlay
              aria-label="브라우저 카메라 영상"
              aria-hidden={remoteMode}
              style={remoteMode ? { display: 'none' } : undefined}
            />
            {remoteMode && (
              <>
                {remotePlaying && remote.url ? (
                  <img
                    className="remote-camera-image"
                    src={remote.url}
                    alt={`${remote.name} 실시간 영상`}
                    referrerPolicy="no-referrer"
                    onError={remote.onError}
                  />
                ) : (
                  <div className="remote-camera-placeholder" role="status">
                    <p>
                      {remotePlaying
                        ? remote.message || '카메라 영상을 연결하고 있습니다.'
                        : '영상 보기를 정지했습니다. 재생을 눌러 다시 연결하세요.'}
                    </p>
                  </div>
                )}
                {remotePlaying && remote.url && (
                  <span className="camera-live">원격 보기 · {remote.name}</span>
                )}
              </>
            )}
            {!remoteMode && !camera.device && (
              <div className="camera-placeholder">
                {camera.stopping
                  ? '카메라를 껐습니다. 서버 정리 중…'
                  : camera.starting || camera.previewStarting
                    ? '카메라를 준비하고 있습니다. 버튼을 다시 누르면 취소됩니다.'
                    : '미리보기 또는 녹화 버튼을 눌러 시작하세요.'}
              </div>
            )}
            {!remoteMode && camera.device && (
              <span className="camera-live" data-preview={camera.previewing} role="status">
                <i className="dot" aria-hidden="true" />
                {camera.active ? '녹화 중' : camera.starting ? '녹화 준비 중' : '미리보기 중'}
              </span>
            )}
          </div>
        </section>
        <section className="dashboard-panel live-motion-panel">
          <div className="panel-title">
            <h2>최근 움직임</h2>
            <span className="muted">{eventsLoading ? '조회 중…' : `${events.length}건`}</span>
          </div>
          {eventsError && (
            <p className="api-error" role="alert">
              {eventsError}
            </p>
          )}
          <div className="event-list">
            {events.map((item) => (
              <button
                className="event motion-event"
                type="button"
                key={item.id}
                onClick={() => onSelectEvent?.(item.id, item.detected_at)}
              >
                {/* [UI-EVT02] 기능·역할: 최근 사건의 피드백 문맥 전달. 수행 이유: 상세 창에서 감지 시각을 실제 기록과 일치시킵니다. */}
                <AnalysisSummary
                  result={item.result}
                  status={item.analysis_status}
                  detectedAt={item.detected_at}
                />
              </button>
            ))}
            {!events.length && !eventsLoading && (
              <p className="empty-state">아직 감지된 움직임이 없어요.</p>
            )}
          </div>
        </section>
      </div>
      {settingsOpen && visible && !remoteMode && (
        <QuestionSettingsDialog request={request} onClose={() => setSettingsOpen(false)} />
      )}
    </section>
  )
}
