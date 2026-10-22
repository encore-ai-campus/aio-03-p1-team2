"""Discord REST 발송과 DB 기반 재시도. Redis는 발송 작업을 깨우는 용도입니다."""

import asyncio
import logging
import math
import re
import time
from contextlib import suppress
from datetime import datetime
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

import httpx
from redis.exceptions import RedisError

logger = logging.getLogger(__name__)


class DeliveryError(Exception):
    def __init__(self, message, *, retry_after=None, blocked=False):
        super().__init__(message)
        self.retry_after, self.blocked = retry_after, blocked


class DiscordBot:
    def __init__(self, http, token):
        self.http, self.token = http, token
        self.next_request_at = 0.0

    async def request(self, path, payload):
        if not self.token:
            raise DeliveryError("Discord 봇 토큰이 설정되지 않았습니다.")
        remaining = self.next_request_at - time.monotonic()
        if remaining > 0:
            raise DeliveryError("Discord 요청 제한으로 대기 중입니다.", retry_after=math.ceil(remaining))
        try:
            response = await self.http.post("https://discord.com/api/v10/" + path,
                headers={"Authorization": "Bot " + self.token,
                         "User-Agent": "DiscordBot (https://github.com/krw82/aio-03-p1-team2, 0.1)"},
                json=payload, timeout=10)
        except httpx.RequestError:
            raise DeliveryError("Discord 연결이 지연됐습니다.", retry_after=30) from None
        if response.status_code == 429:
            try:
                delay = float(response.json().get("retry_after", 5))
                delay = math.ceil(delay) if math.isfinite(delay) else 5
            except (ValueError, TypeError, AttributeError):
                delay = 5
            delay = max(1, min(delay, 3600))
            self.next_request_at = time.monotonic() + delay
            raise DeliveryError("Discord 요청 제한으로 대기 중입니다.", retry_after=delay)
        if response.status_code >= 500:
            raise DeliveryError("Discord가 일시적으로 응답하지 않습니다.", retry_after=30)
        if response.status_code == 403:
            raise DeliveryError("봇과 DM 가능한 연결 및 Discord의 DM 허용 설정을 확인하세요.", blocked=True)
        if not response.is_success:
            raise DeliveryError("Discord 발송 설정을 확인하세요.")
        try:
            identifier = response.json()["id"]
            if not re.fullmatch(r"[1-9][0-9]{16,19}", str(identifier)):
                raise ValueError("invalid Discord id")
        except (ValueError, KeyError, TypeError):
            raise DeliveryError("Discord 응답을 확인할 수 없습니다.") from None
        return str(identifier)

    async def open_dm(self, user_id):
        return await self.request("users/@me/channels", {"recipient_id": user_id})

    async def send(self, channel_id, content, *, notification_id=None):
        if not re.fullmatch(r"[1-9][0-9]{16,19}", str(channel_id)):
            raise DeliveryError("DM 채널을 다시 연결하세요.", blocked=True)
        payload = {"content": content, "allowed_mentions": {"parse": []}, "flags": 4}
        if notification_id is not None:
            # Discord의 최근 메시지 nonce 중복 방지와 DB의 고유 발송 건을 함께 사용합니다.
            payload.update(nonce=str(notification_id), enforce_nonce=True)
        return await self.request(f"channels/{channel_id}/messages", payload)


def notification_text(job, app_url):
    event_id = job["event_id"]
    if not re.fullmatch(r"[0-9a-f]{32}_e[0-9]{6}", event_id):
        raise ValueError("invalid event id")
    title = "판단 어려움" if job["verdict"] == "uncertain" else "확인됨"
    when = datetime.fromisoformat(job["detected_at"].replace("Z", "+00:00"))
    when = when.astimezone(ZoneInfo("Asia/Seoul")).strftime("%Y-%m-%d %H:%M:%S KST")
    return f"**NoteCam 알림 · {title}**\n{job['message']}\n감지 시각: {when}\n사건 보기: {app_url}/?{urlencode({'event': event_id})}"


class DiscordSender:
    def __init__(self, repository, bot, app_url, redis=None):
        self.repository, self.bot, self.app_url, self.redis = repository, bot, app_url, redis

    async def process_one(self):
        if self.bot.next_request_at > time.monotonic():
            return False
        job = await self.repository.claim()
        if not job:
            return False
        try:
            recipient = await self.repository.recipient(job)
            if not recipient:
                await self.repository.finish(job, "skipped")
                return True
            message_id = await self.bot.send(recipient["dm_channel_id"],
                notification_text(job, self.app_url), notification_id=job["notification_id"])
        except DeliveryError as exc:
            if exc.blocked:
                await self.repository.preference(job["owner_id"], False)
            if exc.blocked or exc.retry_after is None:
                await self.repository.error(job["owner_id"], str(exc))
            await self.repository.finish(job, "failed", error=str(exc), retry_after=exc.retry_after)
        except asyncio.CancelledError:
            # 요청이 Discord에 도착했을 수 있습니다. DB lease 만료 후 같은 nonce로 복구합니다.
            raise
        except Exception:
            logger.warning("Discord 발송 처리 실패: notification_id=%s", job["notification_id"])
            await self.repository.finish(job, "failed", error="발송 처리 중 오류가 발생했습니다.", retry_after=30)
        else:
            await self.repository.finish(job, "sent", message_id=message_id)
        return True

    async def run(self):
        subscription = None
        try:
            while True:
                try:
                    if await self.process_one():
                        continue
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.warning("Discord 발송 DB 연결을 확인하지 못했습니다.")
                if self.redis is not None:
                    try:
                        if subscription is None:
                            subscription = self.redis.pubsub()
                            await subscription.psubscribe("notecam:notifications:*")
                        await subscription.get_message(ignore_subscribe_messages=True, timeout=10)
                        continue
                    except RedisError:
                        if subscription is not None:
                            with suppress(RedisError):
                                await subscription.aclose()
                            subscription = None
                # DB가 원본이므로 Redis 중단·재시작 중 생긴 미발송 건도 회수합니다.
                await asyncio.sleep(10)
        finally:
            if subscription is not None:
                with suppress(RedisError):
                    await subscription.aclose()
