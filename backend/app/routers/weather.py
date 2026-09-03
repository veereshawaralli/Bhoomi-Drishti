"""Weather for one region: the current reading and the hourly series.

The response always says where the numbers came from. In DEMO mode they are
produced by the documented physical model in ``ml/hydrology.py``; in LIVE mode
they come from the configured public forecast API. If a live fetch fails the
service falls back to the model and the response says that too, rather than
quietly serving modelled numbers under a LIVE badge.
"""
from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query

from ..models import Region
from ..services import weather_service
from ..services import scenario as scenario_module
from .deps import DbSession, ScenarioKey, region_from_path

LOG = logging.getLogger("app.api.weather")

router = APIRouter(tags=["weather"])


@router.get("/weather/{region_id}", summary="Current weather and hourly series")
def weather(
    db: DbSession,
    scenario: ScenarioKey,
    region: Annotated[Region, Depends(region_from_path)],
    back_hours: Annotated[int, Query(ge=0, le=168)] = 24,
    forward_hours: Annotated[int, Query(ge=0, le=168)] = 48,
) -> dict[str, Any]:
    """Now, plus a contiguous window either side of it.

    The window is read forward through one physical series, so the rainfall
    accumulations and the soil-moisture response are consistent with each
    other - which is what lets the weather chart and the risk curve be read
    together.
    """
    scn = scenario_module.get(scenario)
    now = weather_service.current(region, scenario_key=scn.key)
    series = weather_service.hourly_window(
        region,
        back_hours=back_hours,
        forward_hours=forward_hours,
        scenario_key=scn.key,
    )
    status = weather_service.provider_status()

    return {
        "region_id": region.id,
        "region_code": region.code,
        "region_name": region.name,
        "scenario": scn.key,
        "scenario_label": scn.label,
        "data_mode": now.get("data_mode", scn.data_mode),
        "provider": status["provider"],
        "live_configured": status["live_configured"],
        "current": now,
        "hourly": series,
        "note": status["note"],
    }
