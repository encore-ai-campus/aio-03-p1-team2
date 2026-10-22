"""조회에는 요청별 JWT, 저장·작업자에는 서버 클라이언트를 전달합니다."""

from fastapi import Request
from fastapi.security import HTTPAuthorizationCredentials

from backend.common.dependencies import get_user_context
from backend.vision.composition import MotionServices
from backend.vision.errors import ApplicationError
from backend.vision.repositories.async_motion_repository import AsyncMotionRepository
from backend.vision.services.motion_analysis_service import MotionAnalysisService
from backend.vision.services.motion_evidence_service import MotionEvidenceService
from backend.vision.services.motion_preview_service import MotionPreviewService
from backend.vision.services.motion_run_service import MotionRunService


async def motion_services(request: Request):
    services = request.app.state.motion
    if services is None:
        raise ApplicationError(
            "VISION_UNAVAILABLE", "비전 Supabase 연결 설정이 필요합니다.", 503
        )
    # 인증은 각 라우터의 User 의존성이 수행합니다. 공유 SDK/HTTP 헤더를 수정하지 않습니다.
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        # 미리보기 전용 ticket 요청은 라우터에서 검증한 owner_id로 조회합니다.
        return services
    context = await get_user_context(
        request, HTTPAuthorizationCredentials(scheme=scheme, credentials=token)
    )
    repository = AsyncMotionRepository(services.client, context.client)
    return MotionServices(
        MotionRunService(repository, services.runs.runtime, lock=services.runs._lock),
        MotionEvidenceService(repository, services.evidence.files),
        MotionAnalysisService(repository, services.settings),
        MotionPreviewService(repository, services.preview.runtime),
        services.client,
        services.http,
        services.settings,
    )


async def get_motion_run_service(request: Request) -> MotionRunService:
    return (await motion_services(request)).runs


async def get_motion_evidence_service(request: Request) -> MotionEvidenceService:
    return (await motion_services(request)).evidence


async def get_motion_analysis_service(request: Request) -> MotionAnalysisService:
    return (await motion_services(request)).analyses


async def get_motion_preview_service(request: Request) -> MotionPreviewService:
    return (await motion_services(request)).preview
