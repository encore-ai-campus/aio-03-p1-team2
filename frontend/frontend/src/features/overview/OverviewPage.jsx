import { useEffect, useMemo, useRef, useState } from 'react'
import PageHeading from '../../shared/components/PageHeading.jsx'
import ResourceState from '../../shared/components/ResourceState.jsx'
import Metric from '../../shared/components/Metric.jsx'
import { useApiResource } from '../../shared/hooks/useApiResource.js'
import { useNavigationLock } from '../../shared/hooks/useNavigationLock.js'
import { formatDate } from '../../shared/utils/formatDate.js'
import { FEEDBACK_KINDS, FEEDBACK_STATUSES } from '../feedback/constants.js'
import { createFeedbackApi } from '../feedback/feedbackApi.js'
import FeedbackEditor from '../feedback/FeedbackEditor.jsx'
import '../feedback/feedback-page.css'
import { createAdminOverviewApi } from './overviewApi.js'
import UserOverview from './UserOverview.jsx'
import './overview.css'

const STATUS_KEYS = ['pending', 'in_progress', 'resolved']
const KIND_KEYS = ['false_positive', 'false_negative', 'accurate', 'suggestion']

function FeedbackStatusChart({ totals, total }) {
  return (
    <section className="dashboard-panel overview-panel" aria-labelledby="overview-status-title">
      <h2 id="overview-status-title">피드백 처리 현황</h2>
      <p className="overview-panel-copy">전체 {total}건의 처리 상태</p>
      {total > 0 ? (
        <div className="overview-status-bar" aria-hidden="true">
          {STATUS_KEYS.map((key) =>
            totals[key] > 0 ? (
              <span
                key={key}
                className={`overview-status-segment overview-status-${key}`}
                style={{ flexGrow: totals[key] }}
              />
            ) : null,
          )}
        </div>
      ) : (
        <p className="overview-empty">등록된 피드백이 없습니다.</p>
      )}
      <ul className="overview-status-legend">
        {STATUS_KEYS.map((key) => (
          <li key={key}>
            <span className={`overview-legend-dot overview-status-${key}`} aria-hidden="true" />
            <span>{FEEDBACK_STATUSES[key]}</span>
            <strong>{totals[key]}건</strong>
          </li>
        ))}
      </ul>
    </section>
  )
}

function FeedbackKindChart({ totals, total }) {
  const max = Math.max(...KIND_KEYS.map((key) => totals[key]), 1)
  return (
    <section className="dashboard-panel overview-panel" aria-labelledby="overview-kind-title">
      <h2 id="overview-kind-title">피드백 유형</h2>
      <p className="overview-panel-copy">사용자가 선택한 신고·의견 유형</p>
      {total > 0 ? (
        <ul className="overview-kind-chart">
          {KIND_KEYS.map((key) => (
            <li key={key}>
              <span>{FEEDBACK_KINDS[key]}</span>
              <span className="overview-kind-track" aria-hidden="true">
                <span style={{ width: `${(totals[key] / max) * 100}%` }} />
              </span>
              <strong>{totals[key]}건</strong>
            </li>
          ))}
        </ul>
      ) : (
        <p className="overview-empty">등록된 피드백이 없습니다.</p>
      )}
    </section>
  )
}

function RecentFeedback({ items, onNavigate, onOpenFeedback }) {
  return (
    <section className="dashboard-panel overview-panel" aria-labelledby="overview-feedback-title">
      <div className="overview-list-heading">
        <div>
          <h2 id="overview-feedback-title">최근 고객 피드백</h2>
          <p className="overview-panel-copy">최신 5건</p>
        </div>
        <button type="button" className="button" onClick={() => onNavigate?.('feedback')}>
          전체 보기
        </button>
      </div>
      {items.length ? (
        <ul className="overview-recent-list">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="overview-recent-link"
                aria-label={`${item.title} 피드백 처리`}
                onClick={() => onOpenFeedback(item)}
              >
                <div>
                  <strong>{item.title}</strong>
                  <small>{FEEDBACK_KINDS[item.kind] || item.kind}</small>
                </div>
                <div className="overview-list-meta">
                  <span>{FEEDBACK_STATUSES[item.status] || item.status}</span>
                  <time dateTime={item.created_at}>{formatDate(item.created_at)}</time>
                </div>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="overview-empty">최근 피드백이 없습니다.</p>
      )}
    </section>
  )
}

function RecentAudit({ items, onNavigate, onOpenFeedback }) {
  const targets = { users: '계정', feedback: '피드백' }
  const actions = { update: '수정', delete: '삭제', create: '생성' }
  return (
    <section className="dashboard-panel overview-panel" aria-labelledby="overview-audit-title">
      <div className="overview-list-heading">
        <div>
          <h2 id="overview-audit-title">최근 감사 로그</h2>
          <p className="overview-panel-copy">최신 5건</p>
        </div>
        <button type="button" className="button" onClick={() => onNavigate?.('admin-events')}>
          전체 보기
        </button>
      </div>
      {items.length ? (
        <ul className="overview-recent-list">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="overview-recent-link"
                aria-label={
                  item.target_type === 'feedback'
                    ? `피드백 #${item.target_id} 처리 팝업 열기`
                    : '계정 관리 페이지로 이동'
                }
                onClick={() =>
                  item.target_type === 'feedback'
                    ? onOpenFeedback(item.target_id)
                    : onNavigate?.('accounts')
                }
              >
                <strong>{targets[item.target_type] || item.target_type}</strong>
                <div className="overview-list-meta">
                  <span>{actions[item.action] || item.action}</span>
                  <time dateTime={item.created_at}>{formatDate(item.created_at)}</time>
                </div>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="overview-empty">최근 감사 기록이 없습니다.</p>
      )}
    </section>
  )
}

