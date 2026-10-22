"""알림 공개 응답 변환."""

from backend.notifications.schemas import NotificationResponse


def public_notice(value):
    return NotificationResponse.model_validate(value).model_dump(mode="json")
