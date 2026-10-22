import { useEffect, useState } from 'react'
import { AnalysisSummary } from '../../shared/components/AnalysisResults'
import PageHeading from '../../shared/components/PageHeading.jsx'
import QuestionSettingsDialog from './QuestionSettingsDialog'
import './live.css'

// [UI-CAM01] 기능·역할: 앱에서 공유한 카메라 세션 표시·제어. 수행 이유: 운영현황과 별도 세션을 생성하지 않고 기존 녹화 동작을 유지합니다.
export default function LivePage({ request = null, camera, visible = true, onSelectEvent }) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [events, setEvents] = useState([])
  const [eventsError, setEventsError] = useState('')
  const [eventsLoading, setEventsLoading] = useState(false)

  useEffect(() => {
    if (!visible) setSettingsOpen(false)
  }, [visible])

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
      if (!controller.signal.aborted) timer = setTimeout(load, camera.active ? 3000 : 10000)
    }
    void load()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [request, visible, camera.active])

  return (
    <section hidden={!visible} aria-label="실시간 카메라">
      <PageHeading
        title="실시간 보기"
        description="내 거실 카메라 화면과 최근 움직임을 확인해요."
      />
      <div className="live-toolbar" role="group" aria-label="카메라 제어">
        <button
          className="button"
          type="button"
          disabled={!request}
          onClick={() => setSettingsOpen(true)}
        >
          분석 설정
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
          disabled={!request || camera.stopping}
          onClick={camera.active || camera.starting ? camera.stop : camera.start}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      {!request && <p className="admin-note">로그인 후 카메라 녹화를 시작할 수 있습니다.</p>}
      {camera.error && (
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
            />
            {!camera.device && (
              <div className="camera-placeholder">
                {camera.stopping
                  ? '카메라를 껐습니다. 서버 정리 중…'
                  : camera.starting
                    ? '카메라를 준비하고 있습니다. 버튼을 다시 누르면 취소됩니다.'
                    : '녹화 버튼을 눌러 시작하세요.'}
              </div>
            )}
            {camera.device && (
              <span className="camera-live">
                <i className="dot" aria-hidden="true" />
                LIVE
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
                onClick={() => onSelectEvent?.(item.id)}
              >
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
      {settingsOpen && visible && (
        <QuestionSettingsDialog request={request} onClose={() => setSettingsOpen(false)} />
      )}
    </section>
  )
}
