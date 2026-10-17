from __future__ import annotations

# FastAPI evaluates declarative dependency/parameter defaults at route registration.
# ruff: noqa: B008
import copy
import csv
import hashlib
import hmac
import io
import json
import os
import secrets
import threading
import time
from contextlib import asynccontextmanager
from datetime import UTC
from pathlib import Path

from fastapi import (
    APIRouter,
    Body,
    Depends,
    FastAPI,
    File,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
)
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import func, select, text, update
from sqlalchemy.exc import IntegrityError

from .artifacts import ArtifactStore
from .db import (
    AuditEvent,
    Document,
    Idempotency,
    Job,
    LoginSession,
    digest,
    make_database,
    now,
    uid,
)
from .domain import (
    COLLECTIONS,
    add_document,
    date,
    normalize_conditions,
    normalize_dataset,
    scenario_defaults,
    seed_database,
    serialize,
    validate_scenario,
)
from .patients import filtered_patients, patient_filters, patient_summary
from .schemas import (
    AlertRule,
    ComparisonCreate,
    DatasetEdit,
    ExportCreate,
    JobView,
    MemberCreate,
    ResetReconciliation,
    RunCreate,
    ScenarioCreate,
    ScenarioPatch,
    UpdateApply,
    UpdateCreate,
    command_dict,
)

TERMINAL = {"SUCCEEDED", "FAILED", "CANCELLED"}


def fail(status, message, code="invalid_request", fields=None):
    raise HTTPException(status, {"code": code, "message": message, "fields": fields or []})


def db(request: Request):
    with request.app.state.Session() as session:
        yield session


def current_user(request: Request, response: Response, session=Depends(db)):
    token = request.cookies.get("hsp_session")
    auth = session.get(LoginSession, hashlib.sha256(token.encode()).hexdigest()) if token else None
    if auth and auth.expires_at <= time.time():
        auth = None
    local = request.app.state.local
    if auth is None and local:
        token = secrets.token_urlsafe(40)
        auth = LoginSession(
            token_hash=hashlib.sha256(token.encode()).hexdigest(),
            user_id="user-planner",
            workspace_id="workspace-main",
            role="admin",
            expires_at=time.time() + 8 * 3600,
        )
        session.add(auth)
        session.commit()
        response.set_cookie(
            "hsp_session", token, httponly=True, samesite="lax", secure=False, max_age=8 * 3600
        )
    if auth is None:
        fail(401, "Sign in to access this workspace", "authentication_required")
    member = session.get(Document, auth.user_id) if auth.user_id.startswith("member") else None
    return {
        "id": auth.user_id,
        "name": member.data.get("name")
        if member
        else "Capacity Planner"
        if local
        else os.getenv("ADMIN_NAME", "Workspace administrator"),
        "role": auth.role,
        "workspace_id": auth.workspace_id,
        "local_session": local,
        "memberships": [
            {"workspace_id": auth.workspace_id, "name": "Hospital operations", "role": auth.role}
        ],
    }


def writer(user=Depends(current_user)):
    if user["role"] not in {"planner", "admin"}:
        fail(403, "Your role permits viewing only", "forbidden")
    return user


def admin(user=Depends(current_user)):
    if user["role"] != "admin":
        fail(403, "Workspace administrator access required", "forbidden")
    return user


def owned(session, identity, kind, user):
    row = session.get(Document, identity)
    if not row or row.kind != kind or row.workspace_id != user["workspace_id"]:
        fail(404, "Resource not found", "not_found")
    return row


def owned_job(session, identity, user, kind=None):
    row = session.get(Job, identity)
    if not row or row.workspace_id != user["workspace_id"] or (kind and row.kind != kind):
        fail(404, "Job not found", "not_found")
    return row


def audit(session, user, action, identity, details=None):
    session.add(
        AuditEvent(
            workspace_id=user["workspace_id"],
            user_id=user["id"],
            action=action,
            entity_id=identity,
            details=details or {},
        )
    )


def etag(row, match):
    if match is None or match.strip('W/"') != str(row.revision):
        fail(
            409,
            "Draft changed or If-Match revision is missing. Reload before editing.",
            "revision_conflict",
            [{"revision": row.revision}],
        )


def mutate(session, row, data, match):
    etag(row, match)
    revision = row.revision
    result = session.execute(
        update(Document)
        .where(Document.id == row.id, Document.revision == revision)
        .values(data=data, revision=revision + 1, updated_at=now())
    )
    if result.rowcount != 1:
        fail(409, "Draft changed while editing", "revision_conflict")
    session.flush()
    session.expire(row)
    return row


def listing(items, limit=50, cursor=None):
    try:
        offset = max(0, int(cursor or 0))
    except ValueError:
        fail(422, "Invalid cursor")
    limit = max(1, min(limit, 200))
    page = items[offset : offset + limit]
    return {
        "items": page,
        "total": len(items),
        "next_cursor": str(offset + limit) if offset + limit < len(items) else None,
    }


def documents(session, user, kind):
    return list(
        session.scalars(
            select(Document)
            .where(Document.kind == kind, Document.workspace_id == user["workspace_id"])
            .order_by(Document.created_at.desc(), Document.id)
        )
    )


def idempotent(session, user, operation, key, payload):
    if not key:
        return None
    if len(key) > 256:
        fail(422, "Idempotency key is too long")
    existing = session.scalar(
        select(Idempotency).where(
            Idempotency.workspace_id == user["workspace_id"],
            Idempotency.operation == operation,
            Idempotency.key == key,
        )
    )
    if existing:
        if existing.request_hash != digest(payload):
            fail(409, "Idempotency key was used with a different request", "idempotency_conflict")
        return existing.entity_id
    return None


def remember(session, user, operation, key, payload, identity):
    if key:
        session.add(
            Idempotency(
                workspace_id=user["workspace_id"],
                operation=operation,
                key=key,
                request_hash=digest(payload),
                entity_id=identity,
            )
        )


def context(job=None, **values):
    base = {"timezone": "America/Chicago", "scope": "hospital", "statistic": "p50", "schema_version": "1.0"}
    if job:
        base.update(
            run_group_id=job.id,
            scenario_id=job.payload.get("scenario_id"),
            scenario_revision_id=job.payload.get("scenario_revision_id"),
            dataset_version_id=job.payload.get("dataset_version_id"),
            selected_replication_id=job.result.get("selected_replication_id"),
        )
    return {**base, **values}


def job_view(job):
    scenario = job.payload.get("scenario", {})
    end = scenario.get("end_at")
    if not end and scenario.get("start_at"):
        from datetime import timedelta
        from zoneinfo import ZoneInfo

        end = (
            (
                date(scenario["start_at"]).astimezone(ZoneInfo(scenario.get("timezone", "America/Chicago")))
                + timedelta(days=scenario.get("horizon_calendar_days", 30))
            )
            .astimezone(UTC)
            .isoformat()
            .replace("+00:00", "Z")
        )
    return {
        "id": job.id,
        "run_group_id": job.id,
        "status": job.status,
        "kind": job.kind,
        "completed": job.completed,
        "total": job.total,
        "replications_completed": job.completed,
        "replications_requested": job.total,
        "scenario_id": job.payload.get("scenario_id"),
        "scenario_name": scenario.get("name"),
        "scenario_revision_id": job.payload.get("scenario_revision_id"),
        "source_draft_revision": job.payload.get("source_draft_revision"),
        "start_at": scenario.get("start_at"),
        "end_at": end,
        "model_version": job.payload.get("model_version"),
        "input_sha256": job.payload.get("input_sha256"),
        "measurement_start_at": scenario.get("measurement_start_at"),
        "comparison_id": job.payload.get("comparison_id"),
        "comparison_plan_id": job.payload.get("comparison_plan_id"),
        "dataset_version_id": job.payload.get("dataset_version_id"),
        "selected_replication_id": job.result.get("selected_replication_id"),
        "created_at": job.created_at,
        "completed_at": job.completed_at,
        "error": job.error,
        "failure_message": job.error,
        "compute_estimate": job.payload.get("compute_estimate"),
        "warnings": job.result.get("warnings", []),
        "manifest": job.result.get("manifest"),
        "context": context(job),
    }


DATASET_CARD_FIELDS = (
    "dataset_version_id",
    "name",
    "label",
    "fixture",
    "snapshot_at",
    "timezone",
    "synthetic",
    "input_sha256",
    "manifest",
    "validation",
    "source_dataset_version_id",
)


def dataset_cards(session, workspace_id, limit=50, cursor=None):
    """Read only card metadata, with pagination performed by the database."""
    try:
        offset = max(0, int(cursor or 0))
    except ValueError:
        fail(422, "Invalid cursor")
    limit = max(1, min(limit, 200))
    predicate = (Document.kind == "dataset", Document.workspace_id == workspace_id)
    total = session.scalar(select(func.count()).select_from(Document).where(*predicate))
    rows = session.execute(
        select(
            Document.id,
            Document.workspace_id,
            Document.revision,
            Document.created_at,
            Document.updated_at,
            *(
                (Document.data[key].as_boolean() if key == "synthetic" else Document.data[key]).label(key)
                for key in DATASET_CARD_FIELDS
            ),
        )
        .where(*predicate)
        .order_by(Document.created_at.desc(), Document.id)
        .limit(limit)
        .offset(offset)
    ).mappings()
    return {
        "items": [{key: value for key, value in row.items() if value is not None} for row in rows],
        "total": total,
        "next_cursor": str(offset + limit) if offset + limit < total else None,
    }


def dataset_snapshot(row):
    value = serialize(row)
    snapshot = value["snapshot_at"]
    counts = {key: len(items) for key, items in value.items() if isinstance(items, list)}
    for key in ("assignments", "staff_assignments"):
        value[key] = [
            a for a in value.get(key, []) if a.get("start_at", "") <= snapshot < a.get("end_at", "")
        ]
    value.pop("history", None)
    value.update(
        collection_counts=counts,
        partial_collections=["assignments", "staff_assignments", "history"],
        full_dataset_url=f"/api/datasets/{row.id}",
    )
    return value


def freeze(session, user, scenario):
    value = copy.deepcopy(scenario.data if isinstance(scenario, Document) else scenario)
    identity = uid("revision")
    value.update(id=identity, scenario_id=value["id"], input_sha256=digest(value), frozen_at=now())
    return add_document(session, user["workspace_id"], "scenario_revision", value)


def enforce_job_quota(session, user):
    queued = session.scalar(
        select(func.count())
        .select_from(Job)
        .where(Job.workspace_id == user["workspace_id"], Job.status.notin_(TERMINAL))
    )
    settings = next(iter(documents(session, user, "workspace_settings")), None)
    maximum = (settings.data.get("max_queued_runs") if settings else None) or int(
        os.getenv("MAX_QUEUED_RUNS", "20")
    )
    if queued >= maximum:
        fail(429, "Workspace has reached its active job quota", "quota_exceeded")


def compute_estimate(session, user, dataset, scenario, plans=1):
    from .compute import estimate

    settings = next(iter(documents(session, user, "workspace_settings")), None)
    return estimate(dataset, scenario, settings.data if settings else None, plans)


def reject_over_budget(estimate):
    if not estimate["within_budget"]:
        fail(
            422,
            "Execution estimate exceeds the configured budget. Reduce horizon, repetitions, or plans.",
            "compute_budget_exceeded",
            [*estimate["errors"], {"field": "compute_estimate", "estimate": estimate}],
        )


def enqueue_run(session, user, scenario, replications=None):
    draft_revision = (
        scenario.revision if isinstance(scenario, Document) else scenario.get("_source_draft_revision")
    )
    value = copy.deepcopy(scenario.data if isinstance(scenario, Document) else scenario)
    if replications is not None:
        value["replications"] = replications
    dataset = owned(session, value["dataset_version_id"], "dataset", user)
    value = normalize_conditions(value, dataset.data)
    report = validate_scenario(value, dataset.data)
    if not report["valid"]:
        fail(422, "Scenario validation failed", "validation_failed", report["errors"])
    estimate = compute_estimate(session, user, dataset.data, value)
    reject_over_budget(estimate)
    enforce_job_quota(session, user)
    revision = freeze(session, user, value)
    from surge_engine.common import MODEL_VERSION

    payload = {
        "scenario_id": value["id"],
        "scenario_revision_id": revision.id,
        "dataset_version_id": dataset.id,
        "scenario": value,
        "source_draft_revision": draft_revision,
        "input_sha256": digest({"dataset": dataset.data, "scenario": value}),
        "model_version": MODEL_VERSION,
        "compute_estimate": estimate,
    }
    job = Job(
        id=uid("run"),
        workspace_id=user["workspace_id"],
        kind="run",
        payload=payload,
        result={},
        total=value["replications"],
    )
    session.add(job)
    audit(session, user, "run.queued", job.id, {"input_sha256": payload["input_sha256"]})
    session.flush()
    return job


