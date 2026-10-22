import { getNavigation } from './navigation.js'
import logoHorizontal from '../assets/logo-horizontal.png'
import ProfileShortcut from '../features/profile/ProfileShortcut.jsx'
import './AppLayout.css'
import '../shared/styles/controls.css'

export default function AppLayout({
  user,
  profile,
  avatarId,
  page,
  onNavigate,
  onLogout,
  onHome,
  busy,
  headerActions,
  children,
}) {
  const admin = user.role === 'admin'
  return (
    <div className="dashboard workspace">
      <div className="dashboard-app">
        <header className="dashboard-top">
          <button
            type="button"
            className="dashboard-brand"
            aria-label="홈으로 이동"
            disabled={busy}
            onClick={onHome}
          >
            <img src={logoHorizontal} alt="" width="940" height="220" />
          </button>
          <div className="dashboard-user">
            {headerActions}
            <ProfileShortcut
              profile={profile}
              avatarId={avatarId}
              onClick={() => onNavigate('profile')}
              disabled={busy}
            />
            <button type="button" disabled={busy} onClick={onLogout}>
              로그아웃
            </button>
          </div>
        </header>
        <div className="dashboard-layout">
          <aside className="dashboard-side">
            <small>{admin ? '어드민' : '서비스'}</small>
            <nav aria-label="페이지 메뉴">
              {getNavigation(user.role).map(({ id, label }) => (
                <button
                  type="button"
                  key={id}
                  disabled={busy}
                  aria-current={page === id ? 'page' : undefined}
                  onClick={() => onNavigate(id)}
                >
                  {label}
                </button>
              ))}
            </nav>
            <p>{admin ? '계정과 피드백을 관리합니다.' : '내 프로필과 피드백을 관리합니다.'}</p>
          </aside>
          <main className="dashboard-main">{children}</main>
        </div>
      </div>
    </div>
  )
}
