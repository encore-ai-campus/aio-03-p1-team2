"""Supabase 피드백 저장소. 모든 사용자 작업에 소유자와 삭제 조건을 적용합니다."""
from fastapi import HTTPException
from backend.common.repository import now
from backend.feedback.search import apply_feedback_search

class FeedbackRepository:
    def __init__(self, client):
        self.client = client

    async def create(self, user_id, payload):
        result = await self.client.table("feedback").insert({
            **payload.model_dump(), "user_id": user_id,
        }).execute()
        if not result.data:
            raise HTTPException(503, "피드백을 저장할 수 없습니다.")
        return result.data[0]

    async def page(self, user_id, limit, offset, status=None, kind=None, q="", feedback_id=None):
        query = self.client.table("feedback").select("*", count="exact").eq("user_id", user_id).is_("deleted_at", "null")
        if status:
            query = query.eq("status", status)
        if kind:
            query = query.eq("kind", kind)
        query = apply_feedback_search(query, q, feedback_id)
        result = await query.order("created_at", desc=True).order("id", desc=True).range(offset, offset + limit - 1).execute()
        return {"items": result.data, "total": result.count, "limit": limit, "offset": offset}

    async def get(self, user_id, identifier):
        result = await self.client.table("feedback").select("*").eq("user_id", user_id).eq("id", identifier).is_("deleted_at", "null").execute()
        if not result.data:
            raise HTTPException(404, "피드백을 찾을 수 없습니다.")
        return result.data[0]

    async def update(self, user_id, identifier, changes):
        result = await self.client.table("feedback").update({
            **changes, "updated_at": now(),
        }).eq("user_id", user_id).eq("id", identifier).is_("deleted_at", "null").execute()
        if not result.data:
            raise HTTPException(404, "피드백을 찾을 수 없습니다.")
        return result.data[0]
