"""외부 DB·AI 없이 임시파일 폐기와 종료/완료 경합을 검증합니다."""

import hashlib
import io
import json
import os
import subprocess
import threading
from pathlib import Path
from unittest.mock import Mock

import httpx
import pytest
from PIL import Image

from backend.common.supabase import create_sync_supabase_client
from backend.config import Settings
from backend.vision.errors import ApplicationError
from backend.vision.repositories.motion_repository import MotionRepository
from backend.vision.services.motion_files import LocalFileStore
from backend.vision.services.motion_workers import AnalysisWorker, IngestionWorker
from scripts import prepare_motion_model


def capture(files, part_index=1):
    run_id = "a" * 32
    directory = files.captures / run_id / "events" / f"{run_id}_e000001" / f"part_{part_index:04d}"
    directory.mkdir(parents=True)
    photo = directory / "01.jpg"
    Image.new("RGB", (8, 8)).save(photo)
    manifest = directory / "event.json"
    manifest.write_text(json.dumps({
        "schema_version": 1, "run_id": run_id, "event_id": f"{run_id}_e000001",
        "part_index": part_index, "start_sec": 0, "end_sec": 1, "trigger_sec": 0,
        "episode_end": True, "context_complete": True, "evidence_complete": True,
        "images": [{"path": str(photo), "timestamp_sec": 0.5}],
    }))
    return manifest


@pytest.mark.parametrize("failure", ["upload", "ready", "queue"])
def test_bundle_retries_before_deleting_and_ignores_duplicate_queue_entry(tmp_path, failure):
    files = LocalFileStore(tmp_path)
    manifest = capture(files)
    sibling = capture(files, part_index=2)
    bundle, local = files.prepare_bundle(manifest)
    repository, storage = Mock(), Mock()
    repository.register_bundle.return_value = "part"
    repository.list_photos.return_value = [{**local[0], "id": "photo", "upload_status": "pending"}]
    failing = {"upload": storage.upload, "ready": repository.ready_photo,
               "queue": repository.queue_auto_analysis}[failure]
    failing.side_effect = OSError("offline")
    worker = IngestionWorker(repository, files, storage, "test-model")
    with pytest.raises(OSError, match="offline"):
        worker.process_bundle(bundle.run_id, manifest)
    assert manifest.exists() and files.photo_path(local[0]["storage_key"]).exists()
    failing.side_effect = None
    worker.process_bundle(bundle.run_id, manifest)
    assert not manifest.parent.exists() and sibling.exists()
    calls = repository.register_bundle.call_count
    worker.process_bundle(bundle.run_id, manifest)
    assert repository.register_bundle.call_count == calls


def test_shutdown_discards_only_local_pending_bundle_without_uploading(tmp_path):
    files = LocalFileStore(tmp_path / "captures")
    manifest = capture(files)
    outside = tmp_path / "other-server.jpg"
    outside.write_bytes(b"keep")
    repository, storage = Mock(), Mock()
    worker = IngestionWorker(repository, files, storage, "test-model")
    worker.notify("a" * 32, manifest)
    # 버릴 묶음의 사진이 손상/유실돼도 종료 정리를 막지 않습니다.
    manifest.with_name("01.jpg").unlink()
    worker.close()
    storage.upload.assert_not_called()
    repository.interrupt_pending_bundle.assert_called_once_with("a" * 32 + "_e000001", 1)
    assert not manifest.parent.exists() and outside.read_bytes() == b"keep"


