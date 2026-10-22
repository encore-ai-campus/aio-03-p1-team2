"""실제 로컬 Supabase RPC에서 사건 등록·종료·분석 선점의 동시성을 검증합니다.

VISION_TEST_ENV의 별도 빈 로컬 스택에서만 실행합니다. SQL 연결은 테스트 데이터
준비·잠금 관찰에만 사용하고, 실제 Repository 호출은 Supabase SDK를 사용합니다.
"""

import asyncio
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from urllib.parse import urlparse
from uuid import NAMESPACE_URL, uuid4, uuid5

import httpx
import psycopg
import pytest
from dotenv import dotenv_values
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from backend.config import Settings
from backend.vision.errors import Conflict
from backend.vision.models.analyses import AnalysisResult, DEFAULT_QUESTION_TEXT
from backend.vision.models.manifests import BundleManifest
from backend.vision.repositories.motion_repository import MotionRepository
from backend.common.supabase import create_supabase_client, create_sync_supabase_client
from backend.vision.config import VisionSettings
from backend.vision.repositories.async_motion_repository import AsyncMotionRepository
from backend.vision.services.motion_analysis_service import MotionAnalysisService
from backend.vision.services.motion_workers import AnalysisWorker


def questions(text):
    return [{"id": str(uuid4()), "question": text}]

def result_for(questions, text, verdict="confirmed"):
    return {"items": [{"question_id": q["id"], "verdict": verdict, "summary": text} for q in questions]}


class TestDatabase:
    __test__ = False

    def __init__(self, url):
        self.url = url

    @contextmanager
    def connect(self):
        with psycopg.connect(self.url, row_factory=dict_row, connect_timeout=5) as connection:
            yield connection


@pytest.fixture
def capture():
    path = os.getenv("VISION_TEST_ENV")
    if not path:
        pytest.skip("Supabase 통합 테스트에는 VISION_TEST_ENV가 필요합니다.")
    env = dotenv_values(path)
    for key in ("SUPABASE_URL", "VISION_DATABASE_URL"):
        if urlparse(env[key]).hostname not in {"localhost", "127.0.0.1", "::1"}:
            pytest.fail("동시성 테스트는 별도 로컬 스택에서만 실행하세요.")
    database = TestDatabase(env["VISION_DATABASE_URL"])
    with database.connect() as connection:
        assert not connection.execute("SELECT EXISTS(SELECT 1 FROM auth.users) AS populated").fetchone()["populated"], "별도 빈 로컬 스택에서 실행하세요."
    admin = {"apikey": env["SUPABASE_SECRET_KEY"]}
    sdk_settings = Settings(auth_provider="supabase", supabase_url=env["SUPABASE_URL"],
        supabase_publishable_key=env["SUPABASE_PUBLISHABLE_KEY"], supabase_secret_key=env["SUPABASE_SECRET_KEY"])
    with httpx.Client(timeout=10) as http:
        response = http.post(env["SUPABASE_URL"] + "/auth/v1/admin/users", headers=admin,
            json={"email": f"concurrency-{uuid4().hex}@example.com", "password": uuid4().hex + "Aa1!", "email_confirm": True})
        assert response.is_success
        owner_id = response.json()["id"]
        camera_id = str(uuid4())
        try:
            with database.connect() as connection:
                connection.execute("INSERT INTO cameras(id,owner_id,name) VALUES (%s,%s,'RPC test')", (camera_id, owner_id))
            repository = MotionRepository(create_sync_supabase_client(sdk_settings, http))
            run_id = uuid4().hex
            repository.create_run(run_id, camera_id, {})
            repository.start_run(run_id, datetime.now(UTC))
            bundle = BundleManifest(
                schema_version=1, run_id=run_id, event_id=run_id + "_e000001",
                part_index=1, start_sec=0, end_sec=10, trigger_sec=3,
                episode_end=False, context_complete=True, evidence_complete=True,
                images=[{"path": "test.jpg", "timestamp_sec": 3}],
            )
            yield SimpleNamespace(settings=sdk_settings, database=database, repository=repository, bundle=bundle,
                owner_id=owner_id, photos=[{"timestamp_sec": 3, "byte_size": 1, "sha256": "0" * 64}])
        finally:
            with database.connect() as connection:
                for table in ("motion_analyses", "motion_photos"):
                    connection.execute(sql.SQL("DELETE FROM {} WHERE part_id IN (SELECT p.id FROM motion_parts p JOIN motion_events e ON e.id=p.event_id JOIN motion_runs r ON r.id=e.run_id WHERE r.camera_id=%s)").format(sql.Identifier(table)), (camera_id,))
                connection.execute("DELETE FROM motion_event_analyses WHERE event_id IN (SELECT e.id FROM motion_events e JOIN motion_runs r ON r.id=e.run_id WHERE r.camera_id=%s)", (camera_id,))
                connection.execute("DELETE FROM motion_parts WHERE event_id IN (SELECT e.id FROM motion_events e JOIN motion_runs r ON r.id=e.run_id WHERE r.camera_id=%s)", (camera_id,))
                connection.execute("DELETE FROM motion_events WHERE run_id IN (SELECT id FROM motion_runs WHERE camera_id=%s)", (camera_id,))
                connection.execute("DELETE FROM motion_runs WHERE camera_id=%s", (camera_id,))
                connection.execute("DELETE FROM cameras WHERE id=%s", (camera_id,))
            assert http.delete(env["SUPABASE_URL"] + "/auth/v1/admin/users/" + owner_id, headers=admin).is_success


