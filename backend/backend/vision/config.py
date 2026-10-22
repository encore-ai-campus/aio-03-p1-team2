"""비전 실행·분석·미리보기 설정. 공용 서버 설정과 별도로 검증합니다."""

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path


def vision_enabled() -> bool:
    value = os.getenv("VISION_ENABLED", "true").lower()
    if value not in {"true", "false", "1", "0"}:
        raise ValueError("VISION_ENABLED는 true 또는 false여야 합니다.")
    return value in {"true", "1"}


@dataclass
class VisionSettings:
    enabled: bool = field(default_factory=vision_enabled)
    data_dir: Path = field(
        default_factory=lambda: Path(
            os.getenv("VISION_DATA_DIR") or os.getenv("DATA_DIR") or "data"
        )
    )
    jwt_secret: str = field(
        default_factory=lambda: (
            os.getenv("VISION_PREVIEW_SECRET") or os.getenv("JWT_SECRET", "")
        ),
        repr=False,
    )
    ticket_seconds: int = 60
    motion_model_path: Path = field(
        default_factory=lambda: Path(
            os.getenv("MOTION_MODEL_PATH", "data/motion_module/models/yolo11n.pt")
        )
    )
    motion_device: str = field(
        default_factory=lambda: os.getenv("MOTION_DEVICE", "cpu")
    )
    motion_max_active_runs: int = field(
        default_factory=lambda: int(os.getenv("MOTION_MAX_ACTIVE_RUNS", "4"))
    )
    gemini_api_key: str = field(
        default_factory=lambda: os.getenv("GEMINI_API_KEY", ""), repr=False
    )
    gemini_model: str = field(
        default_factory=lambda: os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")
    )
    gemini_timeout_sec: float = 60
    gemini_max_image_bytes: int = 12 * 1024 * 1024

    def prepare(self):
        if not self.enabled:
            return
        if self.motion_max_active_runs < 1:
            raise ValueError("MOTION_MAX_ACTIVE_RUNS는 1 이상이어야 합니다.")
        if (
            self.ticket_seconds < 1
            or self.gemini_timeout_sec <= 0
            or self.gemini_max_image_bytes < 1
        ):
            raise ValueError("비전 시간 제한과 이미지 용량 제한은 양수여야 합니다.")
        if self.jwt_secret and len(self.jwt_secret) < 32:
            raise ValueError("VISION_PREVIEW_SECRET은 최소 32글자로 설정하세요.")
        self.data_dir.mkdir(parents=True, exist_ok=True)
        path = self.data_dir / "jwt_secret"
        if not self.jwt_secret:
            try:
                with path.open("x", encoding="utf-8") as output:
                    output.write(secrets.token_urlsafe(48))
                path.chmod(0o600)
            except FileExistsError:
                pass
            self.jwt_secret = path.read_text().strip()
        if len(self.jwt_secret) < 32:
            raise ValueError("비전 미리보기 서명 키는 최소 32글자여야 합니다.")
