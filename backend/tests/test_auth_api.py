"""실제 비동기 SDK가 MockTransport로 호출하는 Auth API 계약과 세션 격리."""

import json
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest


def user(identifier):
    return {"id": identifier, "aud": "authenticated", "role": "authenticated",
            "created_at": "2026-01-01T00:00:00Z", "app_metadata": {}, "user_metadata": {}}


def session(env):
    headers, owner = env.headers()
    access = headers["Authorization"].split(" ", 1)[1]
    return {"access_token": access, "refresh_token": "refresh-" + owner,
            "token_type": "bearer", "expires_in": 3600, "user": user(owner)}


def test_backend_login_preserves_password_and_returns_supabase_tokens(client, api_environment):
    env = api_environment
    result = session(env)

    def handler(request):
        assert request.method == "POST" and request.url.path == "/auth/v1/token"
        assert request.url.params["grant_type"] == "password"
        body = json.loads(request.content)
        assert body["email"] == "member@example.com"
        assert body["password"] == " password1234 "
        assert request.headers["apikey"] == "sb_publishable_test"
        return httpx.Response(200, json=result)

    env.auth_handler.append(handler)
    response = client.post("/api/auth/login", json={"email": "member@example.com", "password": " password1234 "})
    assert response.status_code == 200
    assert response.json() == {key: result[key] for key in ("access_token", "refresh_token", "expires_in", "token_type")}
    assert response.headers["cache-control"] == "no-store"
    assert "password" not in response.json()
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer " + response.json()["access_token"]}).json()["id"] == result["user"]["id"]


