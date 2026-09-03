"""Engine, session factory and the FastAPI database dependency.

The same ORM models run on two backends:

* **SQLite** (default) - one file, no server, `pip install -r requirements.txt`
  and go. This is what a judge or a reviewer gets with zero setup.
* **PostgreSQL + PostGIS** (docker-compose) - the production shape, where
  `database/schema.sql` has already created the tables *including* generated
  `geography(Point, 4326)` columns and GIST indexes.

The ORM deliberately does not map those `geom` columns. They are
``GENERATED ALWAYS AS ... STORED`` in PostgreSQL, so the database maintains
them from `latitude`/`longitude` and any attempt to write them would be
rejected. Leaving them unmapped is what lets one set of models serve both
backends: on PostGIS the spatial columns exist and are usable from SQL, and on
SQLite they simply are not there.
"""
from __future__ import annotations

import logging
from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .config import BACKEND_DIR, settings
from .models import Base

LOG = logging.getLogger("app.database")


def _sqlite_file(url: str) -> Path | None:
    """Absolute path behind a sqlite URL, or None for in-memory databases."""
    tail = url.split("///", 1)[-1] if "///" in url else ""
    if not tail or tail == ":memory:":
        return None
    path = Path(tail).expanduser()
    return path if path.is_absolute() else (BACKEND_DIR / path).resolve()


def _build_engine() -> Engine:
    url = settings.database_url
    if settings.is_sqlite:
        target = _sqlite_file(url)
        if target is not None:
            target.parent.mkdir(parents=True, exist_ok=True)
            url = f"sqlite:///{target.as_posix()}"
        # check_same_thread=False: FastAPI serves requests on a thread pool and
        # each one opens its own session, so the default single-thread guard
        # would reject perfectly safe usage.
        return create_engine(
            url,
            echo=settings.sql_echo,
            future=True,
            connect_args={"check_same_thread": False},
        )
    return create_engine(
        url,
        echo=settings.sql_echo,
        future=True,
        pool_pre_ping=True,  # survive a database restart without 500s
        pool_size=10,
        max_overflow=20,
    )


engine = _build_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


@event.listens_for(Engine, "connect")
def _sqlite_pragmas(dbapi_connection, connection_record) -> None:
    """Turn on the SQLite behaviour the schema actually assumes.

    Foreign keys are off by default in SQLite, which would silently skip every
    ``ON DELETE CASCADE`` in the schema. WAL keeps reads from blocking behind
    the background risk refresh.
    """
    if type(dbapi_connection).__module__.split(".")[0] != "sqlite3":
        return
    cursor = dbapi_connection.cursor()
    try:
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
    finally:
        cursor.close()


def init_db() -> None:
    """Create any missing tables.

    ``checkfirst`` is the default, so on the docker-compose stack - where
    ``database/schema.sql`` already ran inside the PostGIS image - this is a
    no-op and the richer SQL definitions (generated geometry columns, CHECK
    constraints, GIST indexes) are left exactly as they were.
    """
    Base.metadata.create_all(bind=engine)
    LOG.info(
        "database ready: %s (%d tables)",
        engine.url.render_as_string(hide_password=True),
        len(Base.metadata.tables),
    )


def healthcheck() -> dict[str, object]:
    """Cheap liveness probe used by /api/health."""
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return {"connected": True, "dialect": engine.dialect.name}
    except Exception as exc:  # pragma: no cover - only on a broken database
        LOG.error("database healthcheck failed: %s", exc)
        return {"connected": False, "dialect": engine.dialect.name, "error": str(exc)}


def get_db() -> Iterator[Session]:
    """FastAPI dependency: one session per request, always closed."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def session_scope() -> Session:
    """A session for background work (seeding, scheduled refresh)."""
    return SessionLocal()
