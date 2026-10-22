"""실제 로컬 Supabase 통합 테스트.

VISION_TEST_ENV=/절대경로/vision.env uv run pytest tests/test_motion_api.py -q
DB/Auth/Storage는 실제 서비스, 카메라와 유료 Gemini 호출만 대역을 사용합니다.
미지정 시 건너뛰며, 실수로 원격 DB에 실행하지 않도록 localhost만 허용합니다.
"""

import asyncio
import io
import json
import os
import threading
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlparse
from uuid import uuid4

import httpx
import pytest
from dotenv import dotenv_values
from fastapi.testclient import TestClient
from google import genai
from PIL import Image
import psycopg
from psycopg.rows import dict_row

from backend.config import Settings
from backend.main import create_app
from backend.vision.composition import build_motion_services
from backend.vision.errors import ApplicationError, Conflict
from backend.vision.models.analyses import DEFAULT_QUESTION_TEXT
from backend.vision.repositories.motion_repository import MotionRepository
from backend.common.supabase import build_supabase, create_sync_supabase_client
from backend.vision.config import VisionSettings


class MotionDatabase:
    def __init__(self, url):
        self.url = url

    @contextmanager
    def connect(self):
        with psycopg.connect(self.url, row_factory=dict_row, connect_timeout=5) as connection:
            yield connection

from backend.vision.services.gemini_service import GeminiAnalyzer
from backend.vision.services.motion_files import LocalFileStore
from backend.vision.services.motion_storage import SupabasePhotoStore
from backend.vision.services.motion_workers import AnalysisWorker, IngestionWorker


def jpeg(color="blue"):
    buffer = io.BytesIO()
    Image.new("RGB", (64, 48), color).save(buffer, format="JPEG")
    return buffer.getvalue()


JPEG = jpeg()


def wait_for(callback, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = callback()
        if value:
            return value
        time.sleep(0.05)
    pytest.fail("Supabase 작업 완료 대기 시간 초과")


def manifest(root, run_id, part_index=1, episode_end=True):
    event_id = run_id + "_e000001"
    directory = root / run_id / "events" / event_id / f"part_{part_index:04d}"
    directory.mkdir(parents=True)
    image = directory / "01_motion.jpg"
    image.write_bytes(JPEG)
    path = directory / "event.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "run_id": run_id,
                "event_id": event_id,
                "part_index": part_index,
                "start_sec": part_index - 1,
                "end_sec": part_index,
                "trigger_sec": 0.5,
                "episode_end": episode_end,
                "context_complete": True,
                "evidence_complete": True,
                "images": [{"path": str(image), "timestamp_sec": part_index - 0.5}],
            }
        )
    )
    return path


class Preview:
    def __init__(self):
        self.closed = False
        self.close_on_snapshot = False
        self.frame = SimpleNamespace(jpeg=JPEG, frame_index=1, elapsed_sec=0.5)

    def attach(self, source):
        pass

    def snapshot(self, *, after=-1, timeout=1):
        if self.close_on_snapshot:
            self.closed = True
        return self.frame if after < self.frame.frame_index else None

    @contextmanager
    def subscribe(self):
        yield self

    def close(self):
        self.closed = True


class Engine:
    def __init__(self, root):
        self.root = root
        self.stopped = threading.Event()
        self.status = "idle"

    def progress(self):
        return {"status": self.status, "frames_processed": 3}

    def stop(self):
        self.stopped.set()

    def start(self, *, run_id, duration_sec, preview, on_event, on_started):
        on_started(datetime.now(UTC))
        preview.attach(None)
        self.status = "running"
        path = manifest(self.root, run_id)
        on_event(SimpleNamespace(manifest_path=path))
        on_event(SimpleNamespace(manifest_path=path))  # 중복 접수도 한 번만 저장
        self.stopped.wait(duration_sec or 15)
        self.status = "stopped"


