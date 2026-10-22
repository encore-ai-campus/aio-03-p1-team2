"""Supabase HTTP 경계에서 프로필 권한·소유권·피드백·관리자 요청을 검증합니다."""
import json
import re
from uuid import uuid4

import httpx
import pytest


def feedback(owner, **changes):
    return {
        "id": 1, "user_id": owner, "title": "제목", "kind": "false_negative",
        "content": "내용", "status": "pending", "admin_note": None, "deleted_at": None,
        "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
        **changes,
    }


# [UI-FB03] 기능·역할: 검색·건수·권한을 실제 SDK HTTP 경계에서 검사. 수행 이유: 검색 후 페이지 계산과 사용자 소유권 조건이 함께 전송되어야 합니다.
@pytest.mark.parametrize("admin", [False, True])
def test_feedback_search_is_filtered_before_pagination(client, api_environment, admin):
    env = api_environment
    headers, owner = env.headers(role="admin" if admin else "user")

    def handle(request):
        params = request.url.params
        assert params["deleted_at"] == "is.null"
        assert params.get("user_id") == (None if admin else "eq." + owner)
        assert params["or"] == '(title.imatch."현관",content.imatch."현관")'
        assert params["kind"] == "eq.suggestion"
        assert params["status"] == "eq.pending"
        assert params["offset"] == "20" and params["limit"] == "20"
        assert "count=exact" in request.headers["prefer"]
        assert params["order"] == "created_at.desc,id.desc"
        return httpx.Response(200, json=[feedback(owner, id=21, kind="suggestion")],
                              headers={"Content-Range": "20-20/31"})

    env.rest_handler.append(handle)
    path = "/api/admin/feedback" if admin else "/api/feedback"
    response = client.get(path, headers=headers, params={
        "q": "  현관  ", "kind": "suggestion", "status": "pending", "offset": 20,
    })
    assert response.status_code == 200
    assert response.json()["total"] == 31
    assert response.json()["items"][0]["id"] == 21


@pytest.mark.parametrize("admin", [False, True])
def test_feedback_number_search_uses_exact_id(client, api_environment, admin):
    env = api_environment
    headers, owner = env.headers(role="admin" if admin else "user")

    def handle(request):
        assert request.url.params["id"] == "eq.42"
        assert request.url.params.get("user_id") == (None if admin else "eq." + owner)
        assert request.url.params["deleted_at"] == "is.null"
        assert "or" not in request.url.params
        return httpx.Response(200, json=[feedback(owner, id=42)],
                              headers={"Content-Range": "0-0/1"})

    env.rest_handler.append(handle)
    path = "/api/admin/feedback" if admin else "/api/feedback"
    response = client.get(path, headers=headers, params={"feedback_id": 42})
    assert response.status_code == 200
    assert response.json()["total"] == 1 and response.json()["items"][0]["id"] == 42


def test_feedback_search_keeps_accounts_separate(client, api_environment):
    env = api_environment
    account_a, owner_a = env.headers()
    account_b, owner_b = env.headers()

    def handle(request):
        owner_filter = request.url.params["user_id"]
        assert owner_filter in {"eq." + owner_a, "eq." + owner_b}
        assert request.url.params["id"] == "eq.42"
        rows = [feedback(owner_a, id=42)] if owner_filter == "eq." + owner_a else []
        return httpx.Response(200, json=rows,
                              headers={"Content-Range": "0-0/1" if rows else "*/0"})

    env.rest_handler.append(handle)
    assert client.get("/api/feedback?feedback_id=42", headers=account_a).json()["total"] == 1
    other = client.get("/api/feedback?feedback_id=42&user_id=" + owner_a, headers=account_b)
    assert other.status_code == 200
    assert other.json()["items"] == [] and other.json()["total"] == 0
    assert client.get("/api/admin/feedback?q=현관", headers=account_b).status_code == 403


@pytest.mark.parametrize("q", ['A%_*.,()"\\', '),user_id.neq.anything', "한글 [감지] + 알림", "a\nb"])
def test_feedback_search_treats_special_characters_as_literal(client, api_environment, q):
    env = api_environment
    headers, owner = env.headers()

    def handle(request):
        assert request.url.params["user_id"] == "eq." + owner
        expression = request.url.params["or"]
        parts = re.fullmatch(r'\(title\.imatch\."((?:[^"\\]|\\.)*)",content\.imatch\."((?:[^"\\]|\\.)*)"\)', expression, re.S)
        assert parts and parts[1] == parts[2]
        pattern = re.sub(r"\\(.)", r"\1", parts[1], flags=re.S)
        assert re.search(pattern, "prefix " + q + " suffix", re.I)
        assert not re.search(pattern, "unrelated", re.I)
        return httpx.Response(200, json=[], headers={"Content-Range": "*/0"})

    env.rest_handler.append(handle)
    response = client.get("/api/feedback", headers=headers, params={"q": q})
    assert response.status_code == 200 and response.json()["total"] == 0


