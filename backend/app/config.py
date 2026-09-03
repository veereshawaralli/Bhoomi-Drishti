"""Runtime configuration.

Everything has a working default, so `uvicorn app.main:app` starts with no
`.env` file at all and lands in DEMO mode on a local SQLite file. Copy
`.env.example` to `.env` to change any of it.

Two settings decide what the platform claims about its own data, and they are
surfaced in every API response and on every screen:

* ``use_live_weather`` - false means weather comes from the deterministic
  physical model in ``ml/hydrology.py`` and is labelled DEMO. True means it is
  fetched from a public forecast API and is labelled LIVE. If a live fetch
  fails the service falls back to DEMO and says so; it never silently presents
  modelled numbers as observations.
* ``model_path`` - where the trained ensemble lives. If it is missing the API
  serves the documented physics model and labels the backend
  ``physics-fallback`` rather than pretending a model is loaded.
"""
from __future__ import annotations

import sys
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/app/config.py -> backend/app -> backend -> repository root
APP_DIR = Path(__file__).resolve().parent
BACKEND_DIR = APP_DIR.parent
REPO_ROOT = BACKEND_DIR.parent


def ensure_ml_importable() -> None:
    """Put the repository root on ``sys.path`` so ``import ml`` works.

    The ML package deliberately lives outside the backend so it can be trained,
    tested and shipped independently (and so a future deployment can move it
    behind its own service without touching the API code). Adding the root
    here is what lets the backend import it in place during development.
    """
    root = str(REPO_ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)


class Settings(BaseSettings):
    """Environment-driven settings, read once and cached."""

    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
        protected_namespaces=(),  # we legitimately use `model_path`
    )

    # --- identity ----------------------------------------------------------
    app_name: str = "Bhoomi-Drishti"
    app_version: str = "1.0.0"

    # --- database ----------------------------------------------------------
    # SQLite by default: no server, no setup, works on a bare laptop.
    database_url: str = "sqlite:///./landslide.db"
    sql_echo: bool = False

    # --- weather -----------------------------------------------------------
    use_live_weather: bool = False
    weather_provider: str = "open-meteo"
    weather_api_base: str = "https://api.open-meteo.com/v1/forecast"
    weather_timeout_seconds: float = 8.0

    # --- machine learning --------------------------------------------------
    model_path: str = "../ml/model.pkl"

    # --- authentication ----------------------------------------------------
    jwt_secret: str = "bhoomi-drishti-demo-secret-change-me"
    jwt_expiry_minutes: int = 720
    seed_demo_users: bool = True

    # --- early-warning thresholds -----------------------------------------
    # The specification's bands: below 60 no major alert, 60-80 HIGH,
    # above 80 CRITICAL.
    alert_high_threshold: float = 60.0
    alert_critical_threshold: float = 80.0

    # --- server ------------------------------------------------------------
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    log_level: str = "INFO"

    # --- demo behaviour ----------------------------------------------------
    # How often the UI is told to re-poll. Also how long a computed risk
    # snapshot stays fresh before the risk engine recomputes it.
    refresh_seconds: int = 60
    upload_dir: str = "uploads"
    max_upload_mb: float = 8.0

    # Regions scored on a full risk-map refresh. All 74 fit comfortably; the
    # cap exists so a much larger production region table cannot accidentally
    # turn one dashboard load into a hundred thousand inferences.
    max_map_regions: int = Field(default=500, ge=1)

    @field_validator("log_level")
    @classmethod
    def _upper(cls, value: str) -> str:
        return value.upper()

    # --- derived -----------------------------------------------------------
    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")

    @property
    def resolved_model_path(self) -> Path:
        """Absolute path to model.pkl, tolerant of where uvicorn was started.

        A relative ``MODEL_PATH`` is interpreted against the backend directory
        (matching ``.env.example``'s ``../ml/model.pkl``), then against the
        repository root, then against the process working directory. The first
        one that exists wins; if none do, the backend runs on the physics
        fallback and says so.
        """
        raw = Path(self.model_path).expanduser()
        if raw.is_absolute():
            return raw
        for base in (BACKEND_DIR, REPO_ROOT, Path.cwd()):
            candidate = (base / raw).resolve()
            if candidate.exists():
                return candidate
        return (BACKEND_DIR / raw).resolve()

    @property
    def resolved_upload_dir(self) -> Path:
        raw = Path(self.upload_dir).expanduser()
        return raw if raw.is_absolute() else (BACKEND_DIR / raw).resolve()

    @property
    def weather_mode(self) -> str:
        """The data_mode label weather rows get when everything works."""
        return "LIVE" if self.use_live_weather else "DEMO"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
