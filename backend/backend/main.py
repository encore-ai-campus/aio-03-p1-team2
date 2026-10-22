"""실행: uv run uvicorn backend.main:app --reload --no-access-log"""

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.admin.router import router as admin_router
from backend.admin.vision_router import router as admin_vision_router
from backend.common.supabase import build_supabase
from backend.config import Settings
from backend.discord.router import lifespan as discord_lifespan, router as discord_router
from backend.feedback.router import router as feedback_router
from backend.login.router import router as login_router
from backend.notifications.router import router as notifications_router
from backend.notifications.realtime import subscriber_client
from backend.users.router import router as users_router
from postgrest.exceptions import APIError
from backend.vision.composition import build_motion_services
from backend.vision.config import VisionSettings
from backend.vision.errors import ApplicationError
from backend.vision.routers import (
    motion_analyses,
    motion_evidence,
    motion_preview,
    motion_runs,
)


def create_app(
    settings: Settings | None = None, vision_settings: VisionSettings | None = None
):
    settings = settings or Settings()
    vision_settings = vision_settings or VisionSettings()

    @asynccontextmanager
    async def lifespan(app):
        settings.prepare()
        app.state.settings = settings
        app.state.vision_settings = vision_settings
        app.state.notification_redis = subscriber_client(settings.redis_url)
        async with build_supabase(settings) as supabase:
            app.state.supabase = supabase
            context = build_motion_services(
                settings, vision_settings, supabase=app.state.supabase
            )
            app.state.motion = await asyncio.to_thread(context.__enter__)
            try:
                async with discord_lifespan(app):
                    yield
            finally:
                try:
                    await asyncio.to_thread(context.__exit__, None, None, None)
                finally:
                    if app.state.notification_redis is not None:
                        await app.state.notification_redis.aclose()

    app = FastAPI(
        title="NoteCam 백엔드",
        version="0.1.0",
        lifespan=lifespan,
        description="Supabase Auth·공용 연결과 기능별 서비스를 제공하는 NoteCam API.",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[x.strip() for x in settings.cors_origins],
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "Last-Event-ID",
        ],
        expose_headers=["X-Frame-Index", "X-Elapsed-Sec"],
    )

    @app.exception_handler(ApplicationError)
    async def motion_error(request, exc):
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": exc.message}},
        )

    @app.exception_handler(APIError)
    async def database_error(request, exc):
        return JSONResponse(status_code=503, content={"detail": "Supabase 데이터 처리에 실패했습니다. DB 설정을 확인하세요."})

    for router in (
        login_router,
        discord_router,
        users_router,
        notifications_router,
        feedback_router,
        admin_router,
        admin_vision_router,
        motion_runs.router,
        motion_evidence.router,
        motion_analyses.router,
        motion_preview.router,
    ):
        app.include_router(router)

    @app.get("/health", tags=["상태"])
    def health():
        return {
            "status": "ok",
            "database": "supabase",
            "auth_provider": settings.auth_provider,
            "version": "0.1.0",
        }

    return app


app = create_app()
