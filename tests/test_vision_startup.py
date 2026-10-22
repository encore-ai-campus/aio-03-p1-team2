"""비전 시작의 OS 호환성과 프로세스 잠금 해제를 검증합니다."""

import subprocess
import sys
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
import httpx
from filelock import FileLock

from backend.config import Settings
from backend.common.supabase import create_sync_supabase_client
from backend.vision.config import VisionSettings
from backend.vision.models.runs import RunCreate
from backend.vision import composition


ROOT = Path(__file__).resolve().parents[1]


def test_app_starts_without_fcntl(tmp_path):
    result = subprocess.run(
        [
            sys.executable,
            "-B",
            "-c",
            """
import sys
from pathlib import Path
sys.modules['fcntl'] = None
from fastapi.testclient import TestClient
from backend.main import create_app
from backend.config import Settings
from backend.vision.config import VisionSettings
settings = Settings(
    app_env='test', auth_provider='supabase',
    supabase_url='https://project.example.com',
    supabase_publishable_key='test-public', supabase_secret_key='test-service',
)
with TestClient(create_app(settings, VisionSettings(enabled=False))) as client:
    assert client.get('/health').status_code == 200
""",
            str(tmp_path),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_second_process_cannot_start_with_same_data_dir(tmp_path):
    lock_path = tmp_path / "motion" / ".runtime.lock"
    lock_path.parent.mkdir()
    with FileLock(lock_path, timeout=0):
        result = subprocess.run(
            [
                sys.executable,
                "-B",
                "-c",
                """
import sys
from pathlib import Path
from backend.config import Settings
from backend.vision.config import VisionSettings
from backend.vision.composition import build_motion_services
settings = Settings(auth_provider='supabase', supabase_url='https://project.example.com', supabase_secret_key='test-service')
vision = VisionSettings(data_dir=Path(sys.argv[1]), jwt_secret='x' * 40, gemini_api_key='')
try:
    with build_motion_services(settings, vision):
        raise AssertionError('A second worker must not start')
except RuntimeError as exc:
    assert 'worker 1개' in str(exc), str(exc)
""",
                str(tmp_path),
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=20,
        )
    assert result.returncode == 0, result.stdout + result.stderr


def test_failed_startup_releases_file_lock(tmp_path, monkeypatch):
    def unavailable_database(*args):
        raise ConnectionError("database unavailable")

    monkeypatch.setattr(composition, "build_worker_supabase", unavailable_database)
    settings = Settings(
        auth_provider="supabase",
        supabase_url="https://project.example.com",
        supabase_secret_key="test-service",
    )
    vision = VisionSettings(data_dir=tmp_path, jwt_secret="x" * 40, gemini_api_key="")
    with pytest.raises(ConnectionError, match="database unavailable"):
        with composition.build_motion_services(
            settings, vision, supabase=SimpleNamespace()
        ):
            pass
    with FileLock(tmp_path / "motion" / ".runtime.lock", timeout=0):
        pass


def test_shutdown_on_another_thread_releases_file_lock(tmp_path, monkeypatch):
    monkeypatch.setattr(
        composition,
        "MotionRepository",
        lambda db: SimpleNamespace(
            check_schema=lambda: None,
            recover=lambda: None,
            start_run=None,
            finish_run=None,
        ),
    )
    monkeypatch.setattr(
        composition,
        "SupabasePhotoStore",
        lambda *args: SimpleNamespace(close=lambda: None),
    )
    monkeypatch.setattr(
        composition,
        "IngestionWorker",
        lambda *args: SimpleNamespace(
            start=lambda: None, close=lambda: None, notify=None
        ),
    )
    settings = Settings(
        auth_provider="supabase",
        supabase_url="https://project.example.com",
        supabase_secret_key="test-service",
    )
    vision = VisionSettings(data_dir=tmp_path, jwt_secret="x" * 40, gemini_api_key="")
    shared = SimpleNamespace(server=SimpleNamespace(), http=SimpleNamespace())
    context = composition.build_motion_services(settings, vision, supabase=shared)
    with (
        ThreadPoolExecutor(max_workers=1) as startup,
        ThreadPoolExecutor(max_workers=1) as shutdown,
    ):
        startup.submit(context.__enter__).result(timeout=5)
        try:
            with pytest.raises(composition.Timeout):
                with FileLock(tmp_path / "motion" / ".runtime.lock", timeout=0):
                    pass
        finally:
            shutdown.submit(context.__exit__, None, None, None).result(timeout=5)
    with FileLock(tmp_path / "motion" / ".runtime.lock", timeout=0):
        pass


def test_startup_preserves_other_server_run_and_shutdown_finishes_own(tmp_path, monkeypatch):
    other_id, own_id = '1' * 32, '2' * 32
    runs = {other_id: {'status': 'running'}, own_id: {'status': 'starting'}}
    settings = Settings(
        app_env='test', supabase_url='https://project.example.com',
        supabase_publishable_key='sb_publishable_test', supabase_secret_key='sb_secret_test',
    )

    def handle(request):
        if request.method == 'GET':
            return httpx.Response(200, json=[])
        payload = json.loads(request.content)
        if request.url.path == '/rest/v1/rpc/motion_recover':
            for run in runs.values():
                if run['status'] in {'starting', 'running', 'stopping'}:
                    run['status'] = 'failed'
        elif request.url.path == '/rest/v1/rpc/motion_start_run':
            run = runs[payload['p_run_id']]
            if run['status'] in {'starting', 'running', 'stopping'}:
                run.update(status='running', started_at=payload['p_started_at'])
        elif request.url.path == '/rest/v1/rpc/motion_finish_run':
            runs[payload['p_run_id']]['status'] = payload['p_status']
        else:
            raise AssertionError(f'Unexpected request: {request.url.path}')
        return httpx.Response(200, json=None)

    @contextmanager
    def worker_resources(config):
        with httpx.Client(transport=httpx.MockTransport(handle)) as http:
            yield SimpleNamespace(server=create_sync_supabase_client(config, http))

    stopped, started = threading.Event(), threading.Event()

    class Engine:
        def start(self, *, on_started, **kwargs):
            on_started(datetime.now(UTC))
            started.set()
            assert stopped.wait(5), 'The runtime must stop its own capture on shutdown'

        def stop(self):
            stopped.set()

    monkeypatch.setattr(composition, 'build_worker_supabase', worker_resources)
    monkeypatch.setattr(composition, 'SupabasePhotoStore',
                        lambda *args: SimpleNamespace(close=lambda: None))
    monkeypatch.setattr(composition, 'IngestionWorker',
                        lambda *args: SimpleNamespace(start=lambda: None, close=lambda: None, notify=None))
    monkeypatch.setattr(composition, 'create_motion',
                        lambda *args, **kwargs: (Engine(), SimpleNamespace(close=lambda: None)))
    shared = SimpleNamespace(server=SimpleNamespace(), http=SimpleNamespace())
    vision = VisionSettings(data_dir=tmp_path, jwt_secret='x' * 40, gemini_api_key='')
    with composition.build_motion_services(settings, vision, supabase=shared) as services:
        assert runs[other_id]['status'] == 'running', 'Startup must preserve another server capture'
        assert runs[own_id]['status'] == 'starting'
        services.runs.runtime.start(own_id, RunCreate(camera_id='00000000-0000-0000-0000-000000000001'))
        assert started.wait(5), 'The new server must be able to start its own capture'
        assert runs[own_id]['status'] == 'running'
    assert runs[own_id]['status'] == 'stopped'
    assert runs[other_id]['status'] == 'running'