@pytest.mark.parametrize("admin", [False, True])
@pytest.mark.parametrize("params", [
    {"q": "x" * 101}, {"feedback_id": "0"}, {"feedback_id": "-1"},
    {"feedback_id": "1.5"}, {"feedback_id": "abc"}, {"feedback_id": "9223372036854775808"},
])
def test_feedback_search_rejects_invalid_parameters(client, api_environment, admin, params):
    env = api_environment
    headers, _ = env.headers(role="admin" if admin else "user")
    path = "/api/admin/feedback" if admin else "/api/feedback"
    assert client.get(path, headers=headers, params=params).status_code == 422
    assert not [request for request in env.seen if request.url.path.endswith("/feedback")]


def test_profile_is_authoritative_and_inactive_users_are_blocked(client, api_environment):
    env = api_environment
    headers, owner = env.headers(role="admin")
    env.profiles[owner]["role"] = "user"
    assert client.get("/api/auth/me", headers=headers).json() == {"id": owner, "role": "user"}
    assert client.get("/api/admin/users", headers=headers).status_code == 403
    env.profiles[owner]["status"] = "inactive"
    assert client.get("/api/users/me", headers=headers).status_code == 403
    assert client.get("/api/feedback", headers=headers).status_code == 403
    assert client.get("/api/users/me").status_code == 401


def test_missing_profile_is_created_without_copying_metadata_role(client, api_environment):
    env = api_environment
    headers, owner = env.headers(role="admin")
    del env.profiles[owner]
    response = client.get("/api/users/me", headers=headers)
    assert response.status_code == 200 and response.json()["role"] == "user"
    inserts = [r for r in env.seen if r.method == "POST" and r.url.path.endswith("/profiles")]
    assert len(inserts) == 1 and json.loads(inserts[0].content) == {"id": owner}
    assert "resolution=ignore-duplicates" in inserts[0].headers["prefer"]


def test_profile_update_and_protected_fields(client, api_environment):
    env = api_environment
    headers, owner = env.headers()
    env.users[headers["Authorization"]]["email"] = "member@example.com"
    response = client.patch("/api/users/me", headers=headers, json={"display_name": "새 이름"})
    assert response.status_code == 200
    assert response.json()["display_name"] == "새 이름"
    assert response.json()["email"] == "member@example.com"
    for payload in ({"display_name": ""}, {"display_name": "이름", "role": "admin"}, {"status": "active"}):
        assert client.patch("/api/users/me", headers=headers, json=payload).status_code == 422
    assert env.profiles[owner]["role"] == "user"


def test_feedback_create_uses_verified_owner(client, api_environment):
    env = api_environment
    headers, owner = env.headers()

    def handle(request):
        assert request.method == "POST" and request.url.path == "/rest/v1/feedback"
        assert json.loads(request.content) == {
            "title": "제목", "kind": "false_negative", "content": "내용", "user_id": owner,
        }
        return httpx.Response(201, json=[feedback(owner)])

    env.rest_handler.append(handle)
    response = client.post("/api/feedback", headers=headers, json={"title": "제목", "kind": "false_negative", "content": "내용"})
    assert response.status_code == 201 and response.json()["id"] == 1


@pytest.mark.parametrize("method,payload", [("GET", None), ("PATCH", {"content": "수정"}), ("DELETE", None)])
def test_feedback_owner_and_deleted_filters_are_sent_to_database(client, api_environment, method, payload):
    env = api_environment
    headers, owner = env.headers()

    def handle(request):
        assert request.url.params["user_id"] == "eq." + owner
        assert request.url.params["id"] == "eq.42"
        assert request.url.params["deleted_at"] == "is.null"
        return httpx.Response(200, json=[])

    env.rest_handler.append(handle)
    assert client.request(method, "/api/feedback/42", headers=headers, json=payload).status_code == 404


def test_feedback_soft_delete(client, api_environment):
    env = api_environment
    headers, owner = env.headers()

    def handle(request):
        assert request.method == "PATCH"
        body = json.loads(request.content)
        assert body["deleted_at"] and body["updated_at"]
        assert set(body) == {"deleted_at", "updated_at"}
        return httpx.Response(200, json=[feedback(owner, **body)])

    env.rest_handler.append(handle)
    response = client.delete("/api/feedback/1", headers=headers)
    assert response.status_code == 204 and not response.content


def test_feedback_list_filters_and_paging(client, api_environment):
    env = api_environment
    headers, owner = env.headers()

    def handle(request):
        assert request.url.params["user_id"] == "eq." + owner
        assert request.url.params["status"] == "eq.pending"
        assert request.url.params["kind"] == "eq.false_negative"
        assert request.url.params["offset"] == "1" and request.url.params["limit"] == "2"
        return httpx.Response(200, json=[feedback(owner)], headers={"Content-Range": "1-1/3"})

    env.rest_handler.append(handle)
    response = client.get("/api/feedback?limit=2&offset=1&status=pending&kind=false_negative", headers=headers)
    assert response.status_code == 200
    assert response.json()["total"] == 3


