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

from backend.common.dependencies import Principal, get_user
from backend.common.supabase import create_supabase_client
from backend.config import Settings
from backend.vision.dependencies import get_motion_run_service
from backend.vision.repositories.async_motion_repository import AsyncMotionRepository
from backend.vision.routers.motion_runs import router
from backend.vision.services.motion_run_service import MotionRunService


@pytest.fixture
def camera_api():
    owners = {"one": str(uuid4()), "two": str(uuid4())}
    rows, seen = [], []
    settings = Settings(
        app_env="test", supabase_url="https://project.example.com",
        supabase_publishable_key="sb_publishable_test", supabase_secret_key="sb_secret_test",
    )

    def handler(request):
        seen.append(request)
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

    async def authenticated(request: Request):
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        if token not in owners:
            raise HTTPException(401, "로그인이 필요합니다.")
        return Principal(owners[token], "user", time.time() + 60)

    async def service(request: Request):
        token = request.headers["authorization"].removeprefix("Bearer ")
        reader = await create_supabase_client(settings, request.app.state.http, token=token)
        return MotionRunService(AsyncMotionRepository(request.app.state.server, reader), None)

    app.dependency_overrides[get_user] = authenticated
    app.dependency_overrides[get_motion_run_service] = service
    with TestClient(app) as client:
        yield SimpleNamespace(client=client, rows=rows, seen=seen, owners=owners)


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
