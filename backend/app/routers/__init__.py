"""HTTP routers.

One module per area of the screen, each mapping onto the service that owns the
logic. The routers do four things and nothing else: validate input through the
Pydantic schemas, resolve the caller's role, call exactly one service, and turn
service-level errors into the right status code. No risk arithmetic happens
here - that all lives in ``app.services.risk_engine``, which is what keeps a
score meaning the same thing on every screen.

===========  =============================================================
regions      GET /api/regions, /api/risk-map, /api/risk/{region_id}
predict      POST /api/predict, POST /api/what-if
forecast     GET /api/forecast/{region_id}
weather      GET /api/weather/{region_id}
alerts       GET/POST /api/alerts, PUT /api/alerts/{id}
history       GET /api/history
reports      POST /api/citizen-report, POST /api/image-analysis, triage
sensors      GET /api/sensors, POST /api/sensors/simulate
simulation   POST /api/simulation (scenario control), GET /api/scenarios
overview     GET /api/overview
auth         POST /api/auth/login, GET /api/auth/me
meta         GET /api/health, GET /api/info, GET /api/model-info
===========  =============================================================
"""
from __future__ import annotations

from fastapi import APIRouter

from . import (
    alerts,
    auth,
    forecast,
    history,
    meta,
    overview,
    predict,
    regions,
    reports,
    sensors,
    simulation,
    weather,
)

api_router = APIRouter(prefix="/api")

# Order matters only for documentation grouping, not for routing: every path
# below is distinct. Static segments are registered before parameterised ones
# within each module so that /api/alerts/stats is never read as an alert id.
api_router.include_router(meta.router)
api_router.include_router(auth.router)
api_router.include_router(regions.router)
api_router.include_router(predict.router)
api_router.include_router(forecast.router)
api_router.include_router(weather.router)
api_router.include_router(alerts.router)
api_router.include_router(history.router)
api_router.include_router(reports.router)
api_router.include_router(sensors.router)
api_router.include_router(simulation.router)
api_router.include_router(overview.router)

__all__ = ["api_router"]
