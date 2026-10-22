"""관리자 인증과 실제 비동기 SDK의 사용자 간 비전 조회 경계를 검증합니다."""
import hashlib
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest

from backend.vision.config import VisionSettings
from backend.vision.repositories.async_motion_repository import AsyncMotionRepository
from backend.vision.services.async_photo_reader import AsyncPhotoReader
from backend.vision.services.motion_analysis_service import MotionAnalysisService
from backend.vision.services.motion_evidence_service import MotionEvidenceService


EVENT = "a" * 32 + "_e000001"
PART = "11111111-1111-4111-8111-111111111111"
PATHS = [
    "/cameras", f"/cameras/{PART}/events", f"/events/{EVENT}",
    f"/events/{EVENT}/parts", f"/parts/{PART}", f"/photos/{PART}/content",
    f"/parts/{PART}/analyses", f"/analyses/{PART}", f"/events/{EVENT}/analysis",
]


@pytest.fixture
def admin_vision(client, api_environment):
    resources = api_environment.app.state.supabase
    repository = AsyncMotionRepository(resources.server)
    services = SimpleNamespace(
        evidence=MotionEvidenceService(repository, AsyncPhotoReader(resources.settings, resources.http)),
        analyses=MotionAnalysisService(repository, VisionSettings(enabled=False)),
    )
    api_environment.app.state.motion = services
    return services


@pytest.mark.parametrize("path", PATHS)
def test_admin_vision_denies_anonymous_and_ordinary_users(client, api_environment, path):
    headers, _ = api_environment.headers()
    assert client.get("/api/admin" + path).status_code == 401
    assert client.get("/api/admin" + path, headers=headers).status_code == 403
    assert not [r for r in api_environment.seen if r.url.path.startswith("/rest/v1/motion_")]


def test_admin_vision_disabled_returns_503(client, api_environment):
    headers, _ = api_environment.headers("admin")
    assert client.get("/api/admin/cameras", headers=headers).status_code == 503


def test_admin_lists_other_users_cameras_and_filters_owner(client, api_environment, admin_vision):
    headers, admin_id = api_environment.headers("admin")
    owner, camera = str(uuid4()), str(uuid4())
    assert owner != admin_id

    def handle(request):
        assert request.url.path == "/rest/v1/cameras"
        assert request.url.params["owner_id"] == "eq." + owner
        assert request.url.params["offset"] == "2"
        assert request.url.params["limit"] == "3"
        return httpx.Response(200, json=[{"id": camera, "owner_id": owner, "name": "거실"}])

    api_environment.rest_handler.append(handle)
    response = client.get(f"/api/admin/cameras?user_id={owner}&offset=2&limit=3", headers=headers)
    assert response.status_code == 200 and response.json()[0]["owner_id"] == owner


def test_admin_camera_events_filter_and_missing_camera(client, api_environment, admin_vision):
    headers, _ = api_environment.headers("admin")
    camera = str(uuid4())

    def handle(request):
        if request.url.path.endswith("/cameras"):
            assert request.url.params["id"] == "eq." + camera
            return httpx.Response(200, json=[{"id": camera}])
        assert request.url.path.endswith("/motion_events")
        assert request.url.params["motion_runs.camera_id"] == "eq." + camera
        assert "motion_runs.cameras.owner_id" not in request.url.params
        return httpx.Response(200, json=[{
            "id": EVENT, "run_id": "a" * 32, "detected_at": "2026-01-01T00:00:00Z",
            "capture_state": "collecting", "questions": [], "motion_parts": [],
            "motion_event_analyses": None,
        }])

    api_environment.rest_handler.append(handle)
    response = client.get(f"/api/admin/cameras/{camera}/events", headers=headers)
    assert response.status_code == 200 and response.json()[0]["id"] == EVENT
    api_environment.rest_handler[0] = lambda request: httpx.Response(200, json=[])
    assert client.get(f"/api/admin/cameras/{camera}/events", headers=headers).status_code == 404


