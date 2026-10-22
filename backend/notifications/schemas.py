"""notifications 요청·응답 모델."""

from datetime import datetime
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, StrictInt
from backend.vision.models.common import EventId


class NotificationSignal(BaseModel):
    model_config = ConfigDict(extra="forbid")
    notification_id: StrictInt = Field(gt=0)
    event_id: EventId


class NotificationResponse(BaseModel):
    id: int
    event_id: str
    camera_id: str
    kind: Literal["motion"]
    verdict: Literal["confirmed", "uncertain"]
    message: str
    created_at: datetime
    read: bool
