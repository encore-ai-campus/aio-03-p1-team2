"""감지 스레드와 분리된 사진 등록 담당 및 단일 분석 담당."""

import logging
import queue
import threading
import time
from pathlib import Path
from backend.notifications.realtime import NotificationPublisher

from backend.vision.errors import ApplicationError
from backend.vision.models.common import DataObject
from backend.vision.repositories.motion_repository import MotionRepository
from backend.vision.services.gemini_service import GeminiAnalyzer
from backend.vision.services.motion_files import LocalFileStore
from backend.vision.services.motion_storage import SupabasePhotoStore

logger = logging.getLogger(__name__)


class IngestionWorker:
    def __init__(
        self,
        repository: MotionRepository,
        files: LocalFileStore,
        storage: SupabasePhotoStore,
        model_name: str,
    ):
        self.repository = repository
        self.files = files
        self.storage = storage
        self.model_name = model_name
        self._queue: queue.Queue[tuple[str, Path]] = queue.Queue(maxsize=16)
        self._stop = threading.Event()
        self._rescan = threading.Event()
        self._rescan.set()  # 재시작 전에 파일만 저장된 묶음과 pending 원본을 복구합니다.
        self._thread = threading.Thread(
            target=self._run, name="motion-ingestion", daemon=True
        )

    def start(self) -> None:
        self._thread.start()

    def notify(self, run_id: str, manifest: Path) -> None:
        try:
            self._queue.put_nowait((run_id, manifest))
        except queue.Full:
            # event.json이 이미 디스크에 있으므로 감지를 막지 않고 다음 스캔에 접수합니다.
            self._rescan.set()

    def process_bundle(self, run_id: str, manifest: Path) -> None:
        # 재스캔에서 먼저 처리한 묶음은 큐에 같은 경로가 남아 있을 수 있습니다.
        if self._stop.is_set() or not manifest.exists():
            return
        bundle, local_photos = self.files.prepare_bundle(manifest)
        if bundle.run_id != run_id:
            raise ValueError("묶음의 실행 ID가 일치하지 않습니다.")
        part_id = self.repository.register_bundle(bundle, local_photos)
        photos = self.repository.list_photos(part_id)
        if len(photos) != len(local_photos):
            raise ValueError("등록된 사진 수가 원본과 다릅니다.")
        for photo, local in zip(photos, local_photos, strict=True):
            if self._stop.is_set():
                return
            if (
                photo["byte_size"] != local["byte_size"]
                or photo["sha256"] != local["sha256"]
            ):
                raise ValueError("기존 묶음의 원본 내용이 변경됐습니다.")
            if photo["upload_status"] == "ready":
                continue
            data = self.files.photo_path(local["storage_key"]).read_bytes()
            self.storage.upload(photo, data)
            self.repository.ready_photo(photo["id"])
        if self._stop.is_set():
            return
        self.repository.queue_auto_analysis(
            part_id, self.model_name
        )
        self.files.remove_bundle(bundle)

    def _process(self, run_id: str, manifest: Path) -> None:
        try:
            self.process_bundle(run_id, manifest)
        except Exception:
            # 네트워크 장애는 촬영을 중단하지 않습니다. 로컬 원본을 보존하고 같은 ID로 확인합니다.
            logger.exception("Capture upload pending: %s", run_id)
            self._rescan.set()

    def _run(self) -> None:
        retry_at = 0.0
        while not self._stop.is_set():
            if self._rescan.is_set() and time.monotonic() >= retry_at:
                self._rescan.clear()
                for manifest in self.files.manifests():
                    if self._stop.is_set():
                        return
                    self._process(manifest.parents[3].name, manifest)
                retry_at = time.monotonic() + 30
            try:
                run_id, manifest = self._queue.get(timeout=0.25)
            except queue.Empty:
                continue
            try:
                self._process(run_id, manifest)
            finally:
                self._queue.task_done()

    def close(self) -> None:
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(timeout=20)
        if self._thread.is_alive():
            raise RuntimeError("사진 등록 작업이 아직 종료되지 않았습니다.")
        # 큐를 비울 때까지 업로드하지 않습니다. 이 서버 디스크에 남은 묶음만 중단합니다.
        for manifest in self.files.manifests():
            bundle = self.files.read_bundle(manifest)
            self.repository.interrupt_pending_bundle(bundle.event_id, bundle.part_index)
            self.files.remove_bundle(bundle)


