"""원본 모듈의 JPEG·event.json을 업로드 대기 원본으로 사용합니다."""

import hashlib
import shutil
from pathlib import Path

from PIL import Image

from backend.vision.errors import ApplicationError, NotFound
from backend.vision.models.common import DataObject
from backend.vision.models.manifests import BundleManifest


class LocalFileStore:
    def __init__(self, captures: Path):
        self.captures = captures.resolve()

    def photo_path(self, storage_key: str) -> Path:
        path = (self.captures / storage_key).resolve()
        if (
            not path.is_relative_to(self.captures)
            or path.suffix != ".jpg"
            or not path.is_file()
        ):
            raise NotFound("사진 파일")
        return path

    def read_bundle(self, manifest: Path) -> BundleManifest:
        path = manifest.resolve()
        if (
            not path.is_relative_to(self.captures)
            or path.name != "event.json"
            or path.stat().st_size > 512 * 1024
        ):
            raise ApplicationError(
                "INVALID_CAPTURE", "촬영 정보 파일이 유효하지 않습니다."
            )
        bundle = BundleManifest.model_validate_json(path.read_bytes())
        expected = (
            self.captures
            / bundle.run_id
            / "events"
            / bundle.event_id
            / f"part_{bundle.part_index:04d}"
            / "event.json"
        )
        if path != expected:
            raise ApplicationError(
                "INVALID_CAPTURE", "촬영 정보와 저장 경로가 일치하지 않습니다."
            )
        return bundle

    def prepare_bundle(self, manifest: Path) -> tuple[BundleManifest, list[DataObject]]:
        bundle = self.read_bundle(manifest)
        path = manifest.resolve()
        photos = []
        for image in bundle.images:
            photo = Path(image.path).resolve()
            if (
                photo.parent != path.parent
                or photo.suffix != ".jpg"
                or not 0 < photo.stat().st_size <= 12 * 1024 * 1024
            ):
                raise ApplicationError(
                    "INVALID_CAPTURE", "사진 위치 또는 크기가 유효하지 않습니다."
                )
            photos.append(
                {
                    "storage_key": photo.relative_to(self.captures).as_posix(),
                    "timestamp_sec": image.timestamp_sec,
                    "byte_size": photo.stat().st_size,
                    "sha256": hashlib.sha256(photo.read_bytes()).hexdigest(),
                }
            )
            with Image.open(photo) as image_file:
                if (
                    image_file.format != "JPEG"
                    or image_file.width * image_file.height > 20_000_000
                ):
                    raise ApplicationError(
                        "INVALID_CAPTURE", "허용되지 않는 JPEG 사진입니다."
                    )
                image_file.verify()
        return bundle, photos

    def manifests(self):
        # staging 폴더는 제외하고, 원본 모듈이 게시를 마친 event.json만 재접수합니다.
        return self.captures.glob("*/events/*/part_[0-9]*/event.json")

    def remove_bundle(self, bundle: BundleManifest) -> None:
        directory = (
            self.captures / bundle.run_id / "events" / bundle.event_id
            / f"part_{bundle.part_index:04d}"
        )
        # 상위 경로의 심볼릭 링크를 따라 다른 묶음이나 외부 파일을 지우지 않습니다.
        if directory.resolve() != directory:
            raise ApplicationError("INVALID_CAPTURE", "촬영 저장 경로가 유효하지 않습니다.")
        shutil.rmtree(directory)
