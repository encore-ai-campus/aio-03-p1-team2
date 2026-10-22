"""모션 모듈이 저장한 event.json에서 실제로 사용할 값만 검사합니다."""

from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .common import EventId, RunId


class ManifestPhoto(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    path: str
    timestamp_sec: float = Field(ge=0)


class BundleManifest(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    schema_version: Literal[1]
    run_id: RunId
    event_id: EventId
    part_index: int = Field(ge=1)
    start_sec: float = Field(ge=0)
    end_sec: float = Field(ge=0)
    trigger_sec: float = Field(ge=0)
    episode_end: bool
    context_complete: bool
    evidence_complete: bool
    images: list[ManifestPhoto] = Field(min_length=1, max_length=6)

    @model_validator(mode="after")
    def validate_bundle(self) -> Self:
        if not self.event_id.startswith(self.run_id + "_e"):
            raise ValueError("사건이 해당 실행에 속하지 않습니다.")
        if self.end_sec < self.start_sec:
            raise ValueError("촬영 구간이 유효하지 않습니다.")
        if any(
            not self.start_sec <= image.timestamp_sec <= self.end_sec
            for image in self.images
        ):
            raise ValueError("사진 시간이 촬영 구간에 속하지 않습니다.")
        return self
