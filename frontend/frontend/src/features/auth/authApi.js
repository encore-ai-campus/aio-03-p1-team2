import { createApiClient } from '../../shared/api/client.js'

export function createAuthApi(baseUrl) {
  const request = createApiClient(baseUrl)
  return {
    login: (email, password) =>
      request('/api/auth/login', { method: 'POST', body: { email, password } }),
    register: (email, password) =>
      request('/api/auth/register', { method: 'POST', body: { email, password } }),
    me: (token, signal) => createApiClient(baseUrl, token)('/api/auth/me', { signal }),
  }
}
