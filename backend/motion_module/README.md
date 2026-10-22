# NoteCam 비전 패키지

`motion-person` 0.2.0에서 객체 움직임 감지와 사건별 사진 묶음 생성에 필요한 파일을 가져온 Python 라이브러리입니다. 고정 카메라의 웹캠 또는 동영상을 입력으로 사용합니다.

YOLO 객체 탐지, MOG2 움직임 판정, 최대 6장의 원본 사진 선택·저장, 미리보기를 제공합니다. Gemini 호출, 서버 API 전송, DB 저장과 알림 처리는 연결 프로젝트에서 구현해야 합니다.

## 설치

Python 3.12 이상에서 팀 프로젝트 루트의 `pyproject.toml`이 있는 위치를 기준으로 실행합니다.

```bash
uv sync --locked
uv run python -c "from motion_person import MotionEngine, EventConfig, FramePreview; print('비전 패키지 import 완료')"
```

루트 프로젝트의 `motion-person[yolo]` 의존성은 `./motion_module`을 editable 경로로 참조합니다. 저장소를 받은 팀원도 같은 소스를 설치하며, `motion_module/motion_person/` 수정 사항은 재설치 없이 반영됩니다. 기본 의존성은 NumPy·OpenCV이며, `yolo` 선택 의존성은 Ultralytics·추적 라이브러리와 그 실행 의존성을 설치합니다.

## 모델과 저장 위치

YOLO 가중치는 패키지에 포함하지 않습니다. 프로젝트 루트에서 `sh scripts/build.sh`를 실행하면 의존성 설치 후 공식 `yolo11n.pt`를 `MOTION_MODEL_PATH`(기본 `data/motion_module/models/yolo11n.pt`)에 자동으로 준비합니다. API 키, 모델과 촬영 결과는 Git에 올리지 않습니다. `data/`는 팀 프로젝트의 `.gitignore`에서 제외됩니다.

아래 코드는 프로젝트 루트에서 실행하는 예입니다. 웹캠은 Python 프로그램 하나에서 열고, 기존 카메라 프로그램을 종료한 뒤 사용합니다.

```python
from motion_person import EventConfig, MotionEngine


def handle_bundle(bundle):
    print(bundle.event_id, bundle.part_index)
    print(bundle.image_paths)


engine = MotionEngine.webcam(
    camera=0,
    objects=("person",),
    capture=True,
    display=False,
    model_path="data/motion_module/models/yolo11n.pt",
    output_dir="data/motion_module/captures",
    events=EventConfig(max_images=6),
)
summary = engine.start(on_event=handle_bundle, duration_sec=30)
```

동영상은 `MotionEngine.video("input.mp4", model_path=..., output_dir=...)`로 처리합니다. 직접 지정한 상대 경로는 실행한 작업 폴더를 기준으로 합니다.

## 사용 계약

- 공개 import는 `from motion_person import MotionEngine, EventConfig, EventBundle, FramePreview, PreviewConfig` 형태를 사용합니다.
- `start()`는 입력 종료·시간 제한·`stop()`까지 실행하는 블로킹 함수입니다. 웹 서버에 연결할 때 실행 스레드와 종료 처리는 호스트에서 관리합니다.
- `on_event`는 사진과 `event.json` 저장이 완료된 후 호출됩니다. 감지 순간의 콜백이 아닙니다. 콜백에서는 짧게 작업 큐에 넣고, Gemini·HTTP 요청은 별도 작업에서 처리합니다.
- 긴 사건은 같은 `event_id`의 `part_index`가 증가합니다. 서버 연결 시 `run_id/event_id/part_index`를 함께 사용해 각 묶음을 구분합니다.
- `trigger_sec`, 사진의 `timestamp_sec`는 입력 기준 상대 시간입니다. 서버가 날짜를 요구하면 촬영 기준 시각과 시간대를 별도로 연결합니다.
- `image_paths`는 원본 사진의 절대 경로입니다. 사진에는 화면 박스·글자·미리보기 반전이 적용되지 않습니다.
- 라이브러리 기본값은 화면과 상세 진단 로그가 꺼져 있습니다. 웹캠의 사진 저장에는 `capture=True`가 필요합니다.
- 미리보기에는 같은 실행의 `FramePreview`를 사용합니다. 시청자마다 카메라나 모델을 다시 만들지 않습니다.

서버 연결 요청 형식은 [팀 API 계약](../docs/API_CONTRACT.md)을 참고합니다. 현재 이 폴더에는 서버 전송 코드가 포함되어 있지 않습니다.

## 포함 범위와 원본

```text
motion_person/
├── __init__.py, composition.py, py.typed
├── domain/          # 설정·데이터 계약·판정·사진 선택
├── application/     # 실행·프레임 분석·사건 수집
├── adapters/        # 탐지·입력·저장·진단·미리보기
└── presentation/    # __init__.py와 overlay.py만 포함
```

원본은 `AIO_TEAM_PROJET_1/idea/motion_person_poc`이며, 기준 커밋은 `cbac78bf5488d5c89b7ccb8d36d3d65c69b5236a`입니다. 2026-10-13에 Python 파일 27개와 `py.typed`를 코드 변경 없이 복사했습니다.

기존 CLI, `presentation/legacy/`, 호환 위임 파일, 웹 예제, 개발 보고서·원본 테스트·영상·모델은 제외했습니다. `motion-person` CLI 명령과 `motion_person.engine` 같은 이전 import 경로는 제공하지 않습니다. 설치 설정과 이 README는 추출 범위에 맞춰 작성했습니다.
