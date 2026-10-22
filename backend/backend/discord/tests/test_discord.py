"""No real OAuth, Redis, Supabase writes, or Discord messages."""
import asyncio
import base64
import hashlib
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from backend.discord.config import DiscordSettings
from backend.discord.oauth import DiscordOAuth
from backend.discord.repository import discord_identity
from backend.discord.router import router
from backend.discord.sender import DeliveryError, DiscordBot, DiscordSender, notification_text

USER = 'f3cb35c7-ef8f-4817-930b-2f94787120da'
OTHER = '724ca126-d233-4bca-8a8a-335a5296aa07'
DISCORD = '1561992883345817622'
AUTH_USER = {'id': USER, 'identities': [{'id': DISCORD, 'identity_id': OTHER,
    'provider': 'discord', 'identity_data': {'full_name': '연결 사용자'}}]}


class MemoryRedis:
    def __init__(self): self.values = {}
    async def set(self, key, value, ex, nx=False):
        if nx and key in self.values: return False
        self.values[key] = value
        return True
    async def get(self, key): return self.values.get(key)
    async def getdel(self, key): return self.values.pop(key, None)


def oauth_fixture(handler):
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    resources = SimpleNamespace(http=http,server=object(),settings=SimpleNamespace(
        supabase_url='https://project.supabase.co',supabase_publishable_key='public-key'))
    repo = SimpleNamespace(sync=AsyncMock(return_value={}),preference=AsyncMock(),remove=AsyncMock())
    oauth = DiscordOAuth(resources,DiscordSettings('https://app.example',True),MemoryRedis(),repo)
    return oauth,http,repo


def test_pkce_single_use_and_identity_source(monkeypatch):
    async def scenario():
        requests = []
        def handler(request):
            requests.append(request)
            if request.url.path.endswith('/token'):
                return httpx.Response(200,json={'access_token':'safe-access','refresh_token':'refresh','expires_in':3600})
            return httpx.Response(200,json=AUTH_USER)
        oauth,http,repo = oauth_fixture(handler)
        monkeypatch.setattr('backend.discord.oauth.ProfileRepository',lambda _:SimpleNamespace(get_or_create=AsyncMock(return_value={'status':'active'})))
        async with http:
            start = await oauth.start('login')
            params = parse_qs(urlsplit(start['url']).query)
            stored = json.loads(await oauth.redis.get('notecam:discord:oauth:'+start['flow_id']))
            expected = base64.urlsafe_b64encode(hashlib.sha256(stored['verifier'].encode()).digest()).decode().rstrip('=')
            assert params['code_challenge'] == [expected]
            assert params['redirect_to'] == ['https://app.example/auth/discord/callback']
            assert stored.get('access_token') is None
            result = await oauth.complete(start['flow_id'],'auth-code')
            assert result['tokens']['access_token'] == 'safe-access'
            repo.sync.assert_awaited_once_with(AUTH_USER)
            assert json.loads(requests[0].content)['code_verifier'] == stored['verifier']
            with pytest.raises(HTTPException) as error: await oauth.complete(start['flow_id'],'auth-code')
            assert error.value.status_code == 400
    asyncio.run(scenario())
    assert discord_identity({'user_metadata':{'provider_id':DISCORD}}) is None
    assert discord_identity(AUTH_USER)[0] == DISCORD


def test_link_requires_original_user_and_rejects_substituted_identity(monkeypatch):
    async def scenario():
        def handler(request):
            if request.url.path.endswith('/authorize'): return httpx.Response(200,json={'url':'https://discord.com/oauth2/authorize'})
            if request.url.path.endswith('/token'): return httpx.Response(200,json={'access_token':'token','refresh_token':'refresh','expires_in':60})
            return httpx.Response(200,json={**AUTH_USER,'id':OTHER})
        oauth,http,repo = oauth_fixture(handler)
        async with http:
            start = await oauth.start('link',user_id=USER,token='user-token')
            with pytest.raises(HTTPException) as wrong: await oauth.complete(start['flow_id'],'code',user_id=OTHER)
            assert wrong.value.status_code == 403
            assert await oauth.redis.get('notecam:discord:oauth:'+start['flow_id'])
            with pytest.raises(HTTPException) as substituted: await oauth.complete(start['flow_id'],'code',user_id=USER)
            assert substituted.value.status_code == 403
            repo.sync.assert_not_awaited()
    asyncio.run(scenario())


