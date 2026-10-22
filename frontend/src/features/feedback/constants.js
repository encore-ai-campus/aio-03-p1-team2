export const FEEDBACK_KINDS = {
  false_positive: '오탐 신고',
  false_negative: '미탐 신고',
  suggestion: '개선 의견',
  // [UI-04] 기능·역할: 정확한 감지 평가 공통 표시명. 수행 이유: 신규 작성에서도 선택하는 유형이므로 기존 항목 문구를 제거합니다.
  accurate: '정확한 감지 평가',
}

export const FEEDBACK_STATUSES = {
  pending: '처리 대기',
  in_progress: '확인 중',
  resolved: '처리 완료',
}
