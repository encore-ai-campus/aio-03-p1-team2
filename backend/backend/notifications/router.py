"""알림 조회, 읽음 처리, SSE 라우터."""

import asyncio
import time
from fastapi import APIRouter, Request, Query, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import ValidationError
from redis.exceptions import RedisError
from backend.common.dependencies import User, get_supabase
from backend.notifications.repositories.repository import NotificationRepository
from backend.notifications.schemas import NotificationResponse, NotificationSignal
from backend.notifications.realtime import user_channel
from backend.notifications.services.notification_service import public_notice

router = APIRouter(prefix="/api/notifications", tags=["알림"])


@router.get("")
async def notifications(
    request: Request,
    user: User,
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    page = await NotificationRepository(get_supabase(request).server).notifications_latest(user.id, limit, offset)
    page["items"] = [public_notice(x) for x in page["items"]]
    return page


@router.patch("/{notification_id}/read", response_model=NotificationResponse)
async def read(notification_id: int, request: Request, user: User):
    return await NotificationRepository(get_supabase(request).server).mark_read(user.id, notification_id)


@router.get("/stream")
async def stream(
    request: Request,
    user: User,
):
    repository = NotificationRepository(get_supabase(request).server)
    await repository.notifications_latest(user.id, 1, 0)
    redis = request.app.state.notification_redis
    if redis is None:
        raise HTTPException(503, "실시간 알림 연결이 설정되지 않았습니다. DB 알림 조회는 계속 사용할 수 있습니다.")
    subscription = redis.pubsub()
    channel = user_channel(user.id)
    try:
        async with asyncio.timeout(5):
            await subscription.subscribe(channel)
            acknowledgement = await subscription.get_message(timeout=5)
            if not acknowledgement or acknowledgement.get("type") != "subscribe" or acknowledgement.get("channel") != channel:
                raise TimeoutError("subscription not acknowledged")
    except asyncio.CancelledError:
        await subscription.aclose()
        raise
    except (RedisError, TimeoutError):
        await subscription.aclose()
        raise HTTPException(503, "실시간 알림에 연결하지 못했습니다. DB 알림 조회는 계속 사용할 수 있습니다.") from None

    async def generate():
        last_ping = time.monotonic()
        try:
            yield 'event: ready\ndata: {}\n\n'
            while not await request.is_disconnected() and time.time() < user.expires_at:
                message = await subscription.get_message(ignore_subscribe_messages=True, timeout=min(1, max(0, user.expires_at-time.time())))
                if message and message.get("type") == "message":
                    try:
                        signal = NotificationSignal.model_validate_json(message["data"])
                    except (ValidationError, TypeError):
                        continue
                    yield f"event: notification.created\ndata: {signal.model_dump_json()}\n\n"
                if time.monotonic() - last_ping >= 15:
                    yield ": heartbeat\n\n"
                    last_ping = time.monotonic()
        except RedisError:
            yield 'event: error\ndata: {"code":"REDIS_UNAVAILABLE"}\n\n'
        finally:
            await subscription.aclose()

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no"},
    )
