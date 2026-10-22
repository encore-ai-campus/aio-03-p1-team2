import { FEEDBACK_KINDS, FEEDBACK_STATUSES } from './constants.js'
import { formatFullDate as dateLabel } from '../../shared/utils/formatDate.js'

// [UI-FB02] 기능·역할: 제목·내용의 일치 부분 강조. 수행 이유: 시안의 검색 표시를 적용하고 HTML 삽입 없이 사용자 입력을 안전하게 보여줍니다.
function Highlight({ value, query }) {
  if (!query) return value
  const index = value.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
  if (index < 0) return value
  return (
    <>
      {value.slice(0, index)}
      <mark>{value.slice(index, index + query.length)}</mark>
      {value.slice(index + query.length)}
    </>
  )
}

export default function FeedbackList({
  page,
  loading,
  refreshing,
  listError,
  kind,
  status,
  search,
  resetFilters,
  adminView,
  busy,
  openEditor,
  remove,
  refresh,
}) {
  return (
    <section
      className="panel feedback-list"
      aria-label="피드백 목록"
      aria-busy={loading || refreshing}
    >
      {loading ? (
        <div className="empty" role="status">
          피드백을 불러오고 있어요…
        </div>
      ) : listError ? (
        <div className="empty">
          <p className="form-error" role="alert">
            {listError}
          </p>

          <button type="button" className="button" onClick={refresh}>
            다시 시도
          </button>
        </div>
      ) : page.items.length === 0 ? (
        <div className="empty">
          {kind || status || search.q || search.feedbackId ? (
            <>
              <strong>조건에 맞는 피드백이 없어요.</strong>
              <p>검색어나 유형·상태 필터를 변경해 보세요.</p>
              <button type="button" className="button" disabled={busy} onClick={resetFilters}>
                검색·필터 초기화
              </button>
            </>
          ) : (
            '아직 등록된 피드백이 없어요.'
          )}
        </div>
      ) : (
        page.items.map((item) => (
          <article className="feedback-item" key={item.id} aria-label={`피드백 #${item.id}`}>
            <div className={`feedback-detail${adminView ? ' actionable' : ''}`}>
              <div className="feedback-title-row">
                {/* [UI-FB02] 기능·역할: 고유 피드백 번호 공통 표시. 수행 이유: 페이지 순번을 새로 매기지 않고 사용자·관리자가 같은 기록을 번호로 찾게 합니다. */}
                <span className="feedback-id" aria-label={`피드백 번호 ${item.id}`}>
                  #{item.id}
                </span>
                <h2 className="feedback-title">
                  <Highlight value={item.title} query={search.q} />
                </h2>
              </div>

              <div className="feedback-meta">
                {/* [UI-FB05] 기능·역할: 피드백 유형별 공통 배지 표시. 수행 이유: 사용자·관리자가 같은 위치에서 유형을 색상과 이름으로 구분합니다. */}
                <span className={`kind-tag ${item.kind}`}>
                  {FEEDBACK_KINDS[item.kind] ?? item.kind}
                </span>
                {' · '}
                <time dateTime={item.created_at}>{dateLabel(item.created_at)}</time>
                {' · '}

                {/* [UI-01] 기능·역할: 작성자 닉네임 공통 표시. 수행 이유: 일반 사용자와 관리자 내 피드백도 같은 위치·표기 방식으로 작성자를 확인합니다. */}
                <span>닉네임: {item.author_nickname?.trim() || '닉네임 없음'}</span>
                {' · '}

                <span className={`status-tag ${item.status}`}>
                  {FEEDBACK_STATUSES[item.status] ?? item.status}
                </span>
              </div>

              <p className="feedback-copy">
                <Highlight value={item.content} query={search.q} />
              </p>

              {item.admin_note && (
                <div className="admin-reply">
                  <strong>관리자 답변</strong>
                  <p>{item.admin_note}</p>
                </div>
              )}

              {adminView && (
                <button
                  type="button"
                  className="feedback-open-button"
                  aria-label={`${item.title} 피드백 처리`}
                  disabled={busy}
                  onClick={() => openEditor('process', item)}
                />
              )}
            </div>

            <div className="actions">
              {!adminView && (
                <button
                  type="button"
                  className="button small"
                  disabled={busy}
                  onClick={() => openEditor('edit', item)}
                >
                  수정
                </button>
              )}

              <button
                type="button"
                className="button small delete"
                disabled={busy}
                onClick={() => remove(item)}
              >
                삭제
              </button>
            </div>
          </article>
        ))
      )}
    </section>
  )
}
