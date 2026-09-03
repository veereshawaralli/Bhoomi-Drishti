"""The historical landslide inventory."""
from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Query

from ..services import history_service
from .deps import DbSession

LOG = logging.getLogger("app.api.history")

router = APIRouter(tags=["history"])


@router.get("/history", summary="Past landslide events, filters and charts")
def history(
    db: DbSession,
    state: Annotated[str | None, Query(description="Filter by state")] = None,
    district: Annotated[str | None, Query(description="Filter by district")] = None,
    year: Annotated[int | None, Query(ge=1900, le=2100)] = None,
    severity: Annotated[
        str | None, Query(description="MINOR, MODERATE, MAJOR or SEVERE")
    ] = None,
    region_id: Annotated[int | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=5000)] = 1000,
) -> dict[str, Any]:
    """Filtered events, the dropdown options, and the four charts.

    The dropdown options are derived from the table rather than hardcoded, so
    replacing the demo inventory with the GSI national inventory changes the
    filters without a code change. The response reports how many events are
    documented from public reports versus modelled for density - a reader
    should always be able to tell how much of the chart is on the record.
    """
    return history_service.build(
        db,
        state=state,
        district=district,
        year=year,
        severity=severity,
        region_id=region_id,
        limit=limit,
    )


@router.get("/history/near", summary="Past events near a point")
def history_near(
    db: DbSession,
    lat: Annotated[float, Query(ge=-90, le=90)],
    lon: Annotated[float, Query(ge=-180, le=180)],
    radius_km: Annotated[float, Query(ge=1, le=200)] = 25.0,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> dict[str, Any]:
    """"Has this happened here before?" - the question a warning invites."""
    events = history_service.near(
        db, lat, lon, radius_km=radius_km, limit=limit
    )
    return {
        "count": len(events),
        "radius_km": radius_km,
        "events": [history_service.to_dict(e) for e in events],
    }
