import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { PageRefreshContext } from '../../shared/hooks/PageRefreshContext.js'
import { createFeedbackApi } from './feedbackApi.js'

const PAGE_SIZE = 20
const EMPTY_SEARCH = { q: '', feedbackId: '' }
const emptyForm = () => ({
  title: '',
  kind: 'false_positive',
  content: '',
  status: 'pending',
  admin_note: '',
})

export function useFeedback({ client, user, onUnauthorized, targetFeedbackId }) {
  const pageRevision = useContext(PageRefreshContext)
  const api = useMemo(() => createFeedbackApi(client), [client])

  const [adminView, setAdminView] = useState(user?.role === 'admin')

  const [kind, setKind] = useState('')
  const [status, setStatus] = useState('')
  const [offset, setOffset] = useState(0)
  // [UI-FB01] 기능·역할: 검색 입력과 적용된 검색 조건 분리. 수행 이유: 검색 버튼·Enter로 조건을 적용하고, 입력을 비우면 즉시 초기화합니다.
  const [searchField, setSearchField] = useState('text')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState(EMPTY_SEARCH)
  const [searchError, setSearchError] = useState('')

  const [page, setPage] = useState({
    items: [],
    total: 0,
  })

  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [listError, setListError] = useState('')
  const [actionError, setActionError] = useState('')
  const [message, setMessage] = useState('')

  const [revision, setRevision] = useState(0)
  const [editor, setEditor] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [busy, setBusy] = useState(false)
  const [targetLoading, setTargetLoading] = useState(false)

  const actionPending = useRef(false)
  const loadedQuery = useRef(null)

  const isAdmin = user?.role === 'admin'

  useEffect(() => {
    if (!isAdmin || targetFeedbackId == null) return
    const controller = new AbortController()
    setTargetLoading(true)
    setActionError('')
    setAdminView(true)
    setKind('')
    setStatus('')
    setOffset(0)

    api
      .getForAdmin(targetFeedbackId, controller.signal)
      .then((item) => {
        if (controller.signal.aborted) return
        setEditor({ type: 'process', item })
        setForm({
          title: item.title,
          kind: item.kind,
          content: item.content,
          status: item.status,
          admin_note: item.admin_note ?? '',
        })
        setMessage('')
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        if (error.status === 401) onUnauthorized?.()
        else if (error.status === 404)
          setActionError('이 피드백은 삭제되었거나 더 이상 조회할 수 없어요.')
        else setActionError(error.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setTargetLoading(false)
      })

    return () => controller.abort()
  }, [api, isAdmin, targetFeedbackId, onUnauthorized])

  useEffect(() => {
    const controller = new AbortController()
    const queryKey = JSON.stringify([adminView, isAdmin, offset, kind, status, search])
    const backgroundRefresh = loadedQuery.current === queryKey

    setLoading(!backgroundRefresh)
    setRefreshing(backgroundRefresh)
    setListError('')

    api
      .list(
        {
          admin: adminView && isAdmin,
          limit: PAGE_SIZE,
          offset,
          kind,
          status,
          ...search,
        },
        controller.signal,
      )
      .then((result) => {
        if (!controller.signal.aborted) {
          // [UI-FB02] 기능·역할: 마지막 유효 페이지로 보정. 수행 이유: 수정·삭제 후 검색 결과에서 제외되어도 비어 있는 초과 페이지에 남지 않습니다.
          const lastOffset = Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1) * PAGE_SIZE
          if (offset > lastOffset) {
            setOffset(lastOffset)
            return
          }
          setPage(result)
          loadedQuery.current = queryKey
        }
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return
        }

        if (error.status === 401) {
          onUnauthorized?.()
        } else {
          setListError(error.message)
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false)
          setRefreshing(false)
        }
      })

    return () => controller.abort()
  }, [
    api,
    adminView,
    isAdmin,
    offset,
    kind,
    status,
    search,
    revision,
    pageRevision,
    onUnauthorized,
  ])

  function applySearch(event) {
    event.preventDefault()
    if (busy) return
    const value = query.trim()
    if (searchField === 'text' && value.length > 100) {
      setSearchError('검색어는 100자 이내로 입력해 주세요.')
      return
    }
    let feedbackId = ''
    if (searchField === 'id' && value) {
      const digits = value.replace(/^#/, '')
      if (!/^\d+$/.test(digits) || BigInt(digits) < 1n || BigInt(digits) > 9223372036854775807n) {
        setSearchError('올바른 피드백 번호를 입력해 주세요. 예: 1034 또는 #1034')
        return
      }
      feedbackId = String(BigInt(digits))
    }
    setSearch({ q: searchField === 'text' ? value : '', feedbackId })
    setOffset(0)
    setSearchError('')
    setMessage('')
    refresh()
  }

  function resetFilters() {
    setKind('')
    setStatus('')
    setOffset(0)
    setSearchField('text')
    setQuery('')
    setSearch(EMPTY_SEARCH)
    setSearchError('')
    refresh()
  }

  // [UI-FB04] 기능·역할: 검색어 삭제 시 자동 초기화. 수행 이유: X 버튼과 전체 글자 삭제도 초기화 버튼과 같은 전체 조회 상태로 돌아갑니다.
  function updateQuery(value) {
    if (!value.trim()) {
      resetFilters()
    } else {
      setQuery(value)
    }
  }

  function switchView(value) {
    setAdminView(value)
    resetFilters()
    setEditor(null)
    setMessage('')
    setActionError('')
  }

  function openEditor(type, item = null) {
    setEditor({ type, item })

    setForm(
      item
        ? {
            title: item.title,
            kind: item.kind,
            content: item.content,
            status: item.status,
            admin_note: item.admin_note ?? '',
          }
        : emptyForm(),
    )

    setMessage('')
    setActionError('')
  }

  function refresh() {
    setRevision((value) => value + 1)
  }

  async function submit(event) {
    event.preventDefault()

    if (actionPending.current) {
      return
    }

    if (editor.type !== 'process' && (!form.title.trim() || !form.content.trim())) {
      setActionError('제목과 내용을 입력해 주세요.')
      return
    }

    actionPending.current = true
    setBusy(true)
    setActionError('')
    setMessage('')

    try {
      if (editor.type === 'process') {
        await api.process(editor.item.id, {
          status: form.status,
          admin_note: form.admin_note.trim() || null,
        })

        setMessage('처리 상태와 답변을 저장했어요.')
      } else {
        const body = {
          title: form.title.trim(),
          kind: form.kind,
          content: form.content.trim(),
        }

        if (editor.type === 'edit') {
          await api.update(editor.item.id, body)
          setMessage('피드백을 수정했어요.')
        } else {
          await api.create(body)

          setOffset(0)
          setKind('')
          setStatus('')
          setSearch(EMPTY_SEARCH)
          setSearchField('text')
          setQuery('')
          setSearchError('')
          setMessage('피드백을 등록했어요.')
        }
      }

      setEditor(null)
      refresh()
    } catch (error) {
      if (error.status === 401) {
        onUnauthorized?.()
      } else {
        setActionError(error.message)
      }
    } finally {
      actionPending.current = false
      setBusy(false)
    }
  }

  async function remove(item) {
    if (actionPending.current) {
      return
    }

    const confirmed = window.confirm(`“${item.title}” 피드백을 삭제할까요?`)

    if (!confirmed) {
      return
    }

    actionPending.current = true
    setBusy(true)
    setActionError('')
    setMessage('')

    try {
      await api.remove(item.id, adminView)

      if (editor?.item?.id === item.id) {
        setEditor(null)
      }

      setMessage('피드백을 삭제했어요.')
      refresh()
    } catch (error) {
      if (error.status === 401) {
        onUnauthorized?.()
      } else {
        setActionError(error.message)
      }
    } finally {
      actionPending.current = false
      setBusy(false)
    }
  }

  return {
    adminView,
    isAdmin,
    switchView,
    search,
    searchField,
    setSearchField,
    query,
    setQuery: updateQuery,
    searchError,
    applySearch,
    resetFilters,
    kind,
    setKind,
    status,
    setStatus,
    offset,
    setOffset,
    page,
    loading,
    refreshing,
    listError,
    actionError,
    setActionError,
    message,
    editor,
    setEditor,
    form,
    setForm,
    busy,
    targetLoading,
    openEditor,
    refresh,
    submit,
    remove,
    pageSize: PAGE_SIZE,
  }
}