def event_analysis(capture):
    async def fetch():
        async with httpx.AsyncClient(timeout=10) as http:
            client = await create_supabase_client(capture.settings, http)
            service = MotionAnalysisService(AsyncMotionRepository(client), VisionSettings())
            return await service.get_event(capture.bundle.event_id, capture.owner_id)

    return asyncio.run(fetch())


@pytest.mark.parametrize("first", ["register", "finish"])
@pytest.mark.parametrize("terminal_status", ["stopped", "failed"])
def test_register_and_finish_serialize_on_run(capture, first, terminal_status):
    # 앞선 RPC를 커밋 전 상태로 유지하고, 실제 HTTP RPC가 같은 실행 행에서
    # 대기하는 것을 DB에서 확인한 후 커밋합니다. sleep으로 순서를 추측하지 않습니다.
    with capture.database.connect() as holder:
        holder_pid = holder.execute("SELECT pg_backend_pid() AS pid").fetchone()["pid"]
        if first == "register":
            part_id = str(uuid5(NAMESPACE_URL, f"motion:part:{capture.bundle.event_id}:1"))
            photos = [{**capture.photos[0], "id": str(uuid5(NAMESPACE_URL, f"motion:photo:{part_id}:1")), "sequence_no": 1}]
            holder.execute("SELECT public.motion_register_bundle(%s,%s,%s)",
                (part_id, Jsonb(capture.bundle.model_dump(mode="json")), Jsonb(photos)))
            operation = lambda: capture.repository.finish_run(capture.bundle.run_id, terminal_status, None)
        else:
            holder.execute("SELECT public.motion_finish_run(%s,%s,NULL)", (capture.bundle.run_id, terminal_status))
            operation = lambda: capture.repository.register_bundle(capture.bundle, capture.photos)
        with ThreadPoolExecutor(max_workers=1) as executor:
            waiter = executor.submit(operation)
            try:
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    with capture.database.connect() as observer:
                        blocked = observer.execute("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE %s=ANY(pg_blocking_pids(pid))) AS blocked", (holder_pid,)).fetchone()["blocked"]
                    if blocked:
                        break
                    if waiter.done():
                        waiter.result()
                        pytest.fail("앞선 RPC가 커밋되기 전에 후속 작업이 끝났습니다.")
                    threading.Event().wait(0.01)
                else:
                    pytest.fail("RPC의 실행 행 잠금 대기를 확인하지 못했습니다.")
            finally:
                holder.commit()
            waiter.result(timeout=5)
    assert capture.repository.get_run(capture.bundle.run_id)["status"] == terminal_status
    assert capture.repository.get_event(capture.bundle.event_id)["capture_state"] == "interrupted"


@pytest.mark.parametrize("episode_end,expected", [(False, "interrupted"), (True, "closed")])
def test_late_bundle_preserves_terminal_capture_state(capture, episode_end, expected):
    capture.repository.finish_run(capture.bundle.run_id, "stopped", None)
    bundle = capture.bundle.model_copy(update={"episode_end": episode_end})
    capture.repository.register_bundle(bundle, capture.photos)
    assert capture.repository.get_event(bundle.event_id)["capture_state"] == expected


