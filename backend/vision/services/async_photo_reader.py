"""비전 API의 사진 읽기. 공용 비동기 HTTP 풀로 크기를 제한해 스트리밍합니다."""

import asyncio
from urllib.parse import quote

import httpx

from backend.config import Settings
from backend.vision.errors import ApplicationError, Conflict
from backend.vision.models.common import DataObject
from backend.vision.services.motion_storage import SupabasePhotoStore


class AsyncPhotoReader:
    def __init__(self, settings: Settings, http: httpx.AsyncClient):
        self.http = http
        self.base_url = (
            settings.supabase_url.rstrip("/") + "/storage/v1/object/motion-evidence/"
        )
        self.headers = {"apikey": settings.supabase_secret_key}
        if not settings.supabase_secret_key.startswith("sb_secret_"):
            self.headers["Authorization"] = "Bearer " + settings.supabase_secret_key

    async def content(self, photo: DataObject) -> bytes:
        if photo["upload_status"] != "ready":
            raise Conflict("사진 저장이 아직 끝나지 않았습니다.")
        try:
            async with self.http.stream(
                "GET",
                self.base_url + quote(photo["storage_key"], safe="/"),
                headers=self.headers,
            ) as response:
                if not response.is_success:
                    raise ApplicationError(
                        "STORAGE_UNAVAILABLE", "사진 원본을 읽지 못했습니다.", 503
                    )
                data = bytearray()
                async for chunk in response.aiter_bytes(chunk_size=65536):
                    data.extend(chunk)
                    if len(data) > photo["byte_size"]:
                        raise Conflict("저장된 사진의 크기가 등록 정보와 다릅니다.")
        except httpx.RequestError as exc:
            raise ApplicationError(
                "STORAGE_UNAVAILABLE", "사진 저장소에 연결하지 못했습니다.", 503
            ) from exc
        await asyncio.to_thread(SupabasePhotoStore.verify, photo, data)
        return bytes(data)