@pytest.fixture(scope="module")
def cloud():
    path = os.getenv("VISION_TEST_ENV")
    if not path:
        pytest.skip("실제 로컬 Supabase 테스트는 VISION_TEST_ENV를 지정하세요.")
    env = dotenv_values(path)
    for key in ("SUPABASE_URL", "VISION_DATABASE_URL"):
        if urlparse(env[key]).hostname not in {"127.0.0.1", "localhost", "::1"}:
            pytest.fail("통합 테스트는 개인 로컬 Supabase에서만 허용합니다.")
    database = MotionDatabase(env["VISION_DATABASE_URL"])
    # 유료 AI 대역과 복구 작업을 실행하므로 개인 화면의 DB에서는 테스트하지 않습니다.
    with database.connect() as c:
        populated = c.execute(
            "SELECT EXISTS(SELECT 1 FROM auth.users) OR EXISTS(SELECT 1 FROM motion_runs) AS populated"
        ).fetchone()["populated"]
    if populated:
        pytest.fail(
            "통합 테스트는 기존 계정·기록이 없는 별도 로컬 Supabase DB에서 실행하세요."
        )
    sdk_http = httpx.Client(timeout=10)
    sdk_settings = Settings(auth_provider="supabase", supabase_url=env["SUPABASE_URL"],
        supabase_publishable_key=env["SUPABASE_PUBLISHABLE_KEY"], supabase_secret_key=env["SUPABASE_SECRET_KEY"])
    repository = MotionRepository(create_sync_supabase_client(sdk_settings, sdk_http))
    storage = SupabasePhotoStore(env["SUPABASE_URL"], env["SUPABASE_SECRET_KEY"])
    users, cameras = [], []
    with httpx.Client(base_url=env["SUPABASE_URL"], timeout=15) as http:
        admin = {
            "apikey": env["SUPABASE_SECRET_KEY"],
        }
        try:
            for _ in range(2):
                email, password = (
                    f"vision-{uuid4().hex}@example.com",
                    uuid4().hex + "Aa1!",
                )
                created = http.post(
                    "/auth/v1/admin/users",
                    headers=admin,
                    json={"email": email, "password": password, "email_confirm": True},
                )
                assert created.status_code in (200, 201), "테스트 Auth 계정 생성 실패"
                user_id = created.json()["id"]
                users.append({"id": user_id})
                login = http.post(
                    "/auth/v1/token?grant_type=password",
                    headers={"apikey": env["SUPABASE_PUBLISHABLE_KEY"]},
                    json={"email": email, "password": password},
                )
                assert login.status_code == 200, "실제 Supabase 비밀번호 로그인 실패"
                users[-1]["headers"] = {
                    "apikey": env["SUPABASE_PUBLISHABLE_KEY"],
                    "Authorization": "Bearer " + login.json()["access_token"],
                }
                camera_id = str(uuid4())
                with database.connect() as c:
                    c.execute(
                        "INSERT INTO cameras(id,owner_id,name) VALUES (%s,%s,%s)",
                        (camera_id, user_id, "vision integration test"),
                    )
                cameras.append(camera_id)
            yield SimpleNamespace(
                env=env,
                db=database,
                repo=repository,
                storage=storage,
                users=users,
                cameras=cameras,
                http=http,
            )
        finally:
            # 테스트에서 만든 사용자 소유 데이터만 정리합니다. 공용/기존 자료는 삭제하지 않습니다.
            with database.connect() as c:
                for user in users:
                    rows = c.execute(
                        "SELECT p.storage_key FROM motion_photos p JOIN motion_parts b ON b.id=p.part_id "
                        "JOIN motion_events e ON e.id=b.event_id JOIN motion_runs r ON r.id=e.run_id "
                        "JOIN cameras ca ON ca.id=r.camera_id WHERE ca.owner_id=%s",
                        (user["id"],),
                    ).fetchall()
                    if rows:
                        result = http.request(
                            "DELETE",
                            "/storage/v1/object/motion-evidence",
                            headers=admin,
                            json={"prefixes": [r["storage_key"] for r in rows]},
                        )
                        assert result.is_success, "테스트 Storage 원본 정리 실패"
                    for table in ("motion_analyses", "motion_photos"):
                        c.execute(
                            f"DELETE FROM {table} WHERE part_id IN (SELECT b.id FROM motion_parts b "
                            "JOIN motion_events e ON e.id=b.event_id JOIN motion_runs r ON r.id=e.run_id "
                            "JOIN cameras ca ON ca.id=r.camera_id WHERE ca.owner_id=%s)",
                            (user["id"],),
                        )
                    c.execute(
                        "DELETE FROM motion_event_analyses WHERE event_id IN (SELECT e.id FROM motion_events e "
                        "JOIN motion_runs r ON r.id=e.run_id JOIN cameras ca ON ca.id=r.camera_id WHERE ca.owner_id=%s)",
                        (user["id"],),
                    )
                    c.execute(
                        "DELETE FROM motion_parts WHERE event_id IN (SELECT e.id FROM motion_events e "
                        "JOIN motion_runs r ON r.id=e.run_id JOIN cameras ca ON ca.id=r.camera_id WHERE ca.owner_id=%s)",
                        (user["id"],),
                    )
                    c.execute(
                        "DELETE FROM motion_events WHERE run_id IN (SELECT r.id FROM motion_runs r JOIN cameras ca ON ca.id=r.camera_id WHERE ca.owner_id=%s)",
                        (user["id"],),
                    )
                    c.execute(
                        "DELETE FROM motion_runs WHERE camera_id IN (SELECT id FROM cameras WHERE owner_id=%s)",
                        (user["id"],),
                    )
                    c.execute("DELETE FROM cameras WHERE owner_id=%s", (user["id"],))
            for user in users:
                result = http.delete(
                    "/auth/v1/admin/users/" + user["id"], headers=admin
                )
                assert result.is_success, "테스트 Auth 계정 정리 실패"
            storage.close()
            sdk_http.close()


