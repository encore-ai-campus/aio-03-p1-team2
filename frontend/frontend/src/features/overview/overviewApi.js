const STATUS_KEYS = ['pending', 'in_progress', 'resolved']
const KIND_KEYS = ['false_positive', 'false_negative', 'accurate', 'suggestion']

export function createAdminOverviewApi(request) {
  const feedback = (filters, signal) => {
    const params = new URLSearchParams({ limit: String(filters.limit ?? 1), offset: '0' })
    if (filters.status) params.set('status', filters.status)
    if (filters.kind) params.set('kind', filters.kind)
    return request(`/api/admin/feedback?${params}`, { signal })
  }

  return {
    async load(signal) {
      const [users, latestFeedback, audit, ...counts] = await Promise.all([
        request('/api/admin/users?limit=1&offset=0', { signal }),
        feedback({ limit: 5 }, signal),
        request('/api/admin/audit-logs?limit=5&offset=0', { signal }),
        ...STATUS_KEYS.map((status) => feedback({ status }, signal)),
        ...KIND_KEYS.map((kind) => feedback({ kind }, signal)),
      ])

      return {
        userTotal: users.total,
        feedbackTotal: latestFeedback.total,
        feedbackItems: latestFeedback.items,
        auditItems: audit.items,
        statusTotals: Object.fromEntries(
          STATUS_KEYS.map((status, index) => [status, counts[index].total]),
        ),
        kindTotals: Object.fromEntries(
          KIND_KEYS.map((kind, index) => [kind, counts[STATUS_KEYS.length + index].total]),
        ),
      }
    },
  }
}

// [UI-OV02] 기능·역할: 본인 운영현황 조회. 수행 이유: 관리자 API 없이 최근 20건과 실제 처리 대기 총수를 사용합니다.
export function createUserOverviewApi(request) {
  return {
    async events(signal) {
      const items = await request('/api/motion/events?limit=20', { signal })
      return { items, receivedAt: new Date().toISOString() }
    },
    // [UI-CAM01] 기능·역할: 운영현황의 최근 실행 조회 제거. 수행 이유: 카메라 상태는 현재 브라우저의 공유 세션에서 직접 전달받습니다.
    pendingFeedback: (signal) =>
      request('/api/feedback?limit=1&offset=0&status=pending', { signal }),
  }
}
