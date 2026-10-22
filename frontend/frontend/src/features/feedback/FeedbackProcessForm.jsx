import { FEEDBACK_STATUSES } from './constants.js'

export default function FeedbackProcessForm({ item, form, setForm, focusRef }) {
  return (
    <>
      <div className="processing-copy">
        <strong>{item.title}</strong>
        <p>{item.content}</p>
      </div>

      <label htmlFor="process-status">처리 상태</label>

      <select
        id="process-status"
        ref={focusRef}
        value={form.status}
        onChange={(event) =>
          setForm({
            ...form,
            status: event.target.value,
          })
        }
      >
        {Object.entries(FEEDBACK_STATUSES).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>

      <label htmlFor="admin-note">작성자에게 남길 답변</label>

      <textarea
        id="admin-note"
        maxLength={1000}
        value={form.admin_note}
        onChange={(event) =>
          setForm({
            ...form,
            admin_note: event.target.value,
          })
        }
        placeholder="작성자가 확인할 답변을 입력해 주세요"
      />
    </>
  )
}
