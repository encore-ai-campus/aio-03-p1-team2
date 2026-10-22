"""서버 전용 SDK를 사용하며 사용자 ID는 검증된 Auth 응답에서 받습니다."""
from fastapi import HTTPException
from backend.common.repository import now

class ProfileRepository:
    def __init__(self, client):
        self.client = client

    async def get_or_create(self, user_id):
        result = await self.client.table("profiles").select("*").eq("id", user_id).execute()
        if not result.data:
            # 기존 관리자 권한이나 비활성 상태를 덮어쓰지 않습니다.
            await self.client.table("profiles").upsert(
                {"id": user_id}, on_conflict="id", ignore_duplicates=True,
            ).execute()
            result = await self.client.table("profiles").select("*").eq("id", user_id).execute()
        if not result.data:
            raise HTTPException(503, "사용자 프로필을 준비할 수 없습니다.")
        return result.data[0]

    async def update(self, user_id, payload):
        result = await self.client.table("profiles").update({
            "display_name": payload.display_name, "updated_at": now(),
        }).eq("id", user_id).execute()
        if not result.data:
            raise HTTPException(404, "사용자 프로필을 찾을 수 없습니다.")
        return result.data[0]
