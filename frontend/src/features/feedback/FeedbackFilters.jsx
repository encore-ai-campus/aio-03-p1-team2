import { FEEDBACK_KINDS, FEEDBACK_STATUSES } from './constants.js'

export default function FeedbackFilters({
  kind,
  setKind,
  status,
  setStatus,
  setOffset,
  busy,
  loading,
  refresh,
  searchField,
  setSearchField,
  query,
  setQuery,
  searchError,
  applySearch,
  resetFilters,
}) {
  return (
    <section className="feedback-search-panel" aria-label="피드백 검색">
      {/* [UI-FB01] 기능·역할: 번호·제목·내용 전체 검색 입력. 수행 이유: 시안의 검색 구조를 사용하고 서버 검색을 명시적으로 실행합니다. */}
      <form className="feedback-search-form" role="search" onSubmit={applySearch}>
        <label htmlFor="feedback-query">피드백 검색</label>
        <div className="feedback-search-controls">
          <select
            aria-label="검색 기준"
            disabled={busy}
            value={searchField}
            onChange={(event) => setSearchField(event.target.value)}
          >
            <option value="text">제목 · 내용</option>
            <option value="id">피드백 번호 (#ID)</option>
          </select>
          <div className="feedback-search-input">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.8" />
              <path d="m13 13 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <input
              id="feedback-query"
              type="search"
              value={query}
              disabled={busy}
              maxLength={searchField === 'id' ? 20 : 100}
              autoComplete="off"
              placeholder={
                searchField === 'id'
                  ? '피드백 번호 입력 (예: 1034 또는 #1034)'
                  : '제목이나 내용에 포함된 검색어를 입력하세요'
              }
              aria-invalid={Boolean(searchError)}
              aria-describedby={`feedback-search-help${searchError ? ' feedback-search-error' : ''}`}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <button className="button primary" type="submit" disabled={busy}>
            검색
          </button>
        </div>
        {searchError && (
          <p className="form-error" id="feedback-search-error" role="alert">
            {searchError}
          </p>
        )}
      </form>
      <div className="feedback-filters">
        <label>
          유형
          <select
            aria-label="유형 필터"
            disabled={busy}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value)
              setOffset(0)
            }}
          >
            <option value="">전체 유형</option>

            {Object.entries(FEEDBACK_KINDS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label>
          상태
          <select
            aria-label="상태 필터"
            disabled={busy}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value)
              setOffset(0)
            }}
          >
            <option value="">전체 상태</option>

            {Object.entries(FEEDBACK_STATUSES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        {/* [UI-FB04] 기능·역할: 초기화·새로고침 버튼 스타일 통일. 수행 이유: 같은 공통 버튼 스타일로 테두리·글꼴·크기를 맞춥니다. */}
        <button type="button" className="button" disabled={busy} onClick={resetFilters}>
          검색·필터 초기화
        </button>
        <button
          type="button"
          className="button refresh-button"
          disabled={busy || loading}
          onClick={refresh}
        >
          새로고침
        </button>
      </div>
      <p className="feedback-search-help" id="feedback-search-help">
        {searchField === 'id'
          ? '등록된 피드백 번호와 정확히 일치하는 기록을 검색합니다.'
          : '현재 조회 권한 안의 모든 피드백에서 제목·내용을 검색합니다. 검색어는 최대 100자입니다.'}
      </p>
    </section>
  )
}
