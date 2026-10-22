"""서버 전용 Redis TCP 연결. 원본은 DB에 두고 저장 신호만 전달합니다."""

import json
import logging

from redis import Redis
from redis.asyncio import Redis as AsyncRedis
from redis.exceptions import RedisError

logger = logging.getLogger(__name__)


def user_channel(owner_id: str) -> str:
    return f"notecam:notifications:{owner_id}"


class NotificationPublisher:
    def __init__(self, url: str):
        self.client = Redis.from_url(url, decode_responses=True, socket_connect_timeout=3,
                                     socket_timeout=3) if url else None

    def publish(self, notice: dict | None) -> None:
        if not notice or self.client is None:
            return
        try:
            self.client.publish(user_channel(notice["owner_id"]), json.dumps({
                "notification_id": notice["id"], "event_id": notice["event_id"],
            }))
        except RedisError:
            # 저장은 이미 완료됐습니다. DB 보정 조회가 복구하며 AI를 다시 호출하지 않습니다.
            logger.warning("알림 실시간 발행 실패: notification_id=%s", notice["id"])

    def close(self) -> None:
        if self.client is not None:
            self.client.close()


def subscriber_client(url: str) -> AsyncRedis | None:
    return AsyncRedis.from_url(url, decode_responses=True, socket_connect_timeout=3,
                               health_check_interval=15) if url else None
