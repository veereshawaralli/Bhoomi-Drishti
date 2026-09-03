"""The FastAPI application.

Assembles the app, wires CORS, request logging and exception handling, mounts
the uploads directory, and prepares the database on start-up. All routing lives
in ``app.routers``; this module only decides how the application behaves around
those routes.

Start-up does three things, in order, and none of them is allowed to take the
API down:

1. ``init_db()`` creates any missing tables. On the PostGIS stack the richer
   SQL schema has already run, so this is a no-op and the generated geometry
   columns are left alone.
2. ``seed_all()`` fills an empty database with regions, terrain, users and the
   landslide inventory. It is idempotent - an existing database is left as it
   is, so a restart never duplicates rows or resets an officer's work.
3. A first scoring pass warms the prediction cache, so the first dashboard load
   of a demo does not pay for 74 model evaluations while a judge watches.

If any of that fails the API still starts and ``/api/health`` reports what is
wrong. An early-warning platform that refuses to boot because seeding failed is
less useful than one that boots and tells you why it is degraded.
"""
from __future__ import annotations

import logging
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Callable

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import SQLAlchemyError
from starlette.exceptions import HTTPException as StarletteHTTPException

from .config import settings
from .database import init_db, session_scope
from .routers import api_router
from .security import warn_on_default_secret

logging.basicConfig(
    level=getattr(logging, settings.log_level, logging.INFO),
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
# SQLAlchemy's own INFO logging echoes every statement; the app's SQL_ECHO
# setting is the intended way to turn that on.
logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)

LOG = logging.getLogger("app")

DESCRIPTION = """
Landslide early warning for Indian hill districts.

**Predict. Explain. Warn. Respond.**

A risk score is produced in exactly one place - `app.services.risk_engine` -
so the number on the map, in the region panel, on the forecast curve, in the
what-if simulator and on an alert all mean the same thing.

Every value carries its provenance. `data_mode` is stamped where the value is
produced, not guessed at the edge:

* **LIVE** - fetched from a public forecast API.
* **DEMO** - produced by the documented physical model in `ml/hydrology.py`.
* **SIMULATED** - a scenario, a what-if, or the virtual sensor network.

The model was trained on synthetic labels drawn from a documented
slope-stability model. `GET /api/model-info` says so, along with what the
metrics do and do not prove. This is a demonstration platform, not an
operational forecasting service.
"""


def _warm_up() -> None:
    """Prepare the database and warm the prediction cache. Never raises."""
    try:
        init_db()
    except Exception as exc:  # pragma: no cover - depends on the environment
        LOG.error("init_db failed (%s) - /api/health will report the details", exc)
        return

    db = session_scope()
    try:
        try:
            from .seed import seed_all

            counts = seed_all(db)
            db.commit()
            if any(counts.values()):
                LOG.info("seeded: %s", counts)
            else:
                LOG.info("database already populated - nothing seeded")
        except Exception as exc:  # pragma: no cover - environment dependent
            db.rollback()
            LOG.error("seeding failed (%s) - the API is up but may be empty", exc)

        try:
            from .services import risk_engine

            regions = risk_engine.regions_query(db)
            if regions:
                scored = risk_engine.score_regions(regions)
                LOG.info(
                    "warm-up: %d regions scored on the %s backend",
                    len(scored),
                    risk_engine.model_status()["backend"],
                )
        except Exception as exc:  # pragma: no cover
            LOG.warning("warm-up scoring skipped (%s)", exc)
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    LOG.info(
        "%s %s starting - database=%s, weather=%s, model=%s",
        settings.app_name,
        settings.app_version,
        "sqlite" if settings.is_sqlite else "postgresql",
        "LIVE" if settings.use_live_weather else "DEMO",
        settings.resolved_model_path.name,
    )
    warn_on_default_secret()
    _warm_up()
    yield
    LOG.info("%s shutting down", settings.app_name)


app = FastAPI(
    title=f"{settings.app_name} API",
    version=settings.app_version,
    description=DESCRIPTION,
    summary="AI landslide early-warning and risk monitoring",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)

# The frontend runs on a different port in development, so the browser needs
# permission to talk to this origin. Origins are listed explicitly rather than
# using a wildcard: `allow_credentials` with `*` is rejected by browsers, and a
# wildcard would let any page on the machine drive an officer's session.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID", "X-Response-Time-Ms"],
)


@app.middleware("http")
async def request_context(request: Request, call_next: Callable) -> Any:
    """Tag every request, time it, and log the ones that matter.

    A request id on the response lets a screenshot of a failed action be traced
    to the exact line in the server log. Successful polling requests are logged
    at DEBUG so a running demo does not bury the interesting lines; anything
    slow or failing is logged at INFO or WARNING.
    """
    request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
    started = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        elapsed = (time.perf_counter() - started) * 1000.0
        LOG.exception(
            "%s %s failed after %.0f ms [%s]",
            request.method, request.url.path, elapsed, request_id,
        )
        raise

    elapsed = (time.perf_counter() - started) * 1000.0
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Response-Time-Ms"] = f"{elapsed:.0f}"

    line = "%s %s -> %d in %.0f ms [%s]"
    args = (request.method, request.url.path, response.status_code, elapsed, request_id)
    if response.status_code >= 500:
        LOG.error(line, *args)
    elif response.status_code >= 400 or elapsed > 1500:
        LOG.warning(line, *args)
    else:
        LOG.debug(line, *args)
    return response


