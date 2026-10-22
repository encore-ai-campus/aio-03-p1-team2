from datetime import datetime
from typing import Any, Literal
from uuid import UUID
from pydantic import BaseModel, Field, model_validator
from backend.common.schemas import InputModel
from backend.feedback.schemas import FeedbackStatus
from backend.users.schemas import ProfileRead

class AdminProfileUpdate(InputModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=40)
    role: Literal["user", "admin"] | None = None
    status: Literal["active", "inactive"] | None = None

    @model_validator(mode="after")
    def valid_changes(self):
        if not self.model_fields_set or any(getattr(self, k) is None for k in self.model_fields_set):
            raise ValueError("수정할 내용을 입력하세요. null은 허용하지 않습니다.")
        return self

class AdminFeedbackUpdate(InputModel):
    status: FeedbackStatus | None = None
    admin_note: str | None = Field(default=None, max_length=1000)

    @model_validator(mode="after")
    def valid_changes(self):
        if not self.model_fields_set or ("status" in self.model_fields_set and self.status is None):
            raise ValueError("수정할 내용을 입력하세요. status는 null일 수 없습니다.")
        return self

class AdminProfileRead(ProfileRead):
    email: str | None = None
    last_sign_in_at: datetime | None = None

class AdminProfilePage(BaseModel):
    items: list[AdminProfileRead]
    total: int
    limit: int
    offset: int

class AuditRead(BaseModel):
    id: int
    actor_id: UUID | None
    action: str
    target_type: Literal["users", "feedback"]
    target_id: str
    old_data: dict[str, Any] | None
    new_data: dict[str, Any] | None
    created_at: datetime

class AuditPage(BaseModel):
    items: list[AuditRead]
    total: int
    limit: int
    offset: int
