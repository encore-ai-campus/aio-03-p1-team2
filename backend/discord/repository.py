"""Discord 테이블/RPC만 변경합니다. ID의 출처는 검증된 Auth identities입니다."""

import re
from datetime import datetime, timezone

from fastapi import HTTPException
from postgrest.exceptions import APIError


def discord_identity(user):
    # user_metadata는 사용자가 수정할 수 있으므로 신원 확인에 사용하지 않습니다.
    for identity in user.get("identities") or []:
        if identity.get("provider") == "discord":
            identifier = identity.get("id", "")
            if not re.fullmatch(r"[1-9][0-9]{16,19}", str(identifier)):
                raise HTTPException(502, "Discord 계정 정보를 확인할 수 없습니다.")
            data = identity.get("identity_data") or {}
            name = data.get("full_name") or data.get("name") or data.get("username") or "Discord 사용자"
            return str(identifier), str(name)[:100], identity.get("identity_id")
    return None


class DiscordRepository:
    def __init__(self, client):
        self.client = client

    async def execute(self, query):
        try:
            return (await query.execute()).data
        except APIError as exc:
            if exc.code == "23505":
                raise HTTPException(409, "이미 다른 계정에 연결된 Discord입니다.") from None
            raise HTTPException(503, "Discord DB 설정을 확인하세요. docs/backend/discord.sql 적용이 필요합니다.") from None

    async def connection(self, user_id):
        rows = await self.execute(self.client.table("discord_connections").select("*").eq("user_id", user_id))
        return rows[0] if rows else None

    async def sync(self, user):
        identity = discord_identity(user)
        if identity is None:
            await self.remove(user["id"])
            return None
        return await self.execute(self.client.rpc("discord_sync_connection", {
            "p_user": user["id"], "p_discord_id": identity[0], "p_name": identity[1],
        }))

    async def preference(self, user_id, enabled):
        row = await self.execute(self.client.rpc("discord_set_notifications", {
            "p_user": user_id, "p_enabled": enabled,
        }))
        if not row:
            raise HTTPException(409, "Discord 연결과 테스트 DM을 먼저 완료하세요.")
        return row

    async def verified(self, user_id, discord_id, channel_id):
        rows = await self.execute(self.client.table("discord_connections").update({
            "dm_channel_id": channel_id, "dm_verified_at": datetime.now(timezone.utc).isoformat(),
            "last_error": None,
        }).eq("user_id", user_id).eq("discord_user_id", discord_id))
        if not rows:
            raise HTTPException(409, "연결된 Discord 계정이 변경됐습니다. 다시 시도하세요.")
        return rows[0]

    async def remove(self, user_id):
        await self.execute(self.client.table("discord_connections").delete().eq("user_id", user_id))

    async def error(self, user_id, message):
        await self.execute(self.client.table("discord_connections").update({"last_error": message}).eq("user_id", user_id))

    async def claim(self):
        return await self.execute(self.client.rpc("discord_claim_delivery", {}))

    async def finish(self, job, status, *, message_id=None, error=None, retry_after=None):
        return await self.execute(self.client.rpc("discord_finish_delivery", {
            "p_id": job["notification_id"], "p_claim": job["claim_token"],
            "p_status": status, "p_message_id": message_id,
            "p_error": error, "p_retry_after": retry_after,
        }))

    async def recipient(self, job):
        row = await self.connection(job["owner_id"])
        if not row or not row["notifications_enabled"] or row["discord_user_id"] != job["discord_user_id"]:
            return None
        if not row.get("enabled_at") or datetime.fromisoformat(job["created_at"].replace("Z", "+00:00")) < datetime.fromisoformat(row["enabled_at"].replace("Z", "+00:00")):
            return None
        # Auth에서 연결 해제/비활성화된 사용자에게도 발송하지 않습니다.
        response = await self.client.auth.admin.get_user_by_id(job["owner_id"])
        user = response.user.model_dump(mode="json") if response.user else {}
        identity = discord_identity(user)
        if not identity or identity[0] != row["discord_user_id"]:
            return None
        profiles = await self.execute(self.client.table("profiles").select("status").eq("id", job["owner_id"]))
        return row if profiles and profiles[0]["status"] == "active" else None
