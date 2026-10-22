import { useCallback, useMemo, useState } from 'react'
import PageHeading from '../../shared/components/PageHeading.jsx'
import ResourceState from '../../shared/components/ResourceState.jsx'
import { AnalysisSummary } from '../../shared/components/AnalysisResults.jsx'
import { useApiResource } from '../../shared/hooks/useApiResource.js'
import { createAdminVisionApi } from './adminVisionApi.js'
import { createAccountsApi } from '../accounts/accountsApi.js'
import EventDetailDialog from './EventDetailDialog.jsx'
import './events.css'

function CameraEvents({ camera, api, request }) {
  const load = useCallback((signal) => api.events(camera.id, signal), [api, camera.id])
  const resource = useApiResource(load)
  const [eventId, setEventId] = useState(null)
  return (
    <section className="dashboard-panel admin-camera-events" aria-label="카메라 사건 기록">
      <div className="page-toolbar">
        <div>
          <h2>{camera.name} 사건 기록</h2>
          <p className="muted">최근 최대 100건 · 촬영 중인 사건도 포함합니다.</p>
        </div>
        <button
          type="button"
          className="button"
          onClick={resource.refresh}
          disabled={resource.loading}
        >
          사건 새로고침
        </button>
      </div>
      <ResourceState loading={resource.loading} error={resource.error} onRetry={resource.refresh}>
        {!resource.data?.length ? (
          <p className="empty-state">표시할 사건이 없습니다.</p>
        ) : (
          <div className="event-list">
            {resource.data.map((event) => (
              <button
                type="button"
                className="event motion-event"
                key={event.id}
                aria-label={`${event.id} 사건 상세 보기`}
                aria-haspopup="dialog"
                onClick={() => setEventId(event.id)}
              >
                <AnalysisSummary
                  result={event.result}
                  status={event.analysis_status}
                  detectedAt={event.detected_at}
                />
              </button>
            ))}
          </div>
        )}
      </ResourceState>
      {eventId && (
        <EventDetailDialog
          key={eventId}
          request={request}
          apiPrefix="/api/admin"
          eventId={eventId}
          onClose={() => setEventId(null)}
        />
      )}
    </section>
  )
}

export default function AdminCameraPage({ request, onUnauthorized }) {
  // 사진 다운로드와 상세 조회에도 동일한 인증 만료 처리를 적용합니다.
  const adminRequest = useCallback(
    async (path, options) => {
      try {
        return await request(path, options)
      } catch (error) {
        if (!options?.signal?.aborted && error.status === 401) onUnauthorized?.()
        throw error
      }
    },
    [request, onUnauthorized],
  )
  const api = useMemo(() => createAdminVisionApi(adminRequest), [adminRequest])
  const accountsApi = useMemo(() => createAccountsApi(adminRequest), [adminRequest])
  const loadUsers = useCallback(
    async (signal) => {
      const items = []
      let userOffset = 0
      while (!signal.aborted) {
        const page = await accountsApi.list({ limit: 100, offset: userOffset }, signal)
        items.push(...page.items)
        userOffset += 100
        if (!page.items.length || userOffset >= page.total) break
      }
      return items
    },
    [accountsApi],
  )
  const users = useApiResource(loadUsers)
  const emails = useMemo(
    () => new Map(users.data?.map((user) => [user.id, user.email]) ?? []),
    [users.data],
  )
  const [userInput, setUserInput] = useState('')
  const [userId, setUserId] = useState('')
  const [offset, setOffset] = useState(0)
  const [camera, setCamera] = useState(null)
  const load = useCallback(
    (signal) => api.cameras({ userId, offset }, signal),
    [api, userId, offset],
  )
  const resource = useApiResource(load)
  function move(next) {
    setCamera(null)
    setOffset(next)
  }
  return (
    <>
      <PageHeading
        title="카메라 기록"
        description="사용자의 카메라와 촬영 사진, Gemini 분석 기록을 조회해요."
      />
      <form
        className="page-toolbar admin-camera-filter"
        onSubmit={(event) => {
          event.preventDefault()
          setCamera(null)
          setOffset(0)
          setUserId(userInput.trim())
          resource.refresh()
        }}
      >
        <label>
          사용자 선택 (이메일 · 사용자 ID)
          <select
            aria-label="카메라 소유 사용자 선택"
            value={userInput}
            onChange={(event) => setUserInput(event.target.value)}
            disabled={users.loading}
          >
            <option value="">전체 사용자</option>
            {users.data?.map((user) => (
              <option key={user.id} value={user.id}>
                {user.email || '이메일 없음'} · {user.id}
              </option>
            ))}
          </select>
        </label>
        <button className="button" type="submit">
          카메라 조회
        </button>
      </form>
      {users.loading && (
        <p className="muted" role="status">
          사용자 이메일을 조회하고 있어요.
        </p>
      )}
      {users.error && (
        <div className="api-error" role="alert">
          사용자 정보를 불러오지 못했어요. 카메라 기록은 계속 조회할 수 있습니다.
          <button type="button" className="button" onClick={users.refresh}>
            사용자 다시 조회
          </button>
        </div>
      )}
      <ResourceState loading={resource.loading} error={resource.error} onRetry={resource.refresh}>
        <section className="dashboard-panel table-panel" aria-label="관리자 카메라 목록">
          <table>
            <thead>
              <tr>
                <th>카메라</th>
                <th>소유자 이메일</th>
                <th>소유 사용자 ID</th>
                <th>기록</th>
              </tr>
            </thead>
            <tbody>
              {resource.data?.map((item) => (
                <tr key={item.id}>
                  <td>{item.name}</td>
                  <td>
                    {users.loading ? '조회 중…' : emails.get(item.owner_id) || '이메일 확인 불가'}
                  </td>
                  <td>{item.owner_id}</td>
                  <td>
                    <button
                      type="button"
                      className="button"
                      aria-label={`${item.name} 기록 보기`}
                      aria-pressed={camera?.id === item.id}
                      onClick={() => setCamera(item)}
                    >
                      기록 보기
                    </button>
                  </td>
                </tr>
              ))}
              {!resource.data?.length && (
                <tr>
                  <td colSpan={4}>조회된 카메라가 없습니다.</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </ResourceState>
      <div className="page-toolbar" role="group" aria-label="카메라 페이지 이동">
        <button
          type="button"
          className="button"
          disabled={resource.loading || offset === 0}
          onClick={() => move(Math.max(0, offset - 20))}
        >
          이전 카메라
        </button>
        <span>{offset / 20 + 1}페이지</span>
        <button
          type="button"
          className="button"
          disabled={resource.loading || Boolean(resource.error) || resource.data?.length !== 20}
          onClick={() => move(offset + 20)}
        >
          다음 카메라
        </button>
      </div>
      {camera && <CameraEvents key={camera.id} camera={camera} api={api} request={adminRequest} />}
    </>
  )
}
