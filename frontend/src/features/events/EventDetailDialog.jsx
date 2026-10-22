import AnalysisResults from '../../shared/components/AnalysisResults'
import { useEffect, useRef, useState } from 'react'
import Dialog from '../../shared/components/Dialog'
import AdminAnalysisHistory from './AdminAnalysisHistory.jsx'
import EventFeedbackForm from './EventFeedbackForm.jsx'
import { useNavigationLock } from '../../shared/hooks/useNavigationLock.js'

const analysisLabels = {
  collecting: '촬영 중',
  waiting: '분석 대기',
  running: '분석 중',
  succeeded: '분석 완료',
  failed: '분석 실패',
  interrupted: '촬영 중단',
}

function Tag({ tone = '', children }) {
  return <span className={`tag ${tone}`.trim()}>{children}</span>
}

function EvidencePhoto({ request, photo, apiPrefix }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (photo.upload_status !== 'ready') return
    const controller = new AbortController()
    let objectUrl
    setError('')
    request(`${apiPrefix}/photos/${photo.id}/content`, {
      signal: controller.signal,
      responseType: 'blob',
    })
      .then((blob) => {
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message)
      })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [request, photo.id, photo.upload_status, retry, apiPrefix])
  return (
    <figure className="evidence-photo">
      {photo.upload_status !== 'ready' ? (
        <p className="empty-state">사진 업로드 중</p>
      ) : error ? (
        <div className="api-error" role="alert">
          {error}
          <button className="button" onClick={() => setRetry((value) => value + 1)}>
            사진 다시 조회
          </button>
        </div>
      ) : url ? (
        <img src={url} alt={`감지 사진 ${photo.sequence_no}`} />
      ) : (
        <p className="empty-state">사진 조회 중…</p>
      )}
      <figcaption>
        사진 {photo.sequence_no} · 촬영 시작 후 {photo.timestamp_sec.toFixed(1)}초
      </figcaption>
    </figure>
  )
}

