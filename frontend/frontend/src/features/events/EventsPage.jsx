import { useContext, useEffect, useMemo, useState } from 'react'
import { PageRefreshContext } from '../../shared/hooks/PageRefreshContext.js'
import PageHeading from '../../shared/components/PageHeading.jsx'
import ResourceState from '../../shared/components/ResourceState.jsx'
import { useApiResource } from '../../shared/hooks/useApiResource.js'
import { formatDate } from '../../shared/utils/formatDate.js'
import { createEventsApi } from './eventsApi.js'
import AnalysisResults from '../../shared/components/AnalysisResults.jsx'
import './events.css'

const roleLabels = { user: '일반 사용자', admin: '관리자' }
const accountStatusLabels = { active: '활성', inactive: '비활성' }
const feedbackStatusLabels = {
  pending: '처리 대기',
  in_progress: '처리 중',
  resolved: '처리 완료',
}

function nicknameFor(usersById, id, snapshotName = '') {
  return usersById.get(id)?.display_name?.trim() || snapshotName?.trim() || ''
}

function AuditPerson({ nickname }) {
  return <span className="audit-person">{nickname || '닉네임 확인 불가'}</span>
}

function formatAuditDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Seoul',
  }).format(date)
}

function changeSummary(item) {
  if (item.action !== 'update') return ''

  const before = item.old_data ?? {}
  const after = item.new_data ?? {}
  const changes = []
  const fields =
    item.target_type === 'users'
      ? [
          ['display_name', '닉네임'],
          ['role', '권한', roleLabels],
          ['status', '상태', accountStatusLabels],
        ]
      : [
          ['status', '처리 상태', feedbackStatusLabels],
          ['admin_note', '관리 메모'],
        ]

  for (const [key, label, values] of fields) {
    if (before[key] === after[key]) continue
    if (key === 'admin_note') changes.push('관리 메모 변경')
    else
      changes.push(
        `${label}: ${values?.[before[key]] ?? before[key] ?? '없음'} → ${values?.[after[key]] ?? after[key] ?? '없음'}`,
      )
  }

  return changes.join(' · ')
}

