"""관리자 변경과 감사 로그는 서버 전용 RPC의 같은 트랜잭션에서 저장합니다."""
from fastapi import HTTPException
from postgrest.exceptions import APIError
from backend.feedback.search import apply_feedback_search

class AdminRepository:
    def __init__(self, client):
        self.client = client

    async def feedback_page(self, limit, offset, status=None, kind=None, q="", feedback_id=None):
        query = self.client.table("feedback").select("*", count="exact").is_("deleted_at", "null")
        if status:
            query = query.eq("status", status)
        if kind:
            query = query.eq("kind", kind)
        query = apply_feedback_search(query, q, feedback_id)
        result = await query.order("created_at", desc=True).order("id", desc=True).range(offset, offset + limit - 1).execute()
        return {"items": result.data, "total": result.count, "limit": limit, "offset": offset}

    async def users_page(self, actor_id, limit, offset):
        result = await self.client.rpc("web_admin_users_page", {
            "p_actor_id": actor_id, "p_limit": limit, "p_offset": offset,
        }).execute()
        return result.data

    async def change(self, actor_id, target_type, target_id, changes, action="update"):
        try:
            result = await self.client.rpc("web_admin_change", {
                "p_actor_id": actor_id, "p_target_type": target_type,
                "p_target_id": str(target_id), "p_changes": changes, "p_action": action,
            }).execute()
        except APIError as exc:
            if exc.code == "P0002":
                raise HTTPException(404, "대상을 찾을 수 없습니다.") from exc
            if exc.code == "42501":
                raise HTTPException(403, "관리자 권한이 필요합니다.") from exc
            if exc.code == "22023":
                raise HTTPException(409, "허용되지 않는 변경입니다. 마지막 활성 관리자와 본인 계정은 보호됩니다.") from exc
            raise
        return result.data

    async def audit_page(self, limit, offset):
        result = await self.client.table("admin_audit_logs").select("*", count="exact").order("created_at", desc=True).order("id", desc=True).range(offset, offset + limit - 1).execute()
        return {"items": result.data, "total": result.count, "limit": limit, "offset": offset}