def test_ready_part_can_be_analyzed_while_event_is_collecting(capture):
    repository = capture.repository
    part_id = repository.register_bundle(capture.bundle, capture.photos)
    with pytest.raises(Conflict):
        repository.queue_auto_analysis(part_id, "test-model")
    for photo in repository.list_photos(part_id):
        repository.ready_photo(photo["id"])
    repository.queue_auto_analysis(part_id, "test-model")
    job = repository.claim_analysis()
    assert job["part_id"] == part_id
    assert job["status"] == "running"
    assert repository.get_run(capture.bundle.run_id)["status"] == "running"
    assert repository.get_event(capture.bundle.event_id)["capture_state"] == "collecting"


def ready_part(capture, index, *, final=False, queue=True):
    bundle = capture.bundle.model_copy(update={"part_index": index, "episode_end": final})
    part_id = capture.repository.register_bundle(bundle, capture.photos)
    for photo in capture.repository.list_photos(part_id):
        capture.repository.ready_photo(photo["id"])
    if queue:
        capture.repository.queue_auto_analysis(part_id, "test-model")
    return part_id


def finish_part(repository, *, success=True):
    job = repository.claim_analysis()
    assert job is not None
    repository.finish_analysis(
        job["id"], result_for(job["questions"], "관찰된 행동", "not_confirmed") if success else None,
        None if success else "묶음 분석 실패", 10,
    )
    return job


def test_single_part_reuses_result_without_event_model_call(capture):
    ready_part(capture, 1, final=True)
    analyzer = Mock()
    analyzer.analyze.return_value = AnalysisResult.model_validate(result_for(capture.repository.get_event(capture.bundle.event_id)["questions"], "사람이 들어옴", "not_confirmed"))
    worker = AnalysisWorker(capture.repository, analyzer)
    assert worker.process_one()
    assert not worker.process_one()
    analyzer.analyze.assert_called_once()
    analyzer.synthesize.assert_not_called()
    result = event_analysis(capture)
    assert result["basis"] == "part"
    assert result["status"] == "succeeded"
    assert result["result"]["items"][0]["verdict"] == "not_confirmed"
    assert capture.repository.get_event_synthesis(capture.bundle.event_id) is None


def test_event_synthesis_waits_for_capture_upload_and_all_auto_results(capture):
    repository = capture.repository
    ready_part(capture, 1)
    finish_part(repository)
    ready_part(capture, 2)
    finish_part(repository)
    assert repository.claim_event_analysis() is None  # 아직 촬영 중
    last = ready_part(capture, 3, final=True, queue=False)
    assert repository.claim_event_analysis() is None  # 자동 분석 미등록
    repository.queue_auto_analysis(last, "test-model")
    assert repository.claim_event_analysis() is None  # 분석 대기 중
    part_job = repository.claim_analysis()
    assert repository.claim_event_analysis() is None  # 분석 실행 중
    repository.finish_analysis(part_job["id"], result_for(part_job["questions"], "물건을 들고 나감"), None, 1)
    analyzer = Mock()
    analyzer.synthesize.return_value = AnalysisResult.model_validate(result_for(part_job["questions"], "들어온 사람이 물건을 들고 나감"))
    worker = AnalysisWorker(repository, analyzer)
    assert worker.process_one()
    assert not worker.process_one()
    analyzer.analyze.assert_not_called()
    job = analyzer.synthesize.call_args.args[0]
    assert [s["part_index"] for s in job["sources"]] == [1, 2, 3]
    final = event_analysis(capture)
    assert final["basis"] == "synthesis"
    assert final["status"] == "succeeded"
    assert final["result"]["items"][0]["verdict"] == "confirmed"


def test_last_bundle_arriving_first_waits_for_missing_indices(capture):
    repository = capture.repository
    ready_part(capture, 3, final=True)
    finish_part(repository)
    ready_part(capture, 1)
    finish_part(repository)
    assert repository.claim_event_analysis() is None
    ready_part(capture, 2)
    finish_part(repository)
    job = repository.claim_event_analysis()
    assert [s["part_index"] for s in job["sources"]] == [1, 2, 3]


