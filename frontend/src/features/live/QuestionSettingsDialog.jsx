import { useEffect, useRef, useState } from 'react'
import Dialog from '../../shared/components/Dialog'

const toDraft = (questions) => questions.map((q) => ({ ...q, key: q.id || crypto.randomUUID() }))

export default function QuestionSettingsDialog({ request, onClose }) {
  const [questions, setQuestions] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [notifyOnUncertain, setNotifyOnUncertain] = useState(false)
  const [retry, setRetry] = useState(0)
  const saveController = useRef(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    request('/api/motion/questions', { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) {
          setQuestions(toDraft(data.questions))
          setNotifyOnUncertain(data.notify_on_uncertain)
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => {
      controller.abort()
      saveController.current?.abort()
    }
  }, [request, retry])

  function change(next) {
    setQuestions(next)
    setMessage('')
    setError('')
  }
  const texts = questions.map((q) => q.question.trim())
  const totalLength = texts.reduce((sum, text) => sum + text.length, 0)
  const valid =
    texts.length > 0 &&
    texts.every(Boolean) &&
    new Set(texts).size === texts.length &&
    totalLength <= 4000
  const busy = loading || saving

  async function saveQuestions(event) {
    event.preventDefault()
    if (busy || !valid) return
    const controller = new AbortController()
    saveController.current = controller
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const data = await request('/api/motion/questions', {
        method: 'PUT',
        signal: controller.signal,
        body: {
          notify_on_uncertain: notifyOnUncertain,
          questions: questions.map((q) => ({
            ...(q.id ? { id: q.id } : {}),
            question: q.question.trim(),
          })),
        },
      })
      if (!controller.signal.aborted) {
        setQuestions(toDraft(data.questions))
        setMessage('저장했습니다. 이후 등록되는 새 사건부터 적용됩니다.')
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause.message)
    } finally {
      if (!controller.signal.aborted) setSaving(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title="분석 설정" className="question-settings-dialog">
      <form className="profile-body" onSubmit={saveQuestions}>
        <div className="question-list-head">
          <h3>
            분석할 질문 <span className="muted">{questions.length}/5</span>
          </h3>
          <button
            type="button"
            className="button"
            disabled={busy || questions.length >= 5}
            onClick={() => change([...questions, { key: crypto.randomUUID(), question: '' }])}
          >
            + 직접 질문 추가
          </button>
        </div>
        <div className="question-inputs">
          {questions.map((q, index) => (
            <div className="question-input" key={q.key}>
              <div className="question-input-head">
                <label htmlFor={`motion-question-${q.key}`}>질문 {index + 1}</label>
                <button
                  type="button"
                  className="question-remove"
                  aria-label={`질문 ${index + 1} 삭제`}
                  disabled={busy}
                  onClick={() => change(questions.filter((item) => item.key !== q.key))}
                >
                  삭제
                </button>
              </div>
              <textarea
                id={`motion-question-${q.key}`}
                value={q.question}
                onChange={(event) =>
                  change(
                    questions.map((item) =>
                      item.key === q.key ? { ...item, question: event.target.value } : item,
                    ),
                  )
                }
                maxLength={4000}
                required
                disabled={busy}
                placeholder="예: 물건을 누가 가져갔는지 확인해줘."
              />
            </div>
          ))}
        </div>
        <p className="muted">
          질문 1~5개 · 전체 {totalLength.toLocaleString()} / 4,000자
          <br />
          저장한 질문은 이후 등록되는 새 사건부터 적용됩니다.
        </p>
        {totalLength > 4000 && (
          <p className="api-error" role="alert">
            질문 전체 길이를 4,000자 이하로 줄여 주세요.
          </p>
        )}
        {new Set(texts).size !== texts.length && (
          <p className="api-error" role="alert">
            중복된 질문을 수정하거나 삭제해 주세요.
          </p>
        )}
        <label className="notification-setting">
          <input
            type="checkbox"
            checked={notifyOnUncertain}
            disabled={busy}
            onChange={(event) => {
              setNotifyOnUncertain(event.target.checked)
              setMessage('')
            }}
          />
          판단 어려움도 알림 받기
        </label>
        <button className="button primary" disabled={busy || !valid}>
          {saving ? '저장 중…' : '질문 저장'}
        </button>
        {error && (
          <p className="api-error" role="alert">
            {error}
            {!questions.length && (
              <button
                type="button"
                className="button"
                onClick={() => setRetry((value) => value + 1)}
              >
                다시 불러오기
              </button>
            )}
          </p>
        )}
        <p className="save-message" role="status">
          {message}
        </p>
      </form>
    </Dialog>
  )
}
