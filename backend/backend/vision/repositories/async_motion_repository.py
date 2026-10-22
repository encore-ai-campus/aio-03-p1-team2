"""비전 API 요청 전용 비동기 저장소. 사용자 조회는 JWT·RLS, 저장은 검증 후 서버 키를 사용합니다."""

import httpx
from postgrest.exceptions import APIError
from supabase import AsyncClient

from backend.vision.errors import ApplicationError, Conflict, NotFound
from backend.vision.models.common import DataObject
from backend.vision.repositories.motion_repository import now


class AsyncMotionRepository:
    def __init__(self, client: AsyncClient, reader: AsyncClient | None = None):
        self.client = client
        self.reader = reader or client

    @staticmethod
    async def execute(query):
        try:
            return (await query.execute()).data
        except APIError as exc:
            if exc.code in {"PT409", "23505"}:
                raise Conflict(
                    exc.message
                    if exc.code == "PT409"
                    else "이미 등록되었거나 처리 중인 작업입니다."
                ) from exc
            if exc.code in {"PT422", "23514", "23503", "22P02"}:
                raise ApplicationError(
                    "INVALID_CAPTURE",
                    exc.message
                    if exc.code == "PT422"
                    else "비전 기록의 입력이 유효하지 않습니다.",
                    422,
                ) from exc
            raise ApplicationError(
                "DATABASE_UNAVAILABLE", "비전 DB 요청을 완료하지 못했습니다.", 503
            ) from exc
        except httpx.RequestError as exc:
            raise ApplicationError(
                "DATABASE_UNAVAILABLE", "비전 DB에 연결하지 못했습니다.", 503
            ) from exc

    async def get_questions(self, owner_id: str) -> DataObject | None:
        rows = await self.execute(
            self.reader.table("motion_analysis_questions")
            .select("questions,notify_on_uncertain,updated_at")
            .eq("user_id", owner_id)
            .limit(1)
        )
        return rows[0] if rows else None

    async def save_questions(self, owner_id: str, questions: list[DataObject], notify_on_uncertain: bool = False) -> DataObject:
        rows = await self.execute(
            self.client.table("motion_analysis_questions").upsert(
                {"user_id": owner_id, "questions": questions, "notify_on_uncertain": notify_on_uncertain, "updated_at": now()},
                on_conflict="user_id",
            )
        )
        return {key: rows[0][key] for key in ("questions", "notify_on_uncertain", "updated_at")}

    async def ensure_questions(self, owner_id: str, questions: list[DataObject]) -> DataObject:
        await self.execute(self.client.table("motion_analysis_questions").upsert(
            {"user_id": owner_id, "questions": questions},
            on_conflict="user_id", ignore_duplicates=True,
        ))
        return await self.get_questions(owner_id)

    async def list_cameras(self, owner_id: str) -> list[DataObject]:
        return await self.execute(
            self.reader.table("cameras")
            .select("id,name")
            .eq("owner_id", owner_id)
            .order("name")
            .order("id")
            .limit(100)
        )

    async def create_camera(self, camera_id: str, owner_id: str, name: str) -> DataObject:
        rows = await self.execute(
            self.client.table("cameras").insert(
                {"id": camera_id, "owner_id": owner_id, "name": name}
            )
        )
        return rows[0]

    async def camera(self, camera_id: str, owner_id: str) -> DataObject:
        rows = await self.execute(
            self.reader.table("cameras")
            .select("*")
            .eq("id", camera_id)
            .eq("owner_id", owner_id)
            .limit(1)
        )
        if not rows:
            raise NotFound("카메라")
        return rows[0]

    async def _owned(
        self, entity: str, identifier: str, owner_id: str | None
    ) -> DataObject:
        tables = {
            "run": ("motion_runs", ["cameras"], "실행"),
            "event": ("motion_events", ["motion_runs", "cameras"], "사건"),
            "part": (
                "motion_parts",
                ["motion_events", "motion_runs", "cameras"],
                "사진 묶음",
            ),
            "photo": (
                "motion_photos",
                ["motion_parts", "motion_events", "motion_runs", "cameras"],
                "사진",
            ),
            "analysis": (
                "motion_analyses",
                ["motion_parts", "motion_events", "motion_runs", "cameras"],
                "분석",
            ),
        }
        table, parents, label = tables[entity]
        columns = "*"
        if owner_id is not None:
            nested = "owner_id"
            for parent in reversed(parents):
                nested = f"{parent}!inner({nested})"
            columns += "," + nested
        query = self.reader.table(table).select(columns).eq("id", identifier)
        if owner_id is not None:
            query = query.eq(".".join([*parents, "owner_id"]), owner_id)
        rows = await self.execute(query.limit(1))
        if not rows:
            raise NotFound(label)
        rows[0].pop(parents[0], None)
        return rows[0]

    async def get_run(self, run_id: str, owner_id: str | None = None) -> DataObject:
        return await self._owned("run", run_id, owner_id)

    async def get_event(self, event_id: str, owner_id: str | None = None) -> DataObject:
        return await self._owned("event", event_id, owner_id)

    async def get_part(self, part_id: str, owner_id: str | None = None) -> DataObject:
        return await self._owned("part", part_id, owner_id)

    async def get_photo(self, photo_id: str, owner_id: str | None) -> DataObject:
        return await self._owned("photo", photo_id, owner_id)

    async def get_analysis(self, analysis_id: str, owner_id: str | None) -> DataObject:
        return await self._owned("analysis", analysis_id, owner_id)

    async def create_run(self, run_id: str, camera_id: str, config: DataObject) -> None:
        await self.execute(
            self.client.table("motion_runs").insert(
                {
                    "id": run_id,
                    "camera_id": camera_id,
                    "config": config,
                    "requested_at": now(),
                }
            )
        )

    async def stop_run(self, run_id: str) -> None:
        await self.execute(
            self.client.table("motion_runs")
            .update({"status": "stopping"})
            .eq("id", run_id)
            .in_("status", ["starting", "running"])
        )

    async def finish_run(
        self, run_id: str, status: str, error_message: str | None
    ) -> None:
        await self.execute(
            self.client.rpc(
                "motion_finish_run",
                {"p_run_id": run_id, "p_status": status, "p_error": error_message},
            )
        )

    async def list_runs(self, owner_id: str, limit: int) -> list[DataObject]:
        rows = await self.execute(
            self.reader.table("motion_runs")
            .select("*,cameras!inner(owner_id)")
            .eq("cameras.owner_id", owner_id)
            .order("requested_at", desc=True)
            .order("id", desc=True)
            .limit(limit)
        )
        return [{k: v for k, v in row.items() if k != "cameras"} for row in rows]

    async def list_events(
        self, owner_id: str | None, run_id: str | None, limit: int, finished_only: bool = False,
        *, camera_id: str | None = None,
    ) -> list[DataObject]:
        query = self.reader.table("motion_events").select(
            "*,motion_runs!inner(cameras!inner(owner_id)),"
            "motion_event_analyses(status,result),"
            "motion_parts(part_index,motion_analyses(status,result))"
        ).eq("motion_parts.part_index", 1).eq("motion_parts.motion_analyses.origin", "auto")
        if owner_id is not None:
            query = query.eq("motion_runs.cameras.owner_id", owner_id)
        if camera_id is not None:
            query = query.eq("motion_runs.camera_id", camera_id)
        if run_id is not None:
            await self.get_run(run_id, owner_id)
            query = query.eq("run_id", run_id)
        if finished_only:
            query = query.in_("capture_state", ["closed", "interrupted"])
        rows = await self.execute(
            query.order("detected_at", desc=True).order("id", desc=True).limit(limit)
        )
        return [{k: v for k, v in row.items() if k != "motion_runs"} for row in rows]

    async def list_parts(
        self, event_id: str, owner_id: str | None, after: int, limit: int
    ) -> list[DataObject]:
        await self.get_event(event_id, owner_id)
        return await self.execute(
            self.reader.table("motion_parts")
            .select("*")
            .eq("event_id", event_id)
            .gt("part_index", after)
            .order("part_index")
            .limit(limit)
        )

    async def list_photos(self, part_id: str) -> list[DataObject]:
        return await self.execute(
            self.reader.table("motion_photos")
            .select("*")
            .eq("part_id", part_id)
            .order("sequence_no")
        )

    async def list_analyses(
        self, part_id: str, owner_id: str | None, limit: int
    ) -> list[DataObject]:
        await self.get_part(part_id, owner_id)
        return await self.execute(
            self.reader.table("motion_analyses")
            .select("*")
            .eq("part_id", part_id)
            .order("created_at", desc=True)
            .order("id", desc=True)
            .limit(limit)
        )

    async def create_analysis(
        self, part_id: str, owner_id: str, questions: list[DataObject], model_name: str
    ) -> DataObject:
        await self.get_part(part_id, owner_id)
        analysis_id = await self.execute(
            self.client.rpc(
                "motion_create_analysis",
                {
                    "p_part_id": part_id,
                    "p_owner_id": owner_id,
                    "p_questions": questions,
                    "p_model": model_name,
                },
            )
        )
        return await self.get_analysis(analysis_id, owner_id)

    async def event_part_analyses(self, event_id: str) -> list[DataObject]:
        result = []
        offset = 0
        while True:
            rows = await self.execute(
                self.reader.table("motion_parts")
                .select(
                    "id,part_index,metadata,motion_analyses(id,questions,model_name,status,result,error_message,created_at,finished_at,latency_ms)"
                )
                .eq("event_id", event_id)
                .eq("motion_analyses.origin", "auto")
                .order("part_index")
                .range(offset, offset + 999)
            )
            for row in rows:
                analyses = row.pop("motion_analyses")
                source = analyses[0] if analyses else {}
                result.append(
                    {
                        "part_id": row["id"],
                        "part_index": row["part_index"],
                        "metadata": row["metadata"],
                        "analysis_id": source.get("id"),
                        **{
                            key: source.get(key)
                            for key in (
                                "questions",
                                "model_name",
                                "status",
                                "result",
                                "error_message",
                                "created_at",
                                "finished_at",
                                "latency_ms",
                            )
                        },
                    }
                )
            if len(rows) < 1000:
                return result
            offset += 1000

    async def get_event_synthesis(self, event_id: str) -> DataObject | None:
        rows = await self.execute(
            self.reader.table("motion_event_analyses")
            .select("*")
            .eq("event_id", event_id)
            .limit(1)
        )
        return rows[0] if rows else None