# --------------------------------------------------------------- error shapes

def _problem(
    request: Request, code: int, message: str, **extra: Any
) -> JSONResponse:
    """One error shape for the whole API.

    The frontend has a single error path because every failure looks the same:
    a status, a human-readable message, and the path it came from. A UI that has
    to guess at five different error shapes ends up showing "[object Object]".
    """
    body: dict[str, Any] = {
        "error": True,
        "status": code,
        "message": message,
        "path": request.url.path,
    }
    body.update(extra)
    return JSONResponse(status_code=code, content=body)


@app.exception_handler(StarletteHTTPException)
async def http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    detail = exc.detail if isinstance(exc.detail, str) else "Request failed."
    return _problem(
        request,
        exc.status_code,
        detail,
        **({"detail": exc.detail} if not isinstance(exc.detail, str) else {}),
    )


@app.exception_handler(RequestValidationError)
async def validation_error(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """Turn Pydantic's field errors into something a form can display.

    ``fields`` maps a field name to its message, which is what an input needs to
    render an error beside itself. The raw error list is kept in ``detail`` for
    anyone debugging against the API directly.
    """
    fields: dict[str, str] = {}
    for error in exc.errors():
        location = [str(part) for part in error.get("loc", []) if part not in ("body", "query")]
        fields[".".join(location) or "request"] = str(error.get("msg", "invalid"))
    first = next(iter(fields.items()), ("request", "invalid"))
    return _problem(
        request,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        f"{first[0]}: {first[1]}",
        fields=fields,
        detail=exc.errors(),
    )


@app.exception_handler(ValueError)
async def value_error(request: Request, exc: ValueError) -> JSONResponse:
    """A rejected domain rule, not a server fault.

    The services raise ``ValueError`` for things a caller can fix - an illegal
    alert transition, an unknown sensor condition, an oversized upload. Those
    are 400s, not 500s, and the message is written to be shown to a user.
    """
    LOG.info("rejected %s %s: %s", request.method, request.url.path, exc)
    return _problem(request, status.HTTP_400_BAD_REQUEST, str(exc) or "Invalid request.")


@app.exception_handler(KeyError)
async def key_error(request: Request, exc: KeyError) -> JSONResponse:
    """An unknown named thing - a scenario, a sensor type, a band."""
    LOG.info("unknown key on %s %s: %s", request.method, request.url.path, exc)
    return _problem(
        request, status.HTTP_400_BAD_REQUEST, f"Unknown value: {exc.args[0] if exc.args else exc}."
    )


@app.exception_handler(SQLAlchemyError)
async def database_error(request: Request, exc: SQLAlchemyError) -> JSONResponse:
    """A database failure, reported without leaking the query or credentials."""
    LOG.exception("database error on %s %s", request.method, request.url.path)
    return _problem(
        request,
        status.HTTP_503_SERVICE_UNAVAILABLE,
        "The database is not available. Check the server log and /api/health.",
    )


@app.exception_handler(Exception)
async def unhandled_error(request: Request, exc: Exception) -> JSONResponse:
    """Last resort. Logged with a traceback, reported without internals."""
    LOG.exception("unhandled error on %s %s", request.method, request.url.path)
    return _problem(
        request,
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        "Something went wrong on the server. The details are in the server log.",
    )


# ------------------------------------------------------------------- routes

app.include_router(api_router)

# Uploaded report photographs, served read-only so the officer dashboard can
# show the image a citizen attached. Created eagerly because StaticFiles
# refuses to mount a directory that does not exist, and an empty uploads
# directory on a fresh clone is the normal case.
settings.resolved_upload_dir.mkdir(parents=True, exist_ok=True)
app.mount(
    "/uploads",
    StaticFiles(directory=str(settings.resolved_upload_dir)),
    name="uploads",
)


@app.get("/", include_in_schema=False)
def root() -> dict[str, Any]:
    """A pointer to the documentation, so the bare host is not a 404."""
    return {
        "name": settings.app_name,
        "version": settings.app_version,
        "tagline": "Predict. Explain. Warn. Respond.",
        "docs": "/docs",
        "health": "/api/health",
        "info": "/api/info",
        "note": (
            "Demonstration platform. Predictions come from modelled weather and "
            "synthetic training labels - see /api/model-info."
        ),
    }


def run() -> None:  # pragma: no cover - CLI helper
    """``python -m app.main`` - the same server the README documents."""
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.api_host,
        port=settings.api_port,
        reload=True,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":  # pragma: no cover
    run()
