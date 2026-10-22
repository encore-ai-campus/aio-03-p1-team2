import PageHeading from '../../shared/components/PageHeading.jsx'
import Pagination from '../../shared/components/Pagination.jsx'
import { useNavigationLock } from '../../shared/hooks/useNavigationLock.js'
import { useFeedback } from './useFeedback.js'
import FeedbackEditor from './FeedbackEditor.jsx'
import FeedbackFilters from './FeedbackFilters.jsx'
import FeedbackList from './FeedbackList.jsx'
import './feedback-page.css'

export default function FeedbackPage({
  client,
  user,
  onUnauthorized,
  onBusyChange,
  targetFeedbackId,
}) {
  const feedback = useFeedback({ client, user, onUnauthorized, targetFeedbackId })
  useNavigationLock(feedback.busy, onBusyChange)
  const { adminView, isAdmin, busy, editor, message, actionError, page, loading, listError } =
    feedback
  const searchLabel = feedback.search.feedbackId
    ? `#${feedback.search.feedbackId}`
    : feedback.search.q
  return (
    <div className="feedback-page">
      <div className="feedback-heading">
        <div>
          <p className="feedback-eyebrow">FEEDBACK SYSTEM</p>
          <PageHeading
            title={adminView ? '고객 피드백 관리' : '고객 피드백'}
            description={
              adminView
                ? '사용자의 의견을 확인하고 처리 상태와 답변을 관리해요.'
                : '남겨주신 의견과 관리자 답변을 확인해요.'
            }
          />
        </div>
        {!adminView && (
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => feedback.openEditor('create')}
          >
            + 피드백 작성
          </button>
        )}
      </div>
      {/* [UI-FB02] 기능·역할: 관리자만 조회 범위 탭 제공. 수행 이유: 일반 사용자는 본인 피드백만 조회하므로 불필요한 전체/내 탭을 렌더링하지 않습니다. */}
      {isAdmin && (
        <div className="feedback-views" role="group" aria-label="피드백 조회 범위">
          <button
            type="button"
            className="button"
            disabled={busy}
            aria-pressed={adminView}
            onClick={() => feedback.switchView(true)}
          >
            전체 피드백
          </button>
          <button
            type="button"
            className="button"
            disabled={busy}
            aria-pressed={!adminView}
            onClick={() => feedback.switchView(false)}
          >
            내 피드백
          </button>
        </div>
      )}
      <p className="feedback-message" role="status">
        {message}
      </p>
      {feedback.targetLoading && <p role="status">선택한 피드백을 불러오고 있어요…</p>}
      {/* [UI-EVT03] 기능·역할: 번호로 이동한 피드백의 조회 불가 안내. 수행 이유: 삭제되었거나 본인 범위 밖인 건을 다른 피드백으로 대체해 표시하지 않습니다. */}
      {!isAdmin &&
        targetFeedbackId != null &&
        feedback.search.feedbackId === String(targetFeedbackId) &&
        !loading &&
        !listError &&
        page.total === 0 && (
          <p role="status">선택한 피드백은 삭제되었거나 더 이상 조회할 수 없어요.</p>
        )}
      {actionError && editor?.type !== 'process' && (
        <p className="form-error alert-box" role="alert">
          {actionError}
        </p>
      )}
      {editor && (
        <FeedbackEditor
          editor={editor}
          form={feedback.form}
          setForm={feedback.setForm}
          busy={busy}
          error={actionError}
          onSubmit={feedback.submit}
          onCancel={() => {
            feedback.setEditor(null)
            feedback.setActionError('')
          }}
        />
      )}
      <FeedbackFilters
        searchField={feedback.searchField}
        setSearchField={feedback.setSearchField}
        query={feedback.query}
        setQuery={feedback.setQuery}
        searchError={feedback.searchError}
        applySearch={feedback.applySearch}
        resetFilters={feedback.resetFilters}
        kind={feedback.kind}
        setKind={feedback.setKind}
        status={feedback.status}
        setStatus={feedback.setStatus}
        setOffset={feedback.setOffset}
        busy={busy}
        loading={loading}
        refresh={feedback.refresh}
      />
      <div className="feedback-results">
        {feedback.refreshing && <span role="status">최신 내용 확인 중…</span>}
        <strong role="status" aria-live="polite">
          {loading
            ? '검색 결과를 불러오고 있어요…'
            : listError
              ? '목록을 불러오지 못했어요.'
              : `${searchLabel ? `“${searchLabel}” 검색 결과` : adminView ? '전체 피드백' : '내가 작성한 피드백'} · ${page.total}건`}
        </strong>
        <span>최신 작성순</span>
      </div>
      <FeedbackList
        page={page}
        loading={loading}
        refreshing={feedback.refreshing}
        listError={listError}
        kind={feedback.kind}
        status={feedback.status}
        search={feedback.search}
        resetFilters={feedback.resetFilters}
        adminView={adminView}
        busy={busy}
        openEditor={feedback.openEditor}
        remove={feedback.remove}
        refresh={feedback.refresh}
      />
      {!loading && !listError && (
        <Pagination
          total={page.total}
          offset={feedback.offset}
          pageSize={feedback.pageSize}
          busy={busy}
          onChange={feedback.setOffset}
        />
      )}
      <p className="feedback-number-note">피드백 번호(#ID)는 등록된 고유 ID를 표시합니다.</p>
    </div>
  )
}
