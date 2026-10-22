from fastapi import APIRouter, Path, Query, Request, Response
from backend.common.dependencies import User, get_supabase
from backend.common.repository import now
from backend.feedback.repositories.repository import FeedbackRepository
from backend.feedback.schemas import FeedbackCreate, FeedbackKind, FeedbackPage, FeedbackResponse, FeedbackStatus, FeedbackUpdate

router = APIRouter(prefix="/api/feedback", tags=["피드백"])

def repository(request):
    return FeedbackRepository(get_supabase(request).server)

@router.post("", response_model=FeedbackResponse, status_code=201)
async def create_feedback(payload: FeedbackCreate, request: Request, user: User):
    return await repository(request).create(user.id, payload)

@router.get("", response_model=FeedbackPage)
async def list_feedback(request: Request, user: User, limit: int = Query(20, ge=1, le=100),
                        offset: int = Query(0, ge=0), status: FeedbackStatus | None = None,
                        kind: FeedbackKind | None = None, q: str = Query("", max_length=100),
                        feedback_id: int | None = Query(None, gt=0, le=9223372036854775807)):
    # [UI-FB01] 기능·역할: 본인 전체 피드백 검색 API. 수행 이유: 검색·번호 조회에도 인증된 본인의 소유권 제한을 그대로 적용합니다.
    return await repository(request).page(user.id, limit, offset, status, kind, q, feedback_id)

@router.get("/{feedback_id}", response_model=FeedbackResponse)
async def get_feedback(request: Request, user: User, feedback_id: int = Path(gt=0)):
    return await repository(request).get(user.id, feedback_id)

@router.patch("/{feedback_id}", response_model=FeedbackResponse)
async def update_feedback(payload: FeedbackUpdate, request: Request, user: User, feedback_id: int = Path(gt=0)):
    return await repository(request).update(user.id, feedback_id, payload.model_dump(exclude_unset=True))

@router.delete("/{feedback_id}", status_code=204)
async def delete_feedback(request: Request, user: User, feedback_id: int = Path(gt=0)):
    await repository(request).update(user.id, feedback_id, {"deleted_at": now()})
    return Response(status_code=204)
