from typing import Annotated
from uuid import UUID
from fastapi import APIRouter, Depends, Query
from backend.common.dependencies import User
from backend.vision.dependencies import get_motion_analysis_service
from backend.vision.models.analyses import (
    AnalysisCreate,
    AnalysisQuestionsRead,
    QuestionSettingsSave,
    AnalysisRead,
    EventAnalysisRead,
)
from backend.vision.models.common import EventId
from backend.vision.services.motion_analysis_service import MotionAnalysisService

router = APIRouter(prefix="/api/motion", tags=["모션 분석"])


@router.get("/questions", response_model=AnalysisQuestionsRead)
async def get_questions(
    user: User,
    service: Annotated[MotionAnalysisService, Depends(get_motion_analysis_service)],
):
    return await service.get_questions(user.id)


@router.put("/questions", response_model=AnalysisQuestionsRead)
async def save_questions(
    payload: QuestionSettingsSave,
    user: User,
    service: Annotated[MotionAnalysisService, Depends(get_motion_analysis_service)],
):
    return await service.save_questions(user.id, payload.questions, payload.notify_on_uncertain)


@router.post("/parts/{part_id}/analyses", response_model=AnalysisRead, status_code=202)
async def create_analysis(
    part_id: UUID,
    payload: AnalysisCreate,
    user: User,
    service: Annotated[MotionAnalysisService, Depends(get_motion_analysis_service)],
):
    return await service.create(str(part_id), user.id, payload.questions)


@router.get("/parts/{part_id}/analyses", response_model=list[AnalysisRead])
async def list_analyses(
    part_id: UUID,
    user: User,
    service: Annotated[MotionAnalysisService, Depends(get_motion_analysis_service)],
    limit: int = Query(20, ge=1, le=100),
):
    return await service.list(str(part_id), user.id, limit)


@router.get("/analyses/{analysis_id}", response_model=AnalysisRead)
async def get_analysis(
    analysis_id: UUID,
    user: User,
    service: Annotated[MotionAnalysisService, Depends(get_motion_analysis_service)],
):
    return await service.get(str(analysis_id), user.id)


@router.get("/events/{event_id}/analysis", response_model=EventAnalysisRead)
async def get_event_analysis(
    event_id: EventId,
    user: User,
    service: Annotated[MotionAnalysisService, Depends(get_motion_analysis_service)],
):
    return await service.get_event(event_id, user.id)