function AdminOverview({ client, onUnauthorized, onNavigate, onBusyChange }) {
  const api = useMemo(() => createAdminOverviewApi(client), [client])
  const feedbackApi = useMemo(() => createFeedbackApi(client), [client])
  const resource = useApiResource(api.load, onUnauthorized)
  const data = resource.data
  const [editor, setEditor] = useState(null)
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [lookupId, setLookupId] = useState(null)
  const [actionError, setActionError] = useState('')
  const [message, setMessage] = useState('')
  const lookupController = useRef(null)
  const actionPending = useRef(false)

  useNavigationLock(busy, onBusyChange)
  useEffect(() => () => lookupController.current?.abort(), [])

  function showFeedback(item) {
    setEditor({ type: 'process', item })
    setForm({
      title: item.title,
      kind: item.kind,
      content: item.content,
      status: item.status,
      admin_note: item.admin_note ?? '',
    })
    setActionError('')
    setMessage('')
  }

  async function openFeedback(itemOrId) {
    lookupController.current?.abort()
    lookupController.current = null
    setLookupId(null)
    setActionError('')
    setMessage('')

    if (typeof itemOrId === 'object') {
      showFeedback(itemOrId)
      return
    }

    const recentItem = data?.feedbackItems.find((item) => String(item.id) === String(itemOrId))
    if (recentItem) {
      showFeedback(recentItem)
      return
    }

    const controller = new AbortController()
    lookupController.current = controller
    setLookupId(itemOrId)
    try {
      const item = await feedbackApi.getForAdmin(itemOrId, controller.signal)
      if (!controller.signal.aborted) showFeedback(item)
    } catch (error) {
      if (controller.signal.aborted) return
      if (error.status === 401) onUnauthorized?.()
      else if (error.status === 404)
        setActionError('이 피드백은 삭제되었거나 더 이상 조회할 수 없어요.')
      else setActionError(error.message)
    } finally {
      if (!controller.signal.aborted) {
        lookupController.current = null
        setLookupId(null)
      }
    }
  }

  async function submitFeedback(event) {
    event.preventDefault()
    if (actionPending.current || !editor) return

    actionPending.current = true
    setBusy(true)
    setActionError('')
    try {
      await feedbackApi.process(editor.item.id, {
        status: form.status,
        admin_note: form.admin_note.trim() || null,
      })
      setEditor(null)
      setMessage('처리 상태와 답변을 저장했어요.')
      resource.refresh()
    } catch (error) {
      if (error.status === 401) onUnauthorized?.()
      else setActionError(error.message)
    } finally {
      actionPending.current = false
      setBusy(false)
    }
  }

  return (
    <div className="admin-overview">
      <PageHeading title="운영현황" description="계정과 고객 피드백의 운영 상태를 확인해요." />
      {message && (
        <p className="overview-action-message" role="status">
          {message}
        </p>
      )}
      {lookupId != null && (
        <p className="muted overview-refreshing" role="status">
          선택한 피드백을 불러오고 있어요…
        </p>
      )}
      {actionError && !editor && (
        <p className="form-error alert-box" role="alert">
          {actionError}
        </p>
      )}
      {editor && (
        <FeedbackEditor
          editor={editor}
          form={form}
          setForm={setForm}
          busy={busy}
          error={actionError}
          onSubmit={submitFeedback}
          onCancel={() => {
            if (busy) return
            setEditor(null)
            setActionError('')
          }}
        />
      )}
      {resource.loading && data && (
        <p className="muted overview-refreshing" role="status">
          최신 내용 확인 중…
        </p>
      )}
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        onRetry={resource.refresh}
        hasData={Boolean(data)}
      >
        {data && (
          <>
            <div className="metric-grid overview-metrics">
              <Metric label="전체 사용자" value={`${data.userTotal}명`} />
              <Metric label="전체 피드백" value={`${data.feedbackTotal}건`} />
              <Metric label="처리 대기" value={`${data.statusTotals.pending}건`} />
            </div>
            <div className="overview-charts">
              <FeedbackStatusChart totals={data.statusTotals} total={data.feedbackTotal} />
              <FeedbackKindChart totals={data.kindTotals} total={data.feedbackTotal} />
            </div>
            <div className="overview-lists">
              <RecentFeedback
                items={data.feedbackItems}
                onNavigate={onNavigate}
                onOpenFeedback={openFeedback}
              />
              <RecentAudit
                items={data.auditItems}
                onNavigate={onNavigate}
                onOpenFeedback={openFeedback}
              />
            </div>
          </>
        )}
      </ResourceState>
    </div>
  )
}

export default function OverviewPage({
  client,
  user,
  onUnauthorized,
  onNavigate,
  onBusyChange,
  ...userOverviewProps
}) {
  if (user.role === 'admin')
    return (
      <AdminOverview
        client={client}
        onUnauthorized={onUnauthorized}
        onNavigate={onNavigate}
        onBusyChange={onBusyChange}
      />
    )

  // [UI-OV01] 기능·역할: 일반 사용자 운영현황 분리. 수행 이유: 기존 관리자 통계와 권한을 보존하면서 본인 기록을 표시합니다.
  return (
    <UserOverview
      client={client}
      onUnauthorized={onUnauthorized}
      onNavigate={onNavigate}
      onBusyChange={onBusyChange}
      {...userOverviewProps}
    />
  )
}
