import { useEffect, useMemo, useRef, useState } from 'react'
import { createFeedbackApi } from '../feedback/feedbackApi.js'
import { FEEDBACK_KINDS } from '../feedback/constants.js'

const emptyDraft = () => ({ kind: '', content: '' })

// [UI-EVT02] 기능·역할: 사건 상세 안에서 기존 피드백 API로 평가 등록. 수행 이유: 백엔드 필드 추가 없이 사건 정보는 본문에 첨부하고 본인 피드백으로 저장합니다.
export default function EventFeedbackForm({
  client,
  request,
  eventId,
  detectedAt,
  drafts,
  onBusyChange,
  onUnauthorized,
  onNavigate,
}) {
  const api = useMemo(() => createFeedbackApi(client), [client])
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState(() => drafts.get(eventId) || emptyDraft())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [history, setHistory] = useState([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyError, setHistoryError] = useState('')
  const [historyRevision, setHistoryRevision] = useState(0)
  const pending = useRef(false)
  const active = useRef(true)
  const trigger = useRef(null)
  const kindInput = useRef(null)
  const [eventTime, setEventTime] = useState(null)
  const [timeError, setTimeError] = useState('')
  const [timeRevision, setTimeRevision] = useState(0)
  const suppliedTime = detectedAt && Number.isFinite(Date.parse(detectedAt)) ? detectedAt : null
  const resolvedTime = suppliedTime || eventTime
  const validTime = resolvedTime && Number.isFinite(Date.parse(resolvedTime))
  const timeLabel = validTime
    ? new Intl.DateTimeFormat('ko-KR', {
        dateStyle: 'medium',
        timeStyle: 'medium',
        timeZone: 'Asia/Seoul',
      }).format(new Date(resolvedTime)) + ' (KST)'
    : '조회 중…'
  const context = `[대상 이벤트]\n이벤트 ID: ${eventId}\n감지 시각: ${timeLabel}\n\n[사용자 의견]\n`
  const maxLength = Math.max(0, 1000 - context.length)

  useEffect(() => {
    if (suppliedTime) return
    const controller = new AbortController()
    setEventTime(null)
    setTimeError('')
    request(`/api/motion/events/${eventId}`, { signal: controller.signal })
      .then((item) => {
        if (controller.signal.aborted) return
        if (!item.detected_at || !Number.isFinite(Date.parse(item.detected_at)))
          throw new Error('사건의 감지 시각이 없습니다.')
        setEventTime(item.detected_at)
      })
      .catch((cause) => {
        if (controller.signal.aborted) return
        if (cause.status === 401 || cause.status === 403) onUnauthorized?.()
        else setTimeError(cause.message)
      })
    return () => controller.abort()
  }, [request, eventId, suppliedTime, timeRevision, onUnauthorized])

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  useEffect(() => {
    if (expanded) kindInput.current?.focus()
  }, [expanded])

  // [UI-EVT03] 기능·역할: 사건별 본인 피드백 최근 5건 조회. 수행 이유: 기존 본문 검색을 재사용해 재접속 후에도 서버의 최신 이력을 표시하고 소유권 범위를 유지합니다.
  useEffect(() => {
    const controller = new AbortController()
    setHistoryLoading(true)
    setHistoryError('')
    api
      .list({ limit: 5, q: `이벤트 ID: ${eventId}` }, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) setHistory(page.items)
      })
      .catch((cause) => {
        if (controller.signal.aborted) return
        if (cause.status === 401 || cause.status === 403) onUnauthorized?.()
        else setHistoryError(cause.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryLoading(false)
      })
    return () => controller.abort()
  }, [api, eventId, historyRevision, onUnauthorized])

  function change(values) {
    const next = { ...draft, ...values }
    drafts.set(eventId, next)
    setDraft(next)
    setError('')
    setMessage('')
  }

  function collapse() {
    if (pending.current) return
    setExpanded(false)
    setError('')
    trigger.current?.focus()
  }

  async function submit(event) {
    event.preventDefault()
    if (pending.current) return
    if (!validTime) {
      setError('감지 시각을 조회한 뒤 등록해 주세요.')
      return
    }
    if (!Object.hasOwn(FEEDBACK_KINDS, draft.kind) || !draft.content.trim()) {
      setError('피드백 유형을 선택하고 내용을 입력해 주세요.')
      return
    }
    if (draft.content.length > maxLength) {
      setError(`내용은 ${maxLength}자 이내로 입력해 주세요.`)
      return
    }
    pending.current = true
    setBusy(true)
    onBusyChange(true)
    setError('')
    setMessage('')
    try {
      const result = await api.create({
        title: `사건 피드백 · ${eventId}`,
        kind: draft.kind,
        content: context + draft.content.trim(),
      })
      drafts.delete(eventId)
      if (active.current) {
        setDraft(emptyDraft())
        setHistory((previous) =>
          [result, ...previous.filter((item) => item.id !== result.id)].slice(0, 5),
        )
        setHistoryRevision((value) => value + 1)
        setMessage(
          `피드백 #${result.id}을 등록했습니다. 고객 피드백에서 처리 상태와 답변을 확인할 수 있습니다.`,
        )
        setExpanded(false)
        trigger.current?.focus()
      }
    } catch (cause) {
      if (active.current) {
        if (cause.status === 401 || cause.status === 403) onUnauthorized?.()
        else setError(cause.message)
      }
    } finally {
      pending.current = false
      if (active.current) {
        setBusy(false)
        onBusyChange(false)
      }
    }
  }

  return (
    <section className="event-feedback" aria-label="사건 평가·피드백">
      <button
        ref={trigger}
        type="button"
        className="button"
        aria-expanded={expanded}
        aria-controls="event-feedback-form"
        disabled={busy}
        onClick={() => {
          if (expanded) collapse()
          else {
            setMessage('')
            setExpanded(true)
          }
        }}
      >
        이 사건 평가·피드백
      </button>
      {timeError && (
        <div role="alert">
          <p className="form-error">감지 시각을 불러오지 못했어요. {timeError}</p>
          <button
            type="button"
            className="button"
            onClick={() => setTimeRevision((value) => value + 1)}
          >
            감지 시각 다시 조회
          </button>
        </div>
      )}
      {message && (
        <p className="event-feedback-success" role="status">
          {message}
        </p>
      )}
      <div
        className="event-feedback-history"
        aria-labelledby="event-feedback-history-title"
        aria-busy={historyLoading}
      >
        <h3 id="event-feedback-history-title">이 사건에 남긴 내 피드백</h3>
        <p className="muted">최근 최대 5개 · 최신 작성순</p>
        {historyLoading && (
          <p className="muted" role="status">
            최근 피드백 이력을 확인하고 있어요…
          </p>
        )}
        {historyError && (
          <div role="alert">
            <p className="form-error">최근 피드백 이력을 불러오지 못했어요. {historyError}</p>
            <button
              type="button"
              className="button"
              disabled={busy || historyLoading}
              onClick={() => setHistoryRevision((value) => value + 1)}
            >
              이력 다시 조회
            </button>
          </div>
        )}
        {!historyLoading && !historyError && history.length === 0 && (
          <p className="muted">이 사건에 남긴 피드백이 없습니다.</p>
        )}
        {history.length > 0 && (
          <ul aria-label="이 사건의 최근 내 피드백">
            {history.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="button"
                  aria-label={`피드백 #${item.id} 보기`}
                  disabled={busy || !onNavigate}
                  onClick={() => onNavigate({ page: 'feedback', feedbackId: item.id })}
                >
                  #{item.id}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <form id="event-feedback-form" hidden={!expanded} onSubmit={submit} aria-busy={busy}>
        <p className="muted event-feedback-context">
          대상 사건: {eventId}
          <br />
          감지 시각: {timeError ? '조회 실패' : timeLabel}
        </p>
        <p className="muted">사건 ID와 감지 시각이 피드백 내용에 함께 저장됩니다.</p>
        <fieldset disabled={busy}>
          <label htmlFor="event-feedback-kind">피드백 유형</label>
          <select
            id="event-feedback-kind"
            ref={kindInput}
            value={draft.kind}
            required
            onChange={(event) => change({ kind: event.target.value })}
          >
            <option value="">유형 선택</option>
            {Object.entries(FEEDBACK_KINDS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <label htmlFor="event-feedback-content">내용</label>
          <textarea
            id="event-feedback-content"
            value={draft.content}
            required
            maxLength={maxLength}
            aria-describedby={`event-feedback-limit${error ? ' event-feedback-error' : ''}`}
            aria-invalid={Boolean(error)}
            placeholder="이 사건의 감지·분석 결과에 대한 의견을 남겨 주세요."
            onChange={(event) => change({ content: event.target.value })}
          />
          <p className="muted" id="event-feedback-limit">
            {draft.content.length} / {maxLength}자 · 사건 정보를 포함해 최대 1,000자
          </p>
          {error && (
            <p id="event-feedback-error" className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button type="button" className="button" onClick={collapse}>
              접기
            </button>
            <button type="submit" className="button primary" disabled={!validTime}>
              {busy ? '등록 중…' : '피드백 등록'}
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  )
}
