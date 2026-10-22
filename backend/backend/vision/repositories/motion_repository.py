"""백그라운드 스레드용 동기 SDK 저장소. API 요청은 AsyncMotionRepository를 사용합니다."""

import uuid
from datetime import UTC, datetime

import httpx
from postgrest.exceptions import APIError
from supabase import Client

from backend.vision.errors import ApplicationError, Conflict, NotFound
from backend.vision.models.common import DataObject
from backend.vision.models.manifests import BundleManifest


def now() -> str:
    return datetime.now(UTC).isoformat()


class MotionRepository:
    def __init__(self, client: Client, reader: Client | None = None):
        self.client = client
        # 사용자 요청은 JWT·RLS로 조회하고, 작업자는 서버 키로 조회합니다.
        self.reader = reader or client

    @staticmethod
    def execute(query):
        try:
            return query.execute().data
        except APIError as exc:
            if exc.code in {"PT409", "23505"}:
                raise Conflict(
                    exc.message if exc.code == "PT409" else "이미 등록되었거나 처리 중인 작업입니다."
                ) from exc
            if exc.code in {"PT422", "23514", "23503", "22P02"}:
                raise ApplicationError(
                    "INVALID_CAPTURE", exc.message if exc.code == "PT422" else "비전 기록의 입력이 유효하지 않습니다.", 422
                ) from exc
            raise ApplicationError(
                "DATABASE_UNAVAILABLE", "비전 DB 요청을 완료하지 못했습니다.", 503
            ) from exc
        except httpx.RequestError as exc:
            raise ApplicationError(
                "DATABASE_UNAVAILABLE", "비전 DB에 연결하지 못했습니다.", 503
            ) from exc

    def check_schema(self) -> None:
        # 서버 시작은 검사만 수행합니다. 스키마·함수는 SQL Editor에서 적용합니다.
        for table, columns in (
            ("motion_photos", "id,upload_status,byte_size,sha256"),
            ("motion_analysis_questions", "user_id,questions,updated_at"),
            ("motion_events", "final_part_index,questions"),
            ("motion_event_analyses", "event_id,sources,questions"),
        ):
            self.execute(self.client.table(table).select(columns).limit(0))

    def get_questions(self, owner_id: str) -> DataObject | None:
        rows = self.execute(self.reader.table("motion_analysis_questions")
                            .select("questions,updated_at").eq("user_id", owner_id).limit(1))
        return rows[0] if rows else None

    def save_questions(self, owner_id: str, questions: list[DataObject]) -> DataObject:
        rows = self.execute(self.client.table("motion_analysis_questions").upsert({
            "user_id": owner_id, "questions": questions, "updated_at": now(),
        }, on_conflict="user_id"))
        return {key: rows[0][key] for key in ("questions", "updated_at")}

    def camera(self, camera_id: str, owner_id: str) -> DataObject:
        rows = self.execute(self.reader.table("cameras").select("*")
                            .eq("id", camera_id).eq("owner_id", owner_id).limit(1))
        if not rows:
            raise NotFound("카메라")
        return rows[0]

    def _owned(self, entity: str, identifier: str, owner_id: str | None) -> DataObject:
        tables = {
            "run": ("motion_runs", ["cameras"], "실행"),
            "event": ("motion_events", ["motion_runs", "cameras"], "사건"),
            "part": ("motion_parts", ["motion_events", "motion_runs", "cameras"], "사진 묶음"),
            "photo": ("motion_photos", ["motion_parts", "motion_events", "motion_runs", "cameras"], "사진"),
            "analysis": ("motion_analyses", ["motion_parts", "motion_events", "motion_runs", "cameras"], "분석"),
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
        rows = self.execute(query.limit(1))
        if not rows:
            raise NotFound(label)
        rows[0].pop(parents[0], None)
        return rows[0]

    def get_run(self, run_id: str, owner_id: str | None = None) -> DataObject:
        return self._owned("run", run_id, owner_id)

    def get_event(self, event_id: str, owner_id: str | None = None) -> DataObject:
        return self._owned("event", event_id, owner_id)

    def get_part(self, part_id: str, owner_id: str | None = None) -> DataObject:
        return self._owned("part", part_id, owner_id)

    def get_photo(self, photo_id: str, owner_id: str) -> DataObject:
        return self._owned("photo", photo_id, owner_id)

    def get_analysis(self, analysis_id: str, owner_id: str) -> DataObject:
        return self._owned("analysis", analysis_id, owner_id)

    def create_run(self, run_id: str, camera_id: str, config: DataObject) -> None:
        self.execute(self.client.table("motion_runs").insert({
            "id": run_id, "camera_id": camera_id, "config": config, "requested_at": now(),
        }))

    def start_run(self, run_id: str, started_at: datetime) -> None:
        self.execute(self.client.rpc("motion_start_run", {
            "p_run_id": run_id, "p_started_at": started_at.isoformat(),
        }))

    def stop_run(self, run_id: str) -> None:
        self.execute(self.client.table("motion_runs").update({"status": "stopping"})
                     .eq("id", run_id).in_("status", ["starting", "running"]))

    def finish_run(self, run_id: str, status: str, error_message: str | None) -> None:
        self.execute(self.client.rpc("motion_finish_run", {
            "p_run_id": run_id, "p_status": status, "p_error": error_message,
        }))

    def recover(self) -> None:
        self.execute(self.client.rpc("motion_recover", {}))

    def list_runs(self, owner_id: str, limit: int) -> list[DataObject]:
        rows = self.execute(self.reader.table("motion_runs")
                            .select("*,cameras!inner(owner_id)").eq("cameras.owner_id", owner_id)
                            .order("requested_at", desc=True).order("id", desc=True).limit(limit))
        return [{k: v for k, v in row.items() if k != "cameras"} for row in rows]

    def list_events(self, owner_id: str, run_id: str | None, limit: int) -> list[DataObject]:
        query = self.reader.table("motion_events").select("*,motion_runs!inner(cameras!inner(owner_id))")
        query = query.eq("motion_runs.cameras.owner_id", owner_id)
        if run_id is not None:
            self.get_run(run_id, owner_id)
            query = query.eq("run_id", run_id)
        rows = self.execute(query.order("detected_at", desc=True).order("id", desc=True).limit(limit))
        return [{k: v for k, v in row.items() if k != "motion_runs"} for row in rows]

    def list_parts(self, event_id: str, owner_id: str, after: int, limit: int) -> list[DataObject]:
        self.get_event(event_id, owner_id)
        return self.execute(self.reader.table("motion_parts").select("*").eq("event_id", event_id)
                            .gt("part_index", after).order("part_index").limit(limit))

    def list_photos(self, part_id: str) -> list[DataObject]:
        return self.execute(self.reader.table("motion_photos").select("*")
                            .eq("part_id", part_id).order("sequence_no"))

    def list_analyses(self, part_id: str, owner_id: str, limit: int) -> list[DataObject]:
        self.get_part(part_id, owner_id)
        return self.execute(self.reader.table("motion_analyses").select("*").eq("part_id", part_id)
                            .order("created_at", desc=True).order("id", desc=True).limit(limit))

    def register_bundle(self, bundle: BundleManifest, photos: list[DataObject]) -> str:
        part_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"motion:part:{bundle.event_id}:{bundle.part_index}"))
        records = [
            {"id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"motion:photo:{part_id}:{index}")),
             "sequence_no": index, "timestamp_sec": photo["timestamp_sec"],
             "byte_size": photo["byte_size"], "sha256": photo["sha256"]}
            for index, photo in enumerate(photos, start=1)
        ]
        return self.execute(self.client.rpc("motion_register_bundle", {
            "p_part_id": part_id, "p_bundle": bundle.model_dump(mode="json"), "p_photos": records,
        }))

    def ready_photo(self, photo_id: str) -> None:
        self.execute(self.client.table("motion_photos").update({"upload_status": "ready"}).eq("id", photo_id))

    def interrupt_pending_bundle(self, event_id: str, part_index: int) -> None:
        parts = self.execute(self.client.table("motion_parts")
                             .select("motion_photos(upload_status),motion_analyses(origin)")
                             .eq("event_id", event_id).eq("part_index", part_index))
        # 접수 응답만 유실됐거나 로컬 삭제가 실패했어도 저장 완료된 사건은 유지합니다.
        if parts and parts[0]["motion_photos"] and all(
            photo["upload_status"] == "ready" for photo in parts[0]["motion_photos"]
        ) and any(analysis["origin"] == "auto" for analysis in parts[0]["motion_analyses"]):
            return
        self.execute(self.client.table("motion_events").update({"capture_state": "interrupted"})
                     .eq("id", event_id))

    def queue_auto_analysis(self, part_id: str, model_name: str) -> None:
        self.execute(self.client.rpc("motion_queue_auto_analysis", {
            "p_part_id": part_id, "p_model": model_name,
        }))

    def create_analysis(self, part_id: str, owner_id: str, questions: list[DataObject], model_name: str) -> DataObject:
        self.get_part(part_id, owner_id)
        analysis_id = self.execute(self.client.rpc("motion_create_analysis", {
            "p_part_id": part_id, "p_owner_id": owner_id, "p_questions": questions, "p_model": model_name,
        }))
        return self.get_analysis(analysis_id, owner_id)

    def claim_analysis(self) -> DataObject | None:
        return self.execute(self.client.rpc("motion_claim_analysis", {}))

    def finish_analysis(self, analysis_id: str, result: DataObject | None,
                        error_message: str | None, latency_ms: int) -> DataObject | None:
        return self.execute(self.client.rpc("notification_finish_analysis", {
            "p_analysis_id": analysis_id, "p_is_event": False, "p_result": result,
            "p_error": error_message, "p_latency_ms": latency_ms,
        }))

    def event_part_analyses(self, event_id: str) -> list[DataObject]:
        # 종합 작업 자체는 RPC가 전체 입력을 읽습니다. 조회는 페이지를 이어 읽어 누락을 막습니다.
        result = []
        offset = 0
        while True:
            rows = self.execute(self.reader.table("motion_parts").select(
                "id,part_index,metadata,motion_analyses(id,questions,model_name,status,result,error_message,created_at,finished_at,latency_ms)"
            ).eq("event_id", event_id).eq("motion_analyses.origin", "auto")
                .order("part_index").range(offset, offset + 999))
            for row in rows:
                analyses = row.pop("motion_analyses")
                source = analyses[0] if analyses else {}
                result.append({
                    "part_id": row["id"], "part_index": row["part_index"], "metadata": row["metadata"],
                    "analysis_id": source.get("id"),
                    **{key: source.get(key) for key in (
                        "questions", "model_name", "status", "result", "error_message",
                        "created_at", "finished_at", "latency_ms",
                    )},
                })
            if len(rows) < 1000:
                return result
            offset += 1000

    def get_event_synthesis(self, event_id: str) -> DataObject | None:
        rows = self.execute(self.reader.table("motion_event_analyses").select("*").eq("event_id", event_id).limit(1))
        return rows[0] if rows else None

    def claim_event_analysis(self) -> DataObject | None:
        return self.execute(self.client.rpc("motion_claim_event_analysis", {}))

    def finish_event_analysis(self, analysis_id: str, result: DataObject | None,
                              error_message: str | None, latency_ms: int) -> DataObject | None:
        return self.execute(self.client.rpc("notification_finish_analysis", {
            "p_analysis_id": analysis_id, "p_is_event": True, "p_result": result,
            "p_error": error_message, "p_latency_ms": latency_ms,
        }))