def test_disabled_expired_and_unsafe_redirect():
    async def scenario():
        oauth,http,_ = oauth_fixture(lambda _:httpx.Response(200,json={'url':'https://attacker.example/'}))
        async with http:
            with pytest.raises(HTTPException): await oauth.complete('x'*43,'code')
            with pytest.raises(HTTPException) as bad: await oauth.start('link',user_id=USER,token='token')
            assert bad.value.status_code == 502
            oauth.config = DiscordSettings()
            with pytest.raises(HTTPException) as disabled: await oauth.start('login')
            assert disabled.value.status_code == 503
    asyncio.run(scenario())
    assert 'do-not-display' not in repr(DiscordSettings(bot_token='do-not-display'))
    for url in ['http://example.com','https://user:password@example.com','https://example.com/?next=evil']:
        with pytest.raises(ValueError): DiscordSettings(url,True).validate()


def test_last_login_identity_cannot_be_unlinked():
    async def scenario():
        oauth,http,repo = oauth_fixture(lambda _:httpx.Response(200,json=AUTH_USER))
        async with http:
            with pytest.raises(HTTPException) as blocked: await oauth.unlink(USER,'token')
            assert blocked.value.status_code == 409
            repo.remove.assert_not_awaited()
    asyncio.run(scenario())


def test_bot_mentions_nonce_and_rate_limit():
    async def scenario():
        requests = []
        def handler(request):
            requests.append(request)
            if len(requests) == 2: return httpx.Response(429,json={'retry_after':1.2,'global':True})
            return httpx.Response(200,json={'id':DISCORD})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            bot = DiscordBot(http,'private-bot-token')
            assert await bot.send(DISCORD,'@everyone',notification_id=123) == DISCORD
            payload = json.loads(requests[0].content)
            assert payload['allowed_mentions'] == {'parse':[]}
            assert payload['nonce'] == '123' and payload['enforce_nonce'] is True
            assert requests[0].headers['Authorization'] == 'Bot private-bot-token'
            with pytest.raises(DeliveryError) as limited: await bot.send(DISCORD,'test')
            assert limited.value.retry_after == 2
            with pytest.raises(DeliveryError): await bot.send(DISCORD,'test')
            assert len(requests) == 2
    asyncio.run(scenario())


@pytest.mark.parametrize('status,delay,blocked',[(403,None,True),(401,None,False),(500,30,False)])
def test_safe_discord_errors(status,delay,blocked):
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _:httpx.Response(status,json={'message':'raw-secret-response'}))) as http:
            bot = DiscordBot(http,'secret')
            with pytest.raises(DeliveryError) as error: await bot.send(DISCORD,'test')
            assert error.value.retry_after == delay and error.value.blocked == blocked
            assert 'raw-secret' not in str(error.value)
    asyncio.run(scenario())


def job_fixture():
    return {'notification_id':1,'claim_token':OTHER,'owner_id':USER,'discord_user_id':DISCORD,
        'event_id':'a'*32+'_e000001','verdict':'confirmed','message':'사건 확인',
        'created_at':'2026-10-20T00:00:00Z','detected_at':'2026-10-20T00:00:00Z'}


@pytest.mark.parametrize('mode',['sent','disabled','blocked','retry','cancelled'])
def test_sender_outcomes(mode):
    async def scenario():
        job = job_fixture()
        repo = SimpleNamespace(claim=AsyncMock(return_value=job),finish=AsyncMock(),preference=AsyncMock(),error=AsyncMock(),
            recipient=AsyncMock(return_value=None if mode=='disabled' else {'dm_channel_id':DISCORD}))
        bot = SimpleNamespace(next_request_at=0,send=AsyncMock(return_value=DISCORD))
        if mode=='blocked': bot.send.side_effect=DeliveryError('DM 차단',blocked=True)
        if mode=='retry': bot.send.side_effect=DeliveryError('일시적 오류',retry_after=30)
        if mode=='cancelled': bot.send.side_effect=asyncio.CancelledError()
        sender = DiscordSender(repo,bot,'https://app.example')
        if mode=='cancelled':
            with pytest.raises(asyncio.CancelledError): await sender.process_one()
            repo.finish.assert_not_awaited()
        else:
            assert await sender.process_one()
            status = repo.finish.await_args.args[1]
            assert status == {'sent':'sent','disabled':'skipped','blocked':'failed','retry':'failed'}[mode]
            if mode=='disabled': bot.send.assert_not_awaited()
            if mode=='blocked': repo.preference.assert_awaited_once_with(USER,False)
            if mode=='retry': assert repo.finish.await_args.kwargs['retry_after']==30
    asyncio.run(scenario())
    assert '2026-10-20 09:00:00 KST' in notification_text(job_fixture(),'https://app.example')


def test_independent_router_redacts_auth_validation():
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        response = client.post('/api/discord/start',json={'intent':'login'})
        assert response.status_code == 503
        response = client.post('/api/discord/complete',json={'flow_id':'private-flow','code':'secret-code','extra':'private-extra'})
        assert response.status_code == 422
        assert 'private-flow' not in response.text and 'secret-code' not in response.text and 'private-extra' not in response.text


