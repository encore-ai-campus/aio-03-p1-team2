const verdicts = { confirmed: '확인됨', not_confirmed: '미확인', uncertain: '판단 어려움' }
const statuses = {
  collecting: '촬영 중',
  waiting: '분석 대기',
  running: '분석 중',
  failed: '분석 실패',
  interrupted: '촬영 중단',
}

export function AnalysisSummary({ result, status, detectedAt }) {
  const priority = ['confirmed', 'uncertain', 'not_confirmed']
  const items = result?.items || []
  const representative = priority
    .map((verdict) => items.find((item) => item.verdict === verdict))
    .find(Boolean)

  return (
    <span className="event-summary">
      <span className="event-summary-head">
        <time className="event-time" dateTime={detectedAt}>
          {new Date(detectedAt).toLocaleString('ko-KR')}
        </time>
        <span className="event-verdicts" aria-label="질문별 판정 개수">
          {priority.map((verdict) => {
            const count = items.filter((item) => item.verdict === verdict).length
            return count ? (
              <span className={`analysis-verdict ${verdict}`} key={verdict}>
                {verdicts[verdict]} {count}개
              </span>
            ) : null
          })}
          {!representative && <span className="muted">{statuses[status] || '분석 대기'}</span>}
        </span>
      </span>
      {representative && <span className="event-summary-text">{representative.summary}</span>}
      <span className="event-summary-footer">
        <span>{representative ? `질문 ${items.length}개 분석` : '사건 상세'}</span>
        <span aria-hidden="true">상세 보기 →</span>
      </span>
    </span>
  )
}

export default function AnalysisResults({ questions = [], result, status, compact = false }) {
  if (!result) return <span className="muted">{statuses[status] || '분석 대기'}</span>
  const byId = new Map(result.items.map((item) => [item.question_id, item]))
  return (
    <span className={`analysis-items${compact ? ' compact' : ''}`}>
      {questions.map((q) => {
        const item = byId.get(q.id)
        if (!item) return null
        return (
          <span className="analysis-item" key={q.id}>
            <span className="analysis-item-heading">
              <strong>{q.question}</strong>
              <span className={`analysis-verdict ${item.verdict}`}>{verdicts[item.verdict]}</span>
            </span>
            <span className="analysis-item-summary">{item.summary}</span>
          </span>
        )
      })}
    </span>
  )
}