export default function EventDetailDialog({
  request,
  eventId,
  onClose,
  apiPrefix = '/api/motion',
  detectedAt,
  feedbackClient,
  feedbackDrafts,
  onBusyChange,
  onUnauthorized,
  onNavigate,
}) {
  const [feedbackBusy, setFeedbackBusy] = useState(false)
  useNavigationLock(feedbackBusy, onBusyChange)
  const [analysis, setAnalysis] = useState(null)
  const [parts, setParts] = useState([])
  const [selectedPart, setSelectedPart] = useState(null)
  const [part, setPart] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [moreLoading, setMoreLoading] = useState(false)
  const [error, setError] = useState('')
  const [partError, setPartError] = useState('')
  const [retry, setRetry] = useState(0)
  const moreController = useRef(null)

  useEffect(() => {
    const controller = new AbortController()
    let timer
    async function load() {
      try {
        const [result, rows] = await Promise.all([
          request(`${apiPrefix}/events/${eventId}/analysis`, { signal: controller.signal }),
          request(`${apiPrefix}/events/${eventId}/parts?limit=20`, { signal: controller.signal }),
        ])
        if (controller.signal.aborted) return
        setAnalysis(result)
        setParts((previous) =>
          [...new Map([...previous, ...rows].map((row) => [row.id, row])).values()].sort(
            (a, b) => a.part_index - b.part_index,
          ),
        )
        setSelectedPart((previous) => previous || rows[0]?.id || null)
        setHasMore((previous) => rows.length === 20 || previous)
        setError('')
        if (!['succeeded', 'failed', 'interrupted'].includes(result.status))
          timer = setTimeout(load, 3000)
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause.message)
      }
    }
    void load()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [request, eventId, retry, apiPrefix])

  useEffect(() => {
    if (!selectedPart) return
    const controller = new AbortController()
    let timer
    setPart(null)
    setPartError('')
    async function load() {
      try {
        const data = await request(`${apiPrefix}/parts/${selectedPart}`, {
          signal: controller.signal,
        })
        if (controller.signal.aborted) return
        setPart(data)
        setPartError('')
        if (data.photos.some((photo) => photo.upload_status !== 'ready'))
          timer = setTimeout(load, 3000)
      } catch (cause) {
        if (!controller.signal.aborted) setPartError(cause.message)
      }
    }
    void load()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [request, selectedPart, retry, apiPrefix])

  useEffect(() => {
    // 추가 묶음 요청도 모달을 닫을 때 취소합니다.
    return () => moreController.current?.abort()
  }, [])
  async function moreParts() {
    moreController.current?.abort()
    const controller = new AbortController()
    moreController.current = controller
    setMoreLoading(true)
    try {
      const after = parts.at(-1)?.part_index || 0
      const rows = await request(`${apiPrefix}/events/${eventId}/parts?after=${after}&limit=20`, {
        signal: controller.signal,
      })
      if (!controller.signal.aborted) {
        setParts((previous) =>
          [...new Map([...previous, ...rows].map((row) => [row.id, row])).values()].sort(
            (a, b) => a.part_index - b.part_index,
          ),
        )
        setHasMore(rows.length === 20)
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause.message)
    } finally {
      if (!controller.signal.aborted) setMoreLoading(false)
    }
  }

  return (
    <Dialog
      open
      onClose={(event) => {
        // [UI-EVT02] 기능·역할: 피드백 전송 중 닫기 방지. 수행 이유: 저장 완료 여부가 불명확해져 같은 의견을 중복 전송하지 않도록 합니다.
        if (feedbackBusy) event?.preventDefault?.()
        else onClose()
      }}
      title="사건 상세"
      className="event-detail-dialog"
    >
      <div className="profile-body">
        <p className="muted event-id">사건 {eventId}</p>
        {error && (
          <p className="api-error" role="alert">
            {error}
          </p>
        )}
        <div className="vision-actions">
          <Tag
            tone={
              analysis?.status === 'failed' ? 'alert' : analysis?.status === 'succeeded' ? 'ok' : ''
            }
          >
            {analysis ? analysisLabels[analysis.status] : '조회 중…'}
          </Tag>
          <button className="button" onClick={() => setRetry((value) => value + 1)}>
            다시 조회
          </button>
        </div>
        {analysis?.result && (
          <div className="analysis-result">
            <AnalysisResults
              questions={analysis.questions}
              result={analysis.result}
              status={analysis.status}
            />
          </div>
        )}
        {analysis?.error_message && (
          <p className="api-error" role="alert">
            {analysis.error_message}
          </p>
        )}
        {/* [UI-EVT02] 기능·역할: 본인 사건의 평가 폼 연결. 수행 이유: 관리자 타인 사건 조회에는 작성 버튼을 제공하지 않고 기존 본인 피드백 권한을 유지합니다. */}
        {feedbackClient && apiPrefix === '/api/motion' && analysis && (
          <EventFeedbackForm
            client={feedbackClient}
            request={request}
            eventId={eventId}
            detectedAt={detectedAt}
            drafts={feedbackDrafts}
            onBusyChange={setFeedbackBusy}
            onUnauthorized={onUnauthorized}
            onNavigate={onNavigate}
          />
        )}
        <h3>촬영 사진</h3>
        <div className="part-list" aria-label="사진 묶음 선택">
          {parts.map((item) => (
            <button
              className="button"
              key={item.id}
              aria-pressed={item.id === selectedPart}
              onClick={() => setSelectedPart(item.id)}
            >
              묶음 {item.part_index}
            </button>
          ))}
          {hasMore && (
            <button className="button" onClick={moreParts} disabled={moreLoading}>
              {moreLoading ? '조회 중…' : '묶음 더 보기'}
            </button>
          )}
        </div>
        {!parts.length && <p className="empty-state">아직 저장된 사진 묶음이 없습니다.</p>}
        {partError && (
          <p className="api-error" role="alert">
            {partError}
          </p>
        )}
        {selectedPart && !part && !partError && <p role="status">사진 묶음 조회 중…</p>}
        {part && (
          <>
            <p className="muted">
              촬영 구간 {part.metadata.start_sec.toFixed(1)}~{part.metadata.end_sec.toFixed(1)}초
              {!part.metadata.context_complete || !part.metadata.evidence_complete
                ? ' · 일부 촬영 문맥이 불완전합니다.'
                : ''}
            </p>
            <div className="evidence-grid">
              {part.photos.map((photo) => (
                <EvidencePhoto
                  key={photo.id}
                  request={request}
                  photo={photo}
                  apiPrefix={apiPrefix}
                />
              ))}
            </div>
          </>
        )}
        {apiPrefix === '/api/admin' && selectedPart && (
          <AdminAnalysisHistory key={selectedPart} request={request} partId={selectedPart} />
        )}
      </div>
    </Dialog>
  )
}
