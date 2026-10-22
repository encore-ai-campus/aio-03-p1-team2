// React 팀원이 가져가서 사용하는 HTTP/SSE 연결 도구. UI 코드는 포함하지 않습니다.
export function createApi(baseUrl, getToken) {
  return async (path, options = {}) => {
    const token = await getToken();
    const response = await fetch(baseUrl + path, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
    });
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  };
}

// native EventSource는 Authorization 헤더를 설정할 수 없으므로 fetch로 SSE를 읽습니다.
// after는 사용자별로 보관한 마지막 알림 ID입니다. onNotice에서 저장하세요.
export function subscribeNotifications(baseUrl, getToken, onNotice, {
  after = 0, onError = console.error, onUnauthorized = () => {},
} = {}) {
  const controller = new AbortController();
  let cursor = after;
  (async () => {
    while (!controller.signal.aborted) {
      try {
        const token = await getToken();
        const response = await fetch(`${baseUrl}/api/notifications/stream?after=${cursor}`, {
          headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
        });
        if (response.status === 401) { onUnauthorized(); return; }
        if (!response.ok) throw new Error(`SSE ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let end;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const lines = block.split('\n');
              const data = lines.filter(x => x.startsWith('data:')).map(x => x.slice(5).trim()).join('\n');
              if (!data) continue;
              const notice = JSON.parse(data);
              if (notice.id <= cursor) continue;
              onNotice(notice);
              cursor = notice.id;
            }
          }
        } finally { reader.releaseLock(); }
      } catch (error) {
        if (controller.signal.aborted) return;
        onError(error);
      }
      // 연결 종료 후 토큰을 다시 얻고 마지막 알림 다음부터 재접속합니다.
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, 2000);
        controller.signal.addEventListener('abort', finish, { once: true });
        if (controller.signal.aborted) finish();
      });
    }
  })();
  return () => controller.abort();
}
