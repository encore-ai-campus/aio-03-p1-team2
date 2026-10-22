"""공용 Supabase·CORS 설정. 모든 실행 환경은 원격 Supabase만 사용합니다."""

import os
from dataclasses import dataclass, field
from ipaddress import ip_address
from pathlib import Path
from urllib.parse import urlparse

from dotenv import dotenv_values

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def validate_profile(mode: str) -> None:
    if mode in {"local", "dev-local"}:
        raise ValueError("로컬 Supabase 프로필은 제거되었습니다. 원격 설정을 사용하세요.")


def load_environment(root: Path = PROJECT_ROOT) -> None:
    # 우선순위: 실행 환경 변수 > 선택한 프로필 파일 > 공통 .env.
    # 실행 위치가 달라도 저장소 루트의 같은 환경 파일을 사용합니다.
    values = dict(dotenv_values(root / ".env"))
    mode = os.getenv("APP_ENV", values.get("APP_ENV") or "production")
    validate_profile(mode)
    if mode == "dev":
        path = root / ".env.dev"
        if not path.is_file():
            raise ValueError(
                f"APP_ENV={mode}에는 {path.name}가 필요합니다. 해당 환경 설정을 먼저 생성하세요."
            )
        values.update(dotenv_values(path))
    values["APP_ENV"] = mode
    for key, value in values.items():
        if value is not None:
            os.environ.setdefault(key, value)


load_environment()


@dataclass
class Settings:
    app_env: str = field(default_factory=lambda: os.getenv("APP_ENV", "production"))
    cors_origins: list[str] = field(
        default_factory=lambda: os.getenv(
            "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
        ).split(",")
    )
    auth_provider: str = field(
        default_factory=lambda: os.getenv("AUTH_PROVIDER", "supabase")
    )
    supabase_url: str = field(default_factory=lambda: os.getenv("SUPABASE_URL", ""))
    supabase_publishable_key: str = field(
        default_factory=lambda: os.getenv("SUPABASE_PUBLISHABLE_KEY", ""), repr=False
    )
    supabase_secret_key: str = field(
        default_factory=lambda: os.getenv("SUPABASE_SECRET_KEY", ""), repr=False
    )
    # 기존 환경 파일의 키 이름도 읽습니다. Supabase 클라이언트는 위 이름을 사용합니다.
    supabase_anon_key: str = field(
        default_factory=lambda: os.getenv("SUPABASE_ANON_KEY", ""), repr=False
    )
    supabase_service_role_key: str = field(
        default_factory=lambda: os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""), repr=False
    )
    supabase_timeout_sec: float = 5
    redis_url: str = field(default_factory=lambda: os.getenv("REDIS_URL", ""), repr=False)

    def __post_init__(self):
        self.supabase_publishable_key = (
            self.supabase_publishable_key or self.supabase_anon_key
        )
        self.supabase_secret_key = (
            self.supabase_secret_key or self.supabase_service_role_key
        )
        self.supabase_anon_key = self.supabase_publishable_key
        self.supabase_service_role_key = self.supabase_secret_key

    def prepare(self):
        validate_profile(self.app_env)
        url = urlparse(self.supabase_url)
        hostname = (url.hostname or "").rstrip(".")
        local = hostname == "localhost" or hostname.endswith((".localhost", ".local"))
        try:
            local = local or not ip_address(hostname).is_global
        except ValueError:
            pass  # 원격 프로젝트 도메인이나 사용자 지정 도메인을 허용합니다.
        if local:
            raise ValueError("SUPABASE_URL에는 원격 Supabase의 HTTPS 주소만 허용합니다.")
        if self.supabase_publishable_key.startswith("sb_secret_"):
            raise ValueError(
                "SUPABASE_PUBLISHABLE_KEY에는 secret 키를 사용할 수 없습니다."
            )
        if self.supabase_secret_key.startswith("sb_publishable_"):
            raise ValueError(
                "SUPABASE_SECRET_KEY에는 서버 전용 secret 키를 설정하세요."
            )
        required = {
            "SUPABASE_URL": self.supabase_url,
            "SUPABASE_PUBLISHABLE_KEY": self.supabase_publishable_key,
            "SUPABASE_SECRET_KEY": self.supabase_secret_key,
        }
        missing = [name for name, value in required.items() if not value.strip()]
        if missing:
            raise ValueError(
                f"Supabase 필수 설정이 비어 있습니다: {', '.join(missing)}"
            )
        if self.auth_provider != "supabase":
            raise ValueError("공용 서버는 AUTH_PROVIDER=supabase만 지원합니다.")
        if (
            not url.hostname
            or url.scheme != "https"
            or url.username
            or url.password
            or url.query
            or url.fragment
        ):
            raise ValueError("Supabase URL은 원격 HTTPS 주소여야 합니다.")
        if not 0 < self.supabase_timeout_sec < float("inf"):
            raise ValueError("Supabase 연결 제한 시간은 양수여야 합니다.")
        self.cors_origins = list(
            dict.fromkeys(
                origin.strip() for origin in self.cors_origins if origin.strip()
            )
        )
        if not self.cors_origins:
            raise ValueError("CORS_ORIGINS에 허용할 프런트 주소를 설정하세요.")
        for origin in self.cors_origins:
            value = urlparse(origin)
            if origin != "*" and (
                value.scheme not in {"http", "https"}
                or not value.hostname
                or value.username
                or value.password
                or value.path not in {"", "/"}
                or value.query
                or value.fragment
            ):
                raise ValueError("CORS_ORIGINS에는 HTTP/HTTPS origin만 설정하세요.")
