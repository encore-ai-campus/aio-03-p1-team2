export function formatDate(value) {
  if (!value) return '-'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '-'
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Seoul',
  }).format(parsed)
}

export function formatFullDate(value) {
  if (!value) return '-'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '-'
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Asia/Seoul',
  }).format(parsed)
}
