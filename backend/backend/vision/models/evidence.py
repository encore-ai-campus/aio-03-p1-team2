from datetime import datetime
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .analyses import AnalysisQuestion, AnalysisResult


class CaptureMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    start_sec: float = Field(ge=0)
    end_sec: float = Field(ge=0)
    context_complete: bool
    evidence_complete: bool

    @model_validator(mode="after")
    def validate_range(self) -> Self:
        if self.end_sec < self.start_sec:
            raise ValueError("촬영 종료 시간은 시작 시간보다 빠를 수 없습니다.")
        return self


class EventRead(BaseModel):
    id: str
    run_id: str
    detected_at: datetime
    capture_state: Literal["collecting", "closed", "interrupted"]
    final_part_index: int | None = None
    questions: list[AnalysisQuestion]


class EventListRead(EventRead):
    analysis_status: Literal["collecting", "waiting", "interrupted", "running", "succeeded", "failed"]
    result: AnalysisResult | None = None


class PartRead(BaseModel):
    id: str
    event_id: str
    part_index: int
    metadata: CaptureMetadata


class PhotoRead(BaseModel):
    id: str
    part_id: str
    sequence_no: int
    timestamp_sec: float
    upload_status: Literal["pending", "ready"]
    content_url: str


class PartDetail(PartRead):
    photos: list[PhotoRead]
