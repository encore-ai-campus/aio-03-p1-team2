from backend.vision.models.common import DataObject
from backend.vision.repositories.async_motion_repository import AsyncMotionRepository
from backend.vision.services.async_photo_reader import AsyncPhotoReader


class MotionEvidenceService:
    def __init__(self, repository: AsyncMotionRepository, files: AsyncPhotoReader):
        self.repository = repository
        self.files = files

    async def list_events(
        self, owner_id: str | None, run_id: str | None, limit: int, finished_only: bool = False,
        *, camera_id: str | None = None,
    ) -> list[DataObject]:
        events = await self.repository.list_events(owner_id, run_id, limit, finished_only, camera_id=camera_id)
        for event in events:
            synthesis = event.pop("motion_event_analyses", None)
            parts = event.pop("motion_parts", [])
            source = synthesis
            if event.get("final_part_index") == 1:
                sources = parts[0].get("motion_analyses", []) if parts else []
                source = sources[0] if sources else None
            state = event["capture_state"]
            status = source["status"] if source else "waiting"
            event["analysis_status"] = (
                state if state != "closed" else "waiting" if status == "queued" else status
            )
            event["result"] = source.get("result") if state == "closed" and status == "succeeded" else None
        return events

    async def get_event(self, event_id: str, owner_id: str | None) -> DataObject:
        return await self.repository.get_event(event_id, owner_id)

    async def list_parts(
        self, event_id: str, owner_id: str | None, after: int, limit: int
    ) -> list[DataObject]:
        return await self.repository.list_parts(event_id, owner_id, after, limit)

    async def get_part(self, part_id: str, owner_id: str | None) -> DataObject:
        part = await self.repository.get_part(part_id, owner_id)
        part["photos"] = [
            {**photo, "content_url": f"/api/motion/photos/{photo['id']}/content"}
            for photo in await self.repository.list_photos(part_id)
        ]
        return part

    async def content(self, photo_id: str, owner_id: str | None) -> bytes:
        photo = await self.repository.get_photo(photo_id, owner_id)
        return await self.files.content(photo)
