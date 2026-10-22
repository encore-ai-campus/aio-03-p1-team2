"""백엔드에서 Supabase Auth를 호출하는 이메일 인증 API."""

from fastapi import APIRouter, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

from backend.common.dependencies import User, get_supabase
from backend.common.supabase import create_auth_supabase_client
from backend.login.schemas import Login, Register, RegisterResponse, TokenResponse
from backend.login.services import auth_service


class AuthRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def handle(request: Request):
            try:
                return await handler(request)
            except RequestValidationError as exc:
                # 검증 오류의 input/ctx에 비밀번호가 노출되지 않게 합니다.
                return JSONResponse(status_code=422, content={"detail": [
                    {"loc": list(error["loc"]), "msg": error["msg"], "type": error["type"]}
                    for error in exc.errors()
                ]})

        return handle


router = APIRouter(prefix="/api/auth", tags=["인증"], route_class=AuthRoute)


@router.post("/register", response_model=RegisterResponse, status_code=201)
async def register(payload: Register, request: Request, response: Response):
    resources = get_supabase(request)
    client = await create_auth_supabase_client(resources.settings, resources.http)
    response.headers["Cache-Control"] = "no-store"
    return await auth_service.register(client, payload)


@router.post("/login", response_model=TokenResponse)
async def login(payload: Login, request: Request, response: Response):
    resources = get_supabase(request)
    client = await create_auth_supabase_client(resources.settings, resources.http)
    response.headers["Cache-Control"] = "no-store"
    return await auth_service.login(client, payload)


@router.get("/me")
async def me(user: User):
    return {"id": user.id, "role": user.role}
