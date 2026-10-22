import { useEffect, useMemo, useRef, useState } from 'react'
import { createApiClient } from '../shared/api/client.js'
import { API_BASE_URL } from '../shared/api/config.js'
import { createRequest } from '../shared/api/request.js'
import { useAuth } from '../features/auth/useAuth.js'
import AuthPage from '../features/auth/AuthPage.jsx'
import DiscordLoginButton from '../features/discord/DiscordLoginButton.jsx'
import DiscordSettings from '../features/discord/DiscordSettings.jsx'
import DiscordCallback from '../features/discord/DiscordCallback.jsx'
import {
  createDiscordApi,
  discordCallbackPath,
  readDiscordEventLink,
} from '../features/discord/discordApi.js'
import SessionRestore from '../features/auth/SessionRestore.jsx'
import Landing from '../features/landing/Landing.jsx'
import ProfilePage from '../features/profile/ProfilePage.jsx'
import { useProfile } from '../features/profile/useProfile.js'
import { readProfileAvatar, saveProfileAvatar } from '../features/profile/profileAvatars.js'
import LivePage from '../features/live/LivePage.jsx'
import { useMotionCamera } from '../features/live/useMotionCamera.js'
import OverviewPage from '../features/overview/OverviewPage.jsx'
import EventsPage from '../features/events/EventsPage.jsx'
import EventDetailDialog from '../features/events/EventDetailDialog.jsx'
import AdminCameraPage from '../features/events/AdminCameraPage.jsx'
import FeedbackPage from '../features/feedback/FeedbackPage.jsx'
import AccountsPage from '../features/accounts/AccountsPage.jsx'
import AppLayout from './AppLayout.jsx'
import { PageRefreshContext } from '../shared/hooks/PageRefreshContext.js'
import { getDefaultPage } from './navigation.js'
import { useNotifications } from '../features/notifications/useNotifications.js'
import NotificationsPanel from '../features/notifications/NotificationsPanel.jsx'
import '../features/notifications/notifications.css'

const HOME_RELOAD_KEY = 'notecam:reload-home'

function shouldRestoreHome() {
  try {
    return window.sessionStorage.getItem(HOME_RELOAD_KEY) === '1'
  } catch {
    return false
  }
}

function reloadHome() {
  try {
    window.sessionStorage.setItem(HOME_RELOAD_KEY, '1')
  } catch {
    // Storage can be disabled; the page can still reload.
  }
  window.location.reload()
}

