from backend.vision.config import VisionSettings
from uuid import uuid4

from backend.vision.models.analyses import DEFAULT_QUESTION_TEXT, QuestionInput
from backend.vision.errors import ApplicationError
from backend.vision.models.common import DataObject
from backend.vision.repositories.async_motion_repository import AsyncMotionRepository


class MotionAnalysisService:
    def __init__(self, repository: AsyncMotionRepository, settings: VisionSettings):
        self.repository = repository
        self.settings = settings

    async def get_questions(self, owner_id: str) -> DataObject:
        saved = await self.repository.get_questions(owner_id)
        if saved is not None:
            return saved
        return await self.repository.ensure_questions(owner_id, [
            {"id": str(uuid4()), "question": DEFAULT_QUESTION_TEXT}
        ])

    async def _assign_questions(self, owner_id: str, inputs: list[QuestionInput]) -> list[DataObject]:
        current = await self.get_questions(owner_id)
        owned_ids = {q["id"] for q in current["questions"]}
        if any(q.id is not None and str(q.id) not in owned_ids for q in inputs):
            raise ApplicationError("INVALID_QUESTION", "저장된 본인 질문의 ID가 아닙니다. 설정을 다시 열어 주세요.", 422)
        return [{"id": str(q.id or uuid4()), "question": q.question} for q in inputs]

    async def save_questions(self, owner_id: str, inputs: list[QuestionInput], notify_on_uncertain: bool = False) -> DataObject:
        return await self.repository.save_questions(owner_id, await self._assign_questions(owner_id, inputs), notify_on_uncertain)

    async def create(self, part_id: str, owner_id: str, inputs: list[QuestionInput]) -> DataObject:
        return await self.repository.create_analysis(
            part_id, owner_id, await self._assign_questions(owner_id, inputs), self.settings.gemini_model
        )

    async def get(self, analysis_id: str, owner_id: str | None) -> DataObject:
        return await self.repository.get_analysis(analysis_id, owner_id)

    async def list(self, part_id: str, owner_id: str | None, limit: int) -> list[DataObject]:
        return await self.repository.list_analyses(part_id, owner_id, limit)

    async def get_event(self, event_id: str, owner_id: str | None) -> DataObject:
        event = await self.repository.get_event(event_id, owner_id)
        response = {"event_id": event_id, "questions": event["questions"]}
        if event["capture_state"] != "closed":
            return {**response, "status": event["capture_state"]}
        final_index = event["final_part_index"]
        if final_index == 1:
            sources = await self.repository.event_part_analyses(event_id)
            if not sources or sources[0]["analysis_id"] is None:
                return {**response, "status": "waiting", "basis": "part"}
            source = sources[0]
            return {
                **source,
                **response,
                "basis": "part",
                "status": "waiting"
                if source["status"] == "queued"
                else source["status"],
            }
        synthesis = (
            await self.repository.get_event_synthesis(event_id) if final_index else None
        )
        if synthesis is None:
            return {
                **response,
                "status": "waiting",
                "basis": "synthesis" if final_index else None,
            }
        return {
            **synthesis,
            **response,
            "analysis_id": synthesis["id"],
            "basis": "synthesis",
        }
