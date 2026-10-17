from __future__ import annotations

import hashlib
import json
import os
import uuid
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import JSON, Boolean, Float, Integer, String, Text, UniqueConstraint, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker


def now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def uid(prefix="id") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:20]}"


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(value) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


class Base(DeclarativeBase):
    pass


class Document(Base):
    """Versioned domain documents. Committed datasets/revisions are append-only."""

    __tablename__ = "documents"
    id: Mapped[str] = mapped_column(String(96), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(96), index=True)
    kind: Mapped[str] = mapped_column(String(40), index=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    data: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[str] = mapped_column(String(40), default=now, index=True)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[str] = mapped_column(String(96), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(96), index=True)
    kind: Mapped[str] = mapped_column(String(40), default="run")
    status: Mapped[str] = mapped_column(String(32), default="QUEUED", index=True)
    payload: Mapped[dict] = mapped_column(JSON)
    result: Mapped[dict] = mapped_column(JSON, default=dict)
    completed: Mapped[int] = mapped_column(Integer, default=0)
    total: Mapped[int] = mapped_column(Integer, default=0)
    cancelled: Mapped[bool] = mapped_column(Boolean, default=False)
    dispatched: Mapped[bool] = mapped_column(Boolean, default=False)
    lease_until: Mapped[float] = mapped_column(Float, default=0)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str] = mapped_column(String(40), default=now, index=True)
    completed_at: Mapped[str | None] = mapped_column(String(40), nullable=True)


class LoginSession(Base):
    __tablename__ = "login_sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(96))
    workspace_id: Mapped[str] = mapped_column(String(96))
    role: Mapped[str] = mapped_column(String(24))
    expires_at: Mapped[float] = mapped_column(Float)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[str] = mapped_column(String(96), primary_key=True, default=lambda: uid("audit"))
    workspace_id: Mapped[str] = mapped_column(String(96), index=True)
    user_id: Mapped[str] = mapped_column(String(96))
    action: Mapped[str] = mapped_column(String(96))
    entity_id: Mapped[str] = mapped_column(String(96))
    details: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[str] = mapped_column(String(40), default=now, index=True)


class Idempotency(Base):
    __tablename__ = "idempotency_keys"
    __table_args__ = (UniqueConstraint("workspace_id", "operation", "key"),)
    id: Mapped[str] = mapped_column(String(96), primary_key=True, default=lambda: uid("idem"))
    workspace_id: Mapped[str] = mapped_column(String(96))
    operation: Mapped[str] = mapped_column(String(128))
    key: Mapped[str] = mapped_column(String(256))
    request_hash: Mapped[str] = mapped_column(String(64))
    entity_id: Mapped[str] = mapped_column(String(96))


def make_database(url=None):
    url = url or os.environ.get("DATABASE_URL", "sqlite:///data/hospital.db")
    if url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    if url.startswith("sqlite:///") and ":memory:" not in url:
        Path(url.removeprefix("sqlite:///")).parent.mkdir(parents=True, exist_ok=True)
    options = {"check_same_thread": False, "timeout": 30} if url.startswith("sqlite") else {}
    from sqlalchemy.pool import StaticPool

    extra = {"poolclass": StaticPool} if ":memory:" in url else {}
    engine = create_engine(url, connect_args=options, pool_pre_ping=True, **extra)
    if url.startswith("sqlite"):

        @event.listens_for(engine, "connect")
        def sqlite_pragmas(connection, _):
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA journal_mode=WAL")

    if os.getenv("APP_ENV", "development") not in {"production", "staging"}:
        Base.metadata.create_all(engine)
    return engine, sessionmaker(engine, expire_on_commit=False)
