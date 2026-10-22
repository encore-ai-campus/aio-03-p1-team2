// 기존 미리보기 화면에 연결할 때 쓰는 변환 예제. React 원본은 변경하지 않습니다.
const kinds = {
  '오탐지 신고': 'false_positive', '미탐 신고': 'false_negative',
  '개선 의견': 'suggestion', '정확한 감지 평가': 'accurate',
};
const statuses = { '처리 대기': 'pending', '확인 중': 'in_progress', '처리 완료': 'resolved' };
const reverse = map => Object.fromEntries(Object.entries(map).map(([label, value]) => [value, label]));
const kindLabels = reverse(kinds);
const statusLabels = reverse(statuses);
const dateLabel = value => value ? new Intl.DateTimeFormat('ko-KR', {
  month: 'long', day: 'numeric', timeZone: 'Asia/Seoul',
}).format(new Date(value)) : '';
const profileView = item => ({ ...item, name: item.display_name ?? '' });
const feedbackView = item => ({
  ...item, kind: kindLabels[item.kind] ?? item.kind,
  status: statusLabels[item.status] ?? item.status,
  user: item.user_id, date: dateLabel(item.created_at),
});
const feedbackBody = draft => ({
  title: draft.title, kind: kinds[draft.kind] ?? draft.kind, content: draft.content,
});

export function createWebApi(baseUrl, getToken) {
  async function request(path, { method = 'GET', body, binary = false } = {}) {
    const token = await getToken();
    const response = await fetch(baseUrl + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const error = new Error(`${response.status}: ${await response.text()}`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : binary ? response.blob() : response.json();
  }
  const page = async (path, convert, query = {}) => {
    const result = await request(path + '?' + new URLSearchParams(query));
    return { ...result, items: result.items.map(convert) };
  };
  return {
    login: (email, password) => request('/api/auth/login', { method: 'POST', body: { email, password } }),
    register: (email, password) => request('/api/auth/register', { method: 'POST', body: { email, password } }),
    me: () => request('/api/auth/me'),
    profile: async () => profileView(await request('/api/users/me')),
    saveProfile: async draft => profileView(await request('/api/users/me', {
      method: 'PATCH', body: { display_name: draft.name },
    })),
    feedback: (admin = false, query = {}) => page(admin ? '/api/admin/feedback' : '/api/feedback', feedbackView, query),
    saveFeedback: async draft => feedbackView(await request(
      draft.id ? `/api/feedback/${draft.id}` : '/api/feedback',
      { method: draft.id ? 'PATCH' : 'POST', body: feedbackBody(draft) },
    )),
    deleteFeedback: (id, admin = false) => request(
      `${admin ? '/api/admin/feedback' : '/api/feedback'}/${id}`, { method: 'DELETE' },
    ),
    updateFeedbackStatus: async (id, status) => feedbackView(await request(
      `/api/admin/feedback/${id}`, { method: 'PATCH', body: { status: statuses[status] ?? status } },
    )),
    accounts: (query = {}) => page('/api/admin/users', item => ({
      ...profileView(item),
      role: item.role === 'admin' ? '관리자' : '일반 사용자',
      status: item.status === 'active' ? '활성' : '비활성',
      lastSeen: dateLabel(item.last_sign_in_at) || '접속 기록 없음',
    }), query),
    saveAccount: draft => request(`/api/admin/users/${draft.id}`, {
      method: 'PATCH', body: {
        display_name: draft.name, role: draft.role === '관리자' ? 'admin' : 'user',
        status: draft.status === '활성' ? 'active' : 'inactive',
      },
    }),
    auditLogs: (query = {}) => request('/api/admin/audit-logs?' + new URLSearchParams(query)),
    adminCameras: (query = {}) => request('/api/admin/cameras?' + new URLSearchParams(query)),
    adminCameraEvents: (id, query = {}) => request(`/api/admin/cameras/${id}/events?` + new URLSearchParams(query)),
    adminEvent: id => request(`/api/admin/events/${id}`),
    adminEventParts: (id, query = {}) => request(`/api/admin/events/${id}/parts?` + new URLSearchParams(query)),
    adminPart: id => request(`/api/admin/parts/${id}`),
    adminPhoto: id => request(`/api/admin/photos/${id}/content`, { binary: true }),
    adminPartAnalyses: (id, query = {}) => request(`/api/admin/parts/${id}/analyses?` + new URLSearchParams(query)),
    adminAnalysis: id => request(`/api/admin/analyses/${id}`),
    adminEventAnalysis: id => request(`/api/admin/events/${id}/analysis`),
  };
}
