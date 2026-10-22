"""Supabase Auth가 검증한 사용자와 요청 전용 SDK를 기능별 저장소에 전달합니다."""

import math
import time
from dataclasses import dataclass, field
from typing import Annotated
from uuid import UUID

import httpx
import jwt
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from supabase import AsyncClient

from backend.common.supabase import SupabaseResources
from backend.users.repository import ProfileRepository


bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class Principal:
    id: str
    role: str
    expires_at: float


@dataclass(frozen=True)
class UserContext(Principal):
    client: AsyncClient = field(repr=False)

    @property
    def user_id(self) -> str:
        return self.id


def get_supabase(request: Request) -> SupabaseResources:
    return request.app.state.supabase


async def get_user_context(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> UserContext:
    if not credentials or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            401, "로그인이 필요합니다.", headers={"WWW-Authenticate": "Bearer"}
        )
    token = credentials.credentials
    cached = getattr(request.state, "supabase_user_context", None)
    if (
        cached is not None
        and getattr(request.state, "supabase_user_token", None) == token
    ):
        if cached.expires_at <= time.time():
            raise HTTPException(401, "로그인 토큰이 만료되었습니다.")
        return cached
    resources = get_supabase(request)
    try:
        response = await resources.http.get(
            resources.settings.supabase_url.rstrip("/") + "/auth/v1/user",
            headers={
                "apikey": resources.settings.supabase_publishable_key,
                "Authorization": "Bearer " + token,
            },
        )
    except httpx.RequestError as exc:
        raise HTTPException(503, "인증 서버에 연결할 수 없습니다.") from exc
    if response.status_code >= 500 or response.status_code == 429:
        raise HTTPException(503, "인증 서버에 연결할 수 없습니다.")
    if response.status_code != 200:
        raise HTTPException(401, "로그인 토큰이 유효하지 않습니다.")
    try:
        user = response.json()
        user_id = str(UUID(user["id"]))
        # JWT의 진위는 위 Auth 요청으로 확인합니다. exp는 SSE·미리보기 종료에 사용합니다.
        expires = jwt.decode(token, options={"verify_signature": False})["exp"]
        if (
            isinstance(expires, bool)
            or not isinstance(expires, (int, float))
            or not math.isfinite(expires)
        ):
            raise ValueError("invalid expiry")
        if expires <= time.time():
            raise HTTPException(401, "로그인 토큰이 만료되었습니다.")
        profile = await ProfileRepository(resources.server).get_or_create(user_id)
        if profile["status"] != "active":
            raise HTTPException(403, "비활성화된 계정입니다.")
        context = UserContext(
            user_id,
            "admin" if profile["role"] == "admin" else "user",
            expires,
            await resources.user_client(token),
        )
    except (
        KeyError,
        TypeError,
        AttributeError,
        ValueError,
        OverflowError,
        jwt.InvalidTokenError,
    ) as exc:
        raise HTTPException(401, "로그인 응답을 확인할 수 없습니다.") from exc
    request.state.supabase_user_context = context
    request.state.profile = {**profile, "email": user.get("email")}
    request.state.supabase_user_token = token
    return context


async def get_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> Principal:
    # 기존 User 의존성 import 경로를 유지합니다. SQLite 인증 분기는 없습니다.
    return await get_user_context(request, credentials)


CurrentUser = Annotated[UserContext, Depends(get_user_context)]
User = Annotated[Principal, Depends(get_user)]
