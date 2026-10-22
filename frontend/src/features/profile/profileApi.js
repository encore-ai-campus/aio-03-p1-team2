export function createProfileApi(request) {
  return {
    get: (signal) => request('/api/users/me', { signal }),
    update: (display_name) => request('/api/users/me', { method: 'PATCH', body: { display_name } }),
  }
}