def settings(cloud, path):
    return Settings(
        auth_provider="supabase",
        supabase_url=cloud.env["SUPABASE_URL"],
        supabase_publishable_key=cloud.env["SUPABASE_PUBLISHABLE_KEY"],
        supabase_anon_key=cloud.env["SUPABASE_PUBLISHABLE_KEY"],
        supabase_secret_key=cloud.env["SUPABASE_SECRET_KEY"],
    )


def vision_settings(path):
    return VisionSettings(data_dir=path, gemini_api_key="", jwt_secret="test-" + "x" * 40)


@contextmanager
def worker_services(cloud, path):
    config = settings(cloud, path)
    with asyncio.Runner() as runner:
        resources = build_supabase(config)
        shared = runner.run(resources.__aenter__())
        try:
            with build_motion_services(config, vision_settings(path), supabase=shared) as services:
                yield services
        finally:
            runner.run(resources.__aexit__(None, None, None))


@pytest.fixture
def app(cloud, tmp_path, monkeypatch):
    previews = []

    def factory(request, settings):
        p = Preview()
        previews.append(p)
        return Engine(settings.data_dir / "motion/captures"), p

    monkeypatch.setattr("backend.vision.composition.create_motion", factory)
    application = create_app(settings(cloud, tmp_path), vision_settings(tmp_path))
    with TestClient(application) as client:
        yield SimpleNamespace(client=client, state=application.state, previews=previews)


