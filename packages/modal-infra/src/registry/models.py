"""Data models for repository and snapshot registry."""

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class SnapshotStatus(StrEnum):
    """Status of a snapshot."""

    BUILDING = "building"
    READY = "ready"
    FAILED = "failed"
    EXPIRED = "expired"


class Repository(BaseModel):
    """Repository configuration for image building."""

    owner: str
    name: str
    default_branch: str = "main"
    # Build configuration
    setup_commands: list[str] = []
    build_commands: list[str] = []
    # Optional: specific paths to warm cache
    cache_paths: list[str] = []
    # Build frequency override (default 30 min)
    build_interval_minutes: int = Field(default=30, ge=0)


class Snapshot(BaseModel):
    """Snapshot metadata."""

    id: str
    repo_owner: str
    repo_name: str
    base_sha: str
    status: SnapshotStatus
    created_at: datetime
    expires_at: datetime | None = None
    # Build metadata
    build_duration_seconds: float | None = Field(default=None, ge=0)
    error_message: str | None = None


class SnapshotMetadata(BaseModel):
    """Metadata stored with a snapshot."""

    snapshot_id: str
    repo_owner: str
    repo_name: str
    base_sha: str
    base_branch: str
    build_timestamp: datetime
    # Environment info
    node_version: str | None = None
    python_version: str | None = None
    # Dependency info
    package_manager: str | None = None  # npm, pnpm, yarn
    dependency_hash: str | None = None  # Hash of lock file
