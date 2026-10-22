const keyFor = (baseUrl) => `notecam:session:v1:${baseUrl}`

export function clearSession(baseUrl) {
  try {
    window.sessionStorage.removeItem(keyFor(baseUrl))
  } catch {
    // Login still works in memory when browser storage is unavailable.
  }
}

export function readSession(baseUrl) {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(keyFor(baseUrl)) || 'null')
    if (
      typeof value?.accessToken === 'string' &&
      value.accessToken &&
      Number.isFinite(value.expiresAt) &&
      (value.expiresAt > Date.now() ||
        (typeof value.refreshToken === 'string' && value.refreshToken))
    ) {
      // Identity and role must always be obtained from /api/auth/me.
      return {
        accessToken: value.accessToken,
        refreshToken: typeof value.refreshToken === 'string' ? value.refreshToken : '',
        expiresAt: value.expiresAt,
      }
    }
  } catch {
    // Malformed or blocked storage is treated as signed out.
  }
  clearSession(baseUrl)
  return null
}

export function saveSession(baseUrl, tokens, receivedAt = Date.now()) {
  const seconds = Number(tokens.expires_in)
  const expiresAt = receivedAt + seconds * 1000
  if (!tokens.access_token || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    clearSession(baseUrl)
    return null
  }
  try {
    window.sessionStorage.setItem(
      keyFor(baseUrl),
      JSON.stringify({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || '',
        expiresAt,
      }),
    )
  } catch {
    // Return the expiry so memory-only sessions also expire correctly.
  }
  return expiresAt
}
