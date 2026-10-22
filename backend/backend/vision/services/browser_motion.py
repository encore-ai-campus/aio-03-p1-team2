"""브라우저 프레임 입력. 원본 모션 패키지를 수정하지 않고 처리기를 재사용합니다."""

from __future__ import annotations

import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

from backend.vision.errors import ApplicationError, Conflict

INPUT_FPS = 10
INPUT_TIMEOUT_SEC = 10
MAX_FRAME_BYTES = 5 * 1024 * 1024
MAX_FRAME_PIXELS = 16_000_000


class BrowserMotionEngine:
    def __init__(self, config, events, output_dir: Path, camera_id: str):
        self.config, self.events = config, events
        self.output_dir, self.camera_id = output_dir, camera_id
        self._condition = threading.Condition()
        self._stopped = False
        self._pending = None  # 처리 중인 프레임 외에 최신 1장만 대기합니다.
        self._sequence = -1
        self._timestamp = -1.0
        self._last_received = None
        self._next_receive_at = 0.0
        self._origin_perf = None
        self._started_at = None
        self._shape = None
        self._progress = {
            "status": "preparing",
            "frames_received": 0,
            "frames_dropped": 0,
        }

    def submit(self, frame, sequence_no: int, timestamp_sec: float) -> dict:
        with self._condition:
            if self._stopped:
                raise Conflict("이미 종료 중인 실행입니다.")
            if sequence_no <= self._sequence or timestamp_sec <= self._timestamp:
                raise Conflict("프레임 번호와 촬영 시간은 이전 프레임보다 커야 합니다.")
            now = time.monotonic()
            if self._origin_perf is None and timestamp_sec > INPUT_TIMEOUT_SEC:
                raise Conflict("첫 프레임의 촬영 상대 시간은 0초부터 시작해야 합니다.")
            if (
                self._origin_perf is not None
                and abs(timestamp_sec - (now - self._origin_perf)) > 5
            ):
                raise Conflict(
                    "촬영 시간이 서버 시간 흐름과 다릅니다. 감지를 다시 시작하세요."
                )
            if self._shape is not None and self._shape != frame.shape:
                raise Conflict("입력 해상도가 바뀌었습니다. 감지를 다시 시작하세요.")
            # 네트워크·타이머의 수 ms 오차를 허용하되 평균 10fps 일정은 유지합니다.
            if now + 0.005 < self._next_receive_at:
                return {
                    "sequence_no": sequence_no,
                    "accepted": False,
                    "reason": "rate_limited",
                }
            self._next_receive_at = max(now, self._next_receive_at) + 1 / INPUT_FPS
            if self._origin_perf is None:
                self._origin_perf = now - timestamp_sec
                self._started_at = datetime.now(UTC) - timedelta(seconds=timestamp_sec)
                self._shape = frame.shape
            if self._pending is not None:
                self._progress["frames_dropped"] += 1
            self._pending = (sequence_no, timestamp_sec, frame)
            self._sequence, self._timestamp = sequence_no, timestamp_sec
            self._last_received = now
            self._progress["frames_received"] += 1
            self._condition.notify_all()
            return {"sequence_no": sequence_no, "accepted": True, "reason": "accepted"}

    def stop(self) -> None:
        with self._condition:
            self._stopped = True
            self._condition.notify_all()

    def progress(self) -> dict:
        with self._condition:
            return dict(self._progress)

    def _next(self, waiting_since: float, deadline: float | None):
        with self._condition:
            while not self._stopped:
                now = time.monotonic()
                if deadline is not None and now >= deadline:
                    return None
                if now - (self._last_received or waiting_since) >= INPUT_TIMEOUT_SEC:
                    raise ApplicationError(
                        "FRAME_INPUT_TIMEOUT",
                        "10초 동안 영상 입력이 없어 감지를 종료했습니다.",
                        408,
                    )
                if self._pending is not None:
                    item, self._pending = self._pending, None
                    return item
                self._condition.wait(timeout=0.25)
            return None

    def start(self, *, run_id, duration_sec, preview, on_event, on_started):
        from motion_person.application.event_capture import EventCaptureEngine
        from motion_person.application.processor import FrameProcessor

        captures = None
        reason = "USER_STOP"
        try:
            with TemporaryDirectory(prefix="vision-tracker-") as temporary:
                processor = FrameProcessor(self.config, run_id)
                processor.load(Path(temporary) / "tracker.yaml")
                captures = EventCaptureEngine(
                    self.output_dir / run_id / "events",
                    run_id,
                    self.camera_id,
                    config=self.events,
                    jpeg_quality=self.config.jpeg_quality,
                    analysis_roi=self.config.analysis_roi,
                )
                # FramePreview는 처리 결과만으로도 JPEG를 만들 수 있습니다.
                preview.attach(None)
                waiting_since = time.monotonic()
                started = False
                first_frame_sec = None
                processed = candidates = 0
                processing_seconds = 0.0
                while True:
                    deadline = (
                        None
                        if duration_sec is None or first_frame_sec is None
                        else self._origin_perf + first_frame_sec + duration_sec
                    )
                    item = self._next(waiting_since, deadline)
                    if item is None:
                        if deadline is not None and time.monotonic() >= deadline:
                            reason = "DURATION_LIMIT"
                        break
                    index, elapsed, raw = item
                    if not started:
                        first_frame_sec = elapsed
                        on_started(
                            self._started_at + timedelta(seconds=first_frame_sec)
                        )
                        started = True
                    # 모델 준비 중 버린 프레임으로 워밍업 시간이 소진되지 않도록
                    # 첫 처리 프레임을 0초로 삼고 DB 시작 시각도 함께 맞춥니다.
                    elapsed -= first_frame_sec
                    tick = time.monotonic()
                    analysis = processor.process(raw, index, elapsed)
                    preview.publish(analysis)
                    for bundle in captures.process(analysis.packet, analysis.decision):
                        on_event(bundle)
                    processing_seconds += time.monotonic() - tick
                    processed += 1
                    candidates += bool(analysis.decision.candidate)
                    with self._condition:
                        self._progress.update(
                            status="warming_up"
                            if analysis.decision.status == "WARMUP"
                            else "running",
                            frames_processed=processed,
                            candidate_frames=candidates,
                            bundle_count=captures.bundle_count,
                            episode_count=captures.episode_count,
                            event_active=captures.active,
                            processing_fps=processed / max(processing_seconds, 1e-9),
                        )
        except Exception:
            reason = "ERROR"
            raise
        finally:
            try:
                if captures is not None:
                    for bundle in captures.flush(reason):
                        on_event(bundle)
            finally:
                self.stop()
                with self._condition:
                    self._pending = None
