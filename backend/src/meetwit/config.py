"""Runtime configuration loaded from environment + sensible macOS defaults."""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_data_dir() -> Path:
    """Return ``~/Library/Application Support/Meetwit``.

    Created lazily by callers when they actually need to write into it.
    """
    return Path.home() / "Library" / "Application Support" / "Meetwit"


class Settings(BaseSettings):
    """Sidecar settings — env vars take precedence, prefixed with ``MEETWIT_``."""

    model_config = SettingsConfigDict(
        env_prefix="MEETWIT_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    host: str = "127.0.0.1"
    port: int = 5167
    log_level: str = "info"

    data_dir: Path = Field(default_factory=_default_data_dir)
    ollama_url: str = "http://127.0.0.1:11434"

    # Calendar integration (ADR-0004). Public OAuth "Desktop app" client id —
    # NOT a secret (PKCE replaces the client secret for public clients). The
    # Rust core reads the same env var directly to run the OAuth flow; this is
    # mirrored here so the sidecar can report whether calendar is configured.
    # Env: MEETWIT_GOOGLE_OAUTH_CLIENT_ID.
    google_oauth_client_id: str | None = None

    @property
    def db_path(self) -> Path:
        return self.data_dir / "meetwit.sqlite"

    @property
    def audio_dir(self) -> Path:
        return self.data_dir / "audio"

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"


def get_settings() -> Settings:
    """Return a fresh ``Settings`` instance. Cheap; do not memoize."""
    return Settings()
