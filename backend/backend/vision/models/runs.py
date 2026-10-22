from datetime import datetime
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, Field, field_validator, model_validator

from .common import DataObject, RequestModel

RunStatus = Literal["starting", "running", "stopping", "stopped", "failed"]


class CameraCreate(RequestModel):
    name: str = Field(min_length=1, max_length=80)

    @field_validator("name", mode="before")
    @classmethod
    def strip_name(cls, value):
        return value.strip() if isinstance(value, str) else value


class CameraRead(BaseModel):
    id: UUID
    name: str


class CaptureSettings(RequestModel):
    pre_capture_sec: float = Field(default=3, ge=0)
    quiet_sec: float = Field(default=3, gt=0)
    max_duration_sec: float = Field(default=10, gt=0, le=10)
    sample_interval_sec: float = Field(default=0.5, gt=0)
    max_images: int = Field(default=6, ge=2, le=6)

    @model_validator(mode="after")
    def validate_intervals(self) -> Self:
        if self.pre_capture_sec >= self.max_duration_sec:
            raise ValueError("사전 촬영 시간은 묶음 최대 시간보다 짧아야 합니다.")
        if max(self.quiet_sec, self.sample_interval_sec) > self.max_duration_sec:
            raise ValueError("대기·샘플링 간격은 묶음 최대 시간을 넘을 수 없습니다.")
        return self


class RunCreate(RequestModel):
    # 등록 카메라의 소유권을 확인합니다. 실제 기기 선택은 브라우저가 담당합니다.
    camera_id: UUID
    objects: list[str] = Field(
        default_factory=lambda: ["person"], min_length=1, max_length=80
    )
    capture: CaptureSettings = Field(default_factory=CaptureSettings)
    analysis_roi: tuple[float, float, float, float] | None = None
    duration_sec: float | None = Field(default=None, gt=0, le=86400)
    preview_mirror: bool = True
    preview_overlay: bool = False

    @field_validator("objects")
    @classmethod
    def normalize_objects(cls, labels: list[str]) -> list[str]:
        labels = list(dict.fromkeys(label.strip().lower() for label in labels))
        if any(not label or len(label) > 80 for label in labels):
            raise ValueError("감지 대상 이름은 1~80자여야 합니다.")
        return labels

    @model_validator(mode="after")
    def validate_roi(self) -> Self:
        if self.analysis_roi is not None:
            x1, y1, x2, y2 = self.analysis_roi
            if not (0 <= x1 < x2 <= 1 and 0 <= y1 < y2 <= 1):
                raise ValueError("분석 영역은 0~1 범위의 x1,y1,x2,y2여야 합니다.")
        return self


class RunRead(BaseModel):
    id: str
    camera_id: UUID
    config: DataObject
    status: RunStatus
    requested_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error_message: str | None = None
    # 진행 정보는 실행 엔진에서 읽으며 DB에 매 프레임 저장하지 않습니다.
    progress: DataObject | None = None


class RunStopRead(BaseModel):
    id: str
    status: RunStatus


class FrameRead(BaseModel):
    sequence_no: int
    accepted: bool
    # 너무 빠르게 도착한 프레임은 대기열에 쌓지 않습니다.
    reason: Literal["accepted", "rate_limited"]
