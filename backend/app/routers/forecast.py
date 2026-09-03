"""The 72-hour risk forecast."""
from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query

from ..models import Region
from ..services import forecast_service
from ..services import scenario as scenario_module
from .deps import DbSession, ScenarioKey, region_from_path

LOG = logging.getLogger("app.api.forecast")

router = APIRouter(tags=["forecast"])


@router.get("/forecast/{region_id}", summary="72-hour risk curve for one region")
def forecast(
    db: DbSession,
    scenario: ScenarioKey,
    region: Annotated[Region, Depends(region_from_path)],
    store: Annotated[bool, Query(description="Persist the curve")] = True,
) -> dict[str, Any]:
    """Risk at NOW, +6, +12, +24, +48 and +72 hours.

    Every point is scored through the same model as the map - the forecast is
    the model applied to forecast weather, not a curve fitted to the current
    score. Confidence decays with lead time, because a 72-hour warning that
    claimed nowcast certainty would be misrepresenting itself.
    """
    scn = scenario_module.get(scenario)
    if store:
        curve = forecast_service.build_and_store(db, region, scenario_key=scn.key)
        db.commit()
    else:
        curve = forecast_service.build(region, scenario_key=scn.key)

    return {
        "region_id": region.id,
        "region_code": region.code,
        "region_name": region.name,
        "district": region.district,
        "state": region.state,
        "issued_at": curve["issued_at"],
        "scenario": scn.key,
        "scenario_label": scn.label,
        "data_mode": curve["data_mode"],
        "model_backend": curve["model_backend"],
        "points": curve["points"],
        "peak": curve["peak"],
        "summary": curve["summary"],
        "note": curve.get("note"),
    }
