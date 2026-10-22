"""Discord 로그인·연결 API와 서버 수명에 묶인 발송 작업."""

import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from redis.asyncio import Redis
from redis.exceptions import RedisError

from backend.common.dependencies import User, bearer, get_user_context
from backend.login.router import AuthRoute
from .config import DiscordSettings
from .oauth import DiscordOAuth
from .repository import DiscordRepository
from .schemas import NotificationPreference, OAuthComplete, OAuthStart
from .sender import DeliveryError, DiscordBot, DiscordSender

router = APIRouter(prefix="/api/discord", tags=["Discord"], route_class=AuthRoute)


@asynccontextmanager
async def lifespan(app, config=None):
    """main의 Supabase lifespan 안에 연결할 진입점. 기본적으로 발송은 꺼져 있습니다."""
    resources = app.state.supabase
    config = config or DiscordSettings.from_env()
    config.validate()
    redis = Redis.from_url(resources.settings.redis_url, decode_responses=True,
                           socket_connect_timeout=3, socket_timeout=15) if resources.settings.redis_url else None
    repository = DiscordRepository(resources.server)
    oauth = DiscordOAuth(resources, config, redis, repository)
    oauth.bot = DiscordBot(resources.http, config.bot_token)
    app.state.discord = oauth
    task = None
    try:
        if config.auth_enabled or config.sender_enabled:
            await repository.execute(resources.server.table("discord_connections").select("user_id").limit(0))
        if config.sender_enabled:
            await repository.execute(resources.server.table("discord_deliveries").select("notification_id").limit(0))
            task = asyncio.create_task(DiscordSender(repository, oauth.bot, config.app_url, redis).run())
        yield
    finally:
        try:
            if task is not None:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
        finally:
            app.state.discord = None
            if redis is not None:
                await redis.aclose()


def service(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    value = getattr(request.app.state, "discord", None)
    if value is None:
        raise HTTPException(503, "Discord 기능이 아직 연결되지 않았습니다.")
    return value


@router.get("/config")
async def config(request: Request, response: Response):
    oauth = service(request, response)
    return {"auth_ready": oauth.config.auth_enabled and oauth.redis is not None}


@router.post("/start")
async def start(payload: OAuthStart, request: Request, response: Response, credentials=Depends(bearer)):
    oauth = service(request, response)
    user = await get_user_context(request, credentials) if payload.intent == "link" else None
    token = credentials.credentials if user else None
    return await oauth.start(payload.intent, user_id=user.id if user else None, token=token)


@router.post("/complete")
async def complete(payload: OAuthComplete, request: Request, response: Response, credentials=Depends(bearer)):
    oauth = service(request, response)
    user = await get_user_context(request, credentials) if credentials else None
    return await oauth.complete(payload.flow_id.get_secret_value(), payload.code.get_secret_value(),
                                user_id=user.id if user else None)


@router.get("/connection")
async def connection(request: Request, response: Response, user: User):
    return await service(request, response).connection(user.id, request.state.supabase_user_token)


@router.patch("/connection")
async def preference(payload: NotificationPreference, request: Request, response: Response, user: User):
    oauth = service(request, response)
    token = request.state.supabase_user_token
    await oauth.connection(user.id, token)
    await oauth.repository.preference(user.id, payload.notifications_enabled)
    return await oauth.connection(user.id, token)


@router.post("/connection/test")
async def test_dm(request: Request, response: Response, user: User):
    oauth = service(request, response)
    if not oauth.config.bot_token or oauth.redis is None:
        raise HTTPException(503, "Discord 봇 또는 테스트 발송 제한 설정이 준비되지 않았습니다.")
    await oauth.connection(user.id, request.state.supabase_user_token)
    row = await oauth.repository.connection(user.id)
    if not row:
        raise HTTPException(409, "Discord 계정을 먼저 연결하세요.")
    try:
        allowed = await oauth.redis.set("notecam:discord:test:" + user.id, "1", nx=True, ex=30)
    except RedisError:
        raise HTTPException(503, "테스트 발송 설정을 확인할 수 없습니다.") from None
    if not allowed:
        raise HTTPException(429, "테스트 DM은 30초 후 다시 보낼 수 있습니다.")
    try:
        channel = await oauth.bot.open_dm(row["discord_user_id"])
        await oauth.bot.send(channel, "NoteCam 테스트 알림입니다. 앱에서 ‘Discord 알림 받기’를 켜면 새 사건 알림을 보내드립니다.")
    except DeliveryError as exc:
        await oauth.repository.error(user.id, str(exc))
        raise HTTPException(429 if exc.retry_after else 409, str(exc)) from None
    await oauth.repository.verified(user.id, row["discord_user_id"], channel)
    return await oauth.connection(user.id, request.state.supabase_user_token)


@router.delete("/connection", status_code=204)
async def unlink(request: Request, response: Response, user: User):
    await service(request, response).unlink(user.id, request.state.supabase_user_token)
