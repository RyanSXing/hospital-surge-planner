"""Initial operational documents, jobs, sessions, audit, idempotency schema."""
from alembic import context, op
import sqlalchemy as sa

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    tables = {
        "documents": [sa.Column("id", sa.String(96), primary_key=True), sa.Column("workspace_id", sa.String(96), nullable=False, index=True), sa.Column("kind", sa.String(40), nullable=False, index=True), sa.Column("revision", sa.Integer(), nullable=False), sa.Column("data", sa.JSON(), nullable=False), sa.Column("created_at", sa.String(40), nullable=False, index=True), sa.Column("updated_at", sa.String(40), nullable=False)],
        "jobs": [sa.Column("id", sa.String(96), primary_key=True), sa.Column("workspace_id", sa.String(96), nullable=False, index=True), sa.Column("kind", sa.String(40), nullable=False), sa.Column("status", sa.String(32), nullable=False, index=True), sa.Column("payload", sa.JSON(), nullable=False), sa.Column("result", sa.JSON(), nullable=False), sa.Column("completed", sa.Integer(), nullable=False), sa.Column("total", sa.Integer(), nullable=False), sa.Column("cancelled", sa.Boolean(), nullable=False), sa.Column("dispatched", sa.Boolean(), nullable=False), sa.Column("lease_until", sa.Float(), nullable=False), sa.Column("attempts", sa.Integer(), nullable=False), sa.Column("error", sa.Text(), nullable=True), sa.Column("created_at", sa.String(40), nullable=False, index=True), sa.Column("completed_at", sa.String(40), nullable=True)],
        "login_sessions": [sa.Column("token_hash", sa.String(64), primary_key=True), sa.Column("user_id", sa.String(96), nullable=False), sa.Column("workspace_id", sa.String(96), nullable=False), sa.Column("role", sa.String(24), nullable=False), sa.Column("expires_at", sa.Float(), nullable=False)],
        "audit_events": [sa.Column("id", sa.String(96), primary_key=True), sa.Column("workspace_id", sa.String(96), nullable=False, index=True), sa.Column("user_id", sa.String(96), nullable=False), sa.Column("action", sa.String(96), nullable=False), sa.Column("entity_id", sa.String(96), nullable=False), sa.Column("details", sa.JSON(), nullable=False), sa.Column("created_at", sa.String(40), nullable=False, index=True)],
        "idempotency_keys": [sa.Column("id", sa.String(96), primary_key=True), sa.Column("workspace_id", sa.String(96), nullable=False), sa.Column("operation", sa.String(128), nullable=False), sa.Column("key", sa.String(256), nullable=False), sa.Column("request_hash", sa.String(64), nullable=False), sa.Column("entity_id", sa.String(96), nullable=False), sa.UniqueConstraint("workspace_id", "operation", "key")],
    }
    existing = set() if context.is_offline_mode() else set(sa.inspect(op.get_bind()).get_table_names())
    for name, columns in tables.items():
        if name not in existing:
            op.create_table(name, *columns)


def downgrade():
    for name in ("idempotency_keys", "audit_events", "login_sessions", "jobs", "documents"):
        op.drop_table(name)
