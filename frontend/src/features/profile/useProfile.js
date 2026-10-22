import { useMemo, useRef, useState } from 'react'
import { useApiResource } from '../../shared/hooks/useApiResource.js'
import { createProfileApi } from './profileApi.js'

export function useProfile(client, onUnauthorized) {
  const api = useMemo(() => createProfileApi(client), [client])
  const resource = useApiResource(api.get, onUnauthorized)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [message, setMessage] = useState('')
  const pending = useRef(false)

  async function save(name) {
    if (pending.current) return false
    setSaveError('')
    setMessage('')
    const value = name.trim()
    if (!value || value.length > 40) {
      setSaveError('닉네임은 1~40자로 입력해 주세요.')
      return false
    }
    pending.current = true
    setBusy(true)
    try {
      resource.setData(await api.update(value))
      setMessage('프로필을 저장했어요.')
      return true
    } catch (err) {
      if (err.status === 401) onUnauthorized?.()
      else setSaveError(err.message)
      return false
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  function clearSaveFeedback() {
    setSaveError('')
    setMessage('')
  }
  return { ...resource, busy, saveError, message, save, clearSaveFeedback }
}
