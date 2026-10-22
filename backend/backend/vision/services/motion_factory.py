"""API 설정을 motion_person의 공개 API에 연결합니다."""

from __future__ import annotations

from dataclasses import replace
from typing import TYPE_CHECKING

from backend.vision.config import VisionSettings
from backend.vision.errors import ApplicationError
from backend.vision.models.runs import RunCreate
from backend.vision.services.browser_motion import BrowserMotionEngine

if TYPE_CHECKING:
    from motion_person import FramePreview


def create_motion(
    request: RunCreate, settings: VisionSettings
) -> tuple[BrowserMotionEngine, FramePreview]:
    # 서버 시작·라우터 import 때는 카메라 모듈과 YOLO를 불러오지 않습니다.
    from motion_person import (
        Config,
        EventConfig,
        FramePreview,
        PreviewConfig,
    )

    if not settings.motion_model_path.is_file():
        raise ApplicationError(
            "MODEL_NOT_FOUND", "MOTION_MODEL_PATH의 YOLO 모델 파일을 확인하세요.", 503
        )
    config = replace(
        Config(),
        device=settings.motion_device,
        tracking=True,
        display=False,
        person_confidence=0.4,
        min_person_motion_pixels_ref=1000,
        capture_cooldown_sec=0.5,
        analysis_roi=request.analysis_roi,
        target_classes=tuple(request.objects),
        model_path=settings.motion_model_path,
    )
    engine = BrowserMotionEngine(
        config,
        EventConfig(**request.capture.model_dump()),
        settings.data_dir / "motion/captures",
        str(request.camera_id),
    )
    preview = FramePreview(
        PreviewConfig(
            width=640,
            fps=8,
            jpeg_quality=75,
            mirror=request.preview_mirror,
            overlay=request.preview_overlay,
        )
    )
    return engine, preview