@pytest.mark.parametrize("payload", [
    {"title": "제목", "kind": "false_positive", "content": "내용", "user_id": str(uuid4())},
    {"title": "제목", "kind": "false_positive", "content": "내용", "status": "resolved"},
    {"title": " ", "kind": "suggestion", "content": "내용"},
    {"title": "제목", "kind": "wrong", "content": "내용"},
])
def test_feedback_rejects_invalid_or_privileged_fields(client, api_environment, payload):
    headers, _ = api_environment.headers()
    assert client.post("/api/feedback", headers=headers, json=payload).status_code == 422
    assert not [r for r in api_environment.seen if r.url.path.endswith("/feedback")]


@pytest.mark.parametrize("payload", [{}, {"content": None}, {"status": "resolved"}, {"admin_note": "수정"}])
def test_feedback_patch_rejects_empty_null_and_admin_fields(client, api_environment, payload):
    headers, _ = api_environment.headers()
    assert client.patch("/api/feedback/1", headers=headers, json=payload).status_code == 422


def test_admin_changes_use_transactional_rpc_with_verified_actor(client, api_environment):
    env = api_environment
    headers, owner = env.headers(role="admin")

    def handle(request):
        assert request.url.path == "/rest/v1/rpc/web_admin_change"
        assert json.loads(request.content) == {
            "p_actor_id": owner, "p_target_type": "feedback", "p_target_id": "1",
            "p_changes": {"status": "resolved", "admin_note": None}, "p_action": "update",
        }
        return httpx.Response(200, json=feedback(owner, status="resolved"))

    env.rest_handler.append(handle)
    response = client.patch("/api/admin/feedback/1", headers=headers, json={"status": "resolved", "admin_note": None})
    assert response.status_code == 200 and response.json()["status"] == "resolved"
    ordinary, _ = env.headers()
    assert client.patch("/api/admin/feedback/1", headers=ordinary, json={"status": "resolved"}).status_code == 403


@pytest.mark.parametrize("code,expected", [("P0002", 404), ("42501", 403), ("22023", 409), ("PGRST202", 503)])
def test_admin_rpc_error_mapping(client, api_environment, code, expected):
    env = api_environment
    headers, _ = env.headers(role="admin")
    env.rest_handler.append(lambda request: httpx.Response(400, json={
        "code": code, "message": "private-database-error", "details": None, "hint": None,
    }))
    response = client.patch("/api/admin/users/" + str(uuid4()), headers=headers, json={"status": "inactive"})
    assert response.status_code == expected
    assert "private-database-error" not in response.text


def test_admin_users_page_includes_auth_email(client, api_environment):
    env = api_environment
    headers, owner = env.headers(role="admin")

    def handle(request):
        assert request.url.path == "/rest/v1/rpc/web_admin_users_page"
        assert json.loads(request.content) == {"p_actor_id": owner, "p_limit": 20, "p_offset": 0}
        return httpx.Response(200, json={"items": [{**env.profiles[owner], "email": "admin@example.com",
            "last_sign_in_at": None}], "total": 1, "limit": 20, "offset": 0})

    env.rest_handler.append(handle)
    response = client.get("/api/admin/users", headers=headers)
    assert response.status_code == 200 and response.json()["items"][0]["email"] == "admin@example.com"


@pytest.mark.parametrize("path", ["/api/notifications", "/api/notifications/stream"])
def test_missing_notification_table_is_explicit_and_stream_does_not_start(client, api_environment, path):
    env = api_environment
    headers, _ = env.headers()
    env.rest_handler.append(lambda request: httpx.Response(404, json={
        "code": "PGRST205", "message": "private-database-error", "details": None, "hint": None,
    }))
    response = client.get(path, headers=headers)
    assert response.status_code == 503 and "notifications" in response.json()["detail"]
    assert "private-database-error" not in response.text


def test_notifications_retain_owner_scope(client, api_environment):
    env = api_environment
    headers, owner = env.headers()

    def handle(request):
        assert request.url.params["owner_id"] == "eq." + owner
        assert request.url.params["kind"] == "eq.motion"
        return httpx.Response(200, json=[], headers={"Content-Range": "*/0"})

    env.rest_handler.append(handle)
    assert client.get("/api/notifications", headers=headers).json()["total"] == 0


def test_cors_delete_and_legacy_event_feedback_removal(client):
    response = client.options("/api/feedback/1", headers={
        "Origin": "http://localhost:5173", "Access-Control-Request-Method": "DELETE",
        "Access-Control-Request-Headers": "Authorization",
    })
    assert response.status_code == 200
    assert client.post("/api/events/" + str(uuid4()) + "/feedback", json={}).status_code == 404
    assert "/api/notifications/stream" in client.app.openapi()["paths"]
