import { useCallback, useMemo, useRef, useState } from 'react'
import { useApiResource } from '../../shared/hooks/useApiResource.js'
import { createAccountsApi } from './accountsApi.js'

export function useAccounts(client, onUnauthorized) {
  const api = useMemo(() => createAccountsApi(client), [client])
  const [offset, setOffset] = useState(0)
  const [savingId, setSavingId] = useState(null)
  const [actionError, setActionError] = useState('')
  const [message, setMessage] = useState('')
  const pending = useRef(false)
  const pageSize = 20
  const load = useCallback((signal) => api.list({ limit: pageSize, offset }, signal), [api, offset])
  const resource = useApiResource(load, onUnauthorized)

  async function update(user, field, value) {
    if (pending.current || value === user[field]) return
    pending.current = true
    setSavingId(user.id)
    setActionError('')
    setMessage('')
    try {
      await api.update(user.id, { [field]: value })
      setMessage('사용자 정보를 저장했어요.')
      resource.refresh()
    } catch (err) {
      if (err.status === 401) onUnauthorized?.()
      else setActionError(err.message)
    } finally {
      pending.current = false
      setSavingId(null)
    }
  }
  return {
    ...resource,
    offset,
    setOffset,
    pageSize,
    savingId,
    busy: savingId !== null,
    actionError,
    message,
    update,
  }
}
