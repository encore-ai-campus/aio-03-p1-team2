import owlImage from '../../assets/profile-owl.png'
import raccoonImage from '../../assets/profile-raccoon.png'
import bearImage from '../../assets/profile-bear.png'
import rabbitImage from '../../assets/profile-rabbit.png'

export const PROFILE_AVATARS = [
  { id: 'owl', name: '부엉이', image: owlImage },
  { id: 'raccoon', name: '라쿤', image: raccoonImage },
  { id: 'bear', name: '곰', image: bearImage },
  { id: 'rabbit', name: '토끼', image: rabbitImage },
]

const DEFAULT_AVATAR_ID = PROFILE_AVATARS[0].id
const STORAGE_PREFIX = 'notecam:profile-avatar:'

export function getProfileAvatar(id) {
  return PROFILE_AVATARS.find((avatar) => avatar.id === id) || PROFILE_AVATARS[0]
}

export function readProfileAvatar(userId) {
  if (!userId) return DEFAULT_AVATAR_ID
  try {
    return getProfileAvatar(window.localStorage.getItem(`${STORAGE_PREFIX}${userId}`)).id
  } catch {
    return DEFAULT_AVATAR_ID
  }
}

export function saveProfileAvatar(userId, avatarId) {
  if (!userId || !PROFILE_AVATARS.some((avatar) => avatar.id === avatarId)) return false
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${userId}`, avatarId)
    return true
  } catch {
    return false
  }
}
