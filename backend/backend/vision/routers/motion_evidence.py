from typing import Annotated
from uuid import UUID
from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from backend.common.dependencies import User
from backend.vision.dependencies import get_motion_evidence_service
from backend.vision.models.common import EventId, RunId
from backend.vision.models.evidence import EventRead, EventListRead, PartDetail, PartRead
from backend.vision.services.motion_evidence_service import MotionEvidenceService

router = APIRouter(prefix="/api/motion", tags=["모션 사건·사진"])


@router.get("/events", response_model=list[EventListRead])
async def list_events(
    user: User,
    service: Annotated[MotionEvidenceService, Depends(get_motion_evidence_service)],
    run_id: RunId | None = None,
    limit: int = Query(20, ge=1, le=100),
    finished_only: bool = False,
):
    return await service.list_events(user.id, run_id, limit, finished_only)


@router.get("/events/{event_id}", response_model=EventRead)
async def get_event(
    event_id: EventId,
    user: User,
    service: Annotated[MotionEvidenceService, Depends(get_motion_evidence_service)],
):
    return await service.get_event(event_id, user.id)


@router.get("/events/{event_id}/parts", response_model=list[PartRead])
async def list_parts(
    event_id: EventId,
    user: User,
    service: Annotated[MotionEvidenceService, Depends(get_motion_evidence_service)],
    after: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
):
    return await service.list_parts(event_id, user.id, after, limit)


@router.get("/parts/{part_id}", response_model=PartDetail)
async def get_part(
    part_id: UUID,
    user: User,
    service: Annotated[MotionEvidenceService, Depends(get_motion_evidence_service)],
):
    return await service.get_part(str(part_id), user.id)


@router.get(
    "/photos/{photo_id}/content",
    response_class=Response,
    responses={200: {"content": {"image/jpeg": {}}}},
)
async def get_photo(
    photo_id: UUID,
    user: User,
    service: Annotated[MotionEvidenceService, Depends(get_motion_evidence_service)],
):
    return Response(
        await service.content(str(photo_id), user.id),
        media_type="image/jpeg",
        headers={"Cache-Control": "private, no-store"},
    )