def test_admin_part_links_and_photo_download(client, api_environment, admin_vision, monkeypatch):
    headers, _ = api_environment.headers("admin")
    data = b"stored-photo-bytes"
    photo = {"id": PART, "part_id": PART, "sequence_no": 0, "timestamp_sec": 1,
             "upload_status": "ready", "storage_key": "original.jpg",
             "byte_size": len(data), "sha256": hashlib.sha256(data).hexdigest()}

    def handle(request):
        assert request.method == "GET"
        assert "owner_id" not in request.url.params["select"]
        if request.url.path.endswith("/motion_parts"):
            return httpx.Response(200, json=[{
                "id": PART, "event_id": EVENT, "part_index": 1,
                "metadata": {"start_sec": 0, "end_sec": 1,
                             "context_complete": True, "evidence_complete": True},
            }])
        return httpx.Response(200, json=[photo])

    api_environment.rest_handler.append(handle)
    detail = client.get(f"/api/admin/parts/{PART}", headers=headers)
    assert detail.status_code == 200
    url = detail.json()["photos"][0]["content_url"]
    assert url == f"/api/admin/photos/{PART}/content"

    download = AsyncMock(return_value=data)
    monkeypatch.setattr(admin_vision.evidence.files, "content", download)
    response = client.get(url, headers=headers)
    assert response.status_code == 200 and response.content == data
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["cache-control"] == "private, no-store"
    download.assert_awaited_once_with(photo)


def test_admin_reads_analysis_without_gemini_call(client, api_environment, admin_vision):
    headers, _ = api_environment.headers("admin")
    row = {"id": PART, "part_id": PART, "origin": "auto", "questions": [],
           "model_name": "test-model", "status": "failed", "result": None,
           "error_message": "Gemini HTTP 401", "created_at": "2026-01-01T00:00:00Z"}

    def handle(request):
        assert request.method == "GET" and request.url.path.endswith("/motion_analyses")
        assert request.url.params["id"] == "eq." + PART
        assert "owner_id" not in request.url.params["select"]
        return httpx.Response(200, json=[row])

    api_environment.rest_handler.append(handle)
    response = client.get(f"/api/admin/analyses/{PART}", headers=headers)
    assert response.status_code == 200 and response.json()["error_message"] == "Gemini HTTP 401"


def test_admin_event_analysis_and_part_history(client, api_environment, admin_vision):
    headers, _ = api_environment.headers("admin")

    def handle(request):
        assert request.method == "GET"
        params = request.url.params
        assert "owner_id" not in params["select"]
        if request.url.path.endswith("/motion_events"):
            return httpx.Response(200, json=[{
                "id": EVENT, "run_id": "a" * 32, "questions": [],
                "capture_state": "closed", "final_part_index": 2,
            }])
        if request.url.path.endswith("/motion_event_analyses"):
            assert params["event_id"] == "eq." + EVENT
            return httpx.Response(200, json=[{
                "id": PART, "questions": [], "status": "failed",
                "error_message": "source failed", "result": None,
            }])
        if request.url.path.endswith("/motion_parts") and "id" in params:
            return httpx.Response(200, json=[{"id": PART}])
        if request.url.path.endswith("/motion_parts"):
            assert params["event_id"] == "eq." + EVENT
            assert params["part_index"] == "gt.2"
        else:
            assert request.url.path.endswith("/motion_analyses")
            assert params["part_id"] == "eq." + PART
        return httpx.Response(200, json=[])

    api_environment.rest_handler.append(handle)
    response = client.get(f"/api/admin/events/{EVENT}/analysis", headers=headers)
    assert response.status_code == 200 and response.json()["basis"] == "synthesis"
    assert response.json()["error_message"] == "source failed"
    assert client.get(f"/api/admin/events/{EVENT}/parts?after=2", headers=headers).json() == []
    assert client.get(f"/api/admin/parts/{PART}/analyses", headers=headers).json() == []
