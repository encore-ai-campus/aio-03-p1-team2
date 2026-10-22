from uuid import UUID
from fastapi import APIRouter, Path, Query, Request, Response
from backend.admin.dependencies import Admin
from backend.admin.repositories.repository import AdminRepository
from backend.admin.schemas import AdminFeedbackUpdate, AdminProfilePage, AdminProfileUpdate, AuditPage
from backend.common.dependencies import get_supabase
from backend.feedback.schemas import FeedbackKind, FeedbackPage, FeedbackResponse, FeedbackStatus
from backend.users.schemas import ProfileRead

router = APIRouter(prefix="/api/admin", tags=["관리자"])

def repository(request):
    return AdminRepository(get_supabase(request).server)

@router.get("/feedback", response_model=FeedbackPage)
async def feedback(request: Request, admin: Admin, limit: int = Query(20, ge=1, le=100),
                   offset: int = Query(0, ge=0), status: FeedbackStatus | None = None,
                   kind: FeedbackKind | None = None, q: str = Query("", max_length=100),
                   feedback_id: int | None = Query(None, gt=0, le=9223372036854775807)):
    # [UI-FB01] 기능·역할: 관리자 전체 피드백 검색 API. 수행 이유: 관리자 인증을 유지하면서 일반 사용자와 같은 검색·페이지 계산을 제공합니다.
    return await repository(request).feedback_page(limit, offset, status, kind, q, feedback_id)

@router.patch("/feedback/{feedback_id}", response_model=FeedbackResponse)
async def update_feedback(payload: AdminFeedbackUpdate, request: Request, admin: Admin,
                          feedback_id: int = Path(gt=0)):
    return await repository(request).change(admin.id, "feedback", feedback_id, payload.model_dump(exclude_unset=True))

@router.delete("/feedback/{feedback_id}", status_code=204)
async def delete_feedback(request: Request, admin: Admin, feedback_id: int = Path(gt=0)):
    await repository(request).change(admin.id, "feedback", feedback_id, {}, action="delete")
    return Response(status_code=204)

@router.get("/users", response_model=AdminProfilePage)
async def users(request: Request, admin: Admin, limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0)):
    return await repository(request).users_page(admin.id, limit, offset)

@router.patch("/users/{user_id}", response_model=ProfileRead)
async def update_user(user_id: UUID, payload: AdminProfileUpdate, request: Request, admin: Admin):
    return await repository(request).change(admin.id, "users", user_id, payload.model_dump(exclude_unset=True))

@router.get("/audit-logs", response_model=AuditPage)
async def audit_logs(request: Request, admin: Admin, limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0)):
    return await repository(request).audit_page(limit, offset)