def test_supabase_auth_vision_api_and_rls(cloud, app):
    client, owner, other = app.client, cloud.users[0], cloud.users[1]
    headers = owner["headers"]

    def api(method, path, **kwargs):
        return getattr(client, method)(path, headers=headers, **kwargs)

    assert client.get("/api/motion/runs").status_code == 401
    assert (
        client.get(
            "/api/motion/runs", headers={"Authorization": "Bearer invalid"}
        ).status_code
        == 401
    )
    assert api("get", "/api/auth/me").json()["id"] == owner["id"]
    spec = client.get("/openapi.json").json()
    assert "/api/motion/questions" in spec["paths"]
    assert "/api/motion/question" not in spec["paths"]
    assert (
        api(
            "post",
            "/api/motion/runs",
            json={"camera_id": cloud.cameras[0], "objects": []},
        ).status_code
        == 422
    )
    assert (
        api("post", "/api/motion/runs", json={"camera_id": str(uuid4())}).status_code
        == 404
    )
    assert (
        client.post(
            "/api/motion/runs",
            headers=other["headers"],
            json={"camera_id": cloud.cameras[0]},
        ).status_code
        == 404
    )
    response = api(
        "post",
        "/api/motion/runs",
        json={"camera_id": cloud.cameras[0], "objects": [" Person ", "person"]},
    )
    assert response.status_code == 202
    run_id = response.json()["id"]
    path = "/api/motion/runs/" + run_id
    wait_for(lambda: api("get", path).json()["status"] == "running")
    assert api("get", path).json()["config"]["objects"] == ["person"]
    assert (
        api(
            "post", "/api/motion/runs", json={"camera_id": cloud.cameras[0]}
        ).status_code
        == 409
    )
    event = wait_for(
        lambda: api("get", "/api/motion/events", params={"run_id": run_id}).json()
    )[0]
    ep = "/api/motion/events/" + event["id"]
    assert api("get", ep).status_code == 200
    parts = api("get", ep + "/parts").json()
    assert len(parts) == 1
    pp = "/api/motion/parts/" + parts[0]["id"]
    detail = wait_for(
        lambda: (
            r
            if (r := api("get", pp).json())["photos"][0]["upload_status"] == "ready"
            else None
        )
    )
    photo = detail["photos"][0]
    response = api("get", photo["content_url"])
    assert response.status_code == 200 and response.content == JPEG
    assert response.headers["content-type"] == "image/jpeg"
    assert api("get", ep + "/parts", params={"after": 1}).json() == []
    assert any(r["id"] == run_id for r in api("get", "/api/motion/runs").json())
    auto = wait_for(lambda: api("get", pp + "/analyses").json())
    assert (
        len(auto) == 1 and auto[0]["origin"] == "auto" and auto[0]["status"] == "queued"
    )
    response = api("post", pp + "/analyses", json={"questions": [{"question": "사람의 움직임은?"}]})
    assert response.status_code == 202
    analysis_path = "/api/motion/analyses/" + response.json()["id"]
    assert api("get", analysis_path).status_code == 200
    for private in (path, ep, pp, photo["content_url"], analysis_path):
        assert client.get(private, headers=other["headers"]).status_code == 404
    assert client.post(path + "/stop", headers=other["headers"]).status_code == 404
    assert (
        client.post(
            pp + "/analyses", headers=other["headers"], json={"questions": [{"question": "test"}]}
        ).status_code
        == 404
    )
    assert api("get", path + "/preview.jpg").content == JPEG
    ticket = api("post", path + "/preview-ticket").json()
    assert client.get(ticket["image_url"]).content == JPEG
    app.previews[0].close_on_snapshot = True
    stream = client.get(ticket["url"])
    assert stream.status_code == 200 and b"--frame" in stream.content
    assert api("post", path + "/stop").status_code == 202
    wait_for(lambda: api("get", path).json()["status"] == "stopped")
    assert cloud.repo.get_run(run_id)["status"] == "stopped"
    assert api("get", path + "/preview.jpg").status_code == 503

    # API 외에 실제 PostgREST RLS와 Storage RLS도 각각 검증합니다.
    for table, identifier in [
        ("motion_runs", run_id),
        ("motion_events", event["id"]),
        ("motion_parts", parts[0]["id"]),
        ("motion_photos", photo["id"]),
        ("motion_analyses", auto[0]["id"]),
    ]:
        a = cloud.http.get(
            "/rest/v1/" + table, headers=headers, params={"id": "eq." + identifier}
        )
        b = cloud.http.get(
            "/rest/v1/" + table,
            headers=other["headers"],
            params={"id": "eq." + identifier},
        )
        assert a.status_code == 200 and len(a.json()) == 1
        assert b.status_code == 200 and b.json() == []
    row = cloud.repo.get_photo(photo["id"], owner["id"])
    url = "/storage/v1/object/authenticated/motion-evidence/" + row["storage_key"]
    assert cloud.http.get(url, headers=headers).content == JPEG
    assert not cloud.http.get(url, headers=other["headers"]).is_success
    assert not cloud.http.get(
        "/storage/v1/object/public/motion-evidence/" + row["storage_key"]
    ).is_success
    assert not cloud.http.post(
        "/rest/v1/motion_runs", headers=headers, json={"id": uuid4().hex}
    ).is_success


def make_bundle(cloud, tmp_path):
    run_id = uuid4().hex
    cloud.repo.create_run(run_id, cloud.cameras[0], {"question": "test"})
    cloud.repo.start_run(run_id, datetime.now(UTC))
    cloud.repo.finish_run(run_id, "stopped", None)
    files = LocalFileStore(tmp_path / "motion/captures")
    path = manifest(files.captures, run_id)
    return run_id, files, path


