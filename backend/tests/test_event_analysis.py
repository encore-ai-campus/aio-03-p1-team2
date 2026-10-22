"""사건 종합의 실제 SDK 요청, 실패 처리와 조회 API 계약을 검증합니다."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from fastapi.testclient import TestClient
from google import genai

from backend.common.dependencies import get_user
from backend.config import Settings
from backend.vision.config import VisionSettings
from backend.main import create_app
from backend.vision.dependencies import get_motion_analysis_service
from backend.vision.errors import ApplicationError, NotFound
from backend.vision.services.gemini_service import GeminiAnalyzer
from backend.vision.services.motion_analysis_service import MotionAnalysisService


QUESTIONS = [{"id": "11111111-1111-4111-8111-111111111111", "question": "물건 누가 가져갔는지 확인해줘"}]

def result(summary, verdict="confirmed"):
    return {"items": [{"question_id": QUESTIONS[0]["id"], "verdict": verdict, "summary": summary}]}


@pytest.fixture
def synthesis_sdk(monkeypatch):
    requests = []
    state = SimpleNamespace(
        status=200,
        text=json.dumps(
            result("물건을 들고 나간 흐름이 확인됩니다.")
        ),
        finish_reason="STOP",
    )

    def handle(request):
        requests.append(request)
        return httpx.Response(
            state.status,
            json={
                "candidates": [
                    {
                        "content": {"role": "model", "parts": [{"text": state.text}]},
                        "finishReason": state.finish_reason,
                    }
                ]
            },
        )

    factory = genai.Client

    def sdk_client(**kwargs):
        kwargs["http_options"].httpx_client = httpx.Client(
            transport=httpx.MockTransport(handle)
        )
        return factory(**kwargs)

    monkeypatch.setattr(genai, "Client", sdk_client)
    state.analyzer = GeminiAnalyzer("test-key", Mock(), 5, 12 * 1024**2)
    state.requests = requests
    state.job = {
        "questions": QUESTIONS,
        "model_name": "test-model",
        "sources": [
            {
                "part_index": index,
                "metadata": {"start_sec": (index - 1) * 10, "end_sec": index * 10},
                "status": "succeeded",
                "questions": QUESTIONS,
                "model_name": "test-model",
                "result": result(observation, "not_confirmed"),
            }
            for index, observation in enumerate(
                ["사람이 들어와 물건을 집음", "물건을 들고 나감"], 1
            )
        ],
    }
    try:
        yield state
    finally:
        state.analyzer.close()


def test_synthesis_sends_all_ordered_results_without_downloading_photos(synthesis_sdk):
    sdk = synthesis_sdk
    assert sdk.analyzer.synthesize(sdk.job).items[0].verdict == "confirmed"
    sdk.analyzer.files.read_photos.assert_not_called()
    assert len(sdk.requests) == 1
    body = json.loads(sdk.requests[0].content)
    parts = body["contents"][0]["parts"]
    assert len(parts) == 1 and "inlineData" not in parts[0]
    payload = json.loads(parts[0]["text"])
    assert [s["part_index"] for s in payload["parts"]] == [1, 2]
    assert payload["parts"][0]["result"]["items"][0]["verdict"] == "not_confirmed"
    assert payload["questions"] == sdk.job["questions"]
    assert "직접 재검토한 것이 아니라" in body["systemInstruction"]["parts"][0]["text"]


@pytest.mark.parametrize(
    "failure", ["part_failed", "different_question", "different_model", "too_large"]
)
def test_invalid_event_inputs_do_not_call_provider(synthesis_sdk, failure):
    sdk = synthesis_sdk
    source = sdk.job["sources"][1]
    if failure == "part_failed":
        source["status"] = "failed"
    elif failure == "different_question":
        source["questions"] = [{**QUESTIONS[0], "question": "다른 질문"}]
    elif failure == "different_model":
        source["model_name"] = "other-model"
    else:
        source["metadata"]["large"] = "가" * 200_000
    with pytest.raises(ApplicationError):
        sdk.analyzer.synthesize(sdk.job)
    assert sdk.requests == []


@pytest.mark.parametrize("failure", ["api", "json", "truncated"])
def test_synthesis_provider_failures_are_not_retried(synthesis_sdk, failure):
    sdk = synthesis_sdk
    if failure == "api":
        sdk.status = 503
    elif failure == "json":
        sdk.text = "not json"
    else:
        sdk.finish_reason = "MAX_TOKENS"
    with pytest.raises(ApplicationError):
        sdk.analyzer.synthesize(sdk.job)
    assert len(sdk.requests) == 1


def test_event_analysis_api_states_and_ownership(tmp_path):
    event_id = "a" * 32 + "_e000001"
    repository = AsyncMock()
    event = {"capture_state": "collecting", "final_part_index": None, "questions": QUESTIONS}

    def owned_event(identifier, owner_id):
        if identifier != event_id or owner_id != "owner":
            raise NotFound("사건")
        return event

    repository.get_event.side_effect = owned_event
    service = MotionAnalysisService(repository, VisionSettings(enabled=False))
    app = create_app(
        Settings(
            app_env="test",
            auth_provider="supabase",
            supabase_url="https://test.example.com",
            supabase_publishable_key="sb_publishable_test",
            supabase_secret_key="sb_secret_test",
        ),
        VisionSettings(enabled=False),
    )
    app.dependency_overrides[get_motion_analysis_service] = lambda: service
    user = SimpleNamespace(id="owner")
    with TestClient(app) as client:
        url = f"/api/motion/events/{event_id}/analysis"
        assert client.get(url).status_code == 401
        app.dependency_overrides[get_user] = lambda: user
        assert client.get(url).json()["status"] == "collecting"
        event.update(capture_state="closed", final_part_index=1)
        repository.event_part_analyses.return_value = []
        assert client.get(url).json()["status"] == "waiting"
        repository.event_part_analyses.return_value = [
            {
                "analysis_id": "part-analysis",
                "status": "succeeded",
                "result": result("조건 미확인", "not_confirmed"),
            }
        ]
        payload = client.get(url).json()
        assert payload["basis"] == "part" and payload["analysis_id"] == "part-analysis"
        event["final_part_index"] = 2
        repository.get_event_synthesis.return_value = None
        assert client.get(url).json()["status"] == "waiting"
        repository.get_event_synthesis.return_value = {
            "id": "event-analysis",
            "status": "succeeded",
            "sources": [{"private": "snapshot"}],
            "result": result("전체 흐름에서 조건 확인"),
        }
        payload = client.get(url).json()
        assert (
            payload["basis"] == "synthesis"
            and payload["analysis_id"] == "event-analysis"
        )
        assert "sources" not in payload
        event["capture_state"] = "interrupted"
        assert client.get(url).json()["status"] == "interrupted"
        user.id = "someone-else"
        assert client.get(url).status_code == 404