function AuditLog({ client, onUnauthorized, onNavigate }) {
  const api = useMemo(() => createEventsApi(client), [client])
  const resource = useApiResource(api.auditLogs, onUnauthorized)
  return (
    <>
      <PageHeading
        title="관리자 감사 로그"
        description="계정과 피드백의 최근 변경 내역을 확인해요."
      />
      <p className="audit-scope muted">
        최근 최대 20건
        {resource.loading && resource.data && <span role="status"> · 최신 내용 확인 중…</span>}
      </p>
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        onRetry={resource.refresh}
        hasData={Boolean(resource.data)}
      >
        <section className="dashboard-panel table-panel audit-panel">
          {resource.data?.identityError && (
            <p className="audit-lookup-warning" role="status">
              {resource.data.identityError}
            </p>
          )}
          {!resource.data?.items.length ? (
            <p className="empty">표시할 기록이 없어요.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">활동</th>
                  <th scope="col">수행자</th>
                  <th scope="col">일시</th>
                </tr>
              </thead>
              <tbody>
                {resource.data.items.map((item) => {
                  const usersById = resource.data.usersById
                  const snapshot = item.new_data ?? item.old_data ?? {}
                  const authorId = item.new_data?.user_id ?? item.old_data?.user_id
                  const action =
                    { create: '생성', update: '수정', delete: '삭제' }[item.action] ?? item.action
                  const summary = changeSummary(item)
                  return (
                    <tr key={item.id}>
                      <td className="audit-activity">
                        <button
                          type="button"
                          className="audit-link"
                          onClick={() =>
                            onNavigate?.(
                              item.target_type === 'feedback'
                                ? { page: 'feedback', feedbackId: item.target_id }
                                : 'accounts',
                            )
                          }
                        >
                          <strong className="audit-activity-title">
                            {item.target_type === 'users' ? (
                              <>
                                <AuditPerson
                                  nickname={nicknameFor(
                                    usersById,
                                    item.target_id,
                                    snapshot.display_name,
                                  )}
                                />
                                {' 계정'}
                              </>
                            ) : snapshot.title ? (
                              `‘${snapshot.title}’ 피드백`
                            ) : (
                              `피드백 #${item.target_id}`
                            )}{' '}
                            {action}
                          </strong>
                          {summary && <span className="audit-change">{summary}</span>}
                          {item.target_type === 'feedback' && (
                            <span className="audit-meta">
                              작성자 <AuditPerson nickname={nicknameFor(usersById, authorId)} />
                              <span aria-hidden="true">·</span> 피드백 #{item.target_id}
                            </span>
                          )}
                        </button>
                      </td>
                      <td className="audit-actor">
                        <AuditPerson nickname={nicknameFor(usersById, item.actor_id)} />
                      </td>
                      <td className="audit-time">
                        <time dateTime={item.created_at}>{formatAuditDate(item.created_at)}</time>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>
      </ResourceState>
    </>
  )
}

function EventsLog({ request, onSelectEvent }) {
  const pageRevision = useContext(PageRefreshContext)
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!request) {
      setEvents([])
      setError('')
      return
    }
    const controller = new AbortController()
    let timer
    // [UI-NAV02] 기능·역할: 메뉴·버튼의 명시적 조회 보장. 수행 이유: 화면 비활성 상태의 자동 조회만 건너뛰고 사용자가 요청한 조회는 즉시 실행합니다.
    async function load(force = false) {
      if (force || !document.hidden) {
        setLoading(true)
        try {
          const data = await request('/api/motion/events?limit=20&finished_only=true', {
            signal: controller.signal,
          })
          if (!controller.signal.aborted) {
            setEvents(data)
            setError('')
            setUpdatedAt(new Date())
          }
        } catch (cause) {
          if (!controller.signal.aborted) setError(cause.message)
        } finally {
          if (!controller.signal.aborted) setLoading(false)
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(load, 10000)
    }
    void load(true)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [request, pageRevision, revision])

  return (
    <section aria-busy={loading}>
      {/* [UI-NAV03] 기능·역할: 모니터링현황 제목 통일. 수행 이유: 일반 사용자 메뉴와 같은 명칭으로 감지·촬영·분석 기록을 안내합니다. */}
      <PageHeading
        title="모니터링현황"
        description="촬영이 끝난 사건의 사진과 AI 분석 기록이에요."
      />
      {/* [UI-NAV02] 기능·역할: 이벤트 목록의 조회 진행·완료 표시. 수행 이유: 기존 기록이 그대로인 경우에도 메뉴 재클릭으로 새로 조회했는지 확인할 수 있습니다. */}
      <div className="page-toolbar">
        <span className="muted" role="status" aria-label="이벤트 조회 상태" aria-atomic="true">
          {loading ? (
            '이벤트 조회 중…'
          ) : error ? (
            '이벤트 조회 실패'
          ) : updatedAt ? (
            <>
              조회 완료 ·{' '}
              <time dateTime={updatedAt.toISOString()}>
                {updatedAt.toLocaleTimeString('ko-KR')}
              </time>
            </>
          ) : (
            '최근 최대 20건'
          )}
        </span>
        <button
          type="button"
          className="button"
          disabled={!request || loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          {loading ? '조회 중…' : '새로고침'}
        </button>
      </div>
      {!request && <p className="admin-note">로그인 후 사건 기록을 확인할 수 있습니다.</p>}
      {error && (
        <p className="api-error" role="alert">
          {error}
        </p>
      )}
      <section className="dashboard-panel table-panel events-panel">
        <table>
          <thead>
            <tr>
              <th>감지 시각</th>
              <th>분석 결과</th>
              <th aria-label="사건 상세 보기" />
            </tr>
          </thead>
          <tbody>
            {events.map((item) => {
              const time = new Date(item.detected_at).toLocaleString('ko-KR')
              return (
                <tr key={item.id}>
                  <td className="event-date">
                    <time dateTime={item.detected_at}>{time}</time>
                  </td>
                  <td className="event-summary">
                    <AnalysisResults
                      questions={item.questions}
                      result={item.result}
                      status={item.analysis_status}
                      compact
                    />
                  </td>
                  <td className="event-open-cell">
                    <button
                      className="event-open"
                      type="button"
                      onClick={() => onSelectEvent?.(item.id)}
                      aria-label={`${time} 사건 상세 보기`}
                      aria-haspopup="dialog"
                      title="사건 상세 팝업 열기"
                    >
                      <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="m9 5 7 7-7 7" />
                      </svg>
                    </button>
                  </td>
                </tr>
              )
            })}
            {!events.length && (
              <tr>
                <td colSpan={3} className="empty-state">
                  {loading ? '사건 조회 중…' : '표시할 이벤트가 없어요.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </section>
  )
}

export default function EventsPage({
  client,
  user,
  onUnauthorized,
  request = null,
  onSelectEvent,
  onNavigate,
}) {
  if (user?.role === 'admin')
    return <AuditLog client={client} onUnauthorized={onUnauthorized} onNavigate={onNavigate} />
  return <EventsLog request={request} onSelectEvent={onSelectEvent} />
}
