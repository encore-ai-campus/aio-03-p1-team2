export function createAccountsApi(request) {
  return {
    list: ({ limit = 20, offset = 0 } = {}, signal) =>
      request(`/api/admin/users?limit=${limit}&offset=${offset}`, { signal }),
    update: (id, changes) =>
      request(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: changes }),
  }
}
