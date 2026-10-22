import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { PageRefreshContext } from './PageRefreshContext.js'

// The caller provides a stable loader (useCallback or a memoized API method).
export function useApiResource(load, onUnauthorized) {
  const pageRevision = useContext(PageRefreshContext)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const previousLoad = useRef(load)
  const refresh = useCallback(() => setRevision((value) => value + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    const sourceChanged = previousLoad.current !== load
    previousLoad.current = load
    setLoading(true)
    if (sourceChanged) setData(null)
    setError('')
    load(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setData(result)
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        if (err.status === 401) onUnauthorized?.()
        else setError(err.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [load, onUnauthorized, revision, pageRevision])

  return { data, setData, loading, error, refresh }
}