def test_pending_ready_uncertain_upload_and_hash(cloud, tmp_path, monkeypatch):
    run_id, files, path = make_bundle(cloud, tmp_path)
    bundle, local = files.prepare_bundle(path)
    part_id = cloud.repo.register_bundle(bundle, local)
    photo = cloud.repo.list_photos(part_id)[0]
    assert photo["upload_status"] == "pending"
    url = "/storage/v1/object/authenticated/motion-evidence/" + photo["storage_key"]
    cloud.storage.upload(photo, JPEG)
    assert not cloud.http.get(url, headers=cloud.users[0]["headers"]).is_success
    admin = {
        "apikey": cloud.env["SUPABASE_SECRET_KEY"],
    }
    assert cloud.http.request(
        "DELETE",
        "/storage/v1/object/motion-evidence",
        headers=admin,
        json={"prefixes": [photo["storage_key"]]},
    ).is_success
    with pytest.raises(Conflict):
        cloud.repo.create_analysis(part_id, cloud.users[0]["id"], [{"id": str(uuid4()), "question": "test"}], "model")
    with pytest.raises(Conflict):
        cloud.storage.content(photo)
    worker = IngestionWorker(
        cloud.repo, files, cloud.storage, "test-model"
    )

    def offline(*args):
        raise ApplicationError("STORAGE_UNAVAILABLE", "test outage", 503)

    original_upload = cloud.storage.upload
    monkeypatch.setattr(cloud.storage, "upload", offline)
    with pytest.raises(ApplicationError):
        worker.process_bundle(run_id, path)
    assert path.is_file() and Path(bundle.images[0].path).is_file()
    assert cloud.repo.list_photos(part_id)[0]["upload_status"] == "pending"
    assert cloud.repo.list_analyses(part_id, cloud.users[0]["id"], 10) == []
    monkeypatch.setattr(cloud.storage, "upload", original_upload)
    original_post = cloud.storage.client.post
    upload_calls = []

    def lost_response(*args, **kwargs):
        upload_calls.append(True)
        response = original_post(*args, **kwargs)
        assert response.is_success
        raise httpx.ReadTimeout("simulated response loss")

    monkeypatch.setattr(cloud.storage.client, "post", lost_response)
    worker.process_bundle(run_id, path)
    row = cloud.repo.list_photos(part_id)[0]
    assert row["upload_status"] == "ready" and len(upload_calls) == 1
    assert cloud.storage.content(row) == JPEG
    worker.process_bundle(run_id, path)
    assert len(cloud.repo.list_analyses(part_id, cloud.users[0]["id"], 10)) == 1
    with pytest.raises(Conflict):
        cloud.storage.upload(row, jpeg("red"))
    with pytest.raises(Conflict):
        cloud.storage.content({**row, "sha256": "0" * 64})


@pytest.mark.parametrize("stored", [False, True])
def test_restart_replays_unfinished_manifest_and_removes_local_copy(cloud, tmp_path, stored):
    run_id, files, path = make_bundle(cloud, tmp_path)
    # 이전 프로세스가 DB 접수 전 또는 Storage 저장 후 ready 반영 전에 강제 종료된 경우
    if stored:
        bundle, photos = files.prepare_bundle(path)
        part_id = cloud.repo.register_bundle(bundle, photos)
        cloud.storage.upload(cloud.repo.list_photos(part_id)[0], JPEG)
    with worker_services(cloud, tmp_path):
        event = wait_for(
            lambda: cloud.repo.list_events(cloud.users[0]["id"], run_id, 10)
        )[0]
        part = wait_for(
            lambda: cloud.repo.list_parts(event["id"], cloud.users[0]["id"], 0, 10)
        )[0]
        wait_for(lambda: not path.exists())
        assert cloud.repo.list_photos(part["id"])[0]["upload_status"] == "ready"
    assert len(cloud.repo.list_events(cloud.users[0]["id"], run_id, 10)) == 1
    assert len(cloud.repo.list_analyses(part["id"], cloud.users[0]["id"], 10)) == 1
    assert not path.parent.exists()


def test_bundle_transaction_rollback_and_path_validation(cloud, tmp_path):
    run_id, files, path = make_bundle(cloud, tmp_path)
    bundle, photos = files.prepare_bundle(path)
    with pytest.raises(ApplicationError):
        cloud.repo.register_bundle(
            bundle, [photos[0], {**photos[0], "sha256": "invalid"}]
        )
    assert cloud.repo.list_events(cloud.users[0]["id"], run_id, 10) == []
    with pytest.raises(ApplicationError):
        files.photo_path("../outside.jpg")
    outside = tmp_path / "event.json"
    outside.write_text(path.read_text())
    with pytest.raises(ApplicationError):
        files.prepare_bundle(outside)


