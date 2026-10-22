"""실제 라우터·서비스·SDK 경계를 통해 종료 필터와 분석 요약을 검증합니다."""
import copy

QUESTION = {"id": "11111111-1111-4111-8111-111111111111", "question": "사람 출입을 확인해줘"}
def result(text):
    return {"items": [{"question_id": QUESTION["id"], "verdict": "confirmed", "summary": text}]}
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from backend.common.dependencies import Principal, get_user
from backend.common.supabase import create_supabase_client
from backend.config import Settings
from backend.vision.dependencies import get_motion_evidence_service
from backend.vision.repositories.async_motion_repository import AsyncMotionRepository
from backend.vision.routers.motion_evidence import router
from backend.vision.services.motion_evidence_service import MotionEvidenceService


@pytest.fixture
def events_api():
    owner = str(uuid4())
    rows, seen = [], []
    settings = Settings(app_env="test", supabase_url="https://project.example.com",
                        supabase_publishable_key="sb_publishable_test", supabase_secret_key="sb_secret_test")

    def handler(request):
        seen.append(request)
        assert request.url.path == "/rest/v1/motion_events"
        assert request.headers["apikey"] == settings.supabase_publishable_key
        assert request.headers["authorization"] == "Bearer owner-token"
        params = request.url.params
        assert params["motion_runs.cameras.owner_id"] == "eq." + owner
        assert params["motion_parts.part_index"] == "eq.1"
        assert params["motion_parts.motion_analyses.origin"] == "eq.auto"
        assert params["order"] == "detected_at.desc,id.desc"
        selected = params["select"]
        assert "motion_event_analyses(status,result)" in selected
        assert "motion_analyses(status,result)" in selected
        result = copy.deepcopy(rows)
        if "capture_state" in params:
            assert params["capture_state"] == "in.(closed,interrupted)"
            result = [row for row in result if row["capture_state"] in {"closed", "interrupted"}]
        return httpx.Response(200, json=result[:int(params["limit"])])

    @asynccontextmanager
    async def lifespan(app):
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            app.state.reader = await create_supabase_client(settings, http, token="owner-token")
            yield

    app = FastAPI(lifespan=lifespan)
    app.include_router(router)

    async def authenticated(request: Request):
        if request.headers.get("authorization") != "Bearer owner-token":
            raise HTTPException(401, "로그인이 필요합니다.")
        return Principal(owner, "user", time.time() + 60)

    def service(request: Request):
        return MotionEvidenceService(AsyncMotionRepository(request.app.state.reader), None)

    app.dependency_overrides[get_user] = authenticated
    app.dependency_overrides[get_motion_evidence_service] = service
    with TestClient(app) as client:
        yield SimpleNamespace(client=client, rows=rows, seen=seen, headers={"Authorization": "Bearer owner-token"})


def event(number, state="closed", final=1, source=None, synthesis=None):
    return {"id": f'{"a" * 32}_e{number:06d}', "run_id": "a" * 32,
            "detected_at": "2026-10-19T04:00:00Z", "capture_state": state,
            "final_part_index": final, "questions": [QUESTION], "motion_runs": {"cameras": {"owner_id": "private"}},
            "motion_parts": [{"part_index": 1, "motion_analyses": [source] if source else []}],
            "motion_event_analyses": synthesis}


def test_finished_filter_is_applied_before_limit_and_keeps_interrupted_events(events_api):
    env = events_api
    env.rows.extend([event(index, "collecting") for index in range(1, 26)])
    env.rows.extend([event(26), event(27, "interrupted"), event(28)])
    response = env.client.get("/api/motion/events?limit=2&finished_only=true", headers=env.headers)
    assert response.status_code == 200
    assert [row["id"] for row in response.json()] == [env.rows[25]["id"], env.rows[26]["id"]]
    assert len(env.seen) == 1


def test_live_list_retains_collecting_events_by_default(events_api):
    env = events_api
    env.rows.append(event(1, "collecting"))
    response = env.client.get("/api/motion/events?limit=5", headers=env.headers)
    assert response.status_code == 200 and response.json()[0]["capture_state"] == "collecting"
    assert "capture_state" not in env.seen[0].url.params


def test_summary_uses_single_part_or_event_synthesis_without_extra_requests(events_api):
    env = events_api
    part = {"status": "succeeded", "result": result("사람이 보이지 않습니다.")}
    synthesis = {"status": "succeeded", "result": result("사람이 현관으로 들어왔습니다.")}
    env.rows.extend([event(1, source=part), event(2, final=2, source=part, synthesis=synthesis)])
    response = env.client.get("/api/motion/events", headers=env.headers)
    assert response.status_code == 200
    assert [row["result"]["items"][0]["summary"] for row in response.json()] == ["사람이 보이지 않습니다.", "사람이 현관으로 들어왔습니다."]
    assert all(not any(key.startswith("motion_") for key in row) for row in response.json())
    assert len(env.seen) == 1


@pytest.mark.parametrize("state,source", [
    ("closed", None), ("closed", {"status": "running", "result": None}),
    ("closed", {"status": "failed", "result": {"analysis": "미완료 결과"}}),
    ("interrupted", {"status": "succeeded", "result": {"analysis": "부분 결과"}}),
])
def test_unavailable_or_unfinished_results_leave_summary_empty(events_api, state, source):
    env = events_api
    env.rows.append(event(1, state, source=source))
    response = env.client.get("/api/motion/events", headers=env.headers)
    assert response.status_code == 200 and response.json()[0]["result"] is None


def test_events_reject_unauthenticated_requests_and_invalid_filters(events_api):
    env = events_api
    assert env.client.get("/api/motion/events?finished_only=true").status_code == 401
    assert env.client.get("/api/motion/events?finished_only=invalid", headers=env.headers).status_code == 422
    assert env.seen == []
