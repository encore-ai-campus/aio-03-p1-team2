"""common 요청·응답 모델."""

from pydantic import BaseModel, ConfigDict


class InputModel(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
