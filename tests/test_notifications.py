import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import httpx
import pytest
from redis.exceptions import ConnectionError

from backend.common.supabase import create_sync_supabase_client
from backend.config import Settings
from backend.notifications.realtime import NotificationPublisher
from backend.notifications.router import stream
from backend.vision.repositories.motion_repository import MotionRepository


@pytest.mark.parametrize('cancel_during', ['subscribe', 'acknowledgement'])
def test_cancelled_subscription_preparation_closes_redis_and_propagates_cancellation(cancel_during):
    async def check():
        waiting = asyncio.Event()

        async def blocked(*args, **kwargs):
            waiting.set()
            await asyncio.Future()

        subscription = SimpleNamespace(
            subscribe=AsyncMock(), get_message=AsyncMock(), aclose=AsyncMock(),
        )
        if cancel_during == 'subscribe':
            subscription.subscribe = blocked
        else:
            subscription.get_message = blocked
        request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
            notification_redis=SimpleNamespace(pubsub=lambda: subscription),
        )))
        user = SimpleNamespace(id='11111111-1111-4111-8111-111111111111')
        repository = SimpleNamespace(notifications_latest=AsyncMock(return_value={'items': []}))
        with patch('backend.notifications.router.NotificationRepository', return_value=repository), \
             patch('backend.notifications.router.get_supabase', return_value=SimpleNamespace(server=Mock())):
            task = asyncio.create_task(stream(request, user))
            await asyncio.wait_for(waiting.wait(), timeout=1)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        subscription.aclose.assert_awaited_once()

    asyncio.run(check())


def test_publisher_sends_only_ids_to_owner_channel_and_failure_keeps_saved_notice():
    notice = {'id': 42, 'event_id': 'a'*32+'_e000001', 'owner_id': 'owner', 'message': 'private summary'}
    publisher = NotificationPublisher('')
    publisher.client = Mock()
    publisher.publish(notice)
    channel, body = publisher.client.publish.call_args.args
    assert channel == 'notecam:notifications:owner'
    assert json.loads(body) == {'notification_id':42,'event_id':notice['event_id']}
    publisher.client.publish.side_effect = ConnectionError('unavailable')
    publisher.publish(notice)  # Must not change the saved result or propagate Redis failure.
    assert notice['id'] == 42
    publisher.publish(None)
    assert publisher.client.publish.call_count == 2
    publisher.close()
    publisher.client.close.assert_called_once()


def test_completion_uses_atomic_rpc_for_part_and_event():
    calls=[]
    def handler(request):
        assert request.url.path == '/rest/v1/rpc/notification_finish_analysis'
        calls.append(json.loads(request.content))
        return httpx.Response(200,json={'id':42,'owner_id':'owner','event_id':'event'})
    settings=Settings(supabase_url='https://project.example.com',supabase_publishable_key='test-public',supabase_secret_key='test-service')
    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        repo=MotionRepository(create_sync_supabase_client(settings,http))
        result={'items':[{'verdict':'confirmed'}]}
        assert repo.finish_analysis('analysis',result,None,10)['id']==42
        assert repo.finish_event_analysis('synthesis',None,'provider failed',20)['id']==42
    assert calls==[
        {'p_analysis_id':'analysis','p_is_event':False,'p_result':result,'p_error':None,'p_latency_ms':10},
        {'p_analysis_id':'synthesis','p_is_event':True,'p_result':None,'p_error':'provider failed','p_latency_ms':20},
    ]
