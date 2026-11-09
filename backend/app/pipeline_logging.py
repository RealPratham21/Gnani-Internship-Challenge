from __future__ import annotations

import json
import logging
from collections import defaultdict, deque
from datetime import datetime, timezone
from threading import Lock
from typing import Any


SENSITIVE_KEYS = {
    "api_key", "apikey", "authorization", "cookie", "password", "secret", "token",
    "x-api-key-id",
}


def redact(value: Any, key: str = "") -> Any:
    normalized = key.lower().replace("-", "_")
    if any(item.replace("-", "_") in normalized for item in SENSITIVE_KEYS):
        return "***REDACTED***"
    if isinstance(value, dict):
        return {str(k): redact(v, str(k)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(item) for item in value]
    if isinstance(value, bytes):
        return f"<bytes:{len(value)}>"
    text = str(value) if not isinstance(value, (str, int, float, bool, type(None))) else value
    return text[:2000] if isinstance(text, str) else text


class PipelineLogStore:
    def __init__(self, max_interactions: int = 100, max_events: int = 100) -> None:
        self.max_interactions = max_interactions
        self.max_events = max_events
        self._events: dict[str, deque[dict[str, Any]]] = defaultdict(
            lambda: deque(maxlen=self.max_events)
        )
        self._order: deque[str] = deque()
        self._lock = Lock()
        self._logger = logging.getLogger("uvicorn.error")

    def emit(
        self,
        request_id: str,
        stage: str,
        event: str,
        status: str = "info",
        **metadata: Any,
    ) -> dict[str, Any]:
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "request_id": request_id,
            "stage": stage,
            "event": event,
            "status": status,
            "metadata": redact(metadata),
        }
        with self._lock:
            if request_id not in self._events:
                self._order.append(request_id)
                while len(self._order) > self.max_interactions:
                    expired = self._order.popleft()
                    self._events.pop(expired, None)
            self._events[request_id].append(record)
        self._logger.info("voice_pipeline %s", json.dumps(record, ensure_ascii=False))
        return record

    def get(self, request_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._events.get(request_id, ()))

    def recent(self, limit: int = 20) -> list[dict[str, Any]]:
        with self._lock:
            ids = list(self._order)[-max(1, min(limit, 100)):]
            return [
                {"request_id": item, "events": list(self._events.get(item, ()))}
                for item in reversed(ids)
            ]


pipeline_logs = PipelineLogStore()

