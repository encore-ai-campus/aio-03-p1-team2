"""Supabase 로그인 요청과 토큰 응답."""

from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, SecretStr


class Login(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: EmailStr
    password: SecretStr = Field(min_length=1, max_length=128)


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    expires_in: int
    token_type: str = "bearer"


class Register(Login):
    password: SecretStr = Field(min_length=10, max_length=128)


class RegisterResponse(BaseModel):
    user_id: UUID
    email_confirmation_required: bool
