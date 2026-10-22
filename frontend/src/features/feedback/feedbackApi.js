export function createFeedbackApi(request) {
  return {
    getForAdmin: async (id, signal) => {
      const limit = 100
      let offset = 0

      while (true) {
        const page = await request(`/api/admin/feedback?limit=${limit}&offset=${offset}`, {
          signal,
        })
        const item = page.items.find((entry) => String(entry.id) === String(id))
        if (item) return item

        offset += page.items.length
        if (page.items.length === 0 || offset >= page.total) break
      }

      const error = new Error('피드백을 찾을 수 없습니다.')
      error.status = 404
      throw error
    },

    list: async (
      { admin = false, limit = 20, offset = 0, kind = '', status = '', q = '', feedbackId = '' },
      signal,
    ) => {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
      })

      if (kind) {
        params.set('kind', kind)
      }

      if (status) {
        params.set('status', status)
      }
      // [UI-FB01] 기능·역할: 서버 전체 검색 조건 전달. 수행 이유: 현재 페이지를 필터링하지 않고 권한 범위 전체에서 검색한 건수·목록을 받습니다.
      if (q) params.set('q', q)
      if (feedbackId) params.set('feedback_id', feedbackId)

      const path = admin ? '/api/admin/feedback' : '/api/feedback'
      const page = await request(`${path}?${params}`, { signal })
      if (page.items.length === 0) return page

      const nicknames = new Map()
      // [UI-02] 기능·역할: 조회 권한에 맞는 작성자 이름 연결. 수행 이유: 내 피드백은 본인 프로필만 조회하고 기존 관리자 전체 조회는 유지합니다.
      if (admin) {
        const missingAuthors = new Set(page.items.map((item) => item.user_id))
        const pageSize = 100
        let userOffset = 0

        while (missingAuthors.size > 0) {
          const users = await request(`/api/admin/users?limit=${pageSize}&offset=${userOffset}`, {
            signal,
          })
          for (const user of users.items) {
            if (missingAuthors.delete(user.id)) nicknames.set(user.id, user.display_name)
          }
          userOffset += pageSize
          if (users.items.length === 0 || userOffset >= users.total) break
        }
      } else {
        const profile = await request('/api/users/me', { signal })
        nicknames.set(profile.id, profile.display_name)
      }

      return {
        ...page,
        items: page.items.map((item) => ({
          ...item,
          author_nickname: nicknames.get(item.user_id) ?? null,
        })),
      }
    },

    create: ({ title, kind, content }) =>
      request('/api/feedback', {
        method: 'POST',
        body: { title, kind, content },
      }),

    update: (id, { title, kind, content }) =>
      request(`/api/feedback/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { title, kind, content },
      }),

    remove: (id, admin = false) => {
      const path = admin ? '/api/admin/feedback' : '/api/feedback'

      return request(`${path}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
    },

    process: (id, { status, admin_note }) =>
      request(`/api/admin/feedback/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { status, admin_note },
      }),
  }
}
