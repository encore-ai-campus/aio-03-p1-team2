from datetime import datetime
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator

from .common import RequestModel

DEFAULT_QUESTION_TEXT = "사진에서 사람이 움직이는 모습이 확인되나요?"


class QuestionInput(RequestModel):
    id: UUID | None = None
    question: str = Field(min_length=1, max_length=4000)

    @field_validator("question")
    @classmethod
    def validate_question(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("분석 질문은 공백일 수 없습니다.")
        return value


class AnalysisQuestion(QuestionInput):
    id: UUID


class QuestionsSave(RequestModel):
    questions: list[QuestionInput] = Field(min_length=1, max_length=5)

    @model_validator(mode="after")
    def validate_questions(self) -> Self:
        ids = [q.id for q in self.questions if q.id is not None]
        texts = [q.question for q in self.questions]
        if len(ids) != len(set(ids)) or len(texts) != len(set(texts)):
            raise ValueError("같은 질문을 중복으로 저장할 수 없습니다.")
        if sum(map(len, texts)) > 4000:
            raise ValueError("질문 전체 길이는 4000자 이하여야 합니다.")
        return self


class AnalysisCreate(QuestionsSave):
    pass


class QuestionSettingsSave(QuestionsSave):
    notify_on_uncertain: StrictBool = False


class AnalysisQuestionsRead(BaseModel):
    questions: list[AnalysisQuestion]
    notify_on_uncertain: bool = False
    updated_at: datetime


class AnalysisItem(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    question_id: str = Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    verdict: Literal["confirmed", "not_confirmed", "uncertain"]
    summary: str = Field(min_length=1, max_length=500)

    @field_validator("summary")
    @classmethod
    def validate_summary(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("분석 설명은 공백일 수 없습니다.")
        return value.strip()


class AnalysisResult(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    items: list[AnalysisItem] = Field(min_length=1, max_length=5)


class AnalysisRead(BaseModel):
    id: str
    part_id: str
    origin: Literal["auto", "manual"]
    questions: list[AnalysisQuestion]
    model_name: str
    status: Literal["queued", "running", "succeeded", "failed"]
    result: AnalysisResult | None = None
    error_message: str | None = None
    created_at: datetime
    finished_at: datetime | None = None
    latency_ms: int | None = None


class EventAnalysisRead(BaseModel):
    event_id: str
    status: Literal["collecting", "waiting", "interrupted", "running", "succeeded", "failed"]
    basis: Literal["part", "synthesis"] | None = None
    analysis_id: str | None = None
    questions: list[AnalysisQuestion]
    model_name: str | None = None
    result: AnalysisResult | None = None
    error_message: str | None = None
    created_at: datetime | None = None
    finished_at: datetime | None = None
    latency_ms: int | None = None
