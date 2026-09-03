"""The national overview.

Every number on this page is computed from the platform's own regions, model,
alerts, events, reports and virtual sensors at the moment of the request. None
of it is a constant in the UI - which is the difference between a dashboard and
a screenshot.

The national figure is deliberately not the national mean. Averaging 60-odd
regions would read "LOW" on the day a district is being evacuated, because the
many quiet regions drown the few that matter. It is the mean of the worst
decile instead: a number that moves when the situation is serious somewhere.
"""
from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Query

from ..services import overview_service
from ..services import scenario as scenario_module
from .deps import DbSession, ScenarioKey

LOG = logging.getLogger("app.api.overview")

router = APIRouter(tags=["overview"])


@router.get("/overview", summary="National risk overview")
def overview(
    db: DbSession,
    scenario: ScenarioKey,
    top_n: Annotated[int, Query(ge=1, le=50, description="How many regions to rank")] = 10,
) -> dict[str, Any]:
    """Band distribution, headline figures, per-state rollup and the top regions.

    ``population_exposed`` is the population of regions currently scored HIGH or
    CRITICAL - the number that decides how many people a district actually has
    to reach, rather than how many live near a slope in general.
    """
    payload = overview_service.build(db, scenario_key=scenario, top_n=top_n)
    scn = scenario_module.get(scenario)
    payload["scenario"] = scn.key
    payload["scenario_label"] = scn.label
    return payload
