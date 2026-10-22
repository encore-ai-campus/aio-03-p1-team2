export default function ResourceState({ loading, error, onRetry, hasData = false, children }) {
  if (loading && !hasData)
    return (
      <p className="empty" role="status">
        불러오는 중…
      </p>
    )
  if (error && !hasData)
    return (
      <div className="empty">
        <p className="form-error" role="alert">
          {error}
        </p>
        <button type="button" className="button" onClick={onRetry}>
          다시 시도
        </button>
      </div>
    )
  return (
    <>
      {error && (
        <div className="dashboard-error" role="alert">
          {error}
          <button type="button" className="button" onClick={onRetry}>
            다시 시도
          </button>
        </div>
      )}
      {children}
    </>
  )
}
