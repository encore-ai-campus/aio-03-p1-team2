import { useEffect, useState } from 'react'

export default function ProfileForm({ profile, busy, onSave, onCancel }) {
  const [name, setName] = useState(profile.display_name || '')
  useEffect(() => setName(profile.display_name || ''), [profile])
  return (
    <form
      className="profile-edit-form"
      onSubmit={(event) => {
        event.preventDefault()
        onSave(name)
      }}
      aria-busy={busy}
    >
      <label htmlFor="profile-nickname">닉네임</label>
      <input
        id="profile-nickname"
        name="nickname"
        autoComplete="nickname"
        autoFocus
        required
        maxLength={40}
        value={name}
        disabled={busy}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault()
            onCancel()
          }
        }}
      />
      <p className="profile-input-hint">1~40자로 입력해 주세요.</p>
      <div className="profile-edit-actions">
        <button className="primary" type="submit" disabled={busy}>
          {busy ? '저장 중…' : '저장'}
        </button>
        <button className="profile-edit-cancel" type="button" disabled={busy} onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  )
}
