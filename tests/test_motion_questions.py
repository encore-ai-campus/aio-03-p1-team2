"""질문 목록 API: 실제 라우터·서비스·SDK를 통과해 UUID 발급과 소유권을 검증합니다."""
import copy
import json
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import Request

from backend.vision.config import VisionSettings
from backend.vision.dependencies import get_motion_analysis_service
from backend.vision.repositories.async_motion_repository import AsyncMotionRepository
from backend.vision.services.motion_analysis_service import MotionAnalysisService


@pytest.fixture
def questions_api(client, api_environment):
    rows = {}
    def handler(request):
        assert request.url.path == '/rest/v1/motion_analysis_questions'
        if request.method == 'GET':
            owner = request.url.params['user_id'].removeprefix('eq.')
            return httpx.Response(200, json=[copy.deepcopy(rows[owner])] if owner in rows else [])
        payload = json.loads(request.content)
        owner = payload['user_id']
        if 'resolution=ignore-duplicates' in request.headers.get('prefer', '') and owner in rows:
            return httpx.Response(201, json=[])
        rows[owner] = {**payload, 'updated_at': payload.get('updated_at', '2026-10-19T00:00:00Z')}
        return httpx.Response(201, json=[copy.deepcopy(rows[owner])])
    api_environment.rest_handler.append(handler)
    def service(request: Request):
        return MotionAnalysisService(AsyncMotionRepository(request.app.state.supabase.server), VisionSettings(enabled=False))
    api_environment.app.dependency_overrides[get_motion_analysis_service] = service
    return client, api_environment, rows


def test_questions_assign_server_ids_keep_owned_ids_and_reject_foreign_ids(questions_api):
    client, env, rows = questions_api
    headers, owner = env.headers()
    other_headers, _ = env.headers()
    url = '/api/motion/questions'
    initial = client.get(url, headers=headers).json()
    assert initial['notify_on_uncertain'] is False
    assert UUID(initial['questions'][0]['id']).version == 4
    assert client.get(url, headers=headers).json() == initial
    saved = client.put(url, headers=headers, json={'notify_on_uncertain': True, 'questions': [
        {**initial['questions'][0], 'question': '  물건 누가 가져갔는지 확인해줘  '},
        {'question': '사람이 넘어졌나요?'},
    ]})
    assert saved.status_code == 200
    questions = saved.json()['questions']
    assert questions[0]['id'] == initial['questions'][0]['id']
    assert questions[0]['question'] == '물건 누가 가져갔는지 확인해줘'
    assert UUID(questions[1]['id']).version == 4 and questions[1]['id'] != questions[0]['id']
    assert rows[owner]['questions'] == questions
    assert client.get(url, headers=headers).json()['notify_on_uncertain'] is True
    assert client.put(url, headers=headers, json={'questions': questions, 'notify_on_uncertain': 'false'}).status_code == 422
    assert client.put(url, headers=other_headers, json={'questions': questions}).status_code == 422
    assert client.get('/api/motion/question', headers=headers).status_code == 404


@pytest.mark.parametrize('payload', [
    {'question': 'old'}, {'questions': []}, {'questions': [{'question': '   '}]},
    {'questions': [{'question': '가' * 4001}]},
    {'questions': [{'question': '가' * 2500}, {'question': '나' * 2500}]},
    {'questions': [{'question': str(i)} for i in range(6)]},
    {'questions': [{'question': '같은 질문'}, {'question': ' 같은 질문 '}]},
    {'questions': [{'id': 'not-a-uuid', 'question': '질문'}]},
    {'questions': [{'question': '질문'}], 'user_id': str(uuid4())},
])
def test_invalid_question_lists_are_rejected_before_database_write(questions_api, payload):
    client, env, rows = questions_api
    headers, _ = env.headers()
    assert client.put('/api/motion/questions', headers=headers, json=payload).status_code == 422
    assert rows == {}


def test_duplicate_question_ids_and_unauthenticated_writes_are_rejected(questions_api):
    client, env, _ = questions_api
    headers, _ = env.headers()
    question = client.get('/api/motion/questions', headers=headers).json()['questions'][0]
    assert client.put('/api/motion/questions', headers=headers, json={'questions': [question, {**question, 'question': '다른 문장'}]}).status_code == 422
    assert client.put('/api/motion/questions', json={'questions': [{'question': '질문'}]}).status_code == 401
