import { createContext } from 'react'

// [UI-NAV01] 기능·역할: 현재 페이지의 재조회 신호 공유. 수행 이유: 메뉴 재클릭 시 입력·필터를 유지하면서 중첩된 목록도 다시 조회합니다.
export const PageRefreshContext = createContext(0)
