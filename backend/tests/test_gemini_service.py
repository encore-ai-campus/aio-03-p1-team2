"""실제 Google SDK와 HTTP 대역으로 분석 입출력·실패 처리를 확인합니다."""

import base64
import json
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from google import genai

from backend.vision.errors import ApplicationError
from backend.vision.services.gemini_service import GeminiAnalyzer

PHOTOS = [
    {"id": "photo-1", "timestamp_sec": 1.5},
    {"id": "photo-2", "timestamp_sec": 3.5},
]
IMAGES = [b"first-jpeg-bytes", b"second-jpeg-bytes"]
QUESTIONS = [{"id": "11111111-1111-4111-8111-111111111111", "question": "사람이 들어왔나요?"},
             {"id": "22222222-2222-4222-8222-222222222222", "question": "물건 누가 가져갔는지 확인해줘"}]
JOB = {"model_name": "test-model", "questions": QUESTIONS}
PART = {"metadata": {"start_sec": 1, "end_sec": 4}}
CONTEXT = {"objects": ["person"], "analysis_roi": None}
RESULT = {"items": [
    {"question_id": QUESTIONS[0]["id"], "verdict": "confirmed", "summary": "사람이 들어왔습니다."},
    {"question_id": QUESTIONS[1]["id"], "verdict": "uncertain", "summary": "손이 가려져 판단하기 어렵습니다."},
]}


def generated(text, finish_reason="STOP"):
    return {
        "candidates": [
            {
                "content": {"role": "model", "parts": [{"text": text}]},
                "finishReason": finish_reason,
            }
        ]
    }


@pytest.fixture
def sdk(monkeypatch):
    requests = []
    state = SimpleNamespace(
        payload=generated(json.dumps(RESULT)), status=200, exception=None
    )

    def handle(request):
        requests.append(request)
        if state.exception:
            raise state.exception
        return httpx.Response(state.status, json=state.payload)

    client_factory = genai.Client

    def sdk_client(**kwargs):
        kwargs["http_options"].httpx_client = httpx.Client(
            transport=httpx.MockTransport(handle)
        )
        return client_factory(**kwargs)

    monkeypatch.setattr(genai, "Client", sdk_client)
    files = SimpleNamespace(read_photos=Mock(return_value=IMAGES))
    analyzer = GeminiAnalyzer("fake-paid-api-key", files, 5, 12345)
    state.requests, state.files, state.analyzer = requests, files, analyzer
    try:
        yield state
    finally:
        analyzer.close()


def test_sdk_sends_ordered_images_question_and_schema(sdk):
    result = sdk.analyzer.analyze(JOB, PART, PHOTOS, CONTEXT)
    assert result.model_dump() == RESULT
    sdk.files.read_photos.assert_called_once_with(PHOTOS, 12345)
    assert len(sdk.requests) == 1
    request = sdk.requests[0]
    assert request.url.path.endswith("/models/test-model:generateContent")
    assert request.headers["x-goog-api-key"] == "fake-paid-api-key"
    assert request.extensions["timeout"]["read"] == 5
    body = json.loads(request.content)
    parts = body["contents"][0]["parts"]
    assert json.loads(parts[0]["text"]) == {
        "questions": JOB["questions"],
        "capture": PART["metadata"],
        "context": CONTEXT,
    }
    assert len(parts) == 5
    for index, (photo, image) in enumerate(zip(PHOTOS, IMAGES, strict=True)):
        assert json.loads(parts[index * 2 + 1]["text"]) == {
            "timestamp_sec": photo["timestamp_sec"],
        }
        assert parts[index * 2 + 2]["inlineData"] == {
            "mime_type": "image/jpeg",
            "data": base64.b64encode(image).decode(),
        }
    config = body["generationConfig"]
    assert config["responseMimeType"] == "application/json"
    assert config["maxOutputTokens"] == 4096
    schema = config["responseJsonSchema"]
    assert set(schema["properties"]) == {"items"}
    assert schema["required"] == ["items"]
    assert schema["properties"]["items"]["maxItems"] == 5
    assert schema["additionalProperties"] is False
    assert body["systemInstruction"]["parts"][0]["text"]


@pytest.mark.parametrize("payload", [
    {}, {"promptFeedback": {"blockReason": "SAFETY"}},
    generated(json.dumps(RESULT), "MAX_TOKENS"), generated("not json"),
    generated(json.dumps({"matched": True, "analysis": "old"})),
    generated(json.dumps({"items": []})),
    generated(json.dumps({"items": RESULT["items"][:1]})),
    generated(json.dumps({"items": [RESULT["items"][0], RESULT["items"][0]]})),
    generated(json.dumps({"items": [{**item, "question_id": "33333333-3333-4333-8333-333333333333"} for item in RESULT["items"]]})),
    *[generated(json.dumps({"items": [{**RESULT["items"][0], **change}, RESULT["items"][1]]})) for change in [
        {"verdict": True}, {"verdict": "maybe"}, {"summary": ""}, {"summary": "  "},
        {"summary": "가" * 501}, {"extra": "no"}, {"question_id": None},
    ]],
])
def test_invalid_or_incomplete_results_are_rejected(sdk, payload):
    sdk.payload = payload
    with pytest.raises(ApplicationError) as error:
        sdk.analyzer.analyze(JOB, PART, PHOTOS, CONTEXT)
    assert error.value.code == "INVALID_ANALYSIS_RESULT"
    assert len(sdk.requests) == 1


@pytest.mark.parametrize("status", [400, 429, 503])
def test_provider_errors_are_not_retried(sdk, status):
    sdk.status = status
    sdk.payload = {"error": {"code": status, "message": "private provider detail"}}
    with pytest.raises(ApplicationError) as error:
        sdk.analyzer.analyze(JOB, PART, PHOTOS, CONTEXT)
    assert error.value.code == "GEMINI_REQUEST_FAILED"
    assert str(status) in error.value.message
    assert "private provider detail" not in error.value.message
    assert len(sdk.requests) == 1


def test_unconfirmed_condition_is_a_completed_analysis(sdk):
    result = {"items": [{**item, "verdict": "uncertain"} for item in RESULT["items"]]}
    sdk.payload = generated(json.dumps(result))
    assert sdk.analyzer.analyze(JOB, PART, PHOTOS, CONTEXT).model_dump() == result


def test_network_timeout_is_not_retried(sdk):
    sdk.exception = httpx.ReadTimeout("test timeout")
    with pytest.raises(ApplicationError) as error:
        sdk.analyzer.analyze(JOB, PART, PHOTOS, CONTEXT)
    assert error.value.code == "GEMINI_NETWORK_ERROR"
    assert len(sdk.requests) == 1


def test_storage_validation_failure_prevents_model_call(sdk):
    sdk.files.read_photos.side_effect = ApplicationError(
        "PHOTO_NOT_READY", "사진 저장이 완료되지 않았습니다."
    )
    with pytest.raises(ApplicationError, match="사진 저장"):
        sdk.analyzer.analyze(JOB, PART, PHOTOS, CONTEXT)
    assert sdk.requests == []


def test_result_order_is_restored_by_question_id(sdk):
    sdk.payload = generated(json.dumps({"items": list(reversed(RESULT["items"]))}))
    assert sdk.analyzer.analyze(JOB, PART, PHOTOS, CONTEXT).model_dump() == RESULT
    assert len(sdk.requests) == 1
