"""브라우저 탭에 묶인 일회성 PKCE. Discord 사용자 토큰은 저장하지 않습니다."""

import base64
import hashlib
import json
import re
import secrets
from urllib.parse import urlencode, urlsplit

import httpx
from fastapi import HTTPException
from redis.exceptions import RedisError

from backend.users.repository import ProfileRepository
from .repository import discord_identity


class DiscordOAuth:
    def __init__(self, resources, config, redis, repository):
        self.resources, self.config, self.redis, self.repository = resources, config, redis, repository

    async def auth_request(self, method, path, *, token=None, **kwargs):
        headers = {"apikey": self.resources.settings.supabase_publishable_key}
        if token:
            headers["Authorization"] = "Bearer " + token
        try:
            response = await self.resources.http.request(
                method, self.resources.settings.supabase_url.rstrip("/") + "/auth/v1/" + path,
                headers=headers, **kwargs,
            )
        except httpx.RequestError:
            raise HTTPException(503, "Discord 인증 서버에 연결할 수 없습니다.") from None
        if not response.is_success:
            status = 503 if response.status_code >= 500 or response.status_code == 429 else 400
            raise HTTPException(status, "Discord 인증을 완료하지 못했습니다. 계정 연결·프로바이더 설정을 확인하세요.")
        if not response.content:
            return {}
        try:
            data = response.json()
            if not isinstance(data, dict):
                raise ValueError("invalid auth response")
        except ValueError:
            raise HTTPException(502, "인증 서버 응답을 확인할 수 없습니다.") from None
        return data

    async def user(self, token, expected_id=None):
        user = await self.auth_request("GET", "user", token=token)
        if not user.get("id") or (expected_id and user["id"] != expected_id):
            raise HTTPException(403, "계정 연결을 시작한 사용자와 다릅니다.")
        return user

    async def start(self, intent, *, user_id=None, token=None):
        if not self.config.auth_enabled or self.redis is None:
            raise HTTPException(503, "Discord 로그인이 아직 설정되지 않았습니다.")
        if intent == "link" and not (user_id and token):
            raise HTTPException(401, "로그인 후 Discord를 연결하세요.")
        flow_id, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        params = {"provider": "discord", "redirect_to": self.config.callback_url,
                  "code_challenge": challenge, "code_challenge_method": "s256", "scopes": "identify email"}
        if intent == "link":
            data = await self.auth_request("GET", "user/identities/authorize", token=token,
                                           params={**params, "skip_http_redirect": "true"})
            url = data.get("url", "")
        else:
            url = self.resources.settings.supabase_url.rstrip("/") + "/auth/v1/authorize?" + urlencode(params)
        target = urlsplit(url)
        allowed = {urlsplit(self.resources.settings.supabase_url).hostname, "discord.com"}
        if target.scheme != "https" or target.hostname not in allowed or target.username or target.password:
            raise HTTPException(502, "Discord 인증 주소를 확인할 수 없습니다.")
        try:
            await self.redis.set("notecam:discord:oauth:" + flow_id, json.dumps({
                "intent": intent, "user_id": user_id, "verifier": verifier,
            }), ex=300, nx=True)
        except RedisError:
            raise HTTPException(503, "인증 진행 정보를 저장하지 못했습니다. 다시 시도하세요.") from None
        return {"flow_id": flow_id, "url": url, "expires_in": 300}

    async def complete(self, flow_id, code, *, user_id=None):
        if not self.config.auth_enabled or self.redis is None:
            raise HTTPException(503, "Discord 로그인이 아직 설정되지 않았습니다.")
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", flow_id):
            raise HTTPException(400, "인증 진행 정보를 확인할 수 없습니다.")
        key = "notecam:discord:oauth:" + flow_id
        try:
            raw = await self.redis.get(key)
            if not raw:
                raise HTTPException(400, "인증이 만료됐거나 이미 사용됐습니다. 다시 시작하세요.")
            flow = json.loads(raw)
            if flow["intent"] == "link" and flow["user_id"] != user_id:
                raise HTTPException(403, "계정 연결을 시작한 사용자로 로그인하세요.")
            if not await self.redis.getdel(key):
                raise HTTPException(400, "이미 처리 중이거나 완료된 인증입니다.")
        except RedisError:
            raise HTTPException(503, "인증 진행 정보를 확인하지 못했습니다.") from None
        data = await self.auth_request("POST", "token?grant_type=pkce", json={
            "auth_code": code, "code_verifier": flow["verifier"],
        })
        access = data.get("access_token")
        if (not isinstance(access, str) or not access
                or not isinstance(data.get("refresh_token"), str) or not data["refresh_token"]
                or type(data.get("expires_in")) is not int or data["expires_in"] <= 0):
            raise HTTPException(502, "로그인 토큰을 확인할 수 없습니다.")
        user = await self.user(access, flow["user_id"] if flow["intent"] == "link" else None)
        if discord_identity(user) is None:
            raise HTTPException(400, "인증된 Discord 계정이 없습니다.")
        profile = await ProfileRepository(self.resources.server).get_or_create(user["id"])
        if profile["status"] != "active":
            raise HTTPException(403, "비활성화된 계정입니다.")
        await self.repository.sync(user)
        return {"intent": flow["intent"], "user_id": user["id"], "tokens": {
            name: data[name] for name in ("access_token", "refresh_token", "expires_in")
        } | {"token_type": "bearer"}}

    async def connection(self, user_id, token):
        user = await self.user(token, user_id)
        row = await self.repository.sync(user)
        return self.public_connection(row, len(user.get("identities") or []) > 1)

    def public_connection(self, row, can_unlink=False):
        return {"linked": bool(row), "discord_name": row["display_name"] if row else None,
                "notifications_enabled": bool(row and row["notifications_enabled"]),
                "dm_verified": bool(row and row.get("dm_verified_at")), "can_unlink": can_unlink,
                "last_error": row.get("last_error") if row else None,
                "auth_ready": self.config.auth_enabled and self.redis is not None,
                "bot_ready": bool(self.config.bot_token)}

    async def unlink(self, user_id, token):
        user = await self.user(token, user_id)
        identity = discord_identity(user)
        if identity:
            if len(user.get("identities") or []) < 2:
                raise HTTPException(409, "유일한 로그인 수단입니다. Discord 알림만 끌 수 있습니다.")
            if not identity[2]:
                raise HTTPException(502, "연결된 인증 정보를 확인할 수 없습니다.")
            await self.repository.preference(user_id, False)
            await self.auth_request("DELETE", "user/identities/" + identity[2], token=token)
        await self.repository.remove(user_id)
