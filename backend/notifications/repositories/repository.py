"""알림 API 호환용 Supabase 저장소. 테이블이 없으면 명시적으로 안내합니다."""
from fastapi import HTTPException
from postgrest.exceptions import APIError

class NotificationRepository:
    def __init__(self, client):
        self.client = client

    async def execute(self, query):
        try:
            return await query.execute()
        except APIError as exc:
            raise HTTPException(503, "알림 DB 연결이 준비되지 않았습니다. notifications 테이블 계약을 확인하세요.") from exc

    async def notifications_latest(self, owner_id, limit, offset):
        query = self.client.table("notifications").select("*", count="exact").eq("owner_id", owner_id).eq("kind", "motion").order("id", desc=True).range(offset, offset + limit - 1)
        result = await self.execute(query)
        return {"items": result.data, "total": result.count, "limit": limit, "offset": offset}

    async def mark_read(self, owner_id, identifier):
        query = self.client.table("notifications").update({"read": True}).eq("owner_id", owner_id).eq("id", identifier).eq("kind", "motion")
        result = await self.execute(query)
        if not result.data:
            raise HTTPException(404, "알림을 찾을 수 없습니다.")
        return result.data[0]
