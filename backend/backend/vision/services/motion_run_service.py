import asyncio
import io
import uuid
import warnings
from PIL import Image, UnidentifiedImageError
from backend.vision.errors import ApplicationError
from backend.vision.models.common import DataObject
from backend.vision.models.runs import CameraCreate, RunCreate
from backend.vision.repositories.async_motion_repository import AsyncMotionRepository
from backend.vision.services.browser_motion import (
    INPUT_FPS,
    MAX_FRAME_BYTES,
    MAX_FRAME_PIXELS,
)
from backend.vision.services.motion_runtime import LocalMotionRuntime


def decode_frame(data: bytes):
    if len(data) > MAX_FRAME_BYTES:
        raise ApplicationError("FRAME_TOO_LARGE", "JPEG는 5 MiB 이하여야 합니다.", 413)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                if image.format != "JPEG":
                    raise ValueError("JPEG required")
                if image.width * image.height > MAX_FRAME_PIXELS:
                    raise ValueError("pixel limit")
                image.load()
                import numpy as np

                frame = np.asarray(image.convert("RGB"))[:, :, ::-1].copy()
    except (
        ValueError,
        OSError,
        UnidentifiedImageError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ) as exc:
        raise ApplicationError(
            "INVALID_FRAME", "유효한 JPEG(최대 1,600만 픽셀)를 보내세요.", 422
        ) from exc
    return frame


class MotionRunService:
    def __init__(
        self,
        repository: AsyncMotionRepository,
        runtime: LocalMotionRuntime,
        *,
        lock=None,
    ):
        self.repository = repository
        self.runtime = runtime
        self._lock = lock if lock is not None else asyncio.Lock()

    async def list_cameras(self, owner_id: str) -> list[DataObject]:
        return await self.repository.list_cameras(owner_id)

    async def create_camera(self, request: CameraCreate, owner_id: str) -> DataObject:
        return await self.repository.create_camera(str(uuid.uuid4()), owner_id, request.name)

    async def create(self, request: RunCreate, owner_id: str) -> DataObject:
        async with self._lock:
            await self.repository.camera(str(request.camera_id), owner_id)
            await asyncio.to_thread(self.runtime.check_capacity, str(request.camera_id))
            config = request.model_dump(mode="json", exclude={"camera_id"})
            config["input"] = {"kind": "browser", "fps": INPUT_FPS}
            run_id = uuid.uuid4().hex
            await self.repository.create_run(run_id, str(request.camera_id), config)
            try:
                await asyncio.to_thread(self.runtime.start, run_id, request)
            except Exception as exc:
                await self.repository.finish_run(
                    run_id, "failed", str(exc)[:1000] or "감지를 시작하지 못했습니다."
                )
                raise
            return await self.get(run_id, owner_id)

    async def get(self, run_id: str, owner_id: str) -> DataObject:
        run = await self.repository.get_run(run_id, owner_id)
        run.update(await asyncio.to_thread(self.runtime.state, run_id))
        return run

    async def list(self, owner_id: str, limit: int) -> list[DataObject]:
        return await self.repository.list_runs(owner_id, limit)

    async def stop(self, run_id: str, owner_id: str) -> DataObject:
        async with self._lock:
            await self.repository.get_run(run_id, owner_id)
            if await asyncio.to_thread(self.runtime.is_active, run_id):
                await self.repository.stop_run(run_id)
                await asyncio.to_thread(self.runtime.stop, run_id)
            run = await self.get(run_id, owner_id)
            return {"id": run_id, "status": run["status"]}

    async def submit_frame(
        self,
        run_id: str,
        owner_id: str,
        data: bytes,
        sequence_no: int,
        timestamp_sec: float,
    ) -> DataObject:
        await self.repository.get_run(run_id, owner_id)
        frame = await asyncio.to_thread(decode_frame, data)
        return await asyncio.to_thread(
            self.runtime.submit, run_id, frame, sequence_no, timestamp_sec
        )
