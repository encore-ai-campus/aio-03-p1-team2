"""실제 HTTP SSE의 인증, 사용자 채널 분리, 재연결과 종료를 검증합니다."""
import asyncio
import json
import socket
import threading
import time
from types import SimpleNamespace

import httpx
import uvicorn


def test_real_http_sse_reconnect(api_environment):
    env = api_environment
    headers, owner = env.headers()
    other_headers, other = env.headers(seconds=1)
    event_id = 'a' * 32 + '_e000001'
    subscriptions = []

    class Subscription:
        def __init__(self):
            self.acknowledged = False
            self.sent = False
            self.closed = False
            subscriptions.append(self)

        async def subscribe(self, channel):
            self.channel = channel

        async def get_message(self, **kwargs):
            if not self.acknowledged:
                self.acknowledged = True
                return {'type': 'subscribe', 'channel': self.channel}
            if self.channel.endswith(owner) and not self.sent:
                self.sent = True
                return {'type': 'message', 'data': json.dumps({'notification_id': 1, 'event_id': event_id})}
            await asyncio.sleep(min(kwargs.get('timeout', 1), .02))

        async def aclose(self):
            self.closed = True

    async def resources_close():
        pass

    def notifications(request):
        assert request.url.path == '/rest/v1/notifications'
        assert request.url.params['owner_id'] in {'eq.' + owner, 'eq.' + other}
        return httpx.Response(200, json=[], headers={'Content-Range': '*/0'})

    env.rest_handler.append(notifications)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); sock.listen()
        server = uvicorn.Server(uvicorn.Config(env.app, log_level='error', access_log=False))
        thread = threading.Thread(target=server.run, kwargs={'sockets': [sock]}, daemon=True)
        thread.start()
        try:
            deadline = time.monotonic() + 5
            while not server.started:
                assert thread.is_alive() and time.monotonic() < deadline
                time.sleep(.01)
            env.app.state.notification_redis = SimpleNamespace(pubsub=Subscription, aclose=resources_close)
            with httpx.Client(base_url=f'http://127.0.0.1:{sock.getsockname()[1]}', timeout=3, trust_env=False) as client:
                assert client.get('/api/notifications/stream').status_code == 401
                for _ in range(2):
                    with client.stream('GET', '/api/notifications/stream', headers=headers) as response:
                        assert response.status_code == 200
                        lines = []
                        for line in response.iter_lines():
                            lines.append(line)
                            if line.startswith('data:') and 'notification_id' in line:
                                assert json.loads(line[5:]) == {'notification_id': 1, 'event_id': event_id}
                                break
                        assert 'event: ready' in lines
                        assert 'event: notification.created' in lines
                with client.stream('GET', '/api/notifications/stream', headers=other_headers) as response:
                    lines = list(response.iter_lines())
                    assert 'event: ready' in lines
                    assert not any('notification_id' in line for line in lines)
                assert client.get('/api/notifications/stream', headers={'Authorization':'Bearer invalid'}).status_code == 401
                # SSE는 연결당 한 번만 DB 준비를 확인하며 DB를 주기 조회하지 않습니다.
                assert len([r for r in env.seen if r.url.path == '/rest/v1/notifications']) == 3
        finally:
            server.should_exit = True
            thread.join(timeout=5)
            assert not thread.is_alive()
        assert all(s.closed for s in subscriptions)
