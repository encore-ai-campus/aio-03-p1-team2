"""Supabase에 로그인하고 발급된 토큰을 반환합니다."""

import logging
import re

import httpx
from fastapi import HTTPException
from supabase import AsyncClient
from supabase_auth.errors import AuthApiError, AuthError, AuthWeakPasswordError

from backend.login.schemas import Login, Refresh, Register, RegisterResponse, TokenResponse

logger = logging.getLogger(__name__)

REGISTER_ERROR_MESSAGES = {
    "email_address_invalid": "Supabase에서 허용하지 않는 이메일 주소입니다. 실제 사용 가능한 이메일 주소를 입력하세요.",
    "email_address_not_authorized": "현재 Supabase 메일 설정에서는 이 주소로 인증 메일을 보낼 수 없습니다. 테스트 프로젝트의 Confirm Email 또는 SMTP 설정을 확인하세요.",
    "signup_disabled": "Supabase에서 신규 회원가입이 비활성화되어 있습니다.",
    "email_provider_disabled": "Supabase에서 이메일 회원가입이 비활성화되어 있습니다.",
    "weak_password": "비밀번호가 가입 조건을 충족하지 않습니다.",
}


async def login(client: AsyncClient, payload: Login) -> TokenResponse:
    try:
        result = await client.auth.sign_in_with_password({
            "email": str(payload.email), "password": payload.password.get_secret_value(),
        })
    except AuthApiError as exc:
        if exc.status == 429:
            raise HTTPException(429, "잠시 후 다시 시도하세요.") from exc
        if exc.status >= 500:
            raise HTTPException(503, "인증 서버에 연결할 수 없습니다.") from exc
        if exc.code == "email_not_confirmed":
            raise HTTPException(403, "이메일 인증 후 로그인하세요.") from exc
        raise HTTPException(401, "이메일 또는 비밀번호를 확인하세요.") from exc
    except (AuthError, httpx.RequestError) as exc:
        raise HTTPException(503, "인증 서버에 연결할 수 없습니다.") from exc
    if result.session is None:
        raise HTTPException(401, "로그인 결과를 확인할 수 없습니다.")
    return TokenResponse(
        access_token=result.session.access_token,
        refresh_token=result.session.refresh_token,
        expires_in=result.session.expires_in,
        token_type=result.session.token_type,
    )


async def refresh(client: AsyncClient, payload: Refresh) -> TokenResponse:
    try:
        result = await client.auth.refresh_session(payload.refresh_token.get_secret_value())
    except AuthApiError as exc:
        if exc.status == 429:
            raise HTTPException(429, "잠시 후 다시 시도하세요.") from exc
        if exc.status >= 500:
            raise HTTPException(503, "인증 서버에 연결할 수 없습니다.") from exc
        raise HTTPException(401, "로그인이 만료되었습니다. 다시 로그인하세요.") from exc
    except (AuthError, httpx.RequestError) as exc:
        raise HTTPException(503, "인증 서버에 연결할 수 없습니다.") from exc
    if result.session is None:
        raise HTTPException(401, "로그인 갱신 결과를 확인할 수 없습니다.")
    return TokenResponse(
        access_token=result.session.access_token,
        refresh_token=result.session.refresh_token,
        expires_in=result.session.expires_in,
        token_type=result.session.token_type,
    )


async def register(client: AsyncClient, payload: Register) -> RegisterResponse:
    try:
        result = await client.auth.sign_up({
            "email": str(payload.email), "password": payload.password.get_secret_value(),
        })
    except AuthWeakPasswordError as exc:
        raise HTTPException(400, "비밀번호가 가입 조건을 충족하지 않습니다.") from exc
    except AuthApiError as exc:
        # 원문 오류에는 이메일 등 민감한 정보가 포함될 수 있어 코드만 기록합니다.
        code = exc.code if isinstance(exc.code, str) and re.fullmatch(r"[a-z_]{1,80}", exc.code) else "unknown"
        logger.warning("Supabase signup failed: status=%s code=%s", exc.status, code)
        if exc.status == 429:
            raise HTTPException(429, "잠시 후 다시 시도하세요.") from exc
        if exc.status >= 500:
            raise HTTPException(503, "인증 서버에 연결할 수 없습니다.") from exc
        if exc.code in {"user_already_exists", "email_exists"}:
            raise HTTPException(409, "이미 가입된 이메일입니다.") from exc
        raise HTTPException(400, REGISTER_ERROR_MESSAGES.get(code, "회원가입 정보를 확인하세요.")) from exc
    except (AuthError, httpx.RequestError) as exc:
        raise HTTPException(503, "인증 서버에 연결할 수 없습니다.") from exc
    if result.user is None:
        raise HTTPException(502, "회원가입 결과를 확인할 수 없습니다.")
    return RegisterResponse(
        user_id=result.user.id, email_confirmation_required=result.session is None,
    )
