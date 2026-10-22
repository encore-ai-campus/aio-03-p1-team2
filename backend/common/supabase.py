"""인증 헤더는 SDK별로 보관하고 서버 수명 동안 HTTP 연결 풀만 공유합니다."""

from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass, field

import httpx
from supabase import AsyncClient, Client, acreate_client, create_client
from supabase.lib.client_options import AsyncClientOptions, SyncClientOptions

from backend.config import Settings


def create_sync_supabase_client(
    settings: Settings, http: httpx.Client, *, token: str | None = None
) -> Client:
    if token is not None and not token.strip():
        raise ValueError("사용자 클라이언트에는 로그인 토큰이 필요합니다.")
    key = (
        settings.supabase_publishable_key
        if token is not None
        else settings.supabase_secret_key
    )
    client = create_client(
        settings.supabase_url,
        key,
        options=SyncClientOptions(
            httpx_client=http,
            headers={"Authorization": f"Bearer {token}"} if token is not None else {},
            persist_session=False,
            auto_refresh_token=False,
        ),
    )
    if token is None and key.startswith("sb_secret_"):
        # Secret 키는 JWT가 아닙니다. 서버 요청은 apikey 헤더로 인증합니다.
        client.options.headers.pop("Authorization", None)
    return client


async def create_supabase_client(
    settings: Settings, http: httpx.AsyncClient, *, token: str | None = None
) -> AsyncClient:
    if token is not None and not token.strip():
        raise ValueError("사용자 클라이언트에는 로그인 토큰이 필요합니다.")
    key = (
        settings.supabase_publishable_key
        if token is not None
        else settings.supabase_secret_key
    )
    client = await acreate_client(
        settings.supabase_url,
        key,
        options=AsyncClientOptions(
            httpx_client=http,
            headers={"Authorization": f"Bearer {token}"} if token is not None else {},
            persist_session=False,
            auto_refresh_token=False,
        ),
    )
    if token is None and key.startswith("sb_secret_"):
        client.options.headers.pop("Authorization", None)
    return client


@dataclass(frozen=True)
class SupabaseResources:
    settings: Settings = field(repr=False)
    http: httpx.AsyncClient = field(repr=False)
    server: AsyncClient = field(repr=False)

    async def user_client(self, token: str) -> AsyncClient:
        return await create_supabase_client(self.settings, self.http, token=token)


@asynccontextmanager
async def build_supabase(settings: Settings):
    async with httpx.AsyncClient(timeout=settings.supabase_timeout_sec) as http:
        yield SupabaseResources(
            settings, http, await create_supabase_client(settings, http)
        )


@dataclass(frozen=True)
class WorkerSupabaseResources:
    settings: Settings = field(repr=False)
    http: httpx.Client = field(repr=False)
    server: Client = field(repr=False)


@contextmanager
def build_worker_supabase(settings: Settings):
    """감지·업로드·분석 스레드가 사용하는 별도 동기 풀. API의 AsyncClient를 공유하지 않습니다."""
    with httpx.Client(timeout=settings.supabase_timeout_sec) as http:
        yield WorkerSupabaseResources(
            settings, http, create_sync_supabase_client(settings, http)
        )


async def create_auth_supabase_client(
    settings: Settings, http: httpx.AsyncClient
) -> AsyncClient:
    """로그인 상태가 서로 섞이지 않는 요청 전용 공개 키 Auth 클라이언트."""
    return await acreate_client(
        settings.supabase_url,
        settings.supabase_publishable_key,
        options=AsyncClientOptions(
            httpx_client=http, persist_session=False, auto_refresh_token=False,
        ),
    )
