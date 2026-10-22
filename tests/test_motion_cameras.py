"""실제 비전 라우터·서비스·비동기 SDK를 통과하며 외부 DB는 호출하지 않습니다."""

import json
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from fastapi.responses import JSONResponse

from backend.common.dependencies import Principal, get_user
from backend.common.supabase import create_supabase_client
from backend.config import Settings
from backend.vision.dependencies import get_motion_preview_service, get_motion_run_service
from backend.vision.errors import ApplicationError
from backend.vision.repositories.async_motion_repository import AsyncMotionRepository
from backend.vision.routers.motion_runs import router
from backend.vision.routers.motion_preview import router as preview_router
from backend.vision.services.motion_run_service import MotionRunService
from backend.vision.services.motion_preview_service import MotionPreviewService


@pytest.fixture
def camera_api():
    owners = {"one": str(uuid4()), "two": str(uuid4())}
    rows, runs, seen = [], [], []
    settings = Settings(
        app_env="test", supabase_url="https://project.example.com",
        supabase_publishable_key="sb_publishable_test", supabase_secret_key="sb_secret_test",
    )

    def handler(request):
        seen.append(request)
        if request.url.path == "/rest/v1/motion_runs":
            assert request.headers["apikey"] == settings.supabase_publishable_key
            owner = owners[request.headers["authorization"].removeprefix("Bearer ")]
            assert request.url.params["cameras.owner_id"] == "eq." + owner
            result = [run for run in runs if run["cameras"]["owner_id"] == owner]
            if "id" in request.url.params:
                result = [run for run in result if "eq." + run["id"] == request.url.params["id"]]
            if "status" in request.url.params:
                assert request.url.params["status"] == "in.(starting,running)"
                result = [run for run in result if run["status"] in {"starting", "running"}]
            return httpx.Response(200, json=result[:int(request.url.params["limit"])])
        assert request.url.path == "/rest/v1/cameras"
        if request.method == "POST":
            assert request.headers["apikey"] == settings.supabase_secret_key
            row = json.loads(request.content)
            rows.append(row)
            return httpx.Response(201, json=[row])
        assert request.headers["apikey"] == settings.supabase_publishable_key
        token = request.headers["authorization"].removeprefix("Bearer ")
        owner = owners[token]
        assert request.url.params["owner_id"] == "eq." + owner
        return httpx.Response(200, json=[row for row in rows if row["owner_id"] == owner])

    @asynccontextmanager
    async def lifespan(app):
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            app.state.http = http
            app.state.server = await create_supabase_client(settings, http)
            yield

    app = FastAPI(lifespan=lifespan)
    app.include_router(router)
    app.include_router(preview_router)
    app.state.vision_settings = SimpleNamespace(jwt_secret="test-preview-key-" * 4, ticket_seconds=60)

    @app.exception_handler(ApplicationError)
    async def application_error(request, exc):
        return JSONResponse(status_code=exc.status_code, content={"error": {"code": exc.code, "message": exc.message}})

    async def authenticated(request: Request):
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        if token not in owners:
            raise HTTPException(401, "로그인이 필요합니다.")
        return Principal(owners[token], "user", time.time() + 60)

    async def service(request: Request):
        token = request.headers.get("authorization", "Bearer one").removeprefix("Bearer ")
        reader = await create_supabase_client(settings, request.app.state.http, token=token)
        return MotionRunService(AsyncMotionRepository(request.app.state.server, reader), None)

    async def preview_service(request: Request):
        repository = (await service(request)).repository
        frame = SimpleNamespace(jpeg=b"private-jpeg", frame_index=1, elapsed_sec=1)
        preview = SimpleNamespace(snapshot=lambda **kwargs: frame)
        return MotionPreviewService(repository, SimpleNamespace(preview=lambda run_id: preview))

    app.dependency_overrides[get_user] = authenticated
    app.dependency_overrides[get_motion_run_service] = service
    app.dependency_overrides[get_motion_preview_service] = preview_service
    with TestClient(app) as client:
        yield SimpleNamespace(client=client, rows=rows, runs=runs, seen=seen, owners=owners)


def test_camera_registration_generates_uuid_and_uses_authenticated_owner(camera_api):
    env = camera_api
    response = env.client.post("/api/motion/cameras", headers={"Authorization": "Bearer one"}, json={"name": "  거실  "})
    assert response.status_code == 201
    camera = response.json()
    assert camera["name"] == "거실" and UUID(camera["id"]).version == 4
    assert env.rows == [{"id": camera["id"], "owner_id": env.owners["one"], "name": "거실"}]
    own = env.client.get("/api/motion/cameras", headers={"Authorization": "Bearer one"})
    assert own.status_code == 200 and own.json() == [camera]
    other = env.client.get("/api/motion/cameras", headers={"Authorization": "Bearer two"})
    assert other.status_code == 200 and other.json() == []


@pytest.mark.parametrize("payload", [
    {}, {"name": ""}, {"name": "   "}, {"name": "x" * 81}, {"name": 123},
    {"name": "거실", "owner_id": str(uuid4())}, {"name": "거실", "id": str(uuid4())},
])
def test_camera_registration_rejects_bad_names_and_client_assigned_identity(camera_api, payload):
    response = camera_api.client.post("/api/motion/cameras", headers={"Authorization": "Bearer one"}, json=payload)
    assert response.status_code == 422
    assert not camera_api.seen


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_camera_endpoints_require_authentication(camera_api, method):
    response = camera_api.client.request(method, "/api/motion/cameras", json={"name": "거실"} if method == "POST" else None)
    assert response.status_code == 401
    assert not camera_api.seen


def test_active_runs_filter_precedes_limit_and_keeps_owner_scope(camera_api):
    env = camera_api
    camera_id = str(uuid4())
    def run(index, status, owner):
        return {"id": f"{index:032x}", "camera_id": camera_id, "config": {}, "status": status,
                "requested_at": "2026-10-22T00:00:00Z", "cameras": {"owner_id": owner}}
    env.runs.extend(run(i, "stopped", env.owners["one"]) for i in range(25))
    env.runs.extend([run(25, "running", env.owners["two"]), run(26, "running", env.owners["one"])])
    response = env.client.get("/api/motion/runs?active_only=true&limit=1", headers={"Authorization": "Bearer one"})
    assert response.status_code == 200
    assert [row["id"] for row in response.json()] == [f"{26:032x}"]
    assert "cameras" not in response.json()[0]
    assert env.client.get("/api/motion/runs?active_only=true").status_code == 401


def test_remote_preview_requires_owner_and_ticket_is_scoped_to_one_run(camera_api):
    env = camera_api
    run_id = "a" * 32
    env.runs.append({"id": run_id, "camera_id": str(uuid4()), "config": {}, "status": "running",
                     "requested_at": "2026-10-22T00:00:00Z", "cameras": {"owner_id": env.owners["one"]}})
    path = f"/api/motion/runs/{run_id}"
    assert env.client.post(path + "/preview-ticket").status_code == 401
    assert env.client.post(path + "/preview-ticket", headers={"Authorization": "Bearer two"}).status_code == 404
    response = env.client.post(path + "/preview-ticket", headers={"Authorization": "Bearer one"})
    assert response.status_code == 200 and 0 < response.json()["expires_in"] <= 60
    url = response.json()["image_url"]
    assert env.client.get(url).content == b"private-jpeg"
    assert env.client.get(url.replace(run_id, "b" * 32)).status_code == 404
    assert env.client.get(path + "/preview.jpg?ticket=invalid").status_code == 401