def test_discord_is_mounted_with_auth_and_sender_disabled(api_environment, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("DISCORD_AUTH_ENABLED", "false")
    monkeypatch.setenv("DISCORD_SENDER_ENABLED", "false")
    with TestClient(api_environment.app) as client:
        response = client.get("/api/discord/config")
        assert response.status_code == 200
        assert response.json() == {"auth_ready": False}
        assert response.headers["cache-control"] == "no-store"
        assert client.post("/api/discord/start", json={"intent": "login"}).status_code == 503
        assert client.get("/api/discord/connection").status_code == 401
        assert not api_environment.seen
    assert api_environment.app.state.discord is None


@pytest.mark.parametrize("status,code,expected", [
    (400, "invalid_credentials", 401),
    (400, "email_not_confirmed", 403),
    (429, "over_request_rate_limit", 429),
    (500, "unexpected_failure", 503),
])
def test_login_errors_hide_upstream_secrets(client, api_environment, status, code, expected):
    api_environment.auth_handler.append(lambda request: httpx.Response(
        status, json={"msg": "upstream-private-secret", "error_code": code},
    ))
    response = client.post("/api/auth/login", json={"email": "member@example.com", "password": "password1234"})
    assert response.status_code == expected
    assert "upstream-private-secret" not in response.text


def test_auth_network_error(client, api_environment):
    def unavailable(request):
        raise httpx.ConnectError("upstream secret", request=request)

    api_environment.auth_handler.append(unavailable)
    response = client.post("/api/auth/login", json={"email": "member@example.com", "password": "password1234"})
    assert response.status_code == 503 and "upstream secret" not in response.text


@pytest.mark.parametrize("payload,secret", [
    ({"email": "invalid", "password": "private-password"}, "private-password"),
    ({"email": "member@example.com", "password": "password1234", "role": "admin"}, "password1234"),
    ({"username": "old-login", "password": "password1234"}, "password1234"),
])
def test_validation_does_not_leak_credentials(client, api_environment, payload, secret):
    response = client.post("/api/auth/login", json=payload)
    assert response.status_code == 422 and secret not in response.text
    assert not api_environment.seen


def test_parallel_logins_do_not_change_shared_clients(client, api_environment):
    env = api_environment
    results = {f"user{i}@example.com": session(env) for i in range(2)}

    def handler(request):
        assert request.headers["authorization"] == "Bearer sb_publishable_test"
        return httpx.Response(200, json=results[json.loads(request.content)["email"]])

    env.auth_handler.append(handler)

    def login(email):
        response = client.post("/api/auth/login", json={"email": email, "password": "password1234"})
        assert response.status_code == 200
        return response.json()

    with ThreadPoolExecutor(max_workers=2) as workers:
        responses = list(workers.map(login, results))
    assert [r["access_token"] for r in responses] == [v["access_token"] for v in results.values()]
    resources = env.app.state.supabase
    assert "authorization" not in resources.http.headers
    assert "Authorization" not in resources.server.options.headers
    for response, expected in zip(responses, results.values()):
        assert client.get("/api/auth/me", headers={"Authorization": "Bearer " + response["access_token"]}).json()["id"] == expected["user"]["id"]


@pytest.mark.parametrize("confirmation_required", [True, False])
def test_register_creates_supabase_user(client, api_environment, confirmation_required):
    env = api_environment
    result = session(env)

    def handler(request):
        assert request.method == "POST" and request.url.path == "/auth/v1/signup"
        assert request.headers["apikey"] == "sb_publishable_test"
        body = json.loads(request.content)
        assert body["email"] == "new@example.com" and body["password"] == " password1234 "
        assert not body.get("data", {}).get("role")
        return httpx.Response(200, json=result["user"] if confirmation_required else result)

    env.auth_handler.append(handler)
    response = client.post("/api/auth/register", json={"email": "new@example.com", "password": " password1234 "})
    assert response.status_code == 201
    assert response.json() == {"user_id": result["user"]["id"], "email_confirmation_required": confirmation_required}
    assert response.headers["cache-control"] == "no-store"
    assert "access_token" not in response.json()
    assert "authorization" not in env.app.state.supabase.http.headers
    assert "Authorization" not in env.app.state.supabase.server.options.headers


@pytest.mark.parametrize("status,code,expected", [
    (422, "user_already_exists", 409),
    (422, "weak_password", 400),
    (400, "signup_disabled", 400),
    (429, "over_email_send_rate_limit", 429),
    (500, "unexpected_failure", 503),
])
def test_register_errors_are_safe(client, api_environment, status, code, expected):
    api_environment.auth_handler.append(lambda request: httpx.Response(status, json={
        "error_code": code, "msg": "private-upstream-secret", "weak_password": {"reasons": ["length"]},
    }))
    response = client.post("/api/auth/register", json={"email": "new@example.com", "password": "password1234"})
    assert response.status_code == expected
    assert "private-upstream-secret" not in response.text and "password1234" not in response.text


@pytest.mark.parametrize("code,detail", [
    ("email_address_invalid", "Supabase에서 허용하지 않는 이메일 주소입니다. 실제 사용 가능한 이메일 주소를 입력하세요."),
    ("email_address_not_authorized", "현재 Supabase 메일 설정에서는 이 주소로 인증 메일을 보낼 수 없습니다. 테스트 프로젝트의 Confirm Email 또는 SMTP 설정을 확인하세요."),
    ("signup_disabled", "Supabase에서 신규 회원가입이 비활성화되어 있습니다."),
    ("email_provider_disabled", "Supabase에서 이메일 회원가입이 비활성화되어 있습니다."),
    ("validation_failed", "회원가입 정보를 확인하세요."),
])
def test_register_explains_rejections_without_leaking_details(client, api_environment, caplog, code, detail):
    api_environment.auth_handler.append(lambda request: httpx.Response(400, json={
        "error_code": code, "msg": "private-upstream-secret",
    }))
    response = client.post("/api/auth/register", json={"email": "new@example.com", "password": "password1234"})
    assert response.status_code == 400
    assert response.json() == {"detail": detail}
    assert f"code={code}" in caplog.text
    for secret in ("private-upstream-secret", "new@example.com", "password1234"):
        assert secret not in response.text and secret not in caplog.text


@pytest.mark.parametrize("payload", [
    {"email": "new@example.com", "password": "p$7"},
    {"email": "invalid", "password": "password1234"},
    {"email": "new@example.com", "password": "password1234", "role": "admin"},
])
def test_register_validation_prevents_sdk_call(client, api_environment, payload):
    response = client.post("/api/auth/register", json=payload)
    assert response.status_code == 422
    assert payload["password"] not in response.text
    assert not api_environment.seen


def test_register_network_failure(client, api_environment):
    def unavailable(request):
        raise httpx.ConnectError("private-upstream-secret", request=request)

    api_environment.auth_handler.append(unavailable)
    response = client.post("/api/auth/register", json={"email": "new@example.com", "password": "password1234"})
    assert response.status_code == 503 and "private-upstream-secret" not in response.text