def test_shutdown_stops_after_inflight_photo_instead_of_draining_queue(tmp_path):
    files = LocalFileStore(tmp_path)
    manifest = capture(files)
    bundle, local = files.prepare_bundle(manifest)
    repository, storage = Mock(), Mock()
    repository.register_bundle.return_value = "part"
    repository.list_photos.return_value = [
        {**local[0], "id": str(index), "upload_status": "pending"} for index in range(2)
    ]
    # 같은 JPEG를 두 번 참조해도 업로드 중단 경계는 사진 단위로 확인할 수 있습니다.
    payload = json.loads(manifest.read_text())
    payload["images"] *= 2
    manifest.write_text(json.dumps(payload))
    entered, release = threading.Event(), threading.Event()

    def upload(*args):
        entered.set()
        assert release.wait(5)

    storage.upload.side_effect = upload
    worker = IngestionWorker(repository, files, storage, "test-model")
    worker.start()
    closer = threading.Thread(target=worker.close)
    try:
        assert entered.wait(3)
        closer.start()
        assert worker._stop.wait(3)
    finally:
        release.set()
        closer.join(3)
        worker._thread.join(3)
    assert not closer.is_alive() and not worker._thread.is_alive()
    storage.upload.assert_called_once()
    repository.queue_auto_analysis.assert_not_called()
    repository.interrupt_pending_bundle.assert_called_once_with(bundle.event_id, 1)
    assert not manifest.parent.exists()


def test_bundle_cleanup_rejects_symlink_target(tmp_path):
    files = LocalFileStore(tmp_path / "captures")
    manifest = capture(files)
    bundle, _ = files.prepare_bundle(manifest)
    outside = tmp_path / "keep"
    manifest.parent.rename(outside)
    manifest.parent.symlink_to(outside, target_is_directory=True)
    with pytest.raises(ApplicationError):
        files.remove_bundle(bundle)
    assert (outside / "event.json").exists()


@pytest.mark.parametrize("saved", [False, True])
def test_shutdown_preserves_saved_event_when_commit_response_was_lost(saved):
    requests = []

    def handle(request):
        requests.append(request)
        if request.method == "GET":
            return httpx.Response(200, json=[{
                "motion_photos": [{"upload_status": "ready" if saved else "pending"}],
                "motion_analyses": [{"origin": "auto"}] if saved else [],
            }])
        return httpx.Response(200, json=[])

    settings = Settings(app_env="test", supabase_url="https://project.example.com",
                        supabase_publishable_key="test-public", supabase_secret_key="sb_secret_test")
    with httpx.Client(transport=httpx.MockTransport(handle)) as http:
        repository = MotionRepository(create_sync_supabase_client(settings, http))
        repository.interrupt_pending_bundle("own-event", 1)
    updates = [request for request in requests if request.method == "PATCH"]
    assert len(updates) == (0 if saved else 1)
    if updates:
        assert updates[0].url.params["id"] == "eq.own-event"
        assert json.loads(updates[0].content) == {"capture_state": "interrupted"}


def analysis_worker(is_event):
    repository, analyzer = Mock(), Mock()
    job = {"id": "own-analysis", "part_id": "part", "sources": [{"status": "succeeded"}]}
    repository.claim_event_analysis.return_value = job if is_event else None
    repository.claim_analysis.return_value = job
    repository.get_part.return_value = {"id": "part", "event_id": "event"}
    repository.get_event.return_value = {"run_id": "run"}
    repository.get_run.return_value = {"config": {}}
    worker = AnalysisWorker(repository, analyzer)
    finish = repository.finish_event_analysis if is_event else repository.finish_analysis
    generate = analyzer.synthesize if is_event else analyzer.analyze
    return worker, finish, generate


@pytest.mark.parametrize("is_event", [False, True])
def test_shutdown_fails_own_analysis_and_ignores_late_ai_result(is_event):
    worker, finish, generate = analysis_worker(is_event)
    entered, release = threading.Event(), threading.Event()

    def blocked(*args):
        entered.set()
        assert release.wait(5)
        return Mock(model_dump=lambda **kwargs: {"items": []})

    generate.side_effect = blocked
    worker.start()
    try:
        assert entered.wait(3)
        worker.close()  # AI를 해제하지 않아도 종료 처리가 반환해야 합니다.
        finish.assert_called_once()
        assert finish.call_args.args[:3] == ("own-analysis", None, "서버 종료로 분석이 중단되었습니다.")
        assert not worker.process_one()
    finally:
        release.set()
        worker._thread.join(3)
    assert not worker._thread.is_alive()
    finish.assert_called_once()


