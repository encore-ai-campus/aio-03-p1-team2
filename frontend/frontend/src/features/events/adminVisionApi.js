export function createAdminVisionApi(request) {
  return {
    cameras: ({ userId = '', offset = 0 }, signal) => {
      const params = new URLSearchParams({ limit: '20', offset: String(offset) })
      if (userId) params.set('user_id', userId)
      return request(`/api/admin/cameras?${params}`, { signal })
    },
    events: (cameraId, signal) =>
      request(`/api/admin/cameras/${encodeURIComponent(cameraId)}/events?limit=100`, { signal }),
    analyses: (partId, signal) =>
      request(`/api/admin/parts/${encodeURIComponent(partId)}/analyses?limit=100`, { signal }),
    analysis: (analysisId, signal) =>
      request(`/api/admin/analyses/${encodeURIComponent(analysisId)}`, { signal }),
  }
}
