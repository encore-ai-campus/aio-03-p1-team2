"""비전 미리보기 URL에 사용하는 짧은 서명 토큰. Supabase 로그인과 별개입니다."""

import time

import jwt
from fastapi import HTTPException, Request


def issue_token(request: Request, user_id: str, scope="access", seconds=3600, **claims):
    stamp = int(time.time())
    return jwt.encode(
        {
            "sub": user_id,
            "scope": scope,
            "iat": stamp,
            "exp": stamp + seconds,
            "iss": "notecam",
            "aud": "notecam",
            **claims,
        },
        request.app.state.vision_settings.jwt_secret,
        algorithm="HS256",
    )


def decode_token(request: Request, token: str, scope="access"):
    try:
        payload = jwt.decode(
            token,
            request.app.state.vision_settings.jwt_secret,
            algorithms=["HS256"],
            issuer="notecam",
            audience="notecam",
            options={"require": ["sub", "exp", "iat", "scope"]},
        )
        if payload["scope"] != scope:
            raise jwt.InvalidTokenError()
        return payload
    except jwt.InvalidTokenError:
        raise HTTPException(
            401,
            "토큰이 유효하지 않거나 만료되었습니다.",
            headers={"WWW-Authenticate": "Bearer"},
        )
