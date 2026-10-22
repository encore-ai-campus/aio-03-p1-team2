const common = [
  { id: 'profile', label: '나의 프로필' },
  { id: 'live', label: '실시간 보기' },
]
const userMenu = [
  ...common,
  // [UI-NAV03] 기능·역할: 일반 사용자 메뉴 명칭 변경. 수행 이유: 개인 요약과 모니터링 기록의 역할을 알리고 기존 경로·관리자 명칭은 유지합니다.
  { id: 'status', label: '내 대시보드' },
  { id: 'events', label: '모니터링현황' },
  { id: 'feedback', label: '고객 피드백' },
]
const adminMenu = [
  ...common,
  { id: 'admin-cameras', label: '카메라 기록' },
  { id: 'admin-overview', label: '운영현황' },
  { id: 'admin-events', label: '감사 로그' },
  { id: 'feedback', label: '고객 피드백 관리' },
  { id: 'accounts', label: '계정 관리' },
]

export const getNavigation = (role) => (role === 'admin' ? adminMenu : userMenu)
export const getDefaultPage = (role) => (role === 'admin' ? 'admin-overview' : 'live')
