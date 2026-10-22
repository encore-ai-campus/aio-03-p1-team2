import { useMemo, useState } from 'react'
import PageHeading from '../../shared/components/PageHeading.jsx'
import ResourceState from '../../shared/components/ResourceState.jsx'
import Dialog from '../../shared/components/Dialog.jsx'
import { useApiResource } from '../../shared/hooks/useApiResource.js'
import { formatDate } from '../../shared/utils/formatDate.js'
import { createUserOverviewApi } from './overviewApi.js'
import './user-overview.css'

const ANALYSIS_STATES = {
  succeeded: '분석 완료',
  running: '분석 중',
  waiting: '분석 대기',
  collecting: '촬영 중',
  failed: '분석 실패',
  interrupted: '촬영 중단',
}
const CAMERA_STATES = {
  on: { label: 'CAMERA ON', tone: 'good', detail: '이 브라우저에서 카메라를 사용하고 있어요.' },
  off: { label: 'CAMERA OFF', tone: 'muted', detail: '이 브라우저에서 카메라를 사용하지 않아요.' },
  preparing: { label: '연결 중', tone: 'warn', detail: '카메라 권한·영상 연결을 준비하고 있어요.' },
  error: { label: '연결 오류', tone: 'error', detail: '카메라 연결을 확인해 주세요.' },
}
const VERDICTS = {
  confirmed: { label: '확인됨', tone: 'good' },
  uncertain: { label: '판단 어려움', tone: 'warn' },
  not_confirmed: { label: '미확인', tone: 'neutral' },
}
const PENDING_SUMMARIES = {
  collecting: '움직임이 감지되어 촬영하고 있어요.',
  waiting: '촬영한 기록의 분석을 기다리고 있어요.',
  running: '촬영한 기록을 분석하고 있어요.',
  failed: '분석 결과를 받지 못했어요. 기록을 확인해 주세요.',
  interrupted: '촬영이 중단되었어요. 기록을 확인해 주세요.',
}
const SUMMARY_ICONS = {
  recording: (
    <>
      <rect x="2" y="5" width="10" height="10" rx="2" />
      <path d="m12 8 5-3v10l-5-3" />
    </>
  ),
  motion: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 5v5l3 2" />
    </>
  ),
  attention: <path d="m10 2 8 15H2ZM10 7v4m0 2v1" />,
  feedback: <path d="M3 3h14v11H8l-5 3ZM6 7h8m-8 3h5" />,
}

// [UI-OV03] 기능·역할: 확인할 사건을 한 번씩 집계. 수행 이유: 여러 질문이 판단 어려움이어도 사건 수를 부풀리지 않습니다.
const needsAttention = (event) =>
  ['failed', 'interrupted'].includes(event.analysis_status) ||
  event.result?.items.some((item) => item.verdict === 'uncertain')

