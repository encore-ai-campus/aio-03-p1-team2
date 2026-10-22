"""한 서버 프로세스에서 실행별 입력·감지 스레드를 관리합니다. Redis는 사용하지 않습니다."""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from backend.vision.errors import ApplicationError, Conflict
from backend.vision.models.runs import RunCreate
from backend.vision.services.browser_motion import BrowserMotionEngine

if TYPE_CHECKING:
    from motion_person import FramePreview

logger = logging.getLogger(__name__)


@dataclass
class ActiveRun:
    id: str
    camera_id: str
    engine: BrowserMotionEngine
    preview: FramePreview
    thread: threading.Thread | None = None
    status: str = "starting"
    started_at: datetime | None = None


class LocalMotionRuntime:
    def __init__(
        self,
        factory: Callable,
        on_bundle: Callable[[str, Path], None],
        on_started: Callable[[str, datetime], None],
        on_finished: Callable,
        *,
        max_active_runs: int = 4,
    ):
        self.factory = factory
        self.max_active_runs = max_active_runs
        if self.max_active_runs < 1:
            raise ValueError("카메라 동시 실행 한도는 1 이상이어야 합니다.")
        self.on_bundle, self.on_started, self.on_finished = (
            on_bundle,
            on_started,
            on_finished,
        )
        self._runs: dict[str, ActiveRun] = {}
        self._lock = threading.RLock()

    def check_capacity(self, camera_id: str) -> None:
        with self._lock:
            if any(run.camera_id == camera_id for run in self._runs.values()):
                raise Conflict("이 카메라에서 이미 감지가 진행 중입니다.")
            if len(self._runs) >= self.max_active_runs:
                raise ApplicationError(
                    "MOTION_CAPACITY",
                    f"동시에 최대 {self.max_active_runs}대의 카메라를 실행할 수 있습니다.",
                    503,
                )

    def start(self, run_id: str, request: RunCreate) -> None:
        with self._lock:
            self.check_capacity(str(request.camera_id))
            engine, preview = self.factory(request)
            active = ActiveRun(run_id, str(request.camera_id), engine, preview)
            active.thread = threading.Thread(
                target=self._run,
                args=(active, request.duration_sec),
                name=f"motion-{run_id[:8]}",
                daemon=True,
            )
            self._runs[run_id] = active
            try:
                active.thread.start()
            except Exception:
                del self._runs[run_id]
                preview.close()
                raise

    def _started(self, active: ActiveRun, started_at: datetime) -> None:
        self.on_started(active.id, started_at)
        with self._lock:
            active.started_at = started_at
            if active.status != "stopping":
                active.status = "running"

    def _run(self, active: ActiveRun, duration_sec: float | None) -> None:
        error = None
        try:
            active.engine.start(
                run_id=active.id,
                duration_sec=duration_sec,
                preview=active.preview,
                on_started=lambda stamp: self._started(active, stamp),
                on_event=lambda bundle: self.on_bundle(active.id, bundle.manifest_path),
            )
        except Exception as exc:
            error = str(exc)[:1000] or "감지 실행에 실패했습니다."
            logger.exception("Motion capture failed: %s", active.id)
        finally:
            active.engine.stop()
            try:
                active.preview.close()
            except Exception:
                error = error or "미리보기를 종료하지 못했습니다."
                logger.exception("Could not close preview: %s", active.id)
            try:
                self.on_finished(active.id, "failed" if error else "stopped", error)
            except Exception:
                logger.exception("Could not finish run: %s", active.id)
            finally:
                with self._lock:
                    self._runs.pop(active.id, None)

    def submit(
        self, run_id: str, frame, sequence_no: int, timestamp_sec: float
    ) -> dict:
        with self._lock:
            active = self._matching(run_id)
            if active.status == "stopping":
                raise Conflict("종료 중인 실행에는 프레임을 보낼 수 없습니다.")
            engine = active.engine
        return engine.submit(frame, sequence_no, timestamp_sec)

    def is_active(self, run_id: str) -> bool:
        with self._lock:
            return run_id in self._runs

    def stop(self, run_id: str) -> None:
        with self._lock:
            active = self._runs.get(run_id)
            if active is not None:
                active.status = "stopping"
                active.engine.stop()

    def state(self, run_id: str) -> dict:
        with self._lock:
            active = self._runs.get(run_id)
            if active is None:
                return {}
            return {
                "status": active.status,
                "started_at": active.started_at,
                "progress": active.engine.progress(),
            }

    def preview(self, run_id: str) -> FramePreview:
        with self._lock:
            active = self._runs.get(run_id)
            if active is None or active.preview.closed:
                raise ApplicationError(
                    "PREVIEW_UNAVAILABLE", "미리보기가 종료됐습니다.", 503
                )
            return active.preview

    def _matching(self, run_id: str) -> ActiveRun:
        if run_id not in self._runs:
            raise Conflict("현재 실행 중인 감지가 아닙니다.")
        return self._runs[run_id]

    def close(self) -> None:
        with self._lock:
            runs = list(self._runs.values())
            for run in runs:
                self.stop(run.id)
        for run in runs:
            if run.thread is not None:
                run.thread.join(timeout=20)
                if run.thread.is_alive():
                    raise RuntimeError("감지 작업이 아직 종료되지 않았습니다.")
