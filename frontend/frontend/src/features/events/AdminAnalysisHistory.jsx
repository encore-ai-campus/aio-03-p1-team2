import { useCallback, useMemo, useState } from 'react'
import AnalysisResults from '../../shared/components/AnalysisResults.jsx'
import ResourceState from '../../shared/components/ResourceState.jsx'
import { useApiResource } from '../../shared/hooks/useApiResource.js'
import { formatDate } from '../../shared/utils/formatDate.js'
import { createAdminVisionApi } from './adminVisionApi.js'

const statuses = {
  queued: '분석 대기',
  running: '분석 중',
  succeeded: '분석 완료',
  failed: '분석 실패',
}

function AnalysisDetail({ api, id }) {
  const load = useCallback((signal) => api.analysis(id, signal), [api, id])
  const resource = useApiResource(load)
  const record = resource.data
  return (
    <ResourceState loading={resource.loading} error={resource.error} onRetry={resource.refresh}>
      {record && (
        <div className="analysis-result" aria-label="Gemini 분석 상세">
          <p>
            {record.model_name} · {statuses[record.status]} · {formatDate(record.created_at)}
          </p>
          <p className="muted">
            {record.finished_at
              ? `완료 ${formatDate(record.finished_at)}`
              : '아직 완료되지 않았습니다.'}
            {record.latency_ms != null && ` · 소요 ${(record.latency_ms / 1000).toFixed(1)}초`}
          </p>
          {record.error_message && (
            <p role="alert" className="api-error">
              {record.error_message}
            </p>
          )}
          <AnalysisResults
            questions={record.questions}
            result={record.result}
            status={record.status}
          />
          <button type="button" className="button" onClick={resource.refresh}>
            분석 상세 새로고침
          </button>
        </div>
      )}
    </ResourceState>
  )
}

export default function AdminAnalysisHistory({ request, partId }) {
  const api = useMemo(() => createAdminVisionApi(request), [request])
  const load = useCallback((signal) => api.analyses(partId, signal), [api, partId])
  const resource = useApiResource(load)
  const [selectedId, setSelectedId] = useState(null)
  return (
    <section aria-label="Gemini 분석 이력">
      <div className="page-toolbar">
        <h3>사진 묶음 분석 이력</h3>
        <button
          type="button"
          className="button"
          onClick={resource.refresh}
          disabled={resource.loading}
        >
          분석 이력 새로고침
        </button>
      </div>
      <p className="muted">최근 최대 100건의 자동·수동 분석 기록입니다.</p>
      <ResourceState loading={resource.loading} error={resource.error} onRetry={resource.refresh}>
        {!resource.data?.length ? (
          <p>저장된 분석 이력이 없습니다.</p>
        ) : (
          <div className="vision-actions">
            {resource.data.map((record) => (
              <button
                type="button"
                className="button"
                key={record.id}
                aria-pressed={record.id === selectedId}
                onClick={() => setSelectedId(record.id)}
              >
                {record.origin === 'manual' ? '수동' : '자동'} · {statuses[record.status]} ·{' '}
                {formatDate(record.created_at)}
              </button>
            ))}
          </div>
        )}
      </ResourceState>
      {selectedId && <AnalysisDetail key={selectedId} api={api} id={selectedId} />}
    </section>
  )
}
