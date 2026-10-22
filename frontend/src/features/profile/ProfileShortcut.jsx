import { getProfileAvatar } from './profileAvatars.js'
import './profileShortcut.css'

export default function ProfileShortcut({ profile, avatarId, onClick, disabled = false }) {
  const nickname = profile?.display_name?.trim() || '내 프로필'
  const avatar = getProfileAvatar(avatarId)

  return (
    <button
      type="button"
      className="profile-shortcut"
      aria-label="나의 프로필로 이동"
      title="나의 프로필로 이동"
      disabled={disabled}
      onClick={onClick}
    >
      <img className="profile-shortcut-avatar" src={avatar.image} alt="" width="32" height="32" />
      <span>{nickname}</span>
    </button>
  )
}
