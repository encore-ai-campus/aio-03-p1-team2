import { useCallback, useEffect, useRef, useState } from 'react'
import { createAuthApi } from './authApi.js'
import { API_BASE_URL } from '../../shared/api/config.js'
import { clearSession, readSession, saveSession } from './sessionStorage.js'

const api = createAuthApi(API_BASE_URL)

export function useAuth() {
  const [session, setSession] = useState(null)
  const [showLogin, setShowLogin] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [mode, setMode] = useState('login')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [expiresAt, setExpiresAt] = useState(null)
  const [restoring, setRestoring] = useState(true)
  const [restoreError, setRestoreError] = useState('')
  const [restoreRevision, setRestoreRevision] = useState(0)
  const restoreController = useRef(null)
  const credentials = useRef(null)
  const revision = useRef(0)
  const pendingRefresh = useRef(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const forgetCredentials = useCallback(() => {
    revision.current++
    credentials.current = null
    pendingRefresh.current = null
    restoreController.current?.abort()
    clearSession(API_BASE_URL)
    setExpiresAt(null)
    setSession(null)
    setRestoring(false)
  }, [])

  const logout = useCallback(() => {
    forgetCredentials()
    setShowLogin(false)
    setPassword('')
    setError('')
    setNotice('')
  }, [forgetCredentials])

  const handleUnauthorized = useCallback(() => {
    forgetCredentials()
    setShowLogin(true)
    setMode('login')
    setNotice('')
    setPassword('')
    setError('로그인이 만료되었습니다. 다시 로그인해 주세요.')
  }, [forgetCredentials])

  const refreshSession = useCallback(() => {
    if (pendingRefresh.current) return pendingRefresh.current
    const previous = credentials.current
    if (!previous?.refreshToken)
      return Promise.reject(Object.assign(new Error('로그인이 만료되었습니다.'), { status: 401 }))
    const currentRevision = revision.current
    const pending = (async () => {
      if (!previous.unverified) {
        const receivedAt = Date.now()
        const tokens = await api.refresh(previous.refreshToken)
        if (!mounted.current || revision.current !== currentRevision) return
        // Keep rotated credentials even when the following identity request loses connectivity.
        const expiry = saveSession(API_BASE_URL, tokens, receivedAt)
        if (!expiry || !tokens.refresh_token)
          throw Object.assign(new Error('로그인 갱신에 실패했습니다.'), { status: 401 })
        credentials.current = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: expiry,
          refreshAt: expiry - Math.min(60000, (expiry - receivedAt) / 2),
          userId: previous.userId,
          unverified: true,
        }
      }
      const current = credentials.current
      const user = await api.me(current.accessToken)
      if (!mounted.current || revision.current !== currentRevision) return
      if (
        !user?.id ||
        !['user', 'admin'].includes(user.role) ||
        (previous.userId && previous.userId !== user.id)
      )
        throw Object.assign(new Error('계정 권한을 확인하지 못했습니다.'), { status: 401 })
      credentials.current.userId = user.id
      credentials.current.unverified = false
      setExpiresAt(current.expiresAt)
      setSession({ accessToken: current.accessToken, user })
    })().finally(() => {
      if (pendingRefresh.current === pending) pendingRefresh.current = null
    })
    pendingRefresh.current = pending
    return pending
  }, [])

  useEffect(() => {
    const saved = readSession(API_BASE_URL)
    if (!saved) {
      setRestoring(false)
      setRestoreError('')
      return undefined
    }
    const controller = new AbortController()
    restoreController.current = controller
    setRestoring(true)
    setRestoreError('')
    credentials.current = saved
    const restore = async () => {
      if (saved.refreshToken && saved.expiresAt - Date.now() <= 60000) {
        await refreshSession()
        return
      }
      try {
        const user = await api.me(saved.accessToken, controller.signal)
        if (controller.signal.aborted) return
        if (!user?.id || !['user', 'admin'].includes(user.role) || saved.expiresAt <= Date.now()) {
          handleUnauthorized()
          return
        }
        setSession({ accessToken: saved.accessToken, user })
        setExpiresAt(saved.expiresAt)
        credentials.current = { ...saved, userId: user.id }
        setShowLogin(true)
      } catch (err) {
        if (!controller.signal.aborted && err.status === 401 && saved.refreshToken) {
          await refreshSession()
        } else throw err
      }
    }
    restore()
      .catch((err) => {
        if (controller.signal.aborted) return
        if (err.status === 401 || err.status === 403) handleUnauthorized()
        else
          setRestoreError(
            '로그인 상태를 확인하지 못했어요. 서버 연결을 확인하고 다시 시도해 주세요.',
          )
      })
      .finally(() => {
        if (!controller.signal.aborted) setRestoring(false)
      })
    return () => controller.abort()
  }, [restoreRevision, handleUnauthorized, refreshSession])

  useEffect(() => {
    if (!session || !expiresAt) return undefined
    let timer,
      disposed = false
    const checkExpiry = async () => {
      clearTimeout(timer)
      const current = credentials.current
      if (!current) return
      const remaining = current.expiresAt - Date.now()
      const refreshIn = (current.refreshAt ?? current.expiresAt - 60000) - Date.now()
      if (current.unverified || (current.refreshToken && refreshIn <= 0)) {
        try {
          await refreshSession()
        } catch (err) {
          if (disposed) return
          const validFor = Math.min(credentials.current?.expiresAt || 0, expiresAt) - Date.now()
          if ([401, 403].includes(err.status) || validFor <= 0) handleUnauthorized()
          else {
            clearTimeout(timer)
            timer = setTimeout(checkExpiry, Math.min(5000, validFor))
          }
        }
      } else if (remaining <= 0) handleUnauthorized()
      else
        timer = setTimeout(
          checkExpiry,
          Math.min(current.refreshToken ? refreshIn : remaining, 2147483647),
        )
    }
    const onVisible = () => {
      if (!document.hidden) void checkExpiry()
    }
    void checkExpiry()
    window.addEventListener?.('focus', checkExpiry)
    document.addEventListener?.('visibilitychange', onVisible)
    return () => {
      disposed = true
      clearTimeout(timer)
      window.removeEventListener?.('focus', checkExpiry)
      document.removeEventListener?.('visibilitychange', onVisible)
    }
  }, [session, expiresAt, handleUnauthorized, refreshSession])

  function retryRestore() {
    setRestoring(true)
    setRestoreError('')
    setRestoreRevision((value) => value + 1)
  }

  function discardRestore() {
    forgetCredentials()
    setRestoring(false)
    setRestoreError('')
    setShowLogin(true)
    switchMode('login')
  }

  function switchMode(nextMode) {
    setMode(nextMode)
    setError('')
    setNotice('')
    setPassword('')
    setPasswordConfirm('')
  }

  const acceptSession = useCallback(async (tokens, expectedUserId) => {
    const receivedAt = Date.now()
    const currentRevision = revision.current
    if (!tokens?.access_token) throw new Error('로그인 토큰을 받지 못했습니다.')
    const user = await api.me(tokens.access_token)
    if (!mounted.current || revision.current !== currentRevision) return
    if (
      !user?.id ||
      !['user', 'admin'].includes(user.role) ||
      (expectedUserId && user.id !== expectedUserId)
    ) {
      throw new Error('계정 권한을 확인하지 못했습니다.')
    }
    revision.current++
    pendingRefresh.current = null
    const expiry = saveSession(API_BASE_URL, tokens, receivedAt)
    if (!expiry) throw new Error('로그인이 만료되었습니다. 다시 로그인해 주세요.')
    setPassword('')
    credentials.current = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || '',
      expiresAt: expiry,
      refreshAt: expiry - Math.min(60000, (expiry - receivedAt) / 2),
      userId: user.id,
    }
    setExpiresAt(expiry)
    setSession({ accessToken: tokens.access_token, user })
  }, [])

  async function handleLogin(event) {
    event.preventDefault()
    if (busy) return

    setBusy(true)
    setError('')

    try {
      const tokens = await api.login(email.trim(), password)
      await acceptSession(tokens)
    } catch (err) {
      const networkError =
        err instanceof TypeError || err.name === 'TimeoutError' || err.name === 'AbortError'

      setError(
        networkError
          ? '서버에 연결하지 못했습니다. 백엔드 실행 상태를 확인해 주세요.'
          : err.message || '로그인에 실패했습니다.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function handleRegister(event) {
    event.preventDefault()
    if (busy) return
    if (password !== passwordConfirm) {
      setError('비밀번호가 서로 일치하지 않습니다.')
      return
    }

    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await api.register(email.trim(), password)
      setMode('login')
      setPassword('')
      setPasswordConfirm('')
      setNotice(
        result?.email_confirmation_required
          ? '회원가입이 완료되었습니다. 이메일 인증 후 로그인해 주세요.'
          : '회원가입이 완료되었습니다. 로그인해 주세요.',
      )
    } catch (err) {
      const networkError =
        err instanceof TypeError || err.name === 'TimeoutError' || err.name === 'AbortError'
      setError(
        networkError
          ? '서버에 연결하지 못했습니다. 백엔드 실행 상태를 확인해 주세요.'
          : err.message || '회원가입에 실패했습니다.',
      )
    } finally {
      setBusy(false)
    }
  }

  return {
    restoring,
    restoreError,
    retryRestore,
    discardRestore,
    session,
    showLogin,
    setShowLogin,
    email,
    setEmail,
    password,
    setPassword,
    passwordConfirm,
    setPasswordConfirm,
    mode,
    busy,
    error,
    notice,
    logout,
    handleUnauthorized,
    switchMode,
    handleLogin,
    acceptSession,
    handleRegister,
  }
}
