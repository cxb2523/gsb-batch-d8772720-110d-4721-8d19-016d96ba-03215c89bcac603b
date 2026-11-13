import uuid
from datetime import datetime
from sqlalchemy import String, Boolean, Text, Integer, ForeignKey, DateTime, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base

class AdapterFetchAttempt(Base):
    """One record per adapter tried during a single fetch run.

    A fetch run walks the platform's adapters by priority until one succeeds;
    each try (success or failure) is logged here and linked to the summary
    AdapterHealthLog written at the end of the run.
    """
    __tablename__ = "adapter_fetch_attempts"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    health_log_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("adapter_health_logs.id", ondelete="CASCADE"))
    source_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sources.id", ondelete="CASCADE"))
    sequence: Mapped[int] = mapped_column(Integer)
    adapter_type: Mapped[str] = mapped_column(String(50))
    success: Mapped[bool] = mapped_column(Boolean)
    error_message: Mapped[str | None] = mapped_column(Text)
    duration_ms: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
