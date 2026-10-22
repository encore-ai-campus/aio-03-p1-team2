from datetime import datetime
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, Field, model_validator
from backend.common.schemas import InputModel

FeedbackKind = Literal["false_positive", "false_negative", "accurate", "suggestion"]
FeedbackStatus = Literal["pending", "in_progress", "resolved"]

class FeedbackCreate(InputModel):
    title: str = Field(min_length=1, max_length=100)
    kind: FeedbackKind
    content: str = Field(min_length=1, max_length=1000)

class FeedbackUpdate(InputModel):
    title: str | None = Field(default=None, min_length=1, max_length=100)
    kind: FeedbackKind | None = None
    content: str | None = Field(default=None, min_length=1, max_length=1000)

    @model_validator(mode="after")
    def valid_changes(self):
        if not self.model_fields_set or any(getattr(self, key) is None for key in self.model_fields_set):
            raise ValueError("수정할 내용을 입력하세요. null은 허용하지 않습니다.")
        return self

class FeedbackResponse(BaseModel):
    id: int
    user_id: UUID
    title: str
    kind: FeedbackKind
    content: str
    status: FeedbackStatus
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None
    admin_note: str | None = None

class FeedbackPage(BaseModel):
    items: list[FeedbackResponse]
    total: int
    limit: int
    offset: int