def test_connection_api_contract_and_explicit_test_dm():
    from backend.common.dependencies import Principal, get_user
    from fastapi import Request

    state = {'linked':True,'discord_name':'연결 사용자','notifications_enabled':False,
             'dm_verified':False,'can_unlink':True,'last_error':None,'bot_ready':True,'auth_ready':True}
    row = {'discord_user_id':DISCORD}
    repo = SimpleNamespace(connection=AsyncMock(return_value=row),verified=AsyncMock(),
        preference=AsyncMock(),error=AsyncMock())
    bot = SimpleNamespace(open_dm=AsyncMock(return_value=DISCORD),send=AsyncMock(return_value=DISCORD))
    oauth = SimpleNamespace(config=SimpleNamespace(bot_token='private'),redis=MemoryRedis(),repository=repo,bot=bot,
        connection=AsyncMock(return_value=state),unlink=AsyncMock())
    app = FastAPI(); app.include_router(router); app.state.discord=oauth
    async def fake_user(request: Request):
        request.state.supabase_user_token='owner-session'
        return Principal(USER,'user',time.time()+3600)
    app.dependency_overrides[get_user]=fake_user
    with TestClient(app) as client:
        result=client.get('/api/discord/connection')
        assert result.status_code==200 and result.json()==state
        assert result.headers['cache-control']=='no-store'
        assert client.patch('/api/discord/connection',json={'notifications_enabled':'true'}).status_code==422
        assert client.patch('/api/discord/connection',json={'notifications_enabled':False,'user_id':OTHER}).status_code==422
        assert client.patch('/api/discord/connection',json={'notifications_enabled':False}).status_code==200
        repo.preference.assert_awaited_once_with(USER,False)
        assert client.post('/api/discord/connection/test').status_code==200
        bot.open_dm.assert_awaited_once_with(DISCORD)
        repo.verified.assert_awaited_once_with(USER,DISCORD,DISCORD)
        assert client.post('/api/discord/connection/test').status_code==429
        assert bot.send.await_count==1
        assert client.delete('/api/discord/connection').status_code==204
        oauth.unlink.assert_awaited_once_with(USER,'owner-session')
    app.dependency_overrides.clear()
    with TestClient(app) as client:
        assert client.post('/api/discord/connection/test').status_code==401
        assert bot.send.await_count==1


def test_sender_recovers_without_redis_and_closes_subscription(monkeypatch):
    async def scenario():
        repo=SimpleNamespace(claim=AsyncMock(return_value=None))
        bot=SimpleNamespace(next_request_at=0)
        sender=DiscordSender(repo,bot,'https://app.example')
        slept=asyncio.Event()
        async def sleep(_):
            slept.set()
            await asyncio.Event().wait()
        monkeypatch.setattr('backend.discord.sender.asyncio.sleep',sleep)
        task=asyncio.create_task(sender.run())
        await asyncio.wait_for(slept.wait(),1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError): await task
        repo.claim.assert_awaited_once()

        entered=asyncio.Event()
        async def message(**_):
            entered.set(); await asyncio.Event().wait()
        subscription=SimpleNamespace(psubscribe=AsyncMock(),get_message=message,aclose=AsyncMock())
        sender.redis=SimpleNamespace(pubsub=lambda:subscription)
        task=asyncio.create_task(sender.run())
        await asyncio.wait_for(entered.wait(),1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError): await task
        subscription.psubscribe.assert_awaited_once_with('notecam:notifications:*')
        subscription.aclose.assert_awaited_once()
    asyncio.run(scenario())


@pytest.mark.parametrize('startup_error',[False,True])
def test_feature_lifespan_owns_and_closes_redis(monkeypatch,startup_error):
    import importlib
    from unittest.mock import MagicMock
    module=importlib.import_module('backend.discord.router')
    async def scenario():
        redis=SimpleNamespace(aclose=AsyncMock())
        monkeypatch.setattr(module.Redis,'from_url',lambda *a,**k:redis)
        execute=AsyncMock(side_effect=HTTPException(503,'스키마 없음') if startup_error else None)
        monkeypatch.setattr(module,'DiscordRepository',lambda _:SimpleNamespace(execute=execute))
        resources=SimpleNamespace(settings=SimpleNamespace(redis_url='rediss://example.invalid'),server=MagicMock(),http=object())
        app=FastAPI();app.state.supabase=resources
        if startup_error:
            with pytest.raises(HTTPException):
                async with module.lifespan(app,DiscordSettings('https://app.example',True)):
                    pytest.fail('startup error must not yield')
        else:
            async with module.lifespan(app,DiscordSettings('https://app.example',True)):
                assert app.state.discord.resources is resources
                redis.aclose.assert_not_awaited()
        redis.aclose.assert_awaited_once()
        assert app.state.discord is None
    asyncio.run(scenario())