class AnalysisWorker:
    def __init__(
        self, repository: MotionRepository, analyzer: GeminiAnalyzer,
        publisher: NotificationPublisher | None = None,
    ):
        self.repository = repository
        self.analyzer = analyzer
        self.publisher = publisher
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._active: tuple[str, bool, float] | None = None
        self._thread = threading.Thread(
            target=self._run, name="motion-analysis", daemon=True
        )

    def start(self) -> None:
        self._thread.start()

    def process_one(self) -> bool:
        # 선점과 종료를 직렬화해 종료 직후 새 running 작업이 남지 않게 합니다.
        with self._lock:
            if self._stop.is_set():
                return False
            event_job = self.repository.claim_event_analysis()
            job = event_job if event_job is not None else self.repository.claim_analysis()
            if job is None:
                return False
            self._active = (job["id"], event_job is not None, time.monotonic())
        if event_job is not None:
            self._process_event(job)
            return True
        result = None
        error_message = None
        try:
            with self._lock:
                if self._stop.is_set():
                    return True
                part = self.repository.get_part(job["part_id"])
                event = self.repository.get_event(part["event_id"])
                run = self.repository.get_run(event["run_id"])
                context = {
                    name: run["config"].get(name) for name in ("objects", "analysis_roi")
                }
                photos = self.repository.list_photos(part["id"])
            result = self.analyzer.analyze(job, part, photos, context).model_dump(
                mode="json"
            )
        except Exception as exc:
            # 결과가 불명확한 AI 호출은 자동 재시도하지 않습니다.
            error_message = (
                exc.message
                if isinstance(exc, ApplicationError)
                else "분석을 완료하지 못했습니다."
            )
            logger.exception("Motion analysis failed: %s", job["id"])
        with self._lock:
            if not self._stop.is_set():
                self._finish(result, error_message)
        return True

    def _process_event(self, job: DataObject) -> None:
        if self._stop.is_set():
            return
        result = None
        error_message = None
        try:
            if any(s["status"] != "succeeded" for s in job["sources"]):
                raise ApplicationError(
                    "INCOMPLETE_EVENT_ANALYSIS",
                    "일부 묶음의 분석이 실패해 사건 전체 분석을 완료하지 못했습니다.",
                )
            result = self.analyzer.synthesize(job).model_dump(mode="json")
        except Exception as exc:
            error_message = (
                exc.message
                if isinstance(exc, ApplicationError)
                else "사건 전체 분석을 완료하지 못했습니다."
            )
            logger.exception("Motion event analysis failed: %s", job["id"])
        with self._lock:
            if not self._stop.is_set():
                self._finish(result, error_message)

    def _finish(self, result: DataObject | None, error_message: str | None) -> None:
        if self._active is None:
            return
        identifier, is_event, started = self._active
        finish = self.repository.finish_event_analysis if is_event else self.repository.finish_analysis
        notice = finish(identifier, result, error_message, round((time.monotonic() - started) * 1000))
        self._active = None
        if self.publisher is not None:
            self.publisher.publish(notice)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                if not self.process_one():
                    self._stop.wait(0.5)
            except Exception:
                logger.exception("Motion analysis database unavailable")
                self._stop.wait(1)

    def close(self) -> None:
        self._stop.set()
        with self._lock:
            # 이미 보낸 Gemini 요청은 기다리지 않습니다. 늦은 응답은 DB에 반영하지 않습니다.
            self._finish(None, "서버 종료로 분석이 중단되었습니다.")
