from fastapi import APIRouter, Request
from backend.common.dependencies import User, get_supabase
from backend.users.repository import ProfileRepository
from backend.users.schemas import ProfileRead, ProfileUpdate

router = APIRouter(prefix="/api/users", tags=["프로필"])

@router.get("/me", response_model=ProfileRead)
async def me(request: Request, user: User):
    return request.state.profile

@router.patch("/me", response_model=ProfileRead)
async def update_me(payload: ProfileUpdate, request: Request, user: User):
    profile = await ProfileRepository(get_supabase(request).server).update(user.id, payload)
    return {**profile, "email": request.state.profile.get("email")}
