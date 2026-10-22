from datetime import datetime
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, Field
from backend.common.schemas import InputModel

class ProfileUpdate(InputModel):
    display_name: str = Field(min_length=1, max_length=40)

class ProfileRead(BaseModel):
    id: UUID
    display_name: str | None
    role: Literal["user", "admin"]
    status: Literal["active", "inactive"]
    created_at: datetime
    updated_at: datetime
    email: str | None = None
