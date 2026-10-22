"""private Supabase Storage. 서버 전용 키는 브라우저·Gemini에 전달하지 않습니다."""

import hashlib
import json
from urllib.parse import quote

import httpx

from backend.vision.errors import ApplicationError, Conflict
from backend.vision.models.common import DataObject


class SupabasePhotoStore:
    bucket = "motion-evidence"

    def __init__(self, url: str, service_key: str):
        headers = {"apikey": service_key}
        # 새 secret 키는 JWT가 아닙니다. Bearer에는 기존 JWT 키만 사용합니다.
        if not service_key.startswith("sb_secret_"):
            headers["Authorization"] = f"Bearer {service_key}"
        self.client = httpx.Client(
            base_url=url.rstrip("/") + "/storage/v1/",
            headers=headers,
            timeout=httpx.Timeout(5),
        )

    def _path(self, photo: DataObject) -> str:
        return f"object/{self.bucket}/{quote(photo['storage_key'], safe='/')}"

    @staticmethod
    def verify(photo: DataObject, data: bytes) -> None:
        if (
            len(data) != photo["byte_size"]
            or hashlib.sha256(data).hexdigest() != photo["sha256"]
        ):
            raise Conflict(
                "저장된 사진의 크기 또는 내용이 최초 사진과 다릅니다. 덮어쓰지 않습니다."
            )

    def _download(self, photo: DataObject, *, missing_ok: bool = False) -> bytes | None:
        try:
            # 손상된 큰 원본도 메모리에 무제한으로 읽지 않습니다.
            with self.client.stream("GET", self._path(photo)) as response:
                if response.status_code in (400, 404):
                    try:
                        body = response.read()
                        code = json.loads(body).get("statusCode")
                    except (ValueError, AttributeError):
                        code = None
                    if missing_ok and str(code) == "404":
                        return None
                if not response.is_success:
                    raise ApplicationError(
                        "STORAGE_UNAVAILABLE", "사진 원본을 읽지 못했습니다.", 503
                    )
                data = bytearray()
                for chunk in response.iter_bytes(chunk_size=65536):
                    data.extend(chunk)
                    if len(data) > photo["byte_size"]:
                        raise Conflict("저장된 사진의 크기가 등록 정보와 다릅니다.")
        except httpx.RequestError as exc:
            raise ApplicationError(
                "STORAGE_UNAVAILABLE", "사진 저장소에 연결하지 못했습니다.", 503
            ) from exc
        self.verify(photo, data)
        return bytes(data)

    def upload(self, photo: DataObject, data: bytes) -> None:
        self.verify(photo, data)
        if self._download(photo, missing_ok=True) is not None:
            return  # 응답 유실 후 재시도: 이미 같은 원본이면 추가 업로드하지 않습니다.
        try:
            response = self.client.post(
                self._path(photo),
                content=data,
                headers={"Content-Type": "image/jpeg", "x-upsert": "false"},
            )
            if not response.is_success:
                # 저장 완료 후 응답만 유실하거나 중복 경로가 생긴 경우도 원본을 대조합니다.
                self._download(photo)
                return
        except httpx.RequestError:
            # 업로드 성공 여부가 불명확할 때 덮어쓰지 않고 저장소에서 확인합니다.
            self._download(photo)
            return
        self._download(photo)  # 확인이 끝나야 호출자가 DB를 ready로 바꿀 수 있습니다.

    def content(self, photo: DataObject) -> bytes:
        if photo["upload_status"] != "ready":
            raise Conflict("사진 저장이 아직 끝나지 않았습니다.")
        return self._download(photo)

    def read_photos(self, photos: list[DataObject], max_bytes: int) -> list[bytes]:
        if not 1 <= len(photos) <= 6 or sum(p["byte_size"] for p in photos) > max_bytes:
            raise ApplicationError(
                "INVALID_ANALYSIS_INPUT",
                "분석 사진은 1~6장이고 합계 크기 제한 이하여야 합니다.",
            )
        return [self.content(photo) for photo in photos]

    def close(self) -> None:
        self.client.close()