def test_analysis_reads_verified_storage_and_persists_result(
    cloud, tmp_path, monkeypatch, app
):
    run_id, files, path = make_bundle(cloud, tmp_path)
    IngestionWorker(
        cloud.repo, files, cloud.storage, "test-model"
    ).process_bundle(run_id, path)
    event = cloud.repo.list_events(cloud.users[0]["id"], run_id, 10)[0]
    part = cloud.repo.list_parts(event["id"], cloud.users[0]["id"], 0, 10)[0]
    result = {
        "items": [{"question_id": "", "verdict": "uncertain", "summary": "사진 근거가 부족해 판단할 수 없습니다."}],
    }

    http_status = 200

    def gemini(request):
        if http_status != 200:
            return httpx.Response(
                http_status,
                json={"error": {"code": http_status, "message": "test limit"}},
            )
        body = json.loads(request.content)
        parts = body["contents"][0]["parts"]
        questions = json.loads(parts[0]["text"])["questions"]
        result["items"] = [{**result["items"][0], "question_id": q["id"]} for q in questions]
        assert any("inlineData" in p for p in parts)
        assert cloud.env["SUPABASE_SECRET_KEY"] not in request.content.decode()
        assert "storage/v1" not in request.content.decode()
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "content": {
                            "role": "model",
                            "parts": [{"text": json.dumps(result)}],
                        },
                        "finishReason": "STOP",
                    }
                ],
            },
        )

    # 실제 SDK의 직렬화·오류 처리를 거치되 외부 Gemini HTTP 요청은 보내지 않습니다.
    client_factory = genai.Client

    def sdk_client(**kwargs):
        kwargs["http_options"].httpx_client = httpx.Client(
            transport=httpx.MockTransport(gemini)
        )
        return client_factory(**kwargs)

    monkeypatch.setattr(genai, "Client", sdk_client)
    analyzer = GeminiAnalyzer("fake-paid-api-key", cloud.storage, 5, 12 * 1024 * 1024)
    try:
        worker = AnalysisWorker(cloud.repo, analyzer)
        # 모듈 내 다른 테스트에서 남긴 queued도 실제 저장된 원본을 사용해 처리합니다.
        while worker.process_one():
            pass
        analysis = cloud.repo.list_analyses(part["id"], cloud.users[0]["id"], 10)[0]
        assert analysis["status"] == "succeeded" and analysis["result"] == result
        assert analysis["finished_at"] and analysis["latency_ms"] >= 0
        response = app.client.get(
            f"/api/motion/analyses/{analysis['id']}", headers=cloud.users[0]["headers"]
        )
        assert response.status_code == 200
        assert response.json()["result"] == result
        result = {
            "items": [{"question_id": "", "verdict": "confirmed", "summary": "사람이 들어오는 행동이 확인됩니다."}],
        }
        manual = cloud.repo.create_analysis(
            part["id"], cloud.users[0]["id"], [{"id": str(uuid4()), "question": "재분석"}], "test-model"
        )
        assert worker.process_one()
        stored = cloud.repo.get_analysis(manual["id"], cloud.users[0]["id"])
        assert stored["status"] == "succeeded" and stored["result"] == result
        response = app.client.get(
            f"/api/motion/parts/{part['id']}/analyses",
            headers=cloud.users[0]["headers"],
        )
        assert response.status_code == 200
        assert any(item["result"] == result for item in response.json())
        http_status = 429
        failed = cloud.repo.create_analysis(
            part["id"], cloud.users[0]["id"], [{"id": str(uuid4()), "question": "실패 이력"}], "test-model"
        )
        assert worker.process_one()
        stored = cloud.repo.get_analysis(failed["id"], cloud.users[0]["id"])
        assert stored["status"] == "failed" and "429" in stored["error_message"]
        assert stored["result"] is None
        assert not worker.process_one()  # 유료 AI 실패를 자동 반복하지 않습니다.
    finally:
        analyzer.close()


def test_recovery_marks_inflight_without_repeating_ai(cloud, tmp_path):
    run_id, files, path = make_bundle(cloud, tmp_path)
    IngestionWorker(
        cloud.repo, files, cloud.storage, "test-model"
    ).process_bundle(run_id, path)
    job = cloud.repo.claim_analysis()
    assert job is not None
    cloud.repo.recover()
    assert (
        cloud.repo.get_analysis(job["id"], cloud.users[0]["id"])["status"] == "failed"
    )
    cloud.repo.finish_run(run_id, "failed", "test")
    cloud.repo.finish_run(run_id, "stopped", None)
    assert cloud.repo.get_run(run_id)["status"] == "failed"


