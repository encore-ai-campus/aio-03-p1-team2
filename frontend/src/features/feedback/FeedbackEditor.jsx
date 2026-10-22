import { useEffect, useRef } from 'react'
import Dialog from '../../shared/components/Dialog.jsx'
import { FEEDBACK_KINDS } from './constants.js'
import FeedbackProcessForm from './FeedbackProcessForm.jsx'
import { splitEventFeedback } from './eventFeedbackContext.js'

export default function FeedbackEditor({ editor, form, setForm, busy, error, onSubmit, onCancel }) {
  const eventContext = editor.type === 'edit' ? splitEventFeedback(editor.item.content).context : ''
  const titleRef = useRef(null)
  const statusRef = useRef(null)
  useEffect(() => {
    if (editor.type === 'process') statusRef.current?.focus()
    else titleRef.current?.focus()
  }, [editor])

  function closeDialog(event) {
    if (busy) {
      event?.preventDefault?.()
      return
    }
    onCancel()
  }

  const formElement = (
    <form className="feedback-form" onSubmit={onSubmit}>
      <fieldset disabled={busy}>
        {editor.type === 'process' ? (
          <FeedbackProcessForm
            item={editor.item}
            form={form}
            setForm={setForm}
            focusRef={statusRef}
          />
        ) : (
          <>
            <label htmlFor="feedback-title">제목</label>

            <input
              id="feedback-title"
              ref={titleRef}
              maxLength={100}
              required
              value={form.title}
              onChange={(event) =>
                setForm({
                  ...form,
                  title: event.target.value,
                })
              }
              placeholder="제목을 입력해 주세요"
            />

            <label htmlFor="feedback-kind">피드백 유형</label>

            <select
              id="feedback-kind"
              value={form.kind}
              onChange={(event) =>
                setForm({
                  ...form,
                  kind: event.target.value,
                })
              }
            >
              {/* [UI-04] 기능·역할: 작성·수정 시 전체 피드백 유형 제공. 수행 이유: 정확한 감지 평가도 신규 작성과 다른 유형에서 변경할 때 선택할 수 있어야 합니다. */}
              {Object.entries(FEEDBACK_KINDS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>

            {eventContext && (
              <div aria-label="연결된 사건 정보">
                <p className="feedback-copy">
                  {eventContext.replace(/\r?\n\[사용자 의견\]\r?\n$/, '').trim()}
                </p>
                <p className="muted">사건 정보는 유지되며 아래에서 의견만 수정할 수 있습니다.</p>
              </div>
            )}
            <label htmlFor="feedback-content">내용</label>

            <textarea
              id="feedback-content"
              maxLength={Math.max(0, 1000 - eventContext.length)}
              required
              value={form.content}
              onChange={(event) =>
                setForm({
                  ...form,
                  content: event.target.value,
                })
              }
              placeholder="잘못 감지하거나 놓친 상황, 개선할 점을 적어주세요"
            />
          </>
        )}
        <div className="actions">
          <button type="button" className="button" onClick={onCancel}>
            취소
          </button>
          <button type="submit" className="button primary">
            {busy ? '저장 중…' : editor.type === 'create' ? '등록' : '저장'}
          </button>
        </div>
      </fieldset>
    </form>
  )

  if (editor.type === 'process') {
    return (
      <Dialog open onClose={closeDialog} title="피드백 처리" className="feedback-process-dialog">
        {error && (
          <p className="form-error alert-box" role="alert">
            {error}
          </p>
        )}
        {formElement}
      </Dialog>
    )
  }

  return (
    <section className="panel form-panel" aria-labelledby="feedback-form-title">
      <div className="panel-head">
        <h2 id="feedback-form-title">{editor.type === 'edit' ? '피드백 수정' : '피드백 작성'}</h2>
      </div>
      {formElement}
    </section>
  )
}
