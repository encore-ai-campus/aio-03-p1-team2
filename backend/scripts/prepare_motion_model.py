"""빌드 때 공식 YOLO11n 가중치를 준비합니다. 실행 중에는 다운로드하지 않습니다."""

import hashlib
import os
from pathlib import Path
from urllib.request import urlopen


MODEL_URL = "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n.pt"
MODEL_SHA256 = "0ebbc80d4a7680d14987a577cd21342b65ecfd94632bd9a8da63ae6417644ee1"


def prepare_model(path: Path) -> None:
    if path.is_file():
        data = path.read_bytes()
    else:
        with urlopen(MODEL_URL, timeout=30) as response:
            data = response.read(10 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != MODEL_SHA256:
        raise ValueError("YOLO11n 모델의 SHA-256이 일치하지 않습니다.")
    if not path.is_file():
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".pt.tmp")
        try:
            temporary.write_bytes(data)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    print(f"YOLO11n ready: {path}")


def main() -> None:
    from backend.config import load_environment

    load_environment()
    prepare_model(Path(os.getenv("MOTION_MODEL_PATH", "data/motion_module/models/yolo11n.pt")))


if __name__ == "__main__":
    main()