def create_app(database_url=None, *, seed=True, start_dispatcher=True):
    engine, Session = make_database(database_url)
    local = os.getenv("APP_ENV", "development") not in {"production", "staging"}

    @asynccontextmanager
    async def lifespan(app):
        if not local and (
            len(os.getenv("ADMIN_PASSWORD", "")) < 16 or len(os.getenv("SESSION_SECRET", "")) < 32
        ):
            raise RuntimeError(
                "Hosted service requires ADMIN_PASSWORD (16+ chars) and SESSION_SECRET (32+ chars)"
            )
        if seed:
            seed_database(Session)
        stop = threading.Event()
        if start_dispatcher:
            from .worker import dispatch_loop

            thread = threading.Thread(
                target=dispatch_loop,
                args=(Session, stop, engine.url.render_as_string(hide_password=False)),
                daemon=True,
            )
            thread.start()
        yield
        stop.set()
        engine.dispose()

    app = FastAPI(title="Hospital Surge Planner", version="1.0.0", lifespan=lifespan)
    app.state.Session = Session
    app.state.engine = engine
    app.state.local = local
    origins = [
        x.strip()
        for x in os.getenv(
            "ALLOWED_ORIGINS",
            "http://localhost:5173,http://127.0.0.1:5173,http://localhost:8000,http://127.0.0.1:8000",
        ).split(",")
        if x.strip()
    ]
    public = os.getenv("PUBLIC_BASE_URL")
    if public:
        origins.append(public.rstrip("/"))
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH"],
        allow_headers=["Content-Type", "If-Match", "Idempotency-Key", "X-Request-ID"],
        expose_headers=["X-Request-ID"],
    )

    @app.middleware("http")
    async def security(request, call_next):
        if request.method in {"POST", "PATCH", "PUT", "DELETE"}:
            origin = request.headers.get("origin")
            if origin and origin.rstrip("/") not in origins:
                return JSONResponse(
                    {"error": {"code": "origin_rejected", "message": "Request origin is not allowed"}},
                    status_code=403,
                )
            if int(request.headers.get("content-length", "0") or 0) > int(
                os.getenv("MAX_UPLOAD_BYTES", "104857600")
            ):
                return JSONResponse(
                    {"error": {"code": "upload_too_large", "message": "Upload exceeds configured limit"}},
                    status_code=413,
                )
        result = await call_next(request)
        result.headers["X-Content-Type-Options"] = "nosniff"
        result.headers["Cache-Control"] = "no-store"
        return result

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        detail = (
            exc.detail
            if isinstance(exc.detail, dict)
            else {"code": "request_failed", "message": str(exc.detail)}
        )
        return JSONResponse(
            {"error": detail, "detail": detail.get("message", "Request failed")}, status_code=exc.status_code
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        fields = [
            {"field": ".".join(str(x) for x in error["loc"]), "message": error["msg"]}
            for error in exc.errors()
        ]
        return JSONResponse(
            {
                "error": {
                    "code": "validation_failed",
                    "message": "Request validation failed",
                    "fields": fields,
                }
            },
            status_code=422,
        )

    @app.exception_handler(IntegrityError)
    async def conflict_error(request, exc):
        return JSONResponse(
            {
                "error": {
                    "code": "write_conflict",
                    "message": "Concurrent or duplicate write. Reload and retry.",
                }
            },
            status_code=409,
        )

    router = APIRouter()
    login_attempts = {}

    @router.get("/health/live")
    def live():
        return {"status": "ok", "service": "hospital-surge-planner"}

    @router.get("/health/ready")
    def ready(session=Depends(db)):
        session.execute(text("SELECT 1"))
        # A connection alone is insufficient: required schema must exist after migrations.
        session.execute(select(Document.id).limit(1))
        queue = "local processes"
        if os.getenv("REDIS_URL"):
            from redis import Redis, RedisError

            try:
                Redis.from_url(os.environ["REDIS_URL"], socket_connect_timeout=2, socket_timeout=2).ping()
                queue = "available"
            except RedisError:
                fail(503, "Work queue is unavailable", "dependency_unavailable")
        return {"status": "ready", "database": "available", "queue": queue, "schema_version": "1.0"}

    @router.post("/auth/login")
    def login(request: Request, response: Response, payload: dict = Body(...), session=Depends(db)):
        address = request.client.host if request.client else "unknown"
        recent = [t for t in login_attempts.get(address, []) if t > time.time() - 60]
        if len(recent) >= 10:
            fail(429, "Too many sign-in attempts. Try again shortly.", "rate_limited")
        login_attempts[address] = recent + [time.time()]
        expected = os.getenv("ADMIN_PASSWORD", "")
        if local and payload.get("demo_role") in {"viewer", "planner", "admin"}:
            role = payload["demo_role"]
            user_id = "user-admin"
            workspace_id = "workspace-main"
        else:
            username = payload.get("username", "admin")
            password = str(payload.get("password", ""))
            if (
                expected
                and hmac.compare_digest(password, expected)
                and username == os.getenv("ADMIN_USERNAME", "admin")
            ):
                role = "admin"
                user_id = "user-admin"
                workspace_id = "workspace-main"
            else:
                member = next(
                    (
                        m
                        for m in session.scalars(select(Document).where(Document.kind == "member"))
                        if m.data.get("username") == username and m.data.get("enabled", True)
                    ),
                    None,
                )
                encoded = hashlib.pbkdf2_hmac(
                    "sha256",
                    password.encode(),
                    bytes.fromhex(member.data["password_salt"]) if member else b"no-user-salt",
                    600000,
                ).hex()
                if not member or not hmac.compare_digest(encoded, member.data["password_hash"]):
                    fail(401, "Invalid sign-in credentials", "authentication_failed")
                role = member.data["role"]
                user_id = member.id
                workspace_id = member.workspace_id
        token = secrets.token_urlsafe(40)
        session.add(
            LoginSession(
                token_hash=hashlib.sha256(token.encode()).hexdigest(),
                user_id=user_id,
                workspace_id=workspace_id,
                role=role,
                expires_at=time.time() + 8 * 3600,
            )
        )
        session.commit()
        response.set_cookie(
            "hsp_session", token, httponly=True, secure=not local, samesite="lax", max_age=8 * 3600
        )
        return {"authenticated": True, "role": role, "workspace_id": workspace_id}

    @router.post("/auth/logout")
    def logout(request: Request, response: Response, session=Depends(db)):
        token = request.cookies.get("hsp_session")
        auth = session.get(LoginSession, hashlib.sha256(token.encode()).hexdigest()) if token else None
        if auth:
            session.delete(auth)
            session.commit()
        response.delete_cookie("hsp_session")
        return {"authenticated": False}

    @router.get("/me")
    def me(user=Depends(current_user)):
        return user

    def workspace_access(identity, user):
        if identity != user["workspace_id"]:
            fail(404, "Workspace not found")

    def member_view(row):
        return {k: v for k, v in serialize(row).items() if k not in {"password_salt", "password_hash"}}

    @router.get("/workspaces/{identity}/members")
    def list_members(identity: str, user=Depends(admin), session=Depends(db)):
        workspace_access(identity, user)
        return {
            "items": [
                {
                    "id": "user-admin",
                    "name": os.getenv("ADMIN_NAME", "Workspace administrator"),
                    "username": os.getenv("ADMIN_USERNAME", "admin"),
                    "role": "admin",
                    "enabled": True,
                    "environment_managed": True,
                }
            ]
            + [member_view(x) for x in documents(session, user, "member")]
        }

    @router.post("/workspaces/{identity}/members", status_code=201)
    def add_member(
        identity: str, payload: MemberCreate = Body(...), user=Depends(admin), session=Depends(db)
    ):
        payload = command_dict(payload)
        workspace_access(identity, user)
        role = payload.get("role", "viewer")
        username = str(payload.get("username", "")).strip()
        password = str(payload.get("password", ""))
        if role not in {"viewer", "planner", "admin"} or not username or len(password) < 16:
            fail(422, "Provide username, role and a password of at least 16 characters")
        if username == os.getenv("ADMIN_USERNAME", "admin") or any(
            x.data.get("username") == username
            for x in session.scalars(select(Document).where(Document.kind == "member"))
        ):
            fail(409, "That username already exists")
        salt = secrets.token_bytes(24)
        value = {
            "id": uid("member"),
            "name": str(payload.get("name", username)),
            "username": username,
            "role": role,
            "enabled": True,
            "password_salt": salt.hex(),
            "password_hash": hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 600000).hex(),
        }
        row = add_document(session, user["workspace_id"], "member", value)
        audit(session, user, "member.created", row.id, {"role": role})
        session.commit()
        return member_view(row)

    @router.patch("/workspaces/{identity}/members/{member_id}")
    def edit_member(
        identity: str,
        member_id: str,
        payload: dict = Body(...),
        match: str | None = Header(default=None, alias="If-Match"),
        user=Depends(admin),
        session=Depends(db),
    ):
        workspace_access(identity, user)
        row = owned(session, member_id, "member", user)
        if set(payload) - {"name", "role", "enabled", "password"}:
            fail(422, "Unsupported member fields")
        value = {**row.data, **{k: v for k, v in payload.items() if k != "password"}}
        if value["role"] not in {"viewer", "planner", "admin"}:
            fail(422, "Invalid role")
        if "password" in payload:
            if len(str(payload["password"])) < 16:
                fail(422, "Password must have at least 16 characters")
            salt = secrets.token_bytes(24)
            value.update(
                password_salt=salt.hex(),
                password_hash=hashlib.pbkdf2_hmac(
                    "sha256", str(payload["password"]).encode(), salt, 600000
                ).hex(),
            )
        mutate(session, row, value, match)
        for login in session.scalars(select(LoginSession).where(LoginSession.user_id == member_id)):
            session.delete(login)
        audit(
            session, user, "member.updated", member_id, {"role": value["role"], "enabled": value["enabled"]}
        )
        session.commit()
        return member_view(row)

    @router.get("/workspaces/{identity}/settings")
    def get_settings(identity: str, user=Depends(admin), session=Depends(db)):
        workspace_access(identity, user)
        row = next(iter(documents(session, user, "workspace_settings")), None)
        if not row:
            row = add_document(
                session,
                user["workspace_id"],
                "workspace_settings",
                {
                    "id": uid("settings"),
                    "max_queued_runs": int(os.getenv("MAX_QUEUED_RUNS", "20")),
                    "retention_days": 90,
                    "retention_policy": {
                        "unselected_trace_days": 30,
                        "failed_import_days": 7,
                        "export_days": 7,
                    },
                    "max_run_trajectories": 40000000,
                    "max_comparison_trajectories": 80000000,
                    "display_thresholds": {"peak_inpatient_queue": [0, 5, 15], "utilization": [0.85, 1.0]},
                },
            )
            session.commit()
        from .retention import policy

        return {**serialize(row), "retention_policy": policy(row.data)}

    @router.patch("/workspaces/{identity}/settings")
    def edit_settings(
        identity: str,
        payload: dict = Body(...),
        match: str | None = Header(default=None, alias="If-Match"),
        user=Depends(admin),
        session=Depends(db),
    ):
        workspace_access(identity, user)
        row = next(iter(documents(session, user, "workspace_settings")), None)
        if not row:
            fail(409, "Load workspace settings before editing")
        if set(payload) - {
            "max_queued_runs",
            "retention_days",
            "retention_policy",
            "display_thresholds",
            "max_run_trajectories",
            "max_comparison_trajectories",
        }:
            fail(422, "Unsupported workspace setting")
        for field in ("max_queued_runs", "retention_days"):
            if field in payload and (not isinstance(payload[field], int) or not 1 <= payload[field] <= 3650):
                fail(422, f"{field} must be an integer from 1 to 3650")
        for field in ("max_run_trajectories", "max_comparison_trajectories"):
            if field in payload and (
                not isinstance(payload[field], int)
                or isinstance(payload[field], bool)
                or not 1 <= payload[field] <= 1000000000
            ):
                fail(422, f"{field} must be an integer from 1 to 1,000,000,000")
        if "retention_policy" in payload:
            from .retention import DEFAULT_POLICY

            policy = payload["retention_policy"]
            if (
                not isinstance(policy, dict)
                or set(policy) - set(DEFAULT_POLICY)
                or any(
                    not isinstance(v, int) or isinstance(v, bool) or not 1 <= v <= 3650
                    for v in policy.values()
                )
            ):
                fail(
                    422,
                    "Retention policy supports unselected_trace_days, failed_import_days and export_days, each 1–3650 days",
                )
            payload["retention_policy"] = {**DEFAULT_POLICY, **row.data.get("retention_policy", {}), **policy}
        mutate(session, row, {**row.data, **payload}, match)
        audit(session, user, "workspace.settings_updated", identity)
        session.commit()
        return serialize(row)

    @router.get("/workspaces/{workspace_id}/summary")
    def summary(workspace_id: str, user=Depends(current_user), session=Depends(db)):
        if workspace_id != user["workspace_id"]:
            fail(404, "Workspace not found")
        datasets = dataset_cards(session, workspace_id, limit=200)
        scenarios = [x for x in documents(session, user, "scenario") if not x.data.get("archived")]
        runs = list(
            session.scalars(
                select(Job)
                .where(Job.workspace_id == workspace_id, Job.kind == "run")
                .order_by(Job.created_at.desc())
                .limit(20)
            )
        )
        scenario = scenarios[0] if scenarios else None
        dataset_id = (
            scenario.data.get("dataset_version_id")
            if scenario
            else datasets["items"][0]["id"]
            if datasets["items"]
            else None
        )
        dataset = owned(session, dataset_id, "dataset", user) if dataset_id else None
        comparison_runs = {
            p["run_group_id"]
            for comparison in documents(session, user, "comparison")
            for p in comparison.data.get("plans", [])
            if p.get("run_group_id")
        }
        run = (
            session.scalar(
                select(Job)
                .where(
                    Job.workspace_id == workspace_id,
                    Job.kind == "run",
                    Job.payload["scenario_id"].as_string() == scenario.id,
                    Job.id.not_in(comparison_runs),
                    Job.payload["comparison_id"].as_string().is_(None),
                )
                .order_by(Job.created_at.desc())
                .limit(1)
            )
            if scenario
            else None
        )
        inventory = {key: len(dataset.data.get(key, [])) for key in COLLECTIONS} if dataset else {}
        return {
            "workspace": {"id": workspace_id, "name": "Hospital operations"},
            "datasets": datasets["items"],
            "datasets_total": datasets["total"],
            "datasets_next_cursor": datasets["next_cursor"],
            "scenarios": [serialize(x) for x in scenarios],
            "runs": [job_view(x) for x in runs],
            "dataset": dataset_snapshot(dataset) if dataset else None,
            "scenario": serialize(scenario) if scenario else None,
            "run": job_view(run) if run else None,
            "run_group": job_view(run) if run else None,
            "inventory": inventory,
            "context": context(),
        }

    @router.post("/demo-datasets", status_code=201)
    def demo_dataset(
        payload: dict = Body(default={}),
        key: str | None = Header(default=None, alias="Idempotency-Key"),
        user=Depends(writer),
        session=Depends(db),
    ):
        from surge_engine import generate_dataset, validate_dataset

        previous = idempotent(session, user, "demo-datasets", key, payload)
        if previous:
            return serialize(owned(session, previous, "dataset", user))
        fixture = payload.get("fixture", "planning_baseline")
        if fixture not in {"planning_baseline", "stress_snapshot"}:
            fail(422, "Unknown snapshot fixture")
        days = payload.get("days", 365)
        if not isinstance(days, int) or not 1 <= days <= 365:
            fail(422, "Days must be between 1 and 365")
        value = normalize_dataset(
            generate_dataset(fixture=fixture, seed=int(payload.get("seed", 41021)), days=days)
        )
        value["validation"] = validate_dataset(value)
        if not value["validation"]["valid"]:
            fail(
                422, "Generated fixture failed validation", "validation_failed", value["validation"]["errors"]
            )
        row = add_document(session, user["workspace_id"], "dataset", value)
        remember(session, user, "demo-datasets", key, payload, row.id)
        audit(session, user, "dataset.generated", row.id)
        session.commit()
        return serialize(row)

    @router.get("/datasets")
    def datasets(limit: int = 50, cursor: str | None = None, user=Depends(current_user), session=Depends(db)):
        return dataset_cards(session, user["workspace_id"], limit, cursor)

    @router.get("/datasets/{identity}")
    def dataset(identity: str, user=Depends(current_user), session=Depends(db)):
        return serialize(owned(session, identity, "dataset", user))

    @router.post("/datasets/{identity}/validate")
    def validate_committed_dataset(identity: str, user=Depends(current_user), session=Depends(db)):
        from surge_engine import validate_dataset

        return validate_dataset(owned(session, identity, "dataset", user).data)

    @router.get("/datasets/{identity}/patients")
    def dataset_patients(
        identity: str,
        limit: int = 50,
        cursor: str | None = None,
        filters=Depends(patient_filters),
        user=Depends(current_user),
        session=Depends(db),
    ):
        row = owned(session, identity, "dataset", user)
        templates = {t["template_id"]: t for t in row.data.get("los_templates", [])}
        items = list(
            filtered_patients(
                row.data.get("patients", []),
                row.data["snapshot_at"],
                filters,
                templates,
                units={u["unit_id"]: u for u in row.data.get("units", [])},
            )
        )
        page = listing(items, limit, cursor)
        page["items"] = [patient_summary(p, row.data["snapshot_at"], templates) for p in page["items"]]
        return {
            **page,
            "context": context(dataset_version_id=identity, state_origin="source_snapshot"),
        }

    @router.get("/datasets/{identity}/facilities")
    def dataset_facilities(identity: str, user=Depends(current_user), session=Depends(db)):
        row = owned(session, identity, "dataset", user)
        return {
            "items": row.data.get("facilities", []),
            "total": len(row.data.get("facilities", [])),
            "geometry": row.data.get("geometry"),
            "context": context(dataset_version_id=identity),
        }

    @router.get("/datasets/{identity}/units/{unit_id}/schedule")
    def dataset_unit_schedule(
        identity: str, unit_id: str, at: str | None = None, user=Depends(current_user), session=Depends(db)
    ):
        dataset = owned(session, identity, "dataset", user).data
        unit = next((u for u in dataset.get("units", []) if u["unit_id"] == unit_id), None)
        if not unit:
            fail(404, "Unit does not belong to this dataset")
        try:
            instant = date(at or dataset["snapshot_at"])
        except (ValueError, TypeError):
            fail(422, "Schedule time requires an explicit UTC offset")
        roster = {s["staff_id"]: s for s in dataset.get("staff", [])}
        assignments = sorted(
            (
                a
                for a in dataset.get("assignments", [])
                if a.get("unit_id") == unit_id and date(a["end_at"]) > instant
            ),
            key=lambda a: (a["start_at"], a["staff_id"]),
        )
        return {
            "unit": unit,
            "assignments": [
                {
                    **a,
                    "role": roster.get(a["staff_id"], {}).get("role"),
                    "capabilities": roster.get(a["staff_id"], {}).get("capabilities", []),
                }
                for a in assignments[:100]
            ],
            "total": len(assignments),
            "source": "declared_dataset_schedule",
            "at": instant.isoformat(),
            "policy": next(
                (
                    p
                    for p in dataset.get("capacity_policies", [])
                    if p["capacity_policy_id"] == unit.get("capacity_policy_id")
                ),
                None,
            ),
        }

    @router.get("/datasets/{identity}/resources")
    def dataset_resources(identity: str, user=Depends(current_user), session=Depends(db)):
        row = owned(session, identity, "dataset", user)
        return {
            **{
                k: row.data.get(k, [])
                for k in ["units", "slots", "staff", "assignments", "equipment_pools", "vehicles", "routes"]
            },
            "context": context(dataset_version_id=identity),
        }

    @router.post("/dataset-drafts", status_code=201)
    def create_dataset_draft(payload: dict = Body(...), user=Depends(writer), session=Depends(db)):
        source = owned(
            session,
            payload.get("dataset_version_id", payload.get("source_dataset_version_id")),
            "dataset",
            user,
        )
        data = copy.deepcopy(source.data)
        data.update(id=uid("draft"), source_dataset_version_id=source.id, dirty_fields=[], validation=None)
        row = add_document(session, user["workspace_id"], "dataset_draft", data)
        audit(session, user, "dataset.draft_created", row.id)
        session.commit()
        return {**serialize(row), "draft_id": row.id, "dataset": row.data}

    @router.get("/dataset-drafts/{identity}")
    def get_dataset_draft(identity: str, response: Response, user=Depends(current_user), session=Depends(db)):
        row = owned(session, identity, "dataset_draft", user)
        response.headers["ETag"] = str(row.revision)
        return {**serialize(row), "draft_id": row.id, "dataset": row.data}

    @router.patch("/dataset-drafts/{identity}/entities")
    def edit_dataset_draft(
        identity: str,
        payload: DatasetEdit = Body(...),
        match: str | None = Header(default=None, alias="If-Match"),
        user=Depends(writer),
        session=Depends(db),
    ):
        payload = command_dict(payload)
        row = owned(session, identity, "dataset_draft", user)
        etag(row, match)
        value = copy.deepcopy(row.data)
        if len(payload.get("operations", [])) > 500:
            fail(422, "At most 500 entity operations are allowed per request")
        for operation in payload.get("operations", []):
            collection = operation.get("collection")
            action = operation.get("action", operation.get("operation", "upsert"))
            if collection not in COLLECTIONS or action not in {"upsert", "delete"}:
                fail(422, "Invalid entity operation")
            entity = operation.get("entity", operation.get("value", {}))
            if collection == "assumptions":
                if (
                    action == "upsert"
                    and isinstance(entity, list)
                    and all(isinstance(x, str) for x in entity)
                ):
                    value[collection] = entity
                elif isinstance(entity, str):
                    entries = list(value.get(collection, []))
                    original = operation.get("id", operation.get("entity_id"))
                    if original is not None:
                        entries = [x for x in entries if x != original]
                    if action == "upsert" and entity not in entries:
                        entries.append(entity)
                    value[collection] = entries
                else:
                    fail(422, "Assumptions require a string or a complete string array")
                value["dirty_fields"] = sorted(set(value.get("dirty_fields", []) + [collection]))
                continue
            if isinstance(value.get(collection), dict):
                if action == "upsert":
                    if not isinstance(entity, dict):
                        fail(422, "Object-valued collections require a JSON object")
                    value[collection] = {**value[collection], **entity}
                else:
                    field = operation.get("entity_id", operation.get("id"))
                    value[collection].pop(field, None)
                value["dirty_fields"] = sorted(set(value.get("dirty_fields", []) + [collection]))
                continue
            id_field = {
                "patients": "patient_id",
                "facilities": "facility_id",
                "units": "unit_id",
                "slots": "slot_id",
                "staff": "staff_id",
                "assignments": "assignment_id",
                "equipment_pools": "equipment_pool_id",
                "routes": "route_id",
                "vehicles": "vehicle_id",
                "cohorts": "cohort_id",
                "los_templates": "template_id",
                "resource_profiles": "resource_profile_id",
                "capacity_policies": "capacity_policy_id",
                "clinic_policies": "clinic_policy_id",
                "entry_streams": "entry_stream_id",
                "pathway_profiles": "pathway_profile_id",
                "capabilities": "capability_code",
                "geometry": "unit_id",
                "organizations": "organization_id",
                "virtual_locations": "location_id",
                "history": "episode_id",
                "hour_of_day_baseline": "hour",
                "weekday_baseline": "weekday",
                "historical_daily_summaries": "local_date",
                "presets": "preset_id",
                "intervention_templates": "template_kind",
                "update_fixtures": "update_id",
                "partner_equipment": "advertisement_id",
            }.get(collection, "id")
            if not isinstance(entity, dict):
                fail(422, "Entity collections require JSON objects")
            entity_id = next(
                (
                    x
                    for x in [
                        operation.get("id"),
                        operation.get("entity_id"),
                        entity.get(id_field),
                        entity.get("id"),
                    ]
                    if x is not None
                ),
                None,
            )
            if entity_id is None:
                fail(422, "Each entity needs a stable identifier")
            items = [p for p in value.get(collection, []) if p.get(id_field, p.get("id")) != entity_id]
            if action == "upsert":
                items.append(entity)
            value[collection] = items
            value["dirty_fields"] = sorted(set(value.get("dirty_fields", []) + [collection]))
        from surge_engine import validate_dataset

        report = validate_dataset(value)
        value["validation"] = report
        mutate(session, row, value, match)
        audit(session, user, "dataset.draft_edited", row.id)
        session.commit()
        return {**serialize(row), "dataset": row.data, "validation": report}

    @router.post("/dataset-drafts/{identity}/validate")
    def validate_dataset_draft(identity: str, user=Depends(writer), session=Depends(db)):
        from surge_engine import validate_dataset

        row = owned(session, identity, "dataset_draft", user)
        report = validate_dataset(row.data)
        return {**report, "change_summary": row.data.get("dirty_fields", []), "revision": row.revision}

    @router.post("/dataset-drafts/{identity}/commit", status_code=201)
    def commit_dataset_draft(
        identity: str,
        match: str | None = Header(default=None, alias="If-Match"),
        user=Depends(writer),
        session=Depends(db),
    ):
        from surge_engine import validate_dataset

        row = owned(session, identity, "dataset_draft", user)
        etag(row, match)
        report = validate_dataset(row.data)
        if not report["valid"]:
            fail(422, "Dataset is invalid", "validation_failed", report["errors"])
        value = normalize_dataset(row.data)
        value["validation"] = report
        committed = add_document(session, user["workspace_id"], "dataset", value)
        audit(session, user, "dataset.committed", committed.id, {"source_draft_id": row.id})
        session.commit()
        return serialize(committed)

    @router.post("/imports", status_code=201)
    def create_import(
        payload: dict = Body(default={}),
        key: str | None = Header(default=None, alias="Idempotency-Key"),
        user=Depends(writer),
        session=Depends(db),
    ):
        previous = idempotent(session, user, "imports", key, payload)
        if previous:
            return serialize(owned(session, previous, "import", user))
        data = {
            "id": uid("import"),
            "status": "STAGED",
            "dataset": payload.get("dataset"),
            "mapping": payload.get("mapping", {}),
            "files": [],
            "validation": None,
            "source_dataset_version_id": payload.get("source_dataset_version_id"),
            "upload_url": None,
            "limits": {
                "max_bytes": int(os.getenv("MAX_UPLOAD_BYTES", "104857600")),
                "formats": ["json", "zip", "csv"],
            },
        }
        row = add_document(session, user["workspace_id"], "import", data)
        row.data = {**row.data, "upload_url": f"/api/imports/{row.id}/files"}
        remember(session, user, "imports", key, payload, row.id)
        audit(session, user, "import.created", row.id)
        session.commit()
        return serialize(row)

    @router.post("/imports/{identity}/files")
    async def import_file(
        identity: str, file: UploadFile = File(...), user=Depends(writer), session=Depends(db)
    ):
        row = owned(session, identity, "import", user)
        if row.data.get("status") == "EXPIRED":
            fail(410, "Temporary upload expired; start a new import", "artifact_expired")
        if row.data.get("status") == "COMMITTED":
            fail(409, "Committed import is immutable")
        maximum = int(os.getenv("MAX_UPLOAD_BYTES", "104857600"))
        used = sum(x.get("byte_size", 0) for x in row.data.get("files", []))
        content = await file.read(maximum + 1)
        if len(content) > maximum:
            fail(413, "File exceeds upload limit")
        suffix = Path(file.filename or "").suffix.lower()
        if suffix not in {".json", ".zip", ".csv"}:
            fail(422, "Supported formats are JSON, ZIP, and CSV")
        if used + len(content) > maximum:
            fail(413, "Import session exceeds its combined upload limit")
        if suffix == ".csv" and len(content) > 25 * 1024 * 1024:
            fail(413, "CSV files are limited to 25 MiB each")
        metadata = ArtifactStore().write(
            user["workspace_id"],
            row.id,
            Path(file.filename).name,
            content,
            file.content_type or "application/octet-stream",
        )
        row.data = {
            **row.data,
            "files": row.data.get("files", []) + [metadata],
            "status": "STAGED",
            "validation": None,
        }
        audit(
            session,
            user,
            "import.file_uploaded",
            row.id,
            {"filename": metadata["name"], "byte_size": len(content)},
        )
        session.commit()
        return serialize(row)

    @router.get("/imports/{identity}")
    def get_import(identity: str, user=Depends(current_user), session=Depends(db)):
        row = owned(session, identity, "import", user)
        result = serialize(row)
        dataset = result.pop("dataset", None)
        result["preview_rows"] = {
            key: values[:5]
            for key, values in (dataset or {}).items()
            if key in COLLECTIONS and isinstance(values, list)
        }
        result["row_counts"] = {
            key: len(values)
            for key, values in (dataset or {}).items()
            if key in COLLECTIONS and isinstance(values, list)
        }
        return result

    @router.post("/imports/{identity}/validate")
    def validate_import(
        identity: str, payload: dict = Body(default={}), user=Depends(writer), session=Depends(db)
    ):
        from surge_engine import validate_dataset

        row = owned(session, identity, "import", user)
        if row.data.get("status") == "EXPIRED":
            fail(410, "Temporary upload expired; start a new import", "artifact_expired")
        if row.data.get("status") == "COMMITTED":
            return row.data["validation"]
        dataset = copy.deepcopy(row.data.get("dataset"))
        if not dataset and row.data.get("source_dataset_version_id"):
            dataset = copy.deepcopy(
                owned(session, row.data["source_dataset_version_id"], "dataset", user).data
            )
        files = row.data.get("files", [])
        mapping = payload.get("mapping", row.data.get("mapping", {}))
        errors = []
        for metadata in files:
            try:
                raw = ArtifactStore().read(metadata)
                name = metadata["name"]
                if name.lower().endswith(".json"):
                    dataset = json.loads(raw)
                    if isinstance(dataset, dict) and "dataset" in dataset and "patients" not in dataset:
                        dataset = dataset["dataset"]
                elif name.lower().endswith(".zip"):
                    import zipfile

                    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                        if len(archive.infolist()) > 200 or sum(
                            x.file_size for x in archive.infolist()
                        ) > int(os.getenv("MAX_UPLOAD_BYTES", "104857600")):
                            raise ValueError("Expanded archive exceeds configured limits")
                        if any(
                            Path(x.filename).is_absolute() or ".." in Path(x.filename).parts
                            for x in archive.infolist()
                        ):
                            raise ValueError("Unsafe archive entry")
                        if "checksums.json" in archive.namelist():
                            checksums = json.loads(archive.read("checksums.json"))
                            if not isinstance(checksums, dict):
                                raise ValueError("Checksum manifest must be an object")
                            for filename, expected in checksums.items():
                                if hashlib.sha256(archive.read(filename)).hexdigest() != expected:
                                    raise ValueError(f"Checksum mismatch: {filename}")
                    from surge_engine import dataset_from_zip

                    dataset = dataset_from_zip(raw)
                else:
                    if dataset is None:
                        raise ValueError("CSV import needs a complete source dataset or full JSON bundle")
                    collection = mapping.get(name, {}).get("collection", Path(name).stem)
                    if collection not in COLLECTIONS:
                        raise ValueError("CSV must map to a supported entity collection")
                    columns = mapping.get(name, {}).get("columns", {})
                    ignored = set(mapping.get(name, {}).get("ignore", []))
                    if isinstance(dataset.get(collection), dict) or collection == "assumptions":
                        raise ValueError("Object-valued collections and assumptions must use a JSON bundle")
                    known = set().union(
                        *(record.keys() for record in dataset.get(collection, []) if isinstance(record, dict))
                    )
                    parsed = []
                    for number, record in enumerate(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))), 2):
                        if None in record:
                            errors.append(
                                {
                                    "file": name,
                                    "row": number,
                                    "field": "columns",
                                    "message": "Unexpected column count",
                                }
                            )
                            continue
                        item = {
                            columns.get(k, k): v
                            for k, v in record.items()
                            if k not in ignored and columns.get(k, k) is not None
                        }
                        unknown = set(item) - known if known else set()
                        if unknown:
                            errors.extend(
                                {
                                    "file": name,
                                    "row": number,
                                    "field": field,
                                    "column": field,
                                    "message": f"Unknown column {field}; map or explicitly ignore it",
                                }
                                for field in sorted(unknown)
                            )
                            continue
                        for key, value in list(item.items()):
                            if value == "":
                                item[key] = None
                            elif value in {"true", "false", "True", "False"}:
                                item[key] = value.lower() == "true"
                            elif value[:1] in {"[", "{"}:
                                try:
                                    item[key] = json.loads(value)
                                except ValueError:
                                    pass
                            else:
                                try:
                                    item[key] = int(value)
                                except (ValueError, TypeError):
                                    try:
                                        item[key] = float(value)
                                    except (ValueError, TypeError):
                                        pass
                        parsed.append(item)
                    dataset[collection] = parsed
            except (ValueError, KeyError, TypeError, UnicodeError) as exc:
                errors.append({"file": metadata["name"], "field": metadata["name"], "message": str(exc)})
        report = (
            validate_dataset(dataset)
            if dataset and not errors
            else {
                "valid": False,
                "errors": errors or [{"field": "files", "message": "Upload a dataset bundle first"}],
                "warnings": [],
            }
        )
        row.data = {
            **row.data,
            "dataset": dataset,
            "mapping": mapping,
            "validation": report,
            "status": "VALIDATED" if report["valid"] else "INVALID",
        }
        audit(session, user, "import.validated", row.id, {"valid": report["valid"]})
        session.commit()
        return report

    @router.post("/imports/{identity}/commit", status_code=201)
    def commit_import(identity: str, user=Depends(writer), session=Depends(db)):
        from surge_engine import validate_dataset

        row = owned(session, identity, "import", user)
        if row.data.get("committed_dataset_id"):
            return serialize(owned(session, row.data["committed_dataset_id"], "dataset", user))
        if row.data.get("status") != "VALIDATED" or not row.data.get("validation", {}).get("valid"):
            fail(
                422,
                "Import validation must pass before commit",
                "validation_failed",
                row.data.get("validation", {}).get("errors", []),
            )
        value = row.data.get("dataset")
        report = (
            validate_dataset(value)
            if value
            else {"valid": False, "errors": [{"field": "dataset", "message": "No validated dataset"}]}
        )
        if not report["valid"]:
            fail(422, "Import validation must pass before commit", "validation_failed", report["errors"])
        value = normalize_dataset(value)
        value.update(validation=report, import_id=row.id)
        committed = add_document(session, user["workspace_id"], "dataset", value)
        row.data = {**row.data, "status": "COMMITTED", "committed_dataset_id": committed.id}
        audit(session, user, "import.committed", committed.id, {"import_id": identity})
        session.commit()
        return serialize(committed)

    @router.post("/scenarios", status_code=201)
    def create_scenario(payload: ScenarioCreate = Body(...), user=Depends(writer), session=Depends(db)):
        payload = command_dict(payload)
        dataset = owned(session, payload.get("dataset_version_id"), "dataset", user)
        value = normalize_conditions(scenario_defaults(payload, dataset.data), dataset.data)
        value["id"] = uid("scenario")
        value["created_by"] = user["id"]
        report = validate_scenario(value, dataset.data)
        if not report["valid"]:
            fail(422, "Invalid scenario", "validation_failed", report["errors"])
        row = add_document(session, user["workspace_id"], "scenario", value)
        audit(session, user, "scenario.created", row.id)
        session.commit()
        return serialize(row)

    @router.get("/scenarios")
    def list_scenarios(
        limit: int = 50,
        cursor: str | None = None,
        archived: bool = False,
        search: str | None = Query(default=None, max_length=128),
        user=Depends(current_user),
        session=Depends(db),
    ):
        items = []
        for row in documents(session, user, "scenario"):
            if bool(row.data.get("archived", False)) != archived:
                continue
            if search and search.lower() not in f"{row.id} {row.data.get('name', '')}".lower():
                continue
            last = session.scalar(
                select(Job)
                .where(
                    Job.workspace_id == user["workspace_id"],
                    Job.kind == "run",
                    Job.payload["scenario_id"].as_string() == row.id,
                    Job.payload["comparison_id"].as_string().is_(None),
                )
                .order_by(Job.created_at.desc())
                .limit(1)
            )
            value = serialize(row)
            if not value.get("created_by"):
                creator = session.scalar(
                    select(AuditEvent.user_id)
                    .where(
                        AuditEvent.workspace_id == user["workspace_id"],
                        AuditEvent.entity_id == row.id,
                        AuditEvent.action.in_(["scenario.created", "scenario.cloned"]),
                    )
                    .order_by(AuditEvent.created_at)
                    .limit(1)
                )
                value["created_by"] = creator or "synthetic_demo_seed"
            if last and last.payload.get("scenario_id") == row.id:
                value["latest_run"] = job_view(last)
            items.append(value)
        return listing(items, limit, cursor)

    @router.get("/scenarios/{identity}")
    def get_scenario(identity: str, response: Response, user=Depends(current_user), session=Depends(db)):
        row = owned(session, identity, "scenario", user)
        response.headers["ETag"] = str(row.revision)
        revisions = [
            serialize(x)
            for x in documents(session, user, "scenario_revision")
            if x.data.get("scenario_id") == identity
        ]
        return {**serialize(row), "revisions": revisions}

    @router.patch("/scenarios/{identity}")
    def edit_scenario(
        identity: str,
        payload: ScenarioPatch = Body(...),
        match: str | None = Header(default=None, alias="If-Match"),
        user=Depends(writer),
        session=Depends(db),
    ):
        payload = command_dict(payload)
        row = owned(session, identity, "scenario", user)
        allowed = {
            "name",
            "dataset_version_id",
            "start_at",
            "timezone",
            "horizon_calendar_days",
            "base_seed",
            "replications",
            "conditions",
            "interventions",
            "updates",
            "description",
        }
        if set(payload) - allowed:
            fail(
                422,
                "Unsupported scenario fields",
                "validation_failed",
                [{"field": key, "message": "Not editable"} for key in set(payload) - allowed],
            )
        value = {**row.data, **payload}
        dataset = owned(session, value["dataset_version_id"], "dataset", user)
        value = normalize_conditions(value, dataset.data)
        report = validate_scenario(value, dataset.data)
        if not report["valid"]:
            fail(422, "Invalid scenario", "validation_failed", report["errors"])
        mutate(session, row, value, match)
        audit(session, user, "scenario.edited", row.id)
        session.commit()
        return serialize(row)

    @router.post("/scenarios/{identity}/validate")
    def validate_scenario_route(identity: str, user=Depends(writer), session=Depends(db)):
        row = owned(session, identity, "scenario", user)
        dataset = owned(session, row.data["dataset_version_id"], "dataset", user).data
        report = validate_scenario(row.data, dataset)
        if report["valid"]:
            report["compute_estimate"] = compute_estimate(session, user, dataset, row.data)
            report["errors"] += report["compute_estimate"]["errors"]
            report["valid"] = not report["errors"]
        return report

    @router.post("/scenarios/{identity}/feasibility")
    def preview_feasibility(
        identity: str, payload: ScenarioPatch = Body(...), user=Depends(current_user), session=Depends(db)
    ):
        from .feasibility import plan_feasibility

        row = owned(session, identity, "scenario", user)
        value = {**copy.deepcopy(row.data), **command_dict(payload)}
        dataset = owned(session, value["dataset_version_id"], "dataset", user).data
        value = normalize_conditions(value, dataset)
        report = validate_scenario(value, dataset)
        feasibility = (
            plan_feasibility(dataset, value, value.get("interventions", []))
            if report["valid"]
            else {"feasible": False, "reasons": [x.get("message", str(x)) for x in report["errors"]]}
        )
        if report["valid"]:
            report["compute_estimate"] = compute_estimate(session, user, dataset, value)
            report["errors"] += report["compute_estimate"]["errors"]
            report["valid"] = not report["errors"]
        return {
            **report,
            "feasibility": feasibility,
            "scenario_revision": row.revision,
            "dataset_version_id": value["dataset_version_id"],
        }

    @router.post("/scenarios/{identity}/revisions", status_code=201)
    def freeze_scenario(
        identity: str, payload: dict = Body(default={}), user=Depends(writer), session=Depends(db)
    ):
        row = owned(session, identity, "scenario", user)
        revision = freeze(session, user, row)
        revision.data = {**revision.data, "revision_name": payload.get("name", f"Revision {row.revision}")}
        audit(session, user, "scenario.frozen", revision.id)
        session.commit()
        return serialize(revision)

    @router.post("/scenarios/{identity}/clone", status_code=201)
    def clone_scenario(
        identity: str, payload: dict = Body(default={}), user=Depends(writer), session=Depends(db)
    ):
        parent = owned(session, identity, "scenario", user)
        value = {
            **copy.deepcopy(parent.data),
            "id": uid("scenario"),
            "name": payload.get("name", parent.data["name"] + " — copy"),
            "parent_scenario_id": identity,
            "archived": False,
            "created_by": user["id"],
        }
        row = add_document(session, user["workspace_id"], "scenario", value)
        audit(session, user, "scenario.cloned", row.id, {"parent": identity})
        session.commit()
        return serialize(row)

    @router.post("/scenarios/{identity}/archive")
    def archive_scenario(identity: str, user=Depends(writer), session=Depends(db)):
        row = owned(session, identity, "scenario", user)
        row.data = {**row.data, "archived": True}
        row.revision += 1
        audit(session, user, "scenario.archived", row.id)
        session.commit()
        return serialize(row)

    @router.post("/run-groups", status_code=202, response_model=JobView)
    def run_group(
        payload: RunCreate = Body(...),
        key: str | None = Header(default=None, alias="Idempotency-Key"),
        user=Depends(writer),
        session=Depends(db),
    ):
        payload = command_dict(payload)
        previous = idempotent(session, user, "run-groups", key, payload)
        if previous:
            return job_view(owned_job(session, previous, user, "run"))
        if payload.get("scenario_id"):
            scenario = owned(session, payload["scenario_id"], "scenario", user)
        elif payload.get("scenario"):
            dataset = owned(session, payload["scenario"].get("dataset_version_id"), "dataset", user)
            value = scenario_defaults(payload["scenario"], dataset.data)
            value["id"] = uid("scenario")
            scenario = add_document(session, user["workspace_id"], "scenario", value)
        else:
            fail(422, "scenario_id or complete scenario is required")
        row = enqueue_run(session, user, scenario, payload.get("replications"))
        remember(session, user, "run-groups", key, payload, row.id)
        session.commit()
        return job_view(row)

    @router.get("/run-groups/{identity}", response_model=JobView)
    def get_run_group(identity: str, user=Depends(current_user), session=Depends(db)):
        return job_view(owned_job(session, identity, user, "run"))

    @router.post("/run-groups/{identity}/cancel")
    def cancel_run(identity: str, user=Depends(writer), session=Depends(db)):
        row = owned_job(session, identity, user, "run")
        if row.status not in TERMINAL:
            row.cancelled = True
            row.status = "CANCELLED" if row.status == "QUEUED" else "CANCEL_REQUESTED"
        audit(session, user, "run.cancel_requested", row.id)
        session.commit()
        return job_view(row)

    @router.post("/run-groups/{identity}/retry", status_code=202)
    def retry_run(identity: str, user=Depends(writer), session=Depends(db)):
        row = owned_job(session, identity, user, "run")
        if row.status not in {"FAILED", "CANCELLED"}:
            fail(409, "Only failed or cancelled work can be retried")
        row.status = "QUEUED"
        row.cancelled = False
        row.dispatched = False
        row.error = None
        row.completed_at = None
        row.lease_until = 0
        audit(session, user, "run.retried", row.id)
        session.commit()
        return job_view(row)

    def results(session, user, identity):
        row = owned_job(session, identity, user, "run")
        if row.status != "SUCCEEDED":
            fail(409, "Final results are available after all replications succeed", "result_not_ready")
        return row, ArtifactStore().get_json_cached(row.result["aggregate_artifact"], mutable=True)

    @router.get("/run-groups/{identity}/metrics")
    def metrics(
        identity: str,
        grain: str = "day",
        start_at: str | None = None,
        end_at: str | None = None,
        max_points: int = Query(default=2000, ge=200, le=2000),
        user=Depends(current_user),
        session=Depends(db),
    ):
        from .responses import cached_response, json_response

        row = owned_job(session, identity, user, "run")
        if row.status != "SUCCEEDED":
            fail(409, "Run results are not complete")
        response_key = (
            "metrics",
            user["workspace_id"],
            identity,
            row.result["aggregate_artifact"]["sha256"],
            grain,
            start_at,
            end_at,
            max_points,
        )
        cached = cached_response(response_key)
        if cached is not None:
            return cached
        value = ArtifactStore().get_json_cached(row.result["aggregate_artifact"], mutable=True)
        if grain not in {"day", "hour", "week", "month"}:
            fail(422, "grain must be hour, day, week or month")
        if grain in {"week", "month"}:
            from .series import legacy_periods

            data = value.get("periods", {}).get(grain)
            if data is None:
                data = legacy_periods(row.result["replications_artifact"], grain)
        else:
            data = value.get("series" if grain == "hour" else "daily", [])
        try:
            lower = date(start_at) if start_at else None
            upper = date(end_at) if end_at else None
            if lower and upper and upper <= lower:
                fail(422, "Interval end must follow its start")
        except (ValueError, TypeError):
            fail(422, "Invalid metrics interval; timestamps require explicit UTC offsets")

        def in_range(item):
            instant = date(item.get("at", item.get("start_at")))
            return (lower is None or instant >= lower) and (upper is None or instant < upper)

        full_series = value.get("series", [])
        window_indices = [i for i, x in enumerate(full_series) if in_range(x)]
        from .series import visible_series

        selected = visible_series([full_series[i] for i in window_indices], max_points)
        indices = [window_indices[i] for i in selected]
        value["series"] = [full_series[i] for i in indices]
        for unit in value.get("unit_series", {}).values():
            for statistics in unit.get("fields", {}).values():
                for statistic, values in statistics.items():
                    if isinstance(values, list):
                        statistics[statistic] = [values[i] for i in indices if i < len(values)]
        resolution = {
            "source_point_count": len(full_series),
            "window_point_count": len(window_indices),
            "returned_point_count": len(indices),
            "max_points": max_points,
            "method": "multivariate_minmax_envelope" if len(indices) < len(window_indices) else "raw",
            "source_indices": indices,
            "base_resolution_minutes": 60,
            "values_are_original_points": True,
        }
        return json_response(
            {
                **value,
                "data": value["series"] if grain == "hour" else [x for x in data if in_range(x)],
                "context": context(row, grain=grain, start_at=start_at, end_at=end_at, resolution=resolution),
            },
            response_key,
        )

    @router.get("/run-groups/{identity}/heatmap")
    def heatmap(identity: str, user=Depends(current_user), session=Depends(db)):
        row, value = results(session, user, identity)
        return {
            "items": value.get("daily", []),
            "thresholds": {"waiting": 0, "utilization_warning": 0.85, "utilization_critical": 1.0},
            "context": context(row, grain="day"),
        }

    @router.get("/run-groups/{identity}/replications")
    def replications(
        identity: str,
        limit: int = 50,
        cursor: str | None = None,
        user=Depends(current_user),
        session=Depends(db),
    ):
        row = owned_job(session, identity, user, "run")
        items = [
            serialize(x)
            for x in documents(session, user, "replication")
            if x.data.get("run_group_id") == identity
        ]
        return {
            **listing(items, limit, cursor),
            "selected_replication_id": row.result.get("selected_replication_id"),
            "context": context(row),
        }

    def trace_for(session, user, identity):
        row = owned(session, identity, "replication", user)
        if not row.data.get("trace_artifact"):
            fail(
                409,
                "This replication has no retained trace. Use the selected representative replication.",
                "trace_not_retained",
            )
        return row, ArtifactStore().get_json_cached(row.data["trace_artifact"])

    def state_for(trace, at):
        from .replay import exact_state

        try:
            return exact_state(trace, at)
        except (ValueError, TypeError):
            fail(422, "Invalid replay timestamp")

    @router.get("/runs/{identity}/state")
    def run_state(identity: str, at: str | None = None, user=Depends(current_user), session=Depends(db)):
        row, trace = trace_for(session, user, identity)
        try:
            value = state_for(trace, at)
        except (ValueError, TypeError):
            fail(422, "Invalid replay timestamp")
        from .replay import bounded_state
        from .responses import json_response

        return json_response(
            {
                **bounded_state(value, identity),
                "context": context(
                    replication_id=identity, run_group_id=row.data["run_group_id"], state_origin="simulation"
                ),
            }
        )

    @router.get("/runs/{identity}/patients")
    def run_patients(
        identity: str,
        at: str | None = None,
        filters=Depends(patient_filters),
        limit: int = 50,
        cursor: str | None = None,
        user=Depends(current_user),
        session=Depends(db),
    ):
        _row, trace = trace_for(session, user, identity)
        value = state_for(trace, at)
        items = value.get("patients", [])
        if isinstance(items, dict):
            items = list(items.values())
        items = list(filtered_patients(items, value["at"], filters, simulated=True))
        page = listing(items, limit, cursor)
        selected_ids = {p["patient_id"] for p in page["items"]}
        originals = {p["patient_id"]: p for p in trace.get("patients", []) if p["patient_id"] in selected_ids}
        enriched = []
        for patient in page["items"]:
            timestamps = {}
            for field in ("admission_requested_at", "queue_entered_at"):
                supplied = originals.get(patient["patient_id"], {}).get(field)
                if not patient.get(field) and supplied and date(supplied) <= date(value["at"]):
                    timestamps[field] = supplied
            enriched.append(patient_summary({**patient, **timestamps}, value["at"], simulated=True))
        page["items"] = enriched
        from .responses import json_response

        return json_response({**page, "context": context(replication_id=identity, at=value["at"])})

    @router.get("/runs/{identity}/patients/{patient_id}")
    def patient_detail(
        identity: str, patient_id: str, at: str | None = None, user=Depends(current_user), session=Depends(db)
    ):
        _row, trace = trace_for(session, user, identity)
        patients = trace.get("patients", [])
        if isinstance(patients, dict):
            patients = list(patients.values())
        patient = next((x for x in patients if x.get("patient_id", x.get("id")) == patient_id), None)
        if not patient:
            fail(404, "Patient not found")
        if at:
            current = next(
                (
                    x
                    for x in state_for(trace, at).get("patients", [])
                    if x.get("patient_id", x.get("id")) == patient_id
                ),
                None,
            )
            if current:
                patient = {**patient, **current}
        return {
            **patient,
            "events": [x for x in trace.get("events", []) if x.get("patient_id") == patient_id],
            "context": context(replication_id=identity, at=at),
        }

    @router.get("/runs/{identity}/units/{unit_id}/timeline")
    def run_unit_timeline(
        identity: str,
        unit_id: str,
        at: str | None = None,
        max_points: int = Query(default=400, ge=200, le=2000),
        user=Depends(current_user),
        session=Depends(db),
    ):
        from .patients import unit_timeline
        from .responses import json_response

        row, trace = trace_for(session, user, identity)
        try:
            value = unit_timeline(trace, unit_id, at or trace["start_at"], max_points)
        except (ValueError, TypeError):
            fail(422, "Invalid selected unit timeline time")
        return json_response(
            {
                **value,
                "context": context(
                    replication_id=identity, run_group_id=row.data["run_group_id"], at=at or trace["start_at"]
                ),
            }
        )

    @router.get("/runs/{identity}/events")
    def events(
        identity: str,
        start_at: str | None = None,
        end_at: str | None = None,
        after_sequence: int | None = None,
        before_sequence: int | None = None,
        patient_id: str | None = None,
        at: str | None = None,
        direction: str | None = None,
        limit: int = 200,
        cursor: str | None = None,
        user=Depends(current_user),
        session=Depends(db),
    ):
        _row, trace = trace_for(session, user, identity)
        if direction not in {None, "before", "after"}:
            fail(422, "Event direction must be before or after")
        if at:
            from datetime import timedelta

            try:
                instant = date(at)
            except (ValueError, TypeError):
                fail(422, "Invalid event cursor timestamp")
            if direction == "before":
                end_at = at
            elif direction == "after":
                start_at = at
            else:
                start_at = (instant - timedelta(hours=1)).isoformat().replace("+00:00", "Z")
                end_at = (instant + timedelta(hours=1)).isoformat().replace("+00:00", "Z")
        try:
            lower = date(start_at) if start_at else None
            upper = date(end_at) if end_at else None
        except (ValueError, TypeError):
            fail(422, "Invalid event interval")
        items = [
            x
            for x in trace.get("events", [])
            if (
                lower is None
                or (
                    date(x["occurred_at"]) > lower
                    if at and direction == "after" and after_sequence is None
                    else date(x["occurred_at"]) >= lower
                )
            )
            and (
                upper is None
                or (
                    date(x["occurred_at"]) <= upper
                    if at and direction == "before" and before_sequence is not None
                    else date(x["occurred_at"]) < upper
                )
            )
            and (before_sequence is None or x.get("sequence_number", 0) < before_sequence)
            and (after_sequence is None or x.get("sequence_number", 0) > after_sequence)
            and (not patient_id or x.get("patient_id") == patient_id)
        ]
        if direction == "before":
            items = list(reversed(items))
        value = listing(items, limit, cursor)
        return {
            **value,
            "last_sequence": value["items"][-1]["sequence_number"] if value["items"] else after_sequence,
            "context": context(replication_id=identity),
        }

    @router.get("/runs/{identity}/checkpoints")
    def checkpoints(
        identity: str,
        at: str | None = None,
        limit: int = 50,
        cursor: str | None = None,
        user=Depends(current_user),
        session=Depends(db),
    ):
        _row, trace = trace_for(session, user, identity)
        items = trace.get("checkpoints", [])
        if at:
            try:
                instant = date(at)
            except (ValueError, TypeError):
                fail(422, "Invalid checkpoint timestamp")
            eligible = [x for x in items if date(x.get("at", x.get("occurred_at", ""))) <= instant]
            selected = eligible[-1:]
            if selected and "patients" not in selected[0]:
                from .replay import bounded_state

                selected = [{**selected[0], **bounded_state(state_for(trace, selected[0]["at"]), identity)}]
            return {"items": selected, "context": context(replication_id=identity, at=at)}
        index = [{k: v for k, v in x.items() if k not in {"patients", "units", "vehicles"}} for x in items]
        return {**listing(index, limit, cursor), "context": context(replication_id=identity)}

    @router.post("/runs/{identity}/trace", status_code=202)
    def regenerate_trace(identity: str, user=Depends(current_user), session=Depends(db)):
        replication = owned(session, identity, "replication", user)
        if replication.data.get("trace_artifact"):
            return {"replication_id": identity, "status": "SUCCEEDED", "ready": True}
        prior = next(
            (
                j
                for j in session.scalars(
                    select(Job).where(Job.kind == "trace", Job.workspace_id == user["workspace_id"])
                )
                if j.payload.get("replication_id") == identity
                and j.status not in {"FAILED", "CANCELLED", "SUCCEEDED"}
            ),
            None,
        )
        if prior:
            return {**job_view(prior), "replication_id": identity, "ready": prior.status == "SUCCEEDED"}
        enforce_job_quota(session, user)
        job = Job(
            id=uid("trace"),
            workspace_id=user["workspace_id"],
            kind="trace",
            payload={"replication_id": identity, "run_group_id": replication.data["run_group_id"]},
            total=1,
            result={},
        )
        session.add(job)
        audit(session, user, "trace.regeneration_queued", identity)
        session.commit()
        return {**job_view(job), "replication_id": identity, "ready": False}

    @router.get("/runs/{identity}/trace")
    def trace_status(identity: str, user=Depends(current_user), session=Depends(db)):
        replication = owned(session, identity, "replication", user)
        if replication.data.get("trace_artifact"):
            return {"replication_id": identity, "status": "SUCCEEDED", "ready": True}
        if replication.data.get("trace_expired_at"):
            return {
                "replication_id": identity,
                "status": "EXPIRED",
                "ready": False,
                "regenerate_url": f"/api/runs/{identity}/trace",
            }
        prior = next(
            (
                j
                for j in session.scalars(
                    select(Job)
                    .where(Job.kind == "trace", Job.workspace_id == user["workspace_id"])
                    .order_by(Job.created_at.desc())
                )
                if j.payload.get("replication_id") == identity
            ),
            None,
        )
        return {
            **(job_view(prior) if prior else {"status": "NOT_REQUESTED"}),
            "replication_id": identity,
            "ready": False,
        }

    @router.post("/comparisons", status_code=202)
    def create_comparison(
        payload: ComparisonCreate = Body(...),
        key: str | None = Header(default=None, alias="Idempotency-Key"),
        user=Depends(writer),
        session=Depends(db),
    ):
        payload = command_dict(payload)
        previous = idempotent(session, user, "comparisons", key, payload)
        if previous:
            return serialize(owned(session, previous, "comparison", user))
        source = owned(session, payload.get("scenario_id"), "scenario", user)
        plans = payload.get("plans", payload.get("candidates", []))
        if not isinstance(plans, list) or any(not isinstance(p, dict) for p in plans):
            fail(
                422,
                "Plans must be an array of objects",
                "validation_failed",
                [{"field": "plans", "message": "Supply plan objects"}],
            )
        if not 1 <= len(plans) <= 3:
            fail(422, "Choose 1–3 alternatives; the unchanged reference is included automatically")
        alternatives = [
            {
                "id": uid("plan"),
                "name": "Unchanged reference",
                "interventions": copy.deepcopy(source.data.get("interventions", [])),
                "reference": True,
            }
        ]
        alternatives += [
            {**plan, "id": uid("plan"), "name": plan.get("name", f"Plan {i + 1}"), "reference": False}
            for i, plan in enumerate(plans)
        ]
        comparison_id = uid("comparison")
        from .feasibility import plan_feasibility

        dataset = owned(session, source.data["dataset_version_id"], "dataset", user).data
        estimate = compute_estimate(
            session,
            user,
            dataset,
            {**source.data, "replications": payload.get("replications", source.data["replications"])},
            len(alternatives),
        )
        reject_over_budget(estimate)
        for plan in alternatives:
            interventions = plan.get("interventions", [])
            report = validate_scenario({**source.data, "interventions": interventions}, dataset)
            if not report["valid"]:
                fail(422, "Comparison plan validation failed", "validation_failed", report["errors"])
            plan["feasibility"] = plan_feasibility(dataset, source.data, interventions)
            if not plan["feasibility"]["feasible"]:
                plan["status"] = "INFEASIBLE"
                continue
            value = {
                **copy.deepcopy(source.data),
                "interventions": interventions,
                "name": plan["name"],
                "_source_draft_revision": source.revision,
            }
            row = enqueue_run(session, user, value, payload.get("replications"))
            row.payload = {**row.payload, "comparison_id": comparison_id, "comparison_plan_id": plan["id"]}
            plan["run_group_id"] = row.id
        data = {
            "id": comparison_id,
            "scenario_id": source.id,
            "source_scenario_snapshot": copy.deepcopy(source.data),
            "source_draft_revision": source.revision,
            "plans": alternatives,
            "compute_estimate": estimate,
            "status": "QUEUED",
            "context": context(scenario_id=source.id),
        }
        row = add_document(session, user["workspace_id"], "comparison", data)
        remember(session, user, "comparisons", key, payload, row.id)
        audit(session, user, "comparison.created", row.id)
        session.commit()
        return serialize(row)

    @router.get("/comparisons")
    def list_comparisons(
        scenario_id: str | None = None,
        limit: int = 50,
        cursor: str | None = None,
        user=Depends(current_user),
        session=Depends(db),
    ):
        rows = [
            serialize(row)
            for row in documents(session, user, "comparison")
            if not scenario_id or row.data.get("scenario_id") == scenario_id
        ]
        for row in rows:
            row.pop("source_scenario_snapshot", None)
        return listing(rows, limit, cursor)

    def comparison_value(row, session, user, max_points=2000):
        from .comparisons import paired_summary, rank_plans, summary_for

        value = copy.deepcopy(row.data)
        reference = None
        all_done = True
        failed = False
        for plan in value["plans"]:
            if not plan.get("run_group_id"):
                continue
            job = owned_job(session, plan["run_group_id"], user)
            plan["status"] = job.status
            plan["completed"] = job.completed
            plan["total"] = job.total
            if job.status not in TERMINAL:
                all_done = False
            if job.status in {"FAILED", "CANCELLED"}:
                failed = True
            if job.status == "SUCCEEDED":
                result = ArtifactStore().get_json_cached(job.result["aggregate_artifact"], mutable=True)
                plan["metrics"] = result
                summary = summary_for(job.result["replications_artifact"], result)
                plan["feasibility"] = summary["feasibility"]
                if not plan["feasibility"]["feasible"]:
                    plan["status"] = "INFEASIBLE"
                    if plan.get("reference"):
                        failed = True
                    continue
                plan["_waits"] = summary["paired_waits"]
                if plan.get("reference"):
                    reference = plan
        if reference:
            for plan in value["plans"]:
                if "_waits" not in plan:
                    continue
                plan["improvement"] = paired_summary(reference["_waits"], plan["_waits"])
        source = (
            value.get("source_scenario_snapshot")
            or owned(session, value["scenario_id"], "scenario", user).data
        )
        rankings = rank_plans(value["plans"], source)
        for rank, plan in enumerate(rankings, 1):
            plan["rank"] = rank
        for plan in value["plans"]:
            plan.pop("_waits", None)
        value.update(
            rankings=[p["id"] for p in rankings],
            status=("FAILED" if failed else "SUCCEEDED") if all_done else "RUNNING",
        )
        value["no_plan_improves"] = bool(
            all_done
            and reference
            and not any(
                p.get("improvement", {}).get("p50", 0) > 0 for p in value["plans"] if not p.get("reference")
            )
        )
        from .series import bound_comparison_series

        bound_comparison_series(value["plans"], max_points)
        return value

    @router.get("/comparisons/{identity}")
    def get_comparison(
        identity: str,
        max_points: int = Query(default=2000, ge=200, le=2000),
        user=Depends(current_user),
        session=Depends(db),
    ):
        from .responses import cached_response, json_response

        row = owned(session, identity, "comparison", user)
        jobs = [
            owned_job(session, p["run_group_id"], user) for p in row.data["plans"] if p.get("run_group_id")
        ]
        signature = tuple(
            (j.id, j.status, j.completed, j.result.get("aggregate_artifact", {}).get("sha256")) for j in jobs
        )
        key = ("comparison", user["workspace_id"], identity, row.revision, signature, max_points)
        cached = cached_response(key)
        if cached is not None:
            return cached
        return json_response(comparison_value(row, session, user, max_points), key)

    @router.post("/comparisons/{identity}/save-plan", status_code=201)
    def save_plan(identity: str, payload: dict = Body(...), user=Depends(writer), session=Depends(db)):
        row = owned(session, identity, "comparison", user)
        plan = next(
            (x for x in comparison_value(row, session, user)["plans"] if x["id"] == payload.get("plan_id")),
            None,
        )
        if not plan:
            fail(404, "Plan not found")
        if not plan["feasibility"]["feasible"]:
            fail(422, "An infeasible plan cannot be saved as feasible")
        if plan.get("status") != "SUCCEEDED":
            fail(409, "Complete the comparison before saving an evaluated plan")
        source = owned(session, row.data["scenario_id"], "scenario", user)
        value = {
            **copy.deepcopy(row.data.get("source_scenario_snapshot", source.data)),
            "id": uid("scenario"),
            "name": payload.get("name", plan["name"]),
            "interventions": plan.get("interventions", []),
            "parent_scenario_id": source.id,
            "planning_status": "proposed",
            "comparison_id": identity,
        }
        result = add_document(session, user["workspace_id"], "scenario", value)
        audit(session, user, "plan.saved", result.id)
        session.commit()
        return serialize(result)

    @router.get("/sites/{identity}/eligibility")
    def site_eligibility(
        identity: str,
        scenario_id: str | None = None,
        scenario_revision_id: str | None = None,
        at: str | None = None,
        care_level: str = "ward",
        resource_profile_id: str | None = None,
        patient_id: str | None = None,
        replication_id: str | None = None,
        resource_requirements: str | None = None,
        user=Depends(current_user),
        session=Depends(db),
    ):
        if scenario_revision_id:
            scenario = owned(session, scenario_revision_id, "scenario_revision", user)
        elif scenario_id:
            scenario = owned(session, scenario_id, "scenario", user)
        else:
            fail(422, "A scenario or scenario revision context is required")
        dataset = owned(session, scenario.data["dataset_version_id"], "dataset", user).data
        site = next(
            (x for x in dataset.get("facilities", []) if x.get("facility_id", x.get("id")) == identity), None
        )
        if site is None:
            fail(404, "Site not found")
        selected = None
        patient = None
        if replication_id:
            replication, trace = trace_for(session, user, replication_id)
            job = owned_job(session, replication.data["run_group_id"], user, "run")
            expected = (
                job.payload.get("scenario_revision_id")
                if scenario_revision_id
                else job.payload.get("scenario_id")
            )
            if expected != scenario.id:
                fail(422, "Replication belongs to a different scenario context")
            if job.payload.get("dataset_version_id") != dataset["id"]:
                fail(422, "Replication and dataset context differ")
            try:
                selected = state_for(trace, at)
            except (ValueError, TypeError):
                fail(422, "Invalid replay timestamp")
        if patient_id:
            patient = next(
                (p for p in (selected or dataset).get("patients", []) if p["patient_id"] == patient_id), None
            )
            if not patient:
                fail(404, "Patient is not present at the selected time", "patient_not_present")
            care_level = patient.get("target_unit_kind") or patient.get("care_level", care_level)
        profile = next(
            (
                p
                for p in dataset.get("resource_profiles", [])
                if p["resource_profile_id"] == resource_profile_id
            ),
            None,
        )
        if resource_profile_id and not profile:
            fail(422, "Unknown resource profile")
        if patient:
            requirements = patient.get(
                "inpatient_resource_requirements", patient.get("resource_requirements", [])
            )
        elif profile:
            requirements = profile.get("required_equipment", [])
        else:
            try:
                requirements = json.loads(resource_requirements) if resource_requirements else []
            except ValueError:
                fail(422, "Resource requirements must be a JSON array")
        requirements = (
            [{"capability_code": r, "quantity": 1} if isinstance(r, str) else r for r in requirements]
            if isinstance(requirements, list)
            else None
        )
        if requirements is None or any(
            not isinstance(r, dict)
            or not r.get("capability_code")
            or not isinstance(r.get("quantity", 1), (int, float))
            or r.get("quantity", 1) <= 0
            for r in requirements
        ):
            fail(422, "Resource requirements must specify a capability and positive quantity")
        from .eligibility import check_placement

        try:
            value = check_placement(
                dataset, scenario.data, site, care_level, requirements, patient, selected, at
            )
        except (ValueError, TypeError):
            fail(422, "Invalid eligibility timestamp")
        return {
            **value,
            "context": context(
                scenario_id=scenario_id,
                scenario_revision_id=scenario_revision_id,
                replication_id=replication_id,
                at=value["at"],
            ),
        }

    UPDATE_TYPES = {
        "arrival_batch",
        "patient_departure",
        "staff_unavailable",
        "staff_available",
        "site_ready",
        "capacity_change",
        "advertised_capacity_change",
        "census_replacement",
        "equipment_change",
        "route_change",
        "retract_or_correct",
    }

    def check_update(payload, session, user):
        scenario = owned(session, payload.get("scenario_id"), "scenario", user)
        errors = []
        if payload.get("type") not in UPDATE_TYPES:
            errors.append({"field": "type", "message": "Unsupported update type"})
        if payload.get("state_origin") not in {"simulation_branch", "observed_reset"}:
            errors.append({"field": "state_origin", "message": "Choose simulation_branch or observed_reset"})
        try:
            effective = date(payload["effective_at"])
            if effective < date(scenario.data.get("branch_at", scenario.data["start_at"])):
                errors.append(
                    {
                        "field": "effective_at",
                        "message": "Update predates the current branch; create a historical revision explicitly",
                    }
                )
        except (ValueError, KeyError, TypeError):
            errors.append({"field": "effective_at", "message": "Timestamp with offset required"})
        from .updates import payload_errors

        errors.extend(
            payload_errors(payload, owned(session, scenario.data["dataset_version_id"], "dataset", user).data)
        )
        if errors:
            fail(422, "Update validation failed", "validation_failed", errors)
        detail = payload.get("payload", {})
        if payload.get("type") == "arrival_batch":
            if not isinstance(detail.get("count"), int) or not 0 <= detail.get("count", -1) <= 10000:
                errors.append(
                    {"field": "payload.count", "message": "Count must be an integer from 0 to 10000"}
                )
            if not detail.get("care_mix"):
                errors.append({"field": "payload.care_mix", "message": "An explicit care mix is required"})
        if payload.get("type") == "census_replacement":
            if payload.get("state_origin") != "observed_reset":
                errors.append(
                    {"field": "state_origin", "message": "Census replacement requires observed_reset"}
                )
            observed = owned(session, detail.get("observed_dataset_version_id"), "dataset", user)
            if date(observed.data["snapshot_at"]) != date(payload["effective_at"]):
                errors.append(
                    {
                        "field": "payload.observed_dataset_version_id",
                        "message": "Snapshot time must equal the update effective time",
                    }
                )
        if payload.get("state_origin") == "simulation_branch" and payload.get("replication_id"):
            owned(session, payload["replication_id"], "replication", user)
        if errors:
            fail(422, "Update validation failed", "validation_failed", errors)
        return scenario

    @router.post("/updates", status_code=201)
    def create_update(
        payload: UpdateCreate = Body(...),
        key: str | None = Header(default=None, alias="Idempotency-Key"),
        user=Depends(writer),
        session=Depends(db),
    ):
        payload = command_dict(payload)
        key = key or payload.get("idempotency_key")
        previous = idempotent(session, user, "updates", key, payload)
        if previous:
            return serialize(owned(session, previous, "update", user))
        check_update(payload, session, user)
        value = {
            **payload,
            "id": uid("update"),
            "update_id": uid("event"),
            "recorded_at": now(),
            "author_id": user["id"],
            "source": payload.get("source", "user_planning_input"),
            "status": "active",
        }
        row = add_document(session, user["workspace_id"], "update", value)
        remember(session, user, "updates", key, payload, row.id)
        audit(session, user, "update.recorded", row.id)
        session.commit()
        return serialize(row)

    @router.get("/updates")
    def list_updates(
        scenario_id: str | None = None,
        limit: int = 50,
        cursor: str | None = None,
        user=Depends(current_user),
        session=Depends(db),
    ):
        items = [
            serialize(x)
            for x in documents(session, user, "update")
            if not scenario_id or x.data["scenario_id"] == scenario_id
        ]
        return listing(items, limit, cursor)

    def reset_reconciliation(
        session, user, scenario, parent, parent_revision, dataset, effective, source, selected_updates
    ):
        """Use the same complete patient ledger and update decisions for preview and commit."""
        from datetime import timedelta
        from zoneinfo import ZoneInfo

        from surge_engine import validate_dataset

        try:
            effective = date(effective).astimezone(UTC).isoformat().replace("+00:00", "Z")
        except (TypeError, ValueError):
            fail(422, "Choose a cutoff timestamp with an explicit UTC offset", "SNAPSHOT_TIME_MISMATCH")
        end = (
            date(parent["end_at"])
            if parent.get("end_at")
            else date(parent["start_at"]).astimezone(ZoneInfo(parent["timezone"]))
            + timedelta(days=parent["horizon_calendar_days"])
        )
        if not date(parent["start_at"]) <= date(effective) < end:
            fail(422, "Reset time must lie within the original horizon", "SNAPSHOT_TIME_MISMATCH")
        validation = validate_dataset(dataset.data)
        if not validation["valid"]:
            fail(
                422,
                "Observed snapshot must be complete and valid",
                "INCOMPLETE_RESET_SNAPSHOT",
                validation["errors"],
            )
        if date(dataset.data["snapshot_at"]) != date(effective):
            fail(422, "Observed snapshot and cutoff must be the same instant", "SNAPSHOT_TIME_MISMATCH")
        prior = owned(session, parent["dataset_version_id"], "dataset", user).data
        predicted = prior.get("patients", [])
        basis = {"source": "previous_dataset_snapshot", "at": prior["snapshot_at"]}
        explicit_run = source.get("parent_run_group_id")
        reference = source.get("reference_replication_id")
        if reference and not explicit_run:
            fail(422, "Choose the parent run for the reconciliation reference", "INVALID_BRANCH_SOURCE")
        candidates = (
            [owned_job(session, explicit_run, user, "run")]
            if explicit_run
            else session.scalars(
                select(Job)
                .where(
                    Job.workspace_id == user["workspace_id"],
                    Job.kind == "run",
                    Job.status == "SUCCEEDED",
                    Job.payload["scenario_id"].as_string() == scenario.id,
                )
                .order_by(Job.created_at.desc())
            )
        )
        for candidate in candidates:
            compatible = candidate.status == "SUCCEEDED" and candidate.payload["scenario_id"] == scenario.id
            compatible = compatible and (
                not parent_revision or candidate.payload["scenario_revision_id"] == parent_revision.id
            )
            if not compatible:
                if explicit_run:
                    fail(
                        422,
                        "Reconciliation run must match the parent scenario and revision",
                        "INVALID_BRANCH_SOURCE",
                    )
                continue
            selected = reference or candidate.result.get("selected_replication_id")
            if not selected:
                continue
            run, trace = trace_for(session, user, selected)
            if run.data["run_group_id"] != candidate.id:
                fail(422, "Reference replication belongs to a different run", "INVALID_BRANCH_SOURCE")
            if not date(candidate.payload["scenario"]["start_at"]) <= date(effective) < date(trace["end_at"]):
                if explicit_run:
                    fail(422, "Reconciliation time lies outside the parent run", "INVALID_BRANCH_SOURCE")
                continue
            predicted = state_for(trace, effective)["patients"]
            parent = candidate.payload["scenario"]
            basis = {
                "source": "selected_parent_projection",
                "replication_id": selected,
                "run_group_id": candidate.id,
                "scenario_revision_id": candidate.payload["scenario_revision_id"],
                "at": effective,
            }
            break
        old_ids = {p["patient_id"] for p in predicted}
        new_ids = {p["patient_id"] for p in dataset.data.get("patients", [])}
        included = set(dataset.data.get("manifest", {}).get("included_update_ids", [])) | set(
            source.get("included_update_ids") or []
        )
        declared = {
            x.id: x for x in documents(session, user, "update") if x.data.get("scenario_id") == scenario.id
        }
        if included - set(declared):
            fail(
                422,
                "Snapshot included_update_ids must reference inputs from the source scenario",
                "UNKNOWN_INCLUDED_UPDATE",
            )
        retained_ids = {
            x["update_id"]
            for x in selected_updates
            if x["type"] != "census_replacement" and x["update_id"] not in included
        }
        disposition = [
            {
                "update_id": x["update_id"],
                "action": "apply" if x["update_id"] in retained_ids else "exclude",
                "reason": "already included in replacement snapshot"
                if x["update_id"] in included
                else "complete snapshot replaces census"
                if x["type"] == "census_replacement"
                else "additional change at the reset cutoff",
            }
            for x in selected_updates
        ]
        selected_ids = {x["update_id"] for x in selected_updates}
        disposition.extend(
            {
                "update_id": x.get("update_id", x.get("id")),
                "action": "exclude",
                "reason": "prior projection inputs are replaced by the complete observed state",
            }
            for x in parent.get("updates", [])
            if x.get("update_id", x.get("id")) not in selected_ids
        )
        mentioned = {x["update_id"] for x in disposition}
        disposition.extend(
            {"update_id": identity, "action": "exclude", "reason": "already included in replacement snapshot"}
            for identity in sorted(included - mentioned)
        )
        report = {
            "previous_dataset_version_id": parent["dataset_version_id"],
            "observed_dataset_version_id": dataset.id,
            "effective_at": effective,
            "matched": sorted(old_ids & new_ids),
            "absent": sorted(old_ids - new_ids),
            "new": sorted(new_ids - old_ids),
            "conflicting": [],
            "basis": basis,
            "update_disposition": disposition,
            "included_update_ids": sorted(included),
            "policy": "replace_complete_snapshot",
            "absent_is_not_discharge": True,
            "counts": validation["counts"],
            "warnings": validation["warnings"],
            "prior_patient_total": len(old_ids),
            "observed_patient_total": len(new_ids),
        }
        report["reconciliation_hash"] = digest(
            {
                key: report[key]
                for key in (
                    "previous_dataset_version_id",
                    "observed_dataset_version_id",
                    "effective_at",
                    "matched",
                    "absent",
                    "new",
                    "basis",
                    "included_update_ids",
                )
            }
        )
        if (
            source.get("reconciliation_hash")
            and source["reconciliation_hash"] != report["reconciliation_hash"]
        ):
            fail(409, "The reset reference changed; review reconciliation again", "UNRESOLVED_RECONCILIATION")
        return report

    @router.post("/scenarios/{identity}/reset-reconciliation")
    def preview_reset(
        identity: str, payload: ResetReconciliation, user=Depends(current_user), session=Depends(db)
    ):
        source = command_dict(payload)
        scenario = owned(session, identity, "scenario", user)
        revision = (
            owned(session, source["parent_scenario_revision_id"], "scenario_revision", user)
            if source.get("parent_scenario_revision_id")
            else None
        )
        if revision and revision.data["scenario_id"] != scenario.id:
            fail(422, "Parent revision belongs to another scenario", "INVALID_BRANCH_SOURCE")
        selected = []
        for update_id in dict.fromkeys(source.get("update_ids") or []):
            event = owned(session, update_id, "update", user)
            if event.data["scenario_id"] != scenario.id or date(event.data["effective_at"]) != date(
                source["effective_at"]
            ):
                fail(422, "Selected updates must share scenario and cutoff")
            selected.append({**copy.deepcopy(event.data), "update_id": event.id})
        dataset = owned(session, source["observed_dataset_version_id"], "dataset", user)
        return reset_reconciliation(
            session,
            user,
            scenario,
            revision.data if revision else scenario.data,
            revision,
            dataset,
            source["effective_at"],
            source,
            selected,
        )

    @router.post("/updates/{identity}/apply")
    def apply_update(
        identity: str,
        payload: UpdateApply = Body(default={}),
        match: str | None = Header(default=None, alias="If-Match"),
        key: str | None = Header(default=None, alias="Idempotency-Key"),
        user=Depends(writer),
        session=Depends(db),
    ):
        payload = command_dict(payload)
        event = owned(session, identity, "update", user)
        if event.data.get("applied_scenario_id"):
            child = owned(session, event.data["applied_scenario_id"], "scenario", user)
            job = (
                owned_job(session, event.data["run_group_id"], user)
                if event.data.get("run_group_id")
                else None
            )
            return {
                "update": serialize(event),
                "scenario": serialize(child),
                "run": job_view(job) if job else None,
                "already_applied": True,
                "scenario_revision_id": event.data.get("scenario_revision_id"),
                "run_group_id": job.id if job else None,
            }
        source_scenario = check_update(event.data, session, user)
        if match is not None:
            etag(source_scenario, match)
        effective = payload.get("effective_at", event.data["effective_at"])
        if date(effective) != date(event.data["effective_at"]):
            fail(422, "Apply cutoff must match the update effective time", "SNAPSHOT_TIME_MISMATCH")
        origin = payload.get("state_origin", event.data["state_origin"])
        if origin != event.data["state_origin"]:
            fail(422, "State origin cannot change during application")
        selected_ids = payload.get("update_ids", [identity])
        if identity not in selected_ids:
            fail(422, "The route update must be included in update_ids")
        selected_updates = []
        for update_id in dict.fromkeys(selected_ids):
            item = owned(session, update_id, "update", user)
            if item.data["scenario_id"] != source_scenario.id or date(item.data["effective_at"]) != date(
                effective
            ):
                fail(422, "Selected updates must share scenario and cutoff")
            selected_updates.append({**copy.deepcopy(item.data), "update_id": item.id})
        parent = source_scenario.data
        parent_revision = None
        if payload.get("parent_scenario_revision_id"):
            parent_revision = owned(
                session, payload["parent_scenario_revision_id"], "scenario_revision", user
            )
            if parent_revision.data["scenario_id"] != source_scenario.id:
                fail(422, "Parent revision belongs to another scenario", "INVALID_BRANCH_SOURCE")
            parent = parent_revision.data
        value = {
            **copy.deepcopy(parent),
            "id": uid("scenario"),
            "name": payload.get("name", source_scenario.data["name"] + " — updated"),
            "parent_scenario_id": source_scenario.id,
            "parent_scenario_revision_id": parent_revision.id if parent_revision else None,
            "branch_at": effective,
            "measurement_start_at": effective,
            "state_origin": origin,
        }
        superseded = {item.get("supersedes_update_id") for item in selected_updates}
        value["updates"] = [
            x for x in value.get("updates", []) if x.get("update_id") not in superseded
        ] + selected_updates
        branch_source = payload.get("source", {})
        enqueue = payload.get("enqueue", payload.get("run", True))
        reps = payload.get("replications", value["replications"])
        if origin == "observed_reset":
            observed_id = branch_source.get(
                "observed_dataset_version_id",
                event.data.get("payload", {}).get("observed_dataset_version_id"),
            )
            if observed_id != event.data.get("payload", {}).get("observed_dataset_version_id"):
                fail(
                    422,
                    "The update and reset source must reference the same observed snapshot",
                    "SNAPSHOT_TIME_MISMATCH",
                )
            dataset = owned(session, observed_id, "dataset", user)
            if (
                branch_source.get("source_replication_id")
                or branch_source.get("reconciliation_policy", "replace_complete_snapshot")
                != "replace_complete_snapshot"
            ):
                fail(
                    422,
                    "Observed reset needs a complete snapshot, without a replication source",
                    "INCOMPLETE_RESET_SNAPSHOT",
                )
            if date(dataset.data["snapshot_at"]) != date(effective):
                fail(422, "Observed snapshot and cutoff must be the same instant", "SNAPSHOT_TIME_MISMATCH")
            from surge_engine import validate_dataset

            observed_validation = validate_dataset(dataset.data)
            if not observed_validation["valid"]:
                fail(
                    422,
                    "Observed snapshot must be complete and valid",
                    "INCOMPLETE_RESET_SNAPSHOT",
                    observed_validation["errors"],
                )
            import math
            from datetime import timedelta
            from zoneinfo import ZoneInfo

            end = (
                date(parent.get("end_at"))
                if parent.get("end_at")
                else date(parent["start_at"]).astimezone(ZoneInfo(parent["timezone"]))
                + timedelta(days=parent["horizon_calendar_days"])
            )
            remaining = (end - date(effective)).total_seconds() / 86400
            if remaining <= 0:
                fail(422, "Reset time must precede the original horizon end")
            reconciliation = reset_reconciliation(
                session,
                user,
                source_scenario,
                parent,
                parent_revision,
                dataset,
                effective,
                branch_source,
                selected_updates,
            )
            included = set(reconciliation["included_update_ids"])
            retained = [
                x
                for x in selected_updates
                if x["type"] != "census_replacement" and x["update_id"] not in included
            ]
            value.update(
                dataset_version_id=dataset.id,
                start_at=effective,
                end_at=end.astimezone(UTC).isoformat(),
                horizon_calendar_days=max(1, math.ceil(remaining)),
                updates=retained,
            )
            value["reconciliation"] = reconciliation
        else:
            replication_id = branch_source.get("source_replication_id", event.data.get("replication_id"))
            parent_run_id = branch_source.get("parent_run_group_id")
            if not parent_run_id and replication_id:
                parent_run_id = owned(session, replication_id, "replication", user).data["run_group_id"]
            if enqueue and not parent_run_id:
                fail(
                    422,
                    "A completed parent run is required to inherit simulated history",
                    "INVALID_BRANCH_SOURCE",
                )
            strategy = branch_source.get(
                "branch_strategy", "selected_replication" if replication_id else "paired_ensemble"
            )
            if strategy not in {"selected_replication", "paired_ensemble"}:
                fail(422, "Unsupported branch strategy", "INVALID_BRANCH_SOURCE")
            if parent_run_id:
                parent_run = owned_job(session, parent_run_id, user, "run")
                if (
                    parent_run.status != "SUCCEEDED"
                    or parent_run.payload["scenario_id"] != source_scenario.id
                ):
                    fail(
                        422,
                        "Branch source must be a completed run of the parent scenario",
                        "INVALID_BRANCH_SOURCE",
                    )
                if parent_revision and parent_revision.id != parent_run.payload["scenario_revision_id"]:
                    fail(422, "Parent run/revision do not match", "INVALID_BRANCH_SOURCE")
                original = parent_run.payload["scenario"]
                parent_revision = owned(
                    session, parent_run.payload["scenario_revision_id"], "scenario_revision", user
                )
                inherited_updates = [
                    x
                    for x in copy.deepcopy(original.get("updates", []))
                    if x.get("update_id") not in superseded
                ]
                child_metadata = {
                    key: value[key]
                    for key in (
                        "id",
                        "name",
                        "parent_scenario_id",
                        "branch_at",
                        "measurement_start_at",
                        "state_origin",
                    )
                }
                value = {
                    **copy.deepcopy(original),
                    **child_metadata,
                    "parent_scenario_revision_id": parent_revision.id,
                    "updates": inherited_updates + selected_updates,
                }
                from datetime import timedelta
                from zoneinfo import ZoneInfo

                end = (
                    date(original.get("end_at"))
                    if original.get("end_at")
                    else date(original["start_at"]).astimezone(ZoneInfo(original["timezone"]))
                    + timedelta(days=original["horizon_calendar_days"])
                )
                if not date(original["start_at"]) <= date(effective) < end:
                    fail(422, "Branch time lies outside parent run interval", "INVALID_BRANCH_SOURCE")
                value.update(
                    base_seed=original["base_seed"],
                    start_at=original["start_at"],
                    end_at=end.astimezone(UTC).isoformat(),
                    horizon_calendar_days=original["horizon_calendar_days"],
                    parent_run_group_id=parent_run.id,
                    branch_strategy=strategy,
                )
                if strategy == "paired_ensemble" and reps != parent_run.total:
                    fail(
                        422,
                        "Paired branch repetition count must equal parent count",
                        "REPLICATION_COUNT_MISMATCH",
                    )
                if strategy == "selected_replication":
                    if not replication_id:
                        fail(422, "Selected branch requires source_replication_id", "INVALID_BRANCH_SOURCE")
                    replication = owned(session, replication_id, "replication", user)
                    if replication.data["run_group_id"] != parent_run.id:
                        fail(
                            422, "Selected replication does not belong to parent run", "INVALID_BRANCH_SOURCE"
                        )
                    # Deterministic replay reconstructs the exact parent event ledger up to cutoff.
                    value.update(
                        parent_replication_id=replication.id,
                        branch_replication_index=replication.data["replication_index"],
                        conditional_label=f"Conditional on replication {replication.data['replication_index']} at {effective}",
                    )
        value["replications"] = reps
        report = validate_scenario(value, owned(session, value["dataset_version_id"], "dataset", user).data)
        if not report["valid"]:
            fail(422, "Updated scenario is invalid", "validation_failed", report["errors"])
        child = add_document(session, user["workspace_id"], "scenario", value)
        job = enqueue_run(session, user, child, reps) if enqueue else None
        revision = (
            session.get(Document, job.payload["scenario_revision_id"])
            if job
            else freeze(session, user, child)
        )
        for update_id in selected_ids:
            item = owned(session, update_id, "update", user)
            item.data = {
                **item.data,
                "applied_scenario_id": child.id,
                "scenario_revision_id": revision.id,
                "run_group_id": job.id if job else None,
                "applied_at": now(),
            }
        audit(
            session,
            user,
            "update.applied",
            event.id,
            {"child_scenario_id": child.id, "state_origin": origin, "source": branch_source},
        )
        session.commit()
        return {
            "update": serialize(event),
            "scenario": serialize(child),
            "run": job_view(job) if job else None,
            "run_group_id": job.id if job else None,
            "scenario_revision_id": revision.id,
            "input_sha256": revision.data["input_sha256"],
            "lineage": {
                "parent_scenario_id": source_scenario.id,
                "parent_scenario_revision_id": parent_revision.id if parent_revision else None,
            },
            "state_origin": origin,
            "reconciliation": value.get("reconciliation"),
        }

    @router.post("/updates/{identity}/correct", status_code=201)
    def correct_update(identity: str, payload: dict = Body(...), user=Depends(writer), session=Depends(db)):
        original = owned(session, identity, "update", user)
        value = {
            **copy.deepcopy(original.data),
            "id": uid("update"),
            "update_id": uid("event"),
            "payload": payload.get("payload", {}),
            "supersedes_update_id": identity,
            "reason": payload.get("reason", "Correction"),
            "recorded_at": now(),
            "author_id": user["id"],
            "status": "active",
        }
        for field in ["applied_scenario_id", "scenario_revision_id", "run_group_id", "applied_at"]:
            value.pop(field, None)
        check_update(value, session, user)
        row = add_document(session, user["workspace_id"], "update", value)
        audit(session, user, "update.corrected", row.id, {"supersedes_update_id": identity})
        session.commit()
        return serialize(row)

    @router.get("/alert-rules")
    def get_alert_rules(
        limit: int = 50, cursor: str | None = None, user=Depends(current_user), session=Depends(db)
    ):
        return listing([serialize(x) for x in documents(session, user, "alert_rule")], limit, cursor)

    def validate_rule(payload):
        from .alerts import rule_errors

        errors = rule_errors(payload)
        if errors:
            fail(422, "Alert rule validation failed", "validation_failed", errors)

    @router.post("/alert-rules", status_code=201)
    def create_rule(payload: AlertRule = Body(...), user=Depends(writer), session=Depends(db)):
        payload = command_dict(payload)
        validate_rule(payload)
        row = add_document(
            session,
            user["workspace_id"],
            "alert_rule",
            {
                "id": uid("rule"),
                "enabled": True,
                "scope": "hospital",
                "statistic": "p50",
                "operator": "gt",
                **payload,
            },
        )
        audit(session, user, "alert_rule.created", row.id)
        session.commit()
        return serialize(row)

    @router.patch("/alert-rules/{identity}")
    def revise_rule(
        identity: str,
        payload: dict = Body(...),
        match: str | None = Header(default=None, alias="If-Match"),
        user=Depends(writer),
        session=Depends(db),
    ):
        row = owned(session, identity, "alert_rule", user)
        value = {**row.data, **payload}
        validate_rule(value)
        add_document(
            session,
            user["workspace_id"],
            "alert_rule_revision",
            {**row.data, "id": uid("rule_revision"), "rule_id": identity, "rule_revision": row.revision},
        )
        mutate(session, row, value, match)
        audit(session, user, "alert_rule.revised", identity)
        session.commit()
        return serialize(row)

    @router.get("/alerts")
    def get_alerts(
        run_group_id: str | None = None,
        replication_id: str | None = None,
        limit: int = 50,
        cursor: str | None = None,
        user=Depends(current_user),
        session=Depends(db),
    ):
        if not run_group_id:
            return listing([], limit, cursor)
        job, _result = results(session, user, run_group_id)
        from .alerts import evaluate

        try:
            items = evaluate(session, user["workspace_id"], job, replication_id)
        except ValueError as exc:
            fail(422, str(exc))
        session.commit()
        return listing(items, limit, cursor)

    @router.get("/metric-registry")
    def metric_registry(user=Depends(current_user)):
        from .alerts import METRICS

        return {
            "items": [
                {"metric": key, **value, "scope_filters": ["FAC-MAIN"]} for key, value in METRICS.items()
            ]
        }

    @router.post("/alerts/{identity}/acknowledge")
    def acknowledge(identity: str, user=Depends(writer), session=Depends(db)):
        row = owned(session, identity, "alert", user)
        row.data = {**row.data, "acknowledged": True, "acknowledged_by": user["id"], "acknowledged_at": now()}
        audit(session, user, "alert.acknowledged", identity)
        session.commit()
        return serialize(row)

    @router.post("/exports", status_code=202)
    def create_export(
        payload: ExportCreate = Body(...),
        key: str | None = Header(default=None, alias="Idempotency-Key"),
        user=Depends(current_user),
        session=Depends(db),
    ):
        payload = command_dict(payload)
        previous = idempotent(session, user, "exports", key, payload)
        if previous:
            return export_view(owned_job(session, previous, user, "export"))
        if payload.get("format", "zip") not in {"zip", "json", "csv"}:
            fail(422, "Export format must be zip, json or csv")
        comparison = None
        if payload.get("comparison_id"):
            comparison = comparison_value(
                owned(session, payload["comparison_id"], "comparison", user), session, user
            )
            if comparison["status"] != "SUCCEEDED":
                fail(409, "Comparison must finish before export")
        if payload.get("run_group_id"):
            owned_job(session, payload["run_group_id"], user, "run")
        elif comparison:
            pass
        elif payload.get("dataset_version_id"):
            owned(session, payload["dataset_version_id"], "dataset", user)
        elif payload.get("scenario_id"):
            owned(session, payload["scenario_id"], "scenario", user)
        else:
            fail(422, "An immutable run, dataset or scenario context is required")
        value = copy.deepcopy(payload)
        if comparison:
            requested = payload.get("plan_id")
            plan = next((p for p in comparison["plans"] if p["id"] == requested), None) if requested else None
            if requested and plan is None:
                fail(404, "Comparison plan not found")
            explicit_run = payload.get("run_group_id")
            if requested and explicit_run and plan["run_group_id"] != explicit_run:
                fail(422, "Selected comparison plan and explicit export run do not match")
            if explicit_run:
                selected_run = owned_job(session, explicit_run, user, "run")
                if not any(p.get("run_group_id") == explicit_run for p in comparison["plans"]):
                    source = comparison.get("source_scenario_snapshot", {})
                    frozen = selected_run.payload["scenario"]
                    fields = (
                        "dataset_version_id",
                        "start_at",
                        "end_at",
                        "horizon_calendar_days",
                        "timezone",
                        "base_seed",
                        "conditions",
                        "interventions",
                        "updates",
                    )
                    mismatch = [field for field in fields if frozen.get(field) != source.get(field)]
                    if mismatch:
                        fail(
                            422,
                            "Comparison and selected run use different planning inputs",
                            "context_mismatch",
                            [
                                {
                                    "field": field,
                                    "message": "Select a matching immutable baseline or comparison plan",
                                }
                                for field in mismatch
                            ],
                        )
            else:
                plan = plan or next(p for p in comparison["plans"] if p.get("reference"))
                value["run_group_id"] = plan["run_group_id"]
            value["comparison_snapshot"] = {
                "id": comparison["id"],
                "scenario_id": comparison["scenario_id"],
                "plans": [],
            }
            for candidate in comparison["plans"]:
                metrics = candidate.get("metrics", {}).get("scalar_metrics", {})
                value["comparison_snapshot"]["plans"].append(
                    {
                        "plan_id": candidate["id"],
                        "name": candidate["name"],
                        "status": candidate["status"],
                        "rank": candidate.get("rank"),
                        "feasibility": candidate["feasibility"],
                        "inpatient_waiting_patient_hours": metrics.get("inpatient_waiting_patient_hours"),
                        "peak_inpatient_queue": metrics.get("peak_inpatient_queue"),
                        "improvement": candidate.get("improvement"),
                    }
                )
        if value.get("run_group_id"):
            selected_run = owned_job(session, value["run_group_id"], user, "run")
            value["scenario_revision_id"] = selected_run.payload["scenario_revision_id"]
        elif payload.get("scenario_id"):
            revision = freeze(session, user, owned(session, payload["scenario_id"], "scenario", user))
            value["scenario_revision_id"] = revision.id
        if "include_events" in value and not isinstance(value["include_events"], bool):
            fail(422, "include_events must be a boolean")
        if value.get("replication_id"):
            replication = owned(session, value["replication_id"], "replication", user)
            if replication.data.get("run_group_id") != value.get("run_group_id"):
                fail(422, "Export replication must belong to the selected run")
        enforce_job_quota(session, user)
        row = Job(
            id=uid("export"),
            workspace_id=user["workspace_id"],
            kind="export",
            payload=value,
            total=1,
            result={},
        )
        session.add(row)
        remember(session, user, "exports", key, payload, row.id)
        audit(session, user, "export.queued", row.id)
        session.commit()
        return export_view(row)

    def export_view(row):
        return {
            **job_view(row),
            "download_url": f"/api/exports/{row.id}/download"
            if row.status == "SUCCEEDED" and not row.result.get("expired_at")
            else None,
            "artifact": row.result.get("artifact"),
            "expired": bool(row.result.get("expired_at")),
            "expired_at": row.result.get("expired_at"),
            "regenerate_url": f"/api/exports/{row.id}/regenerate" if row.result.get("expired_at") else None,
        }

    @router.get("/exports/{identity}")
    def get_export(identity: str, user=Depends(current_user), session=Depends(db)):
        return export_view(owned_job(session, identity, user, "export"))

    @router.get("/exports/{identity}/download")
    def download_export(identity: str, user=Depends(current_user), session=Depends(db)):
        row = owned_job(session, identity, user, "export")
        if row.result.get("expired_at"):
            fail(
                410,
                "Export expired under workspace retention; regenerate from its preserved inputs",
                "artifact_expired",
                [{"regenerate_url": f"/api/exports/{identity}/regenerate"}],
            )
        if row.status != "SUCCEEDED":
            fail(409, "Export is not ready")
        metadata = row.result["artifact"]
        audit(session, user, "export.downloaded", row.id)
        session.commit()
        return Response(
            ArtifactStore().read(metadata),
            media_type=metadata["media_type"],
            headers={"Content-Disposition": f'attachment; filename="{metadata["name"]}"'},
        )

    @router.post("/exports/{identity}/regenerate", status_code=202)
    def regenerate_export(identity: str, user=Depends(current_user), session=Depends(db)):
        original = owned_job(session, identity, user, "export")
        enforce_job_quota(session, user)
        row = Job(
            id=uid("export"),
            workspace_id=user["workspace_id"],
            kind="export",
            payload={**copy.deepcopy(original.payload), "regenerated_from": identity},
            total=1,
            result={},
        )
        session.add(row)
        audit(session, user, "export.regenerated", row.id, {"original_export_id": identity})
        session.commit()
        return export_view(row)

    @router.get("/workspaces/{identity}/execution-metrics")
    def execution_metrics(identity: str, user=Depends(admin), session=Depends(db)):
        from .observability import metrics_snapshot

        workspace_access(identity, user)
        counts = session.execute(
            select(Job.kind, Job.status, func.count())
            .where(Job.workspace_id == identity)
            .group_by(Job.kind, Job.status)
        ).all()
        recent = session.scalars(
            select(Job).where(Job.workspace_id == identity).order_by(Job.created_at.desc()).limit(100)
        )
        return {
            "request_process": metrics_snapshot(),
            "jobs": [{"kind": kind, "status": status, "count": count} for kind, status, count in counts],
            "recent_jobs": [
                {
                    "id": job.id,
                    "kind": job.kind,
                    "status": job.status,
                    "completed": job.completed,
                    "total": job.total,
                    "created_at": job.created_at,
                    "completed_at": job.completed_at,
                    "execution_metrics": job.result.get("execution_metrics"),
                }
                for job in recent
            ],
            "scope": "current workspace jobs; request metrics for this API process only",
        }

    @router.post("/workspaces/{identity}/retention")
    def retention_operation(
        identity: str, payload: dict = Body(default={}), user=Depends(admin), session=Depends(db)
    ):
        from .retention import cleanup

        workspace_access(identity, user)
        if (
            set(payload) - {"apply", "limit"}
            or not isinstance(payload.get("apply", False), bool)
            or not isinstance(payload.get("limit", 100), int)
            or not 1 <= payload.get("limit", 100) <= 1000
        ):
            fail(422, "Supply apply boolean and limit integer from1 to1000")
        return cleanup(
            Session, apply=payload.get("apply", False), limit=payload.get("limit", 100), workspace_id=identity
        )

    @router.get("/audit-events")
    def audits(limit: int = 50, cursor: str | None = None, user=Depends(admin), session=Depends(db)):
        try:
            offset = max(0, int(cursor or 0))
        except ValueError:
            fail(422, "Invalid cursor")
        limit = max(1, min(limit, 200))
        total = session.scalar(
            select(func.count())
            .select_from(AuditEvent)
            .where(AuditEvent.workspace_id == user["workspace_id"])
        )
        rows = session.scalars(
            select(AuditEvent)
            .where(AuditEvent.workspace_id == user["workspace_id"])
            .order_by(AuditEvent.created_at.desc(), AuditEvent.id)
            .offset(offset)
            .limit(limit)
        )
        return {
            "items": [
                {
                    "id": x.id,
                    "action": x.action,
                    "entity_id": x.entity_id,
                    "user_id": x.user_id,
                    "details": x.details,
                    "created_at": x.created_at,
                }
                for x in rows
            ],
            "total": total,
            "next_cursor": str(offset + limit) if offset + limit < total else None,
        }

    app.include_router(router, prefix="/api")
    app.include_router(router, prefix="/api/v1", include_in_schema=False)

    @app.get("/api/openapi.json", include_in_schema=False)
    def api_schema():
        return app.openapi()

    from .observability import install_observability

    install_observability(app)
    return app


app = create_app()
