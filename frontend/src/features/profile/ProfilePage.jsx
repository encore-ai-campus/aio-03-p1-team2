import { useState } from 'react'
import PageHeading from '../../shared/components/PageHeading.jsx'
import ResourceState from '../../shared/components/ResourceState.jsx'
import { useNavigationLock } from '../../shared/hooks/useNavigationLock.js'
import { formatFullDate } from '../../shared/utils/formatDate.js'
import { getProfileAvatar, PROFILE_AVATARS } from './profileAvatars.js'
import ProfileForm from './ProfileForm.jsx'
import './profile.css'

function ProfileDetails({
  profile,
  avatarId,
  onChooseAvatar,
  busy,
  saveError,
  message,
  onSave,
  clearSaveFeedback,
  connections,
}) {
  const [avatarMessage, setAvatarMessage] = useState('')
  const [avatarStorageError, setAvatarStorageError] = useState(false)
  const [editingNickname, setEditingNickname] = useState(false)
  const avatar = getProfileAvatar(avatarId)

  function chooseAvatar(nextAvatar) {
    const saved = onChooseAvatar(nextAvatar)
    setAvatarStorageError(!saved)
    setAvatarMessage(
      saved
        ? `${nextAvatar.name} 아바타를 선택했어요.`
        : '브라우저 저장소를 사용할 수 없어 선택을 유지할 수 없어요.',
    )
  }

  function startEditingNickname() {
    clearSaveFeedback()
    setEditingNickname(true)
  }

  function cancelEditingNickname() {
    clearSaveFeedback()
    setEditingNickname(false)
  }

  async function saveNickname(name) {
    if (await onSave(name)) setEditingNickname(false)
  }

  return (
    <div className="profile-sections">
      <section className="dashboard-panel profile-summary" aria-labelledby="profile-summary-title">
        <div className="profile-summary-main">
          <img
            className="profile-summary-avatar"
            src={avatar.image}
            alt={`현재 선택한 ${avatar.name} 프로필 이미지`}
            width="112"
            height="112"
          />
          <div className="profile-summary-intro">
            <p className="profile-eyebrow">내 계정</p>
            <div className="profile-name-row">
              <h2 id="profile-summary-title">
                {profile.display_name?.trim() || '닉네임을 설정해 주세요'}
              </h2>
              {!editingNickname && (
                <button
                  className="profile-edit-trigger"
                  type="button"
                  aria-label="닉네임 수정"
                  title="닉네임 수정"
                  disabled={busy}
                  onClick={startEditingNickname}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
                    <path
                      d="M4 20h4l11-11a2.12 2.12 0 0 0-3-3L5 17l-1 3Z"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path d="m14.5 7.5 3 3" stroke="currentColor" strokeWidth="1.8" />
                  </svg>
                </button>
              )}
            </div>
            <p className="profile-summary-caption">고객 피드백에 표시되는 이름이에요.</p>
            {editingNickname && (
              <div className="profile-inline-editor">
                {saveError && (
                  <p className="form-error" role="alert">
                    {saveError}
                  </p>
                )}
                <ProfileForm
                  profile={profile}
                  busy={busy}
                  onSave={saveNickname}
                  onCancel={cancelEditingNickname}
                />
              </div>
            )}
            {!editingNickname && (
              <p className="profile-feedback" role="status">
                {message}
              </p>
            )}
          </div>
        </div>
        <dl className="profile-facts">
          <div>
            <dt>이메일</dt>
            <dd>{profile.email || '이메일 정보 없음'}</dd>
          </div>
          <div>
            <dt>가입일</dt>
            <dd>{formatFullDate(profile.created_at)}</dd>
          </div>
        </dl>
      </section>

      <section className="dashboard-panel profile-card" aria-labelledby="profile-avatar-title">
        <h2 id="profile-avatar-title">프로필 이미지</h2>
        <p className="profile-card-copy">마음에 드는 아바타를 선택해 주세요.</p>
        <div className="profile-avatar-options" role="group" aria-label="프로필 이미지 선택">
          {PROFILE_AVATARS.map((choice) => (
            <button
              className="profile-avatar-option"
              type="button"
              key={choice.id}
              aria-label={`${choice.name} 아바타 선택`}
              aria-pressed={avatarId === choice.id}
              onClick={() => chooseAvatar(choice)}
            >
              <img src={choice.image} alt="" width="84" height="84" />
              <span>{choice.name}</span>
            </button>
          ))}
        </div>
        <p
          className={`profile-feedback${avatarStorageError ? ' profile-feedback-error' : ''}`}
          role="status"
        >
          {avatarMessage}
        </p>
      </section>
      {connections}
    </div>
  )
}

export default function ProfilePage({
  profile,
  avatarId,
  onChooseAvatar,
  onBusyChange,
  connections,
}) {
  useNavigationLock(profile.busy, onBusyChange)
  return (
    <div className="profile-content">
      <PageHeading title="나의 프로필" description="프로필과 계정 연결·알림 설정을 관리해요." />
      <ResourceState loading={profile.loading} error={profile.error} onRetry={profile.refresh}>
        {profile.data && (
          <ProfileDetails
            key={profile.data.id}
            profile={profile.data}
            avatarId={avatarId}
            onChooseAvatar={onChooseAvatar}
            busy={profile.busy}
            saveError={profile.saveError}
            message={profile.message}
            onSave={profile.save}
            clearSaveFeedback={profile.clearSaveFeedback}
            connections={connections}
          />
        )}
      </ResourceState>
    </div>
  )
}
