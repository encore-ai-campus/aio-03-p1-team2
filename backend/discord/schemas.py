from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, StrictBool


class OAuthStart(BaseModel):
    model_config = ConfigDict(extra="forbid")
    intent: Literal["login", "link"] = "login"


class OAuthComplete(BaseModel):
    model_config = ConfigDict(extra="forbid")
    flow_id: SecretStr = Field(min_length=32, max_length=128)
    code: SecretStr = Field(min_length=1, max_length=2048)


class NotificationPreference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    notifications_enabled: StrictBool
