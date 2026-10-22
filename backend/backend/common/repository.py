"""저장 시각의 UTC 표현."""

from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat()