function AuthenticatedApp({
  session,
  client,
  profile,
  avatarId,
  onChooseAvatar,
  page,
  feedbackTargetId,
  onNavigate,
  onLogout,
  onUnauthorized,
  onHome,
  discordApi,
  initialEventId,
}) {
  const [busy, setBusy] = useState(false)
  const [pageRevision, setPageRevision] = useState(0)
  const [selectedEventId, setSelectedEventId] = useState(initialEventId || null)
  // [UI-EVT02] 기능·역할: 사건별 피드백 문맥·임시 입력 유지. 수행 이유: 상세 창을 다시 열어도 작성 중인 의견을 보존하고 로그인 종료 시 함께 정리합니다.
  const [selectedEventTime, setSelectedEventTime] = useState(null)
  const eventFeedbackDrafts = useRef(new Map())
  // 비전 API는 사진 업로드(FormData)와 증거 사진(blob)을 다루기 때문에 전용 request를 씁니다.
  const visionRequest = useMemo(
    () => createRequest({ baseUrl: API_BASE_URL, token: session.accessToken }),
    [session.accessToken],
  )
  const props = { client, user: session.user, onUnauthorized, onBusyChange: setBusy }
  // [UI-CAM01] 기능·역할: 실시간 보기·운영현황의 카메라 세션 공유. 수행 이유: 메뉴 이동에도 실제 카메라 ON/OFF를 같은 상태로 표시합니다.
  const camera = useMotionCamera(visionRequest)
  const notifications = useNotifications({
    client,
    baseUrl: API_BASE_URL,
    token: session.accessToken,
    onUnauthorized,
  })

  function selectNotification(notice) {
    setSelectedEventId(notice.event_id)
    setSelectedEventTime(notice.detected_at || null)
    void notifications.markRead(notice)
  }

  function navigate(next) {
    const nextPage = typeof next === 'string' ? next : next.page
    // [UI-NAV01] 기능·역할: 활성 메뉴 재클릭 시 데이터 새로고침. 수행 이유: 홈·실시간 보기·프로필은 기존 동작을 유지하고 다른 화면의 목록만 갱신합니다.
    if (nextPage === page && !['profile', 'live', 'remote-live'].includes(nextPage)) {
      setPageRevision((value) => value + 1)
      if (nextPage === 'status') void notifications.refresh()
    }
    setSelectedEventId(null)
    onNavigate(next)
  }

  function selectEvent(id, detectedAt = null) {
    setSelectedEventId(id)
    setSelectedEventTime(detectedAt)
  }

  let content
  switch (page) {
    case 'admin-cameras':
      content =
        session.user.role === 'admin' ? (
          <AdminCameraPage request={visionRequest} onUnauthorized={onUnauthorized} />
        ) : null
      break
    case 'profile':
      content = (
        <ProfilePage
          profile={profile}
          avatarId={avatarId}
          onChooseAvatar={onChooseAvatar}
          onBusyChange={setBusy}
          connections={<DiscordSettings api={discordApi} onUnauthorized={onUnauthorized} />}
        />
      )
      break
    case 'status':
    case 'admin-overview':
      content = (
        <OverviewPage
          {...props}
          onNavigate={navigate}
          notifications={notifications}
          cameraState={camera.cameraState}
          onSelectNotification={selectNotification}
          onSelectEvent={selectEvent}
        />
      )
      break
    case 'events':
    case 'admin-events':
      content = (
        <EventsPage
          {...props}
          request={visionRequest}
          onSelectEvent={selectEvent}
          onNavigate={navigate}
        />
      )
      break
    case 'feedback':
      content = <FeedbackPage {...props} targetFeedbackId={feedbackTargetId} />
      break
    case 'accounts':
      content = session.user.role === 'admin' ? <AccountsPage {...props} /> : null
      break
    default:
      content = null
  }

  return (
    <AppLayout
      user={session.user}
      profile={profile.data}
      avatarId={avatarId}
      page={page}
      onNavigate={navigate}
      onLogout={onLogout}
      onHome={onHome}
      busy={busy}
      headerActions={<NotificationsPanel resource={notifications} onSelect={selectNotification} />}
    >
      {/* 녹화가 페이지 이동에도 유지되도록 LivePage는 언마운트하지 않고 숨김 처리합니다. */}
      <LivePage
        request={visionRequest}
        camera={camera}
        visible={page === 'live' || page === 'remote-live'}
        remoteMode={page === 'remote-live'}
        onSelectEvent={selectEvent}
      />
      <PageRefreshContext.Provider value={pageRevision}>
        {page !== 'live' && page !== 'remote-live' && content}
      </PageRefreshContext.Provider>
      {notifications.toast && (
        <aside className="notification-toast" role="status" aria-live="polite">
          <strong>{notifications.toast.verdict === 'uncertain' ? '판단 어려움' : '확인됨'}</strong>
          <p>{notifications.toast.message}</p>
          <div>
            <button
              type="button"
              className="button"
              onClick={() => selectNotification(notifications.toast)}
            >
              사건 보기
            </button>
            <button
              type="button"
              className="button"
              aria-label="알림 팝업 닫기"
              onClick={notifications.dismiss}
            >
              닫기
            </button>
          </div>
        </aside>
      )}
      {/* [UI-EVT03] 기능·역할: 최근 피드백 번호에서 고객 피드백 이동. 수행 이유: 기존 특정 피드백 조회 경로로 사건 상세를 닫고 선택한 건을 표시합니다. */}
      {selectedEventId && (
        <EventDetailDialog
          key={selectedEventId}
          request={visionRequest}
          eventId={selectedEventId}
          detectedAt={selectedEventTime}
          feedbackClient={client}
          feedbackDrafts={eventFeedbackDrafts.current}
          onNavigate={navigate}
          onBusyChange={setBusy}
          onUnauthorized={onUnauthorized}
          onClose={() => setSelectedEventId(null)}
        />
      )}
    </AppLayout>
  )
}

