import { useEffect } from 'react'

export function useNavigationLock(busy, onBusyChange) {
  useEffect(() => {
    onBusyChange?.(busy)
    return () => onBusyChange?.(false)
  }, [busy, onBusyChange])
}
