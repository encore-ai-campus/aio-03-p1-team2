"""관리자 전용 비전 기록 조회. 서버 SDK는 Admin 검증 이후에만 사용합니다."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel

from backend.admin.dependencies import Admin
from backend.vision.composition import MotionServices
from backend.vision.errors import ApplicationError, NotFound
from backend.vision.models.analyses import AnalysisRead, EventAnalysisRead
from backend.vision.models.common import EventId
from backend.vision.models.evidence import EventListRead, EventRead, PartDetail, PartRead

router = APIRouter(prefix="/api/admin", tags=["관리자 비전"])


def admin_motion(request: Request, admin: Admin) -> MotionServices:
    services = request.app.state.motion
    if services is None:
        raise ApplicationError("VISION_UNAVAILABLE", "비전 기능이 활성화되지 않았습니다.", 503)
    # 요청 사용자 JWT를 사용하는 일반 비전 의존성과 달리 서버 SDK를 사용합니다.
    return services


Services = Annotated[MotionServices, Depends(admin_motion)]


class AdminCameraRead(BaseModel):
    id: UUID
    owner_id: UUID
    name: str


@router.get("/cameras", response_model=list[AdminCameraRead])
async def cameras(
    services: Services, user_id: UUID | None = None,
    limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0),
):
    repository = services.evidence.repository
    query = repository.reader.table("cameras").select("id,owner_id,name")
    if user_id is not None:
        query = query.eq("owner_id", str(user_id))
    return await repository.execute(query.order("name").order("id").range(offset, offset + limit - 1))


@router.get("/cameras/{camera_id}/events", response_model=list[EventListRead])
async def camera_events(
    camera_id: UUID, services: Services,
    limit: int = Query(20, ge=1, le=100), finished_only: bool = False,
):
    repository = services.evidence.repository
    rows = await repository.execute(
        repository.reader.table("cameras").select("id").eq("id", str(camera_id)).limit(1)
    )
    if not rows:
        raise NotFound("카메라")
    return await services.evidence.list_events(None, None, limit, finished_only, camera_id=str(camera_id))


@router.get("/events/{event_id}", response_model=EventRead)
async def event(event_id: EventId, services: Services):
    return await services.evidence.get_event(event_id, None)


@router.get("/events/{event_id}/parts", response_model=list[PartRead])
async def parts(
    event_id: EventId, services: Services,
    after: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=100),
):
    return await services.evidence.list_parts(event_id, None, after, limit)


@router.get("/parts/{part_id}", response_model=PartDetail)
async def part(part_id: UUID, services: Services):
    detail = await services.evidence.get_part(str(part_id), None)
    for photo in detail["photos"]:
        photo["content_url"] = f"/api/admin/photos/{photo['id']}/content"
    return detail


@router.get("/photos/{photo_id}/content", response_class=Response,
            responses={200: {"content": {"image/jpeg": {}}}})
async def photo(photo_id: UUID, services: Services):
    return Response(await services.evidence.content(str(photo_id), None),
                    media_type="image/jpeg", headers={"Cache-Control": "private, no-store"})


@router.get("/parts/{part_id}/analyses", response_model=list[AnalysisRead])
async def analyses(part_id: UUID, services: Services, limit: int = Query(20, ge=1, le=100)):
    return await services.analyses.list(str(part_id), None, limit)


@router.get("/analyses/{analysis_id}", response_model=AnalysisRead)
async def analysis(analysis_id: UUID, services: Services):
    return await services.analyses.get(str(analysis_id), None)


@router.get("/events/{event_id}/analysis", response_model=EventAnalysisRead)
async def event_analysis(event_id: EventId, services: Services):
    return await services.analyses.get_event(event_id, None)
