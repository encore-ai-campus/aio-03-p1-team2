export function createEventsApi(request) {
  return {
    auditLogs: async (signal) => {
      const page = await request('/api/admin/audit-logs?limit=20&offset=0', { signal })
      const neededIds = new Set()

      for (const item of page.items) {
        if (item.actor_id) neededIds.add(item.actor_id)
        if (item.target_type === 'users' && item.target_id) neededIds.add(item.target_id)
        if (item.target_type === 'feedback') {
          const authorId = item.new_data?.user_id ?? item.old_data?.user_id
          if (authorId) neededIds.add(authorId)
        }
      }

      const usersById = new Map()
      let identityError = ''
      let offset = 0
      const limit = 100

      try {
        while (neededIds.size > 0) {
          const users = await request(`/api/admin/users?limit=${limit}&offset=${offset}`, {
            signal,
          })
          for (const user of users.items) {
            if (neededIds.delete(user.id)) usersById.set(user.id, user)
          }
          offset += limit
          if (users.items.length === 0 || offset >= users.total) break
        }
      } catch (error) {
        if (signal.aborted || error.status === 401 || error.status === 403) throw error
        identityError = '닉네임을 불러오지 못해 일부 기록은 닉네임 확인 불가로 표시합니다.'
      }

      return { ...page, usersById, identityError }
    },
  }
}