function relativeTime(value, reference) {
  const elapsed = Date.parse(reference) - Date.parse(value)
  if (!Number.isFinite(elapsed)) return '시각 확인 불가'
  const minutes = Math.max(0, Math.floor(elapsed / 60000))
  if (minutes < 1) return '방금 전'
  if (minutes < 60) return `${minutes}분 전`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 전`
  return `${Math.floor(minutes / 1440)}일 전`
}

// [UI-OV07] 기능·역할: 시안의 요약 카드 표현. 수행 이유: 제목·아이콘·숫자 단위·상태 색상을 같은 크기와 배치로 맞춥니다.
function SummaryCard({
  label,
  icon,
  resource = {},
  value,
  unit,
  tone = 'neutral',
  live,
  detail,
  children,
}) {
  const unavailable = resource.loading || Boolean(resource.error)
  return (
    <section
      className={`user-overview-summary${unavailable ? ' is-unavailable' : ''}`}
      aria-label={label}
      aria-busy={Boolean(resource.loading)}
    >
      <div className="user-overview-card-head">
        <h2>{label}</h2>
        <span className="user-overview-card-icon" aria-hidden="true">
          <svg
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {SUMMARY_ICONS[icon]}
          </svg>
        </span>
      </div>
      <div className={`user-overview-card-value user-overview-tone-${tone}`}>
        {resource.loading ? (
          '불러오는 중…'
        ) : resource.error ? (
          '조회 불가'
        ) : (
          <>
            {live && <span className="user-overview-live-dot" aria-hidden="true" />}
            {value}
            {unit && <span className="user-overview-unit">{unit}</span>}
          </>
        )}
      </div>
      {resource.error ? (
        <>
          <p className="form-error" role="alert">
            {resource.error}
          </p>
          <button
            className="user-overview-link"
            type="button"
            onClick={resource.refresh}
            aria-label={`${label} 다시 조회`}
          >
            다시 조회
          </button>
        </>
      ) : (
        !resource.loading && (
          <>
            <p className="user-overview-detail">{detail}</p>
            <div className="user-overview-card-foot">{children}</div>
          </>
        )
      )}
    </section>
  )
}

function MotionRecords({ items, onSelectEvent }) {
  return (
    <ul className="user-overview-records">
      {items.map((event) => {
        // [UI-OV08] 기능·역할: 최근 기록의 요약·상태 배지. 수행 이유: 시안의 시간·본문·상태 배치를 사용하고 질문별 전체 결과는 기존 상세 화면에서 확인합니다.
        const status = event.analysis_status
        const results = event.result?.items ?? []
        const representative =
          status === 'succeeded'
            ? Object.keys(VERDICTS)
                .map((verdict) => results.find((item) => item.verdict === verdict))
                .find(Boolean)
            : null
        const badge = representative
          ? VERDICTS[representative.verdict]
          : {
              label: ANALYSIS_STATES[status] ?? '상태 확인 필요',
              tone:
                status === 'failed'
                  ? 'error'
                  : status === 'interrupted'
                    ? 'warn'
                    : status === 'succeeded'
                      ? 'good'
                      : 'neutral',
            }
        return (
          <li key={event.id}>
            <button
              type="button"
              className="user-overview-record"
              aria-label={`${event.id} 내 대시보드 사건 상세 보기`}
              onClick={() => onSelectEvent(event.id)}
            >
              <time
                className="user-overview-record-time"
                dateTime={event.detected_at}
                title={formatDate(event.detected_at)}
                aria-label={formatDate(event.detected_at)}
              >
                {new Date(event.detected_at).toLocaleTimeString('ko-KR', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })}
              </time>
              <span className="user-overview-row-content">
                <span className="user-overview-record-title">
                  {representative?.summary ||
                    PENDING_SUMMARIES[status] ||
                    '기록을 눌러 분석 내용을 확인해 주세요.'}
                </span>
                <span className="user-overview-record-meta">
                  <span className={`user-overview-pill user-overview-tone-${badge.tone}`}>
                    {badge.label}
                  </span>
                  {representative && <span>질문 {results.length}개 분석</span>}
                </span>
              </span>
              <span className="user-overview-row-arrow" aria-hidden="true">
                ›
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function AnalysisChart({ items }) {
  if (!items.length) return <p className="overview-empty">아직 분석할 기록이 없어요.</p>
  const counts = Object.fromEntries(
    Object.keys(ANALYSIS_STATES).map((status) => [
      status,
      items.filter((event) => event.analysis_status === status).length,
    ]),
  )
  return (
    <>
      <p className="user-overview-chart-summary">
        <strong>{counts.succeeded}</strong>
        <span>/ {items.length}건 분석 완료</span>
      </p>
      <p className="user-overview-chart-range">
        조회된 기록 범위 · {formatDate(items.at(-1).detected_at)} ~{' '}
        {formatDate(items[0].detected_at)}
      </p>
      <div className="overview-status-bar user-overview-status-bar" aria-hidden="true">
        {Object.keys(ANALYSIS_STATES).map(
          (status) =>
            counts[status] > 0 && (
              <span
                key={status}
                className={`user-overview-state-${status}`}
                style={{ flexGrow: counts[status] }}
              />
            ),
        )}
      </div>
      <ul className="user-overview-status-legend" aria-label="최근 기록의 분석 상태별 건수">
        {Object.entries(ANALYSIS_STATES).map(([status, label]) => (
          <li key={status}>
            <span
              className={`overview-legend-dot user-overview-state-${status}`}
              aria-hidden="true"
            />
            <span>{label}</span>
            <strong>{counts[status]}건</strong>
          </li>
        ))}
      </ul>
      <p className="user-overview-note">
        최근 조회한 {items.length}건의 처리 상태예요. 분석 완료는 감지 정확도나 위험 여부를 뜻하지
        않습니다.
      </p>
    </>
  )
}

export default function UserOverview({
  client,
  onUnauthorized,
  onNavigate,
  notifications,
  cameraState,
  onSelectNotification,
  onSelectEvent,
}) {
  const api = useMemo(() => createUserOverviewApi(client), [client])
  // [UI-OV04] 기능·역할: 영역별 로딩·실패 구분. 수행 이유: 한 API가 실패해도 다른 정보를 유지하고 조회 실패를 0건으로 표시하지 않습니다.
  const events = useApiResource(api.events, onUnauthorized)
  const feedback = useApiResource(api.pendingFeedback, onUnauthorized)
  const [expanded, setExpanded] = useState(false)
  const [showAttention, setShowAttention] = useState(false)
  const items = events.data?.items ?? []
  const attention = items.filter(needsAttention)
  const cameraDisplay = CAMERA_STATES[cameraState.status]
  const recentNotices = notifications.items.slice(0, 5)

  function refresh() {
    events.refresh()
    feedback.refresh()
    void notifications.refresh()
  }

  return (
    <div className="user-overview">
      <div className="overview-toolbar">
        <div>
          {/* [UI-NAV03] 기능·역할: 내 대시보드 제목 통일. 수행 이유: 일반 사용자 메뉴와 페이지 제목·접근성 안내에 같은 명칭을 사용합니다. */}
          <p className="user-overview-eyebrow">MY DASHBOARD</p>
          <PageHeading
            title="내 대시보드"
            description="내 카메라의 최근 기록과 확인할 소식을 모았어요."
          />
        </div>
        <div className="user-overview-refresh">
          {events.data && <span>기록 조회 · {formatDate(events.data.receivedAt)}</span>}
          <button
            type="button"
            className="button"
            aria-label="내 대시보드 새로고침"
            disabled={events.loading || feedback.loading}
            onClick={refresh}
          >
            새로고침
          </button>
        </div>
      </div>
      <div className="metric-grid user-overview-metrics">
        <SummaryCard
          label="현재 카메라 상태"
          icon="recording"
          value={
            <span className="user-overview-camera-value" role="status">
              {cameraDisplay.label}
            </span>
          }
          live={cameraState.status === 'on'}
          tone={cameraDisplay.tone}
          detail={
            <>
              {/* [UI-CAM02] 기능·역할: 실제 카메라 트랙 상태 표시. 수행 이유: 다른 기기나 과거 실행의 상태를 현재 카메라 상태로 오인하지 않게 합니다. */}
              {cameraState.label && (
                <>
                  {cameraState.label}
                  <br />
                </>
              )}
              {cameraState.message || cameraDisplay.detail}
            </>
          }
        >
          현재 브라우저의 카메라 사용 기준
        </SummaryCard>
        <SummaryCard
          label="마지막 움직임"
          icon="motion"
          resource={events}
          value={
            items.length ? relativeTime(items[0].detected_at, events.data.receivedAt) : '기록 없음'
          }
          detail={items.length ? formatDate(items[0].detected_at) : '아직 감지된 움직임이 없어요.'}
        >
          기록 조회 시각 기준
        </SummaryCard>
        <SummaryCard
          label="확인이 필요한 기록"
          icon="attention"
          resource={events}
          value={attention.length}
          unit="건"
          tone={attention.length ? 'warn' : 'neutral'}
          detail="판단 어려움·분석 실패·촬영 중단"
        >
          <button
            type="button"
            className="user-overview-link"
            disabled={!attention.length}
            onClick={() => setShowAttention(true)}
          >
            최근 {items.length}건 중 · 기록 확인 →
          </button>
        </SummaryCard>
        <SummaryCard
          label="처리 대기 내 피드백"
          icon="feedback"
          resource={feedback}
          value={feedback.data?.total ?? 0}
          unit="건"
          detail="접수한 문의의 처리 대기 상태예요."
        >
          <button
            type="button"
            className="user-overview-link"
            onClick={() => onNavigate('feedback')}
          >
            내 피드백 상태 보기 →
          </button>
        </SummaryCard>
      </div>
      {/* [UI-OV05] 기능·역할: 분석 현황 전체 너비 배치. 수행 이유: 승인된 시안대로 분석 기준 설정 영역을 제외합니다. */}
      <section
        className="dashboard-panel overview-panel user-overview-chart"
        aria-labelledby="user-overview-analysis-title"
      >
        <div className="overview-list-heading">
          <h2 id="user-overview-analysis-title">최근 분석 처리 현황</h2>
          {events.data && <span className="user-overview-tag">최근 {items.length}건 기준</span>}
        </div>
        <div className="user-overview-chart-body">
          <ResourceState loading={events.loading} error={events.error} onRetry={events.refresh}>
            <AnalysisChart items={items} />
          </ResourceState>
        </div>
      </section>
      <div className="overview-lists">
        <section
          className="dashboard-panel overview-panel"
          aria-labelledby="user-overview-events-title"
        >
          <div className="overview-list-heading">
            <h2 id="user-overview-events-title">최근 움직임</h2>
            <button
              type="button"
              className="user-overview-link"
              disabled={events.loading || Boolean(events.error) || items.length <= 5}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded
                ? '최근 5건 보기'
                : items.length
                  ? `최근 ${items.length}건 보기`
                  : '최근 기록 보기'}{' '}
              →
            </button>
          </div>
          <p className="overview-panel-copy">
            {/* [UI-OV04] 기능·역할: 성공한 조회의 건수만 안내. 수행 이유: 로딩·조회 실패를 빈 목록으로 오인하지 않게 합니다. */}
            {events.data && `최근 ${Math.min(expanded ? 20 : 5, items.length)}건 · `}
            기록을 누르면 분석 내용을 확인할 수 있어요.
          </p>
          <ResourceState loading={events.loading} error={events.error} onRetry={events.refresh}>
            {items.length ? (
              <MotionRecords
                items={items.slice(0, expanded ? 20 : 5)}
                onSelectEvent={onSelectEvent}
              />
            ) : (
              <p className="overview-empty">아직 감지된 움직임이 없어요.</p>
            )}
          </ResourceState>
        </section>
        <section
          className="dashboard-panel overview-panel"
          aria-labelledby="user-overview-notifications-title"
        >
          <div className="overview-list-heading">
            <h2 id="user-overview-notifications-title">최근 알림</h2>
            {!notifications.loading && !notifications.error && (
              <span className="user-overview-tag">
                최근 {recentNotices.length}건 중 미확인{' '}
                {recentNotices.filter((notice) => !notice.read).length}건
              </span>
            )}
          </div>
          <p className="overview-panel-copy">
            알림을 누르면 해당 기록을 확인하고 읽음으로 표시해요.
          </p>
          {/* [UI-OV01] 기능·역할: 앱 공통 알림 재사용. 수행 이유: 헤더와 같은 읽음 상태를 유지하고 별도 SSE 연결을 생성하지 않습니다. */}
          <ResourceState
            loading={notifications.loading}
            error={notifications.error}
            onRetry={notifications.refresh}
          >
            {recentNotices.length ? (
              <ul className="user-overview-records">
                {recentNotices.map((notice) => (
                  <li key={notice.id}>
                    <button
                      type="button"
                      className={`user-overview-notice${notice.read ? ' is-read' : ''}`}
                      aria-label={`${notice.id} 내 대시보드 알림 확인`}
                      onClick={() => onSelectNotification(notice)}
                    >
                      <span className="user-overview-notice-dot" aria-hidden="true" />
                      <span className="user-overview-row-content">
                        <span className="user-overview-notice-message">{notice.message}</span>
                        <span className="user-overview-notice-meta">
                          <time dateTime={notice.created_at}>{formatDate(notice.created_at)}</time>{' '}
                          · {notice.read ? '읽음' : '미확인'}
                        </span>
                      </span>
                      <span className="user-overview-row-arrow" aria-hidden="true">
                        ›
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="overview-empty">아직 받은 알림이 없어요.</p>
            )}
          </ResourceState>
        </section>
      </div>
      {showAttention && (
        <Dialog
          open
          title="확인이 필요한 최근 기록"
          onClose={() => setShowAttention(false)}
          className="user-overview-dialog"
        >
          <div className="user-overview-dialog-body">
            <p>
              {events.data && `최근 ${items.length}건 중 ${attention.length}건 · `}사건당 한 번
              집계합니다.
            </p>
            <p className="overview-panel-copy">
              판단 어려움·분석 실패·촬영 중단 기록이며, 위험 발생 건수가 아닙니다.
            </p>
            <ResourceState loading={events.loading} error={events.error} onRetry={events.refresh}>
              {attention.length ? (
                <MotionRecords
                  items={attention}
                  onSelectEvent={(id) => {
                    setShowAttention(false)
                    onSelectEvent(id)
                  }}
                />
              ) : (
                <p className="overview-empty">확인이 필요한 기록이 없어요.</p>
              )}
            </ResourceState>
          </div>
        </Dialog>
      )}
      <p className="user-overview-scope">
        내 계정의 기록만 표시 · 분석 상태와 확인 필요 건수는 최근 조회된 최대 20건 기준
      </p>
    </div>
  )
}
