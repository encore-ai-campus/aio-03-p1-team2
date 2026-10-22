from __future__ import annotations
import asyncio
from typing import TYPE_CHECKING
from backend.vision.repositories.async_motion_repository import AsyncMotionRepository
from backend.vision.services.motion_runtime import LocalMotionRuntime

if TYPE_CHECKING:
    from motion_person import FramePreview


class MotionPreviewService:
    def __init__(self, repository: AsyncMotionRepository, runtime: LocalMotionRuntime):
        self.repository = repository
        self.runtime = runtime

    async def get(self, run_id: str, owner_id: str) -> FramePreview:
        await self.repository.get_run(run_id, owner_id)
        return await asyncio.to_thread(self.runtime.preview, run_id)
