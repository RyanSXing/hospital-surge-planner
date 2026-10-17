"""Bounded process-local HTTP telemetry with no request content in logs."""

from __future__ import annotations

import inspect
import json
import logging
import re
import threading
import time
import uuid
from datetime import UTC, datetime

from starlette.responses import JSONResponse

_LOG = logging.getLogger("surge_api.requests")
_LOCK = threading.Lock()
_STARTED = time.time()
_METRICS = {}
_BUCKETS = (5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000)
_REQUEST_ID = re.compile(r"[A-Za-z0-9._-]{1,64}\Z")
_METHODS = {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"}


def request_id(headers):
    values = [value for name, value in headers if name.lower() == b"x-request-id"]
    if len(values) == 1:
        try:
            candidate = values[0].decode("ascii")
            if _REQUEST_ID.fullmatch(candidate):
                return candidate
        except UnicodeDecodeError:
            pass
    return str(uuid.uuid4())


def _record(method, route, status, duration):
    key = (method, route, status)
    with _LOCK:
        # Registered route templates have finite cardinality. Still bound memory
        # if application code creates routes dynamically.
        if key not in _METRICS and len(_METRICS) >= 2048:
            key = ("OTHER", "__overflow__", status // 100 * 100)
        value = _METRICS.setdefault(
            key,
            {
                "count": 0,
                "duration_ms_sum": 0.0,
                "duration_ms_max": 0.0,
                "duration_ms_buckets": [0] * (len(_BUCKETS) + 1),
            },
        )
        value["count"] += 1
        value["duration_ms_sum"] += duration
        value["duration_ms_max"] = max(value["duration_ms_max"], duration)
        for i, bound in enumerate(_BUCKETS):
            value["duration_ms_buckets"][i] += int(duration <= bound)
        value["duration_ms_buckets"][-1] += 1


def metrics_snapshot():
    """Aggregate telemetry only; caller must enforce its admin authorization."""
    with _LOCK:
        rows = []
        for (method, route, status), value in sorted(_METRICS.items()):
            rows.append(
                {
                    "method": method,
                    "route_template": route,
                    "status_code": status,
                    "request_count": value["count"],
                    "duration_ms_sum": round(value["duration_ms_sum"], 3),
                    "duration_ms_mean": round(value["duration_ms_sum"] / value["count"], 3),
                    "duration_ms_max": round(value["duration_ms_max"], 3),
                    "duration_ms_buckets": {
                        str(bound): value["duration_ms_buckets"][i]
                        for i, bound in enumerate((*_BUCKETS, "+Inf"))
                    },
                }
            )
    return {
        "scope": "current_api_process",
        "since": datetime.fromtimestamp(_STARTED, UTC).isoformat(),
        "request_count": sum(row["request_count"] for row in rows),
        "requests": rows,
    }


class RequestObservability:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        identity = request_id(scope.get("headers", []))
        scope.setdefault("state", {})["request_id"] = identity
        started = time.perf_counter()
        status = 500

        async def send_response(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = int(message["status"])
                message = {
                    **message,
                    "headers": [
                        (key, value)
                        for key, value in message.get("headers", [])
                        if key.lower() != b"x-request-id"
                    ]
                    + [(b"x-request-id", identity.encode("ascii"))],
                }
            await send(message)

        try:
            await self.app(scope, receive, send_response)
        finally:
            duration = max(0.0, (time.perf_counter() - started) * 1000)
            route = getattr(scope.get("route"), "path", None) or "__unmatched__"
            method = scope.get("method", "OTHER")
            method = method if method in _METHODS else "OTHER"
            _record(method, route, status, duration)
            _LOG.info(
                json.dumps(
                    {
                        "event": "http_request",
                        "request_id": identity,
                        "method": method,
                        "route_template": route,
                        "status_code": status,
                        "duration_ms": round(duration, 3),
                    },
                    separators=(",", ":"),
                )
            )


def install_observability(app):
    """Install last so rejected-origin and validation responses are measured too."""
    if getattr(app.state, "observability_installed", False):
        return
    app.state.observability_installed = True
    _LOG.setLevel(logging.INFO)
    if not _LOG.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(message)s"))
        _LOG.addHandler(handler)
    _LOG.propagate = False
    previous = app.exception_handlers.get(Exception) or app.exception_handlers.get(500)

    async def server_error(request, exc):
        if previous:
            response = previous(request, exc)
            if inspect.isawaitable(response):
                response = await response
        else:
            response = JSONResponse(
                {"error": {"code": "internal_error", "message": "The request could not be completed."}},
                status_code=500,
            )
        response.headers["X-Request-ID"] = getattr(request.state, "request_id", str(uuid.uuid4()))
        return response

    # ServerErrorMiddleware surrounds user middleware; its fallback response
    # needs the same correlation header when an unhandled exception escapes.
    app.add_exception_handler(Exception, server_error)
    app.add_middleware(RequestObservability)
