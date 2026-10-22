"""서버 시작 때 서비스 구현체를 한 번 만들고, 종료 때 역순으로 정리합니다.

main.py가 공용 Supabase 자원과 VisionSettings를 전달해 app.state.motion을 구성합니다.
이 파일은 객체를 연결하는 곳이며, 서비스가 자동 검색되는 컨테이너는 아닙니다.
카메라는 브라우저에서 열고, 서버는 실행별 JPEG 프레임을 받습니다.
"""

from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from functools import partial

import httpx
from filelock import FileLock, Timeout
from supabase import AsyncClient

from backend.config import Settings
from backend.notifications.realtime import NotificationPublisher
from backend.common.supabase import SupabaseResources, build_worker_supabase
from backend.vision.config import VisionSettings
from backend.vision.repositories.motion_repository import MotionRepository
from backend.vision.repositories.async_motion_repository import AsyncMotionRepository
from backend.vision.services.async_photo_reader import AsyncPhotoReader
from backend.vision.services.gemini_service import GeminiAnalyzer
from backend.vision.services.motion_analysis_service import MotionAnalysisService
from backend.vision.services.motion_evidence_service import MotionEvidenceService
from backend.vision.services.motion_factory import create_motion
from backend.vision.services.motion_files import LocalFileStore
from backend.vision.services.motion_preview_service import MotionPreviewService
from backend.vision.services.motion_run_service import MotionRunService
from backend.vision.services.motion_runtime import LocalMotionRuntime
from backend.vision.services.motion_storage import SupabasePhotoStore
from backend.vision.services.motion_workers import AnalysisWorker, IngestionWorker


@dataclass
class MotionServices:
    # main.py에 전달할 도메인별 서비스 구현체입니다.
    runs: MotionRunService
    evidence: MotionEvidenceService
    analyses: MotionAnalysisService
    preview: MotionPreviewService
    client: AsyncClient
    http: httpx.AsyncClient
    settings: VisionSettings


@contextmanager
def build_motion_services(
    settings: Settings,
    vision: VisionSettings | None = None,
    *,
    supabase: SupabaseResources | None = None,
):
    vision = vision or VisionSettings()
    if not vision.enabled:
        yield None
        return
    vision.prepare()
    with ExitStack() as resources:
        root = vision.data_dir / "motion"
        root.mkdir(parents=True, exist_ok=True)
        # 한 프로세스가 실행별 입력 메모리·분석 작업을 소유합니다. 다중 worker를 막습니다.
        try:
            # lifespan의 진입·종료는 서로 다른 스레드에서 실행될 수 있습니다.
            resources.enter_context(
                FileLock(root / ".runtime.lock", timeout=0, thread_local=False)
            )
        except Timeout as exc:
            raise RuntimeError(
                "비전 서버는 같은 DATA_DIR에서 worker 1개로 실행하세요."
            ) from exc

        # HTTP 풀에는 인증 헤더를 저장하지 않습니다. 요청별 SDK가 자기 헤더를 보냅니다.
        # 공유 DB에서 다른 서버의 진행 중 작업을 시작 시 일괄 정리하지 않습니다.
        if supabase is None:
            raise ValueError("비전 API에는 공용 비동기 Supabase 연결이 필요합니다.")
        worker_supabase = resources.enter_context(build_worker_supabase(settings))
        http, client = supabase.http, supabase.server
        repository = MotionRepository(worker_supabase.server)
        repository.check_schema()
        files = LocalFileStore(root / "captures")
        storage = SupabasePhotoStore(
            settings.supabase_url, settings.supabase_secret_key
        )
        resources.callback(storage.close)
        ingestion = IngestionWorker(
            repository,
            files,
            storage,
            vision.gemini_model,
        )
        runtime = LocalMotionRuntime(
            partial(create_motion, settings=vision),
            ingestion.notify,
            repository.start_run,
            repository.finish_run,
            max_active_runs=vision.motion_max_active_runs,
        )

        # API 키가 없으면 감지와 사진 조회는 제공하고, 분석은 queued로 보관합니다.
        if vision.gemini_api_key:
            analyzer = GeminiAnalyzer(
                vision.gemini_api_key,
                storage,
                vision.gemini_timeout_sec,
                vision.gemini_max_image_bytes,
            )
            resources.callback(analyzer.close)
            publisher = NotificationPublisher(settings.redis_url)
            resources.callback(publisher.close)
            worker = AnalysisWorker(repository, analyzer, publisher)
            worker.start()
            resources.callback(worker.close)

        ingestion.start()
        resources.callback(ingestion.close)
        resources.callback(runtime.close)

        # FastAPI 의존성 함수가 여기서 만든 동일한 서비스 객체를 요청에 전달합니다.
        api_repository = AsyncMotionRepository(client)
        yield MotionServices(
            MotionRunService(api_repository, runtime),
            MotionEvidenceService(api_repository, AsyncPhotoReader(settings, http)),
            MotionAnalysisService(api_repository, vision),
            MotionPreviewService(api_repository, runtime),
            client,
            http,
            vision,
        )
        # 종료 순서: 감지 중지 → 남은 임시 묶음 폐기 → 처리 중 분석 실패 → HTTP·잠금 해제
