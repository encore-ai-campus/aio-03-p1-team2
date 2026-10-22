export default function Pagination({
  total,
  offset,
  pageSize,
  busy,
  onChange,
  label = '목록 페이지',
}) {
  if (!total) return null
  return (
    <nav className="pagination" aria-label={label}>
      <button
        type="button"
        className="button"
        disabled={busy || offset === 0}
        onClick={() => onChange(Math.max(0, offset - pageSize))}
      >
        이전
      </button>
      <span>
        {Math.floor(offset / pageSize) + 1} / {Math.max(1, Math.ceil(total / pageSize))}
      </span>
      <button
        type="button"
        className="button"
        disabled={busy || offset + pageSize >= total}
        onClick={() => onChange(offset + pageSize)}
      >
        다음
      </button>
    </nav>
  )
}
