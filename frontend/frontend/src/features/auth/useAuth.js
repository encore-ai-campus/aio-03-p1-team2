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

  const logout = useCallback(() => {
    clearSession(API_BASE_URL)
    setExpiresAt(null)
    setSession(null)
    setShowLogin(false)
    setPassword('')
    setError('')
    setNotice('')
  }, [])

  const handleUnauthorized = useCallback(() => {
    clearSession(API_BASE_URL)
    setExpiresAt(null)
    setSession(null)
    setShowLogin(true)
    setMode('login')
    setNotice('')
    setPassword('')
    setError('로그인이 만료되었습니다. 다시 로그인해 주세요.')
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
    api
      .me(saved.accessToken, controller.signal)
      .then((user) => {
        if (controller.signal.aborted) return
        if (!user?.id || !['user', 'admin'].includes(user.role) || saved.expiresAt <= Date.now()) {
          handleUnauthorized()
          return
        }
        setSession({ accessToken: saved.accessToken, user })
        setExpiresAt(saved.expiresAt)
        setShowLogin(true)
      })
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
  }, [restoreRevision, handleUnauthorized])

  useEffect(() => {
    if (!session || !expiresAt) return undefined
    let timer
    const checkExpiry = () => {
      clearTimeout(timer)
      const remaining = expiresAt - Date.now()
      if (remaining <= 0) handleUnauthorized()
      else timer = setTimeout(checkExpiry, Math.min(remaining, 2147483647))
    }
    checkExpiry()
    window.addEventListener?.('focus', checkExpiry)
    return () => {
      clearTimeout(timer)
      window.removeEventListener?.('focus', checkExpiry)
    }
  }, [session, expiresAt, handleUnauthorized])

  function retryRestore() {
    setRestoring(true)
    setRestoreError('')
    setRestoreRevision((value) => value + 1)
  }

  function discardRestore() {
    restoreController.current?.abort()
    clearSession(API_BASE_URL)
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
    if (!tokens?.access_token) throw new Error('로그인 토큰을 받지 못했습니다.')
    const user = await api.me(tokens.access_token)
    if (
      !user?.id ||
      !['user', 'admin'].includes(user.role) ||
      (expectedUserId && user.id !== expectedUserId)
    ) {
      throw new Error('계정 권한을 확인하지 못했습니다.')
    }
    const expiry = saveSession(API_BASE_URL, tokens, receivedAt)
    if (!expiry) throw new Error('로그인이 만료되었습니다. 다시 로그인해 주세요.')
    setPassword('')
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
