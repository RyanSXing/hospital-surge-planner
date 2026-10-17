import json
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from surge_api import observability


def app_with_telemetry():
    app = FastAPI()

    @app.get("/patients/{patient_id}")
    def patient(patient_id: str):
        return {"id": patient_id}

    @app.get("/denied")
    def denied():
        raise HTTPException(403, "Private explanation")

    @app.get("/crash")
    def crash():
        raise RuntimeError("Never write patient-secret into a request log")

    observability.install_observability(app)
    return app


def test_request_ids_and_logs_never_include_request_content(monkeypatch):
    records = []
    monkeypatch.setattr(observability._LOG, "info", lambda message: records.append(json.loads(message)))
    with TestClient(app_with_telemetry()) as client:
        response = client.get(
            "/patients/patient-secret?access_token=credential-secret",
            headers={"X-Request-ID": "request-123", "Authorization": "Bearer credential-secret"},
        )
        assert response.headers["X-Request-ID"] == "request-123"
        other = client.get("/patients/another-private-id", headers={"X-Request-ID": "unsafe value"})
        uuid.UUID(other.headers["X-Request-ID"])
        assert client.get("/unregistered/private-name").status_code == 404
    text = json.dumps(records)
    assert "patient-secret" not in text and "credential-secret" not in text and "private-name" not in text
    assert records[0]["route_template"] == "/patients/{patient_id}"
    assert records[0]["status_code"] == 200
    assert records[-1]["route_template"] == "__unmatched__"
    assert all(row["duration_ms"] >= 0 for row in records)


def test_error_responses_have_correlation_and_aggregate_metrics(monkeypatch):
    monkeypatch.setattr(observability._LOG, "info", lambda message: None)
    before = observability.metrics_snapshot()["request_count"]
    with TestClient(app_with_telemetry(), raise_server_exceptions=False) as client:
        for route, status in [("/denied", 403), ("/crash", 500)]:
            response = client.get(route, headers={"X-Request-ID": "errors-123"})
            assert response.status_code == status
            assert response.headers["X-Request-ID"] == "errors-123"
        assert "patient-secret" not in response.text
    snapshot = observability.metrics_snapshot()
    assert snapshot["request_count"] == before + 2
    crash = next(row for row in snapshot["requests"] if row["route_template"] == "/crash")
    assert crash["status_code"] == 500 and crash["request_count"] >= 1
    assert crash["duration_ms_buckets"]["+Inf"] == crash["request_count"]
    snapshot["requests"].clear()
    assert observability.metrics_snapshot()["requests"]  # no mutable internal references


def test_request_id_rejects_duplicate_or_oversized_headers():
    for headers in (
        [(b"x-request-id", b"a" * 65)],
        [(b"x-request-id", b"a"), (b"X-Request-ID", b"b")],
        [(b"x-request-id", b"\xff")],
    ):
        uuid.UUID(observability.request_id(headers))