function AuthenticatedShell({
  session,
  showHome,
  onLogout,
  onUnauthorized,
  onHome,
  onEnterService,
  discordApi,
  entry,
}) {
  const client = useMemo(
    () => createApiClient(API_BASE_URL, session.accessToken),
    [session.accessToken],
  )
  const profile = useProfile(client, onUnauthorized)
  const [avatarId, setAvatarId] = useState(() => readProfileAvatar(session.user.id))
  const [destination, setDestination] = useState(() => ({
    page: entry.page || getDefaultPage(session.user.role),
  }))
  const page = destination.page

  function navigate(next) {
    setDestination(typeof next === 'string' ? { page: next } : next)
  }

  function chooseAvatar(choice) {
    setAvatarId(choice.id)
    return saveProfileAvatar(session.user.id, choice.id)
  }

  function goHome() {
    navigate(getDefaultPage(session.user.role))
    onHome()
  }

  function enterService(nextPage = getDefaultPage(session.user.role)) {
    navigate(nextPage)
    onEnterService()
  }

  if (showHome)
    return (
      <Landing
        onLogin={() => enterService()}
        onLogout={onLogout}
        onHome={reloadHome}
        onProfile={() => enterService('profile')}
        isAuthenticated
        profile={profile.data}
        avatarId={avatarId}
      />
    )

  return (
    <AuthenticatedApp
      session={session}
      client={client}
      profile={profile}
      avatarId={avatarId}
      onChooseAvatar={chooseAvatar}
      page={page}
      feedbackTargetId={destination.feedbackId}
      onNavigate={navigate}
      onLogout={onLogout}
      onUnauthorized={onUnauthorized}
      onHome={goHome}
      discordApi={discordApi}
      initialEventId={entry.eventId}
    />
  )
}

export default function App() {
  const auth = useAuth()
  const [showHome, setShowHome] = useState(shouldRestoreHome)
  const [callback, setCallback] = useState(() => window.location?.pathname === discordCallbackPath)
  const [entry, setEntry] = useState(() => ({
    eventId: window.location?.href ? readDiscordEventLink(window.location.href) : null,
  }))
  const discordApi = useMemo(
    () => createDiscordApi(API_BASE_URL, auth.session?.accessToken),
    [auth.session?.accessToken],
  )

  useEffect(() => {
    try {
      window.sessionStorage.removeItem(HOME_RELOAD_KEY)
    } catch {
      // Storage can be disabled.
    }
  }, [])

  function leaveCallback() {
    window.history.replaceState(null, '', '/')
    setCallback(false)
    setShowHome(false)
    auth.setShowLogin(true)
  }

  async function completeDiscord(result) {
    if (!result.user_id) throw new Error('Discord 계정 정보를 확인하지 못했습니다.')
    await auth.acceptSession(result.tokens, result.user_id)
    setEntry({ page: result.intent === 'link' ? 'profile' : null, eventId: result.eventId })
    leaveCallback()
  }

  function logout() {
    setEntry({})
    setShowHome(false)
    auth.logout()
  }

  function goHome() {
    if (!auth.session) {
      auth.switchMode('login')
      auth.setShowLogin(false)
    }
    setShowHome(true)
    window.scrollTo?.(0, 0)
  }

  function enterService() {
    setShowHome(false)
    if (!auth.session) auth.setShowLogin(true)
    window.scrollTo?.(0, 0)
  }

  if (auth.restoring || auth.restoreError) return <SessionRestore auth={auth} />

  if (callback)
    return (
      <DiscordCallback
        api={discordApi}
        onComplete={completeDiscord}
        onBack={() => {
          setEntry({ page: auth.session ? 'profile' : null })
          leaveCallback()
        }}
      />
    )

  if (auth.session)
    return (
      <AuthenticatedShell
        key={`${auth.session.user.id}:${auth.session.user.role}`}
        session={auth.session}
        showHome={showHome}
        onLogout={logout}
        onUnauthorized={auth.handleUnauthorized}
        onHome={goHome}
        onEnterService={enterService}
        discordApi={discordApi}
        entry={entry}
      />
    )
  if (showHome) return <Landing onLogin={enterService} onHome={reloadHome} />
  if (auth.showLogin || entry.eventId)
    return (
      <AuthPage
        auth={auth}
        onHome={goHome}
        socialLogin={(props) => <DiscordLoginButton api={discordApi} {...props} />}
      />
    )
  return <Landing onLogin={enterService} onHome={reloadHome} />
}