def test_file_lock_prevents_second_worker_recovery(cloud, tmp_path):
    with (
        worker_services(cloud, tmp_path / "first"),
        pytest.raises(RuntimeError, match="worker 1개"),
        worker_services(cloud, tmp_path / "first"),
    ):
        pass


def test_vision_without_connection_returns_503(client, api_environment):
    headers, _ = api_environment.headers()
    response = client.get("/api/motion/runs", headers=headers)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "VISION_UNAVAILABLE"


@pytest.fixture
def clean_questions(cloud):
    """이 테스트 모듈에서 만든 두 계정의 질문만 초기화합니다."""

    def clear():
        with cloud.db.connect() as c:
            c.execute(
                "DELETE FROM motion_analysis_questions WHERE user_id IN (%s,%s)",
                tuple(user["id"] for user in cloud.users),
            )

    clear()
    yield
    clear()


def test_question_lists_and_snapshot_survive_settings_edit_before_upload(cloud, app, tmp_path, clean_questions):
    client, owner, other = app.client, cloud.users[0], cloud.users[1]
    url = "/api/motion/questions"
    headers = owner["headers"]
    initial = client.get(url, headers=headers)
    assert initial.status_code == 200
    assert client.get(url, headers=headers).json() == initial.json()
    saved = client.put(url, headers=headers, json={"questions": [
        {"question": "물건을 가져가는 행동이 있나요?"},
        {"question": "사람이 넘어졌나요?"},
    ]})
    assert saved.status_code == 200
    original = saved.json()["questions"]
    assert len({q["id"] for q in original}) == 2
    assert client.put(url, headers=other["headers"], json={"questions": original}).status_code == 422
    run_id, files, path = make_bundle(cloud, tmp_path)
    bundle, photos = files.prepare_bundle(path)
    # Register while photos are still pending: settings must already be frozen.
    part_id = cloud.repo.register_bundle(bundle, photos)
    edited = [{**original[0], "question": "물건 누가 가져갔는지 확인해줘"}]
    assert client.put(url, headers=headers, json={"questions": edited}).status_code == 200
    ingestion = IngestionWorker(cloud.repo, files, cloud.storage, "test-model")
    ingestion.process_bundle(run_id, path)
    ingestion.process_bundle(run_id, manifest(files.captures, run_id, part_index=2))
    sources = cloud.repo.event_part_analyses(bundle.event_id)
    assert all(source["questions"] == original for source in sources)
    assert cloud.repo.get_event(bundle.event_id)["questions"] == original
    assert cloud.repo.get_questions(owner["id"])["questions"] == edited
    # A later event receives the edited list, with the same owned question UUID.
    next_path = manifest(files.captures, run_id, part_index=3)
    data = json.loads(next_path.read_text())
    data.update(event_id=run_id + "_e000002", part_index=1)
    new_dir = files.captures / run_id / "events" / data["event_id"] / "part_0001"
    new_dir.mkdir(parents=True)
    (new_dir / "01_motion.jpg").write_bytes(JPEG)
    data["images"][0]["path"] = str(new_dir / "01_motion.jpg")
    next_path = new_dir / "event.json"
    next_path.write_text(json.dumps(data))
    ingestion.process_bundle(run_id, next_path)
    assert cloud.repo.get_event(data["event_id"])["questions"] == edited
    # The user's JWT cannot read another owner's saved list or modify it through REST.
    rest = "/rest/v1/motion_analysis_questions"
    assert cloud.http.get(rest, headers=other["headers"], params={"user_id": "eq."+owner["id"]}).json() == []
    assert not cloud.http.patch(rest, headers=other["headers"], params={"user_id": "eq."+owner["id"]}, json={"questions": edited}).is_success
    assert client.get("/api/motion/question", headers=headers).status_code == 404