@pytest.mark.parametrize("is_event", [False, True])
def test_shutdown_preserves_analysis_that_already_finished(is_event):
    worker, finish, generate = analysis_worker(is_event)
    generate.return_value.model_dump.return_value = {"items": []}
    assert worker.process_one()
    worker.close()
    finish.assert_called_once()
    assert finish.call_args.args[:3] == ("own-analysis", {"items": []}, None)


def test_shutdown_during_claim_does_not_leave_a_new_running_job():
    worker, finish, generate = analysis_worker(True)
    entered, release = threading.Event(), threading.Event()
    job = worker.repository.claim_event_analysis.return_value

    def claim():
        entered.set()
        assert release.wait(5)
        return job

    worker.repository.claim_event_analysis.side_effect = claim
    worker.start()
    closer = threading.Thread(target=worker.close)
    try:
        assert entered.wait(3)
        closer.start()
        assert worker._stop.wait(3)
    finally:
        release.set()
        closer.join(3)
        worker._thread.join(3)
    assert not closer.is_alive() and not worker._thread.is_alive()
    generate.assert_not_called()
    finish.assert_called_once()
    assert finish.call_args.args[1] is None


def test_build_model_verifies_download_and_reuses_existing_file(tmp_path, monkeypatch):
    data = b"verified model bytes"
    download = Mock(side_effect=lambda *args, **kwargs: io.BytesIO(data))
    monkeypatch.setattr(prepare_motion_model, "urlopen", download)
    monkeypatch.setattr(prepare_motion_model, "MODEL_SHA256", hashlib.sha256(data).hexdigest())
    path = tmp_path / "models" / "yolo11n.pt"
    prepare_motion_model.prepare_model(path)
    prepare_motion_model.prepare_model(path)
    download.assert_called_once()
    assert path.read_bytes() == data
    path.unlink()
    monkeypatch.setattr(prepare_motion_model, "MODEL_SHA256", "0" * 64)
    with pytest.raises(ValueError, match="SHA-256"):
        prepare_motion_model.prepare_model(path)
    assert not path.exists() and not path.with_suffix(".pt.tmp").exists()


def test_model_preparation_uses_server_environment_loader(tmp_path, monkeypatch):
    target = tmp_path / "configured.pt"
    load = Mock(side_effect=lambda: monkeypatch.setenv("MOTION_MODEL_PATH", str(target)))
    prepare = Mock()
    monkeypatch.setattr("backend.config.load_environment", load)
    monkeypatch.setattr(prepare_motion_model, "prepare_model", prepare)
    prepare_motion_model.main()
    load.assert_called_once_with()
    prepare.assert_called_once_with(target)


@pytest.mark.skipif(os.name != "posix", reason="Mac/Linux용 sh 빌드 명령 검증")
@pytest.mark.parametrize("sync_fails", [False, True])
def test_build_installs_dependencies_then_prepares_model_and_stops_on_failure(tmp_path, sync_fails):
    fake_uv = tmp_path / "uv"
    log = tmp_path / "commands.log"
    fake_uv.write_text(
        '#!/bin/sh\nprintf "%s|%s\\n" "$PWD" "$*" >> "$BUILD_TEST_LOG"\n'
        'if [ "$1" = sync ] && [ "$BUILD_TEST_FAIL_SYNC" = 1 ]; then exit 7; fi\n'
        'exit 0\n'
    )
    fake_uv.chmod(0o755)
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(["sh", str(root / "scripts/build.sh"), "--no-dev"], cwd=tmp_path,
                            env={**os.environ, "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
                                 "BUILD_TEST_LOG": str(log), "BUILD_TEST_FAIL_SYNC": "1" if sync_fails else "0"})
    commands = ["sync --frozen --no-dev"]
    if not sync_fails:
        commands.append("run --no-sync python -m scripts.prepare_motion_model")
    assert log.read_text().splitlines() == [f"{root}|{command}" for command in commands]
    assert result.returncode == (7 if sync_fails else 0)
