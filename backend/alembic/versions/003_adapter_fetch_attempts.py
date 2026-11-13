"""per-adapter fetch attempt records

A fetch run tries a platform's adapters in priority order until one
succeeds, but previously only the final outcome was logged — intermediate
failures were silently swallowed. This table stores one row per attempted
adapter (type, success, error, duration, order) linked to the summary
adapter_health_logs row written at the end of the run.

Revision ID: 003
Revises: 002
Create Date: 2026-11-14
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "003"
down_revision = "002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "adapter_fetch_attempts",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("health_log_id", UUID(as_uuid=True), sa.ForeignKey("adapter_health_logs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source_id", UUID(as_uuid=True), sa.ForeignKey("sources.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sequence", sa.Integer, nullable=False),
        sa.Column("adapter_type", sa.String(50), nullable=False),
        sa.Column("success", sa.Boolean, nullable=False),
        sa.Column("error_message", sa.Text),
        sa.Column("duration_ms", sa.Integer, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_fetch_attempts_health_log", "adapter_fetch_attempts", ["health_log_id", "sequence"])
    op.create_index("ix_fetch_attempts_source_created", "adapter_fetch_attempts", ["source_id", "created_at"])


def downgrade() -> None:
    op.drop_table("adapter_fetch_attempts")