def test_failed_part_marks_event_failed_without_synthesis_call(capture):
    ready_part(capture, 1)
    finish_part(capture.repository, success=False)
    ready_part(capture, 2, final=True)
    finish_part(capture.repository)
    analyzer = Mock()
    worker = AnalysisWorker(capture.repository, analyzer)
    assert worker.process_one()
    assert not worker.process_one()
    analyzer.synthesize.assert_not_called()
    result = capture.repository.get_event_synthesis(capture.bundle.event_id)
    assert result["status"] == "failed"
    assert result["result"] is None
    assert "일부 묶음" in result["error_message"]


def test_event_claim_is_unique_and_running_job_is_not_retried_after_restart(capture):
    for index in (1, 2):
        ready_part(capture, index, final=index == 2)
        finish_part(capture.repository)
    with ThreadPoolExecutor(max_workers=2) as executor:
        jobs = list(executor.map(lambda _: capture.repository.claim_event_analysis(), range(2)))
    assert sum(job is not None for job in jobs) == 1
    capture.repository.recover()
    assert capture.repository.get_event_synthesis(capture.bundle.event_id)["status"] == "failed"
    assert capture.repository.claim_event_analysis() is None


def test_question_changes_apply_to_next_event(capture):
    repository = capture.repository
    original = questions("첫 질문")
    repository.save_questions(capture.owner_id, original)
    ready_part(capture, 1)
    changed = [{**original[0], "question": "새 질문"}]
    repository.save_questions(capture.owner_id, changed)
    ready_part(capture, 2, final=True)
    assert [s["questions"] for s in repository.event_part_analyses(capture.bundle.event_id)] == [original, original]
    capture.bundle = capture.bundle.model_copy(update={"event_id": capture.bundle.run_id + "_e000002"})
    ready_part(capture, 1, final=True)
    assert repository.event_part_analyses(capture.bundle.event_id)[0]["questions"] == changed


def test_manual_analysis_does_not_replace_auto_source(capture):
    ready_part(capture, 1)
    finish_part(capture.repository)
    part_id = ready_part(capture, 2, final=True, queue=False)
    capture.repository.create_analysis(part_id, capture.owner_id, questions("수동 질문"), "test-model")
    finish_part(capture.repository)
    assert capture.repository.claim_event_analysis() is None
    capture.repository.queue_auto_analysis(part_id, "test-model")
    finish_part(capture.repository)
    job = capture.repository.claim_event_analysis()
    assert len(job["sources"]) == 2
    assert all(s["questions"][0]["question"] == DEFAULT_QUESTION_TEXT for s in job["sources"])


def test_manifest_rescan_restores_final_count_for_existing_event(capture):
    ready_part(capture, 1, final=True)
    with capture.database.connect() as connection:
        connection.execute("UPDATE motion_events SET final_part_index=NULL")
    ready_part(capture, 1, final=True)
    assert capture.repository.get_event(capture.bundle.event_id)["final_part_index"] == 1


@pytest.mark.parametrize(
    "columns,message",
    [
        (None, "테이블이 필요"),
        ("id TEXT PRIMARY KEY,owner_id UUID", "cameras.id는 UUID"),
        ("id UUID PRIMARY KEY,owner_id TEXT", "cameras.owner_id는 UUID"),
    ],
)
def test_vision_sql_reports_camera_prerequisites(capture, columns, message):
    source = (Path(__file__).resolve().parents[1] / "backend/vision/repositories/schema.sql").read_text()
    preflight = source.split("BEGIN;", 1)[1].split("CREATE TABLE IF NOT EXISTS public.motion_runs", 1)[0]
    schema = "vision_prerequisite_" + uuid4().hex
    # 실패 시 CREATE SCHEMA까지 같은 트랜잭션에서 롤백됩니다.
    with (
        pytest.raises(psycopg.errors.RaiseException, match=message),
        capture.database.connect() as connection,
    ):
        connection.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        if columns:
            connection.execute(
                sql.SQL("CREATE TABLE {}.cameras (" + columns + ")").format(sql.Identifier(schema))
            )
        connection.execute(preflight.replace("public.cameras", f"{schema}.cameras"))