def test_event_synthesis_uses_real_storage_and_enforces_owner_rls(cloud, app, tmp_path, monkeypatch):
    run_id, files, path = make_bundle(cloud, tmp_path)
    ingestion = IngestionWorker(cloud.repo, files, cloud.storage, "test-model")
    ingestion.process_bundle(run_id, path)
    ingestion.process_bundle(run_id, manifest(files.captures, run_id, part_index=2))
    event_id = run_id + "_e000001"
    route = f"/api/motion/events/{event_id}/analysis"
    owner, other = cloud.users
    assert app.client.get(route, headers=owner["headers"]).json()["status"] == "waiting"
    synthesis_inputs = []

    def generate(request):
        body = json.loads(request.content)
        payload = json.loads(body["contents"][0]["parts"][0]["text"])
        synthesis = "parts" in payload
        if synthesis:
            synthesis_inputs.append(payload)
        result = {"items": [{"question_id": q["id"], "verdict": "confirmed" if synthesis else "uncertain",
                  "summary": "물건을 들고 나간 흐름이 확인됩니다." if synthesis else "사람의 구간별 행동이 관찰됩니다."}
                  for q in payload["questions"]]}
        return httpx.Response(200, json={"candidates": [{"content": {"role": "model", "parts": [{"text": json.dumps(result)}]}, "finishReason": "STOP"}]})

    factory = genai.Client

    def sdk_client(**kwargs):
        kwargs["http_options"].httpx_client = httpx.Client(transport=httpx.MockTransport(generate))
        return factory(**kwargs)

    monkeypatch.setattr(genai, "Client", sdk_client)
    analyzer = GeminiAnalyzer("fake-paid-key", cloud.storage, 5, 12 * 1024**2)
    try:
        worker = AnalysisWorker(cloud.repo, analyzer)
        while worker.process_one():
            pass
    finally:
        analyzer.close()
    response = app.client.get(route, headers=owner["headers"])
    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "succeeded" and result["basis"] == "synthesis"
    assert result["result"]["items"][0]["verdict"] == "confirmed"
    assert any([p["part_index"] for p in payload["parts"]] == [1, 2] for payload in synthesis_inputs)
    assert app.client.get(route, headers=other["headers"]).status_code == 404
    assert app.client.get(route).status_code == 401
    rest = f"/rest/v1/motion_event_analyses?select=id,event_id&event_id=eq.{event_id}"
    owned = cloud.http.get(rest, headers=owner["headers"])
    assert owned.status_code == 200 and len(owned.json()) == 1
    hidden = cloud.http.get(rest, headers=other["headers"])
    assert hidden.status_code == 200 and hidden.json() == []
    assert not cloud.http.get(rest, headers={"apikey": cloud.env["SUPABASE_PUBLISHABLE_KEY"]}).is_success
    assert not cloud.http.post("/rest/v1/motion_event_analyses", headers=owner["headers"], json={"event_id": event_id}).is_success


def test_server_rpc_cannot_be_called_with_user_or_public_key(cloud):
    for headers in ({"apikey": cloud.env["SUPABASE_PUBLISHABLE_KEY"]}, cloud.users[0]["headers"]):
        for name in ("motion_recover", "motion_claim_analysis", "motion_claim_event_analysis"):
            response = cloud.http.post('/rest/v1/rpc/' + name, headers=headers, json={})
            assert response.status_code in (401, 403)
    with cloud.db.connect() as connection:
        roles = connection.execute("SELECT p.proname,has_function_privilege('authenticated',p.oid,'EXECUTE') AS user_execute,has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,has_function_privilege('service_role',p.oid,'EXECUTE') AS server_execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('motion_start_run','motion_finish_run','motion_recover','motion_register_bundle','motion_queue_auto_analysis','motion_create_analysis','motion_claim_analysis','motion_claim_event_analysis')").fetchall()
    assert len(roles) == 8
    assert all(row['server_execute'] and not row['user_execute'] and not row['anon_execute'] for row in roles)


def test_sdk_readers_use_separate_user_tokens_and_rls(cloud, tmp_path):
    from backend.vision.errors import NotFound
    from concurrent.futures import ThreadPoolExecutor

    run_id, _, _ = make_bundle(cloud, tmp_path)
    config = settings(cloud, tmp_path)
    with httpx.Client(timeout=10) as shared:
        readers = [create_sync_supabase_client(config, shared, token=user['headers']['Authorization'].split(' ', 1)[1]) for user in cloud.users]
        repositories = [MotionRepository(cloud.repo.client, reader) for reader in readers]
        # owner_id를 생략해도 사용자 JWT의 RLS가 다른 소유자의 행을 차단해야 합니다.
        def read(index):
            if index % 2 == 0:
                return repositories[0].get_run(run_id)['id']
            with pytest.raises(NotFound):
                repositories[1].get_run(run_id)
            return None
        with ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(read, range(12)))
        assert results[::2] == [run_id] * 6
        assert 'authorization' not in shared.headers and 'apikey' not in shared.headers
