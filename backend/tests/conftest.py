"""DB 없이 실제 공용 SDK·Auth 경계를 통과하는 웹 테스트 자원."""

import json
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace
from uuid import uuid4

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.common.supabase import SupabaseResources, create_supabase_client
from backend.config import Settings
from backend.vision.config import VisionSettings


@pytest.fixture
def api_environment(monkeypatch):
    users = {}
    seen = []
    auth_handler = []
    rest_handler = []
    profiles = {}
    settings = Settings(
        app_env="test", auth_provider="supabase",
        supabase_url="https://project.example.com",
        supabase_publishable_key="sb_publishable_test",
        supabase_secret_key="sb_secret_test",
        cors_origins=["http://localhost:5173"],
    )

    def handler(request):
        seen.append(request)
        if request.url.path.startswith("/rest/v1/"):
            assert request.headers["apikey"] == settings.supabase_secret_key
            if request.url.path == "/rest/v1/profiles":
                if request.method == "GET":
                    identifier = request.url.params["id"].removeprefix("eq.")
                    return httpx.Response(200, json=[profiles[identifier]] if identifier in profiles else [])
                if request.method == "POST":
                    identifier = json.loads(request.content)["id"]
                    profiles.setdefault(identifier, {"id": identifier, "display_name": None,
                        "role": "user", "status": "active", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"})
                    return httpx.Response(201, json=[])
                if request.method == "PATCH":
                    identifier = request.url.params["id"].removeprefix("eq.")
                    profiles[identifier].update(json.loads(request.content))
                    return httpx.Response(200, json=[profiles[identifier]])
            assert rest_handler, "unexpected database request"
            return rest_handler[0](request)
        assert request.headers["apikey"] == settings.supabase_publishable_key
        if request.url.path != "/auth/v1/user":
            assert auth_handler, "unexpected Auth request"
            return auth_handler[0](request)
        user = users.get(request.headers.get("authorization"))
        return httpx.Response(200, json=user) if user else httpx.Response(401, json={})

    @asynccontextmanager
    async def resources(config):
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            yield SupabaseResources(config, http, await create_supabase_client(config, http))

    def headers(role="user", seconds=60):
        owner = str(uuid4())
        access = jwt.encode({"sub": owner, "exp": time.time() + seconds}, "test-" + "x" * 40)
        authorization = "Bearer " + access
        users[authorization] = {"id": owner, "app_metadata": {"role": role}}
        profiles[owner] = {"id": owner, "display_name": "테스트", "role": role, "status": "active",
                           "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"}
        return {"Authorization": authorization}, owner

    monkeypatch.setattr(main, "build_supabase", resources)
    app = main.create_app(settings, VisionSettings(enabled=False))
    return SimpleNamespace(app=app, headers=headers, users=users, seen=seen, auth_handler=auth_handler,
                           profiles=profiles, rest_handler=rest_handler)


@pytest.fixture
def client(api_environment):
    with TestClient(api_environment.app) as client:
        yield client
