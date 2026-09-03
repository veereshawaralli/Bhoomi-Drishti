"""Dependencies shared by the routers.

Mostly one job: turn "the client named a region" into a ``Region`` row or a
404 with a useful message. Every endpoint that takes a region accepts either
the numeric id or the region code (``WYD``), because the demo script types
codes and the frontend sends ids, and neither should have to care.
"""
from __future__ import annotations

import logging
from typing import Annotated

from fastapi import Depends, HTTPException, Path, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..database import get_db
from ..models import Region
from ..services import scenario as scenario_module

LOG = logging.getLogger("app.api")


def resolve_region(db: Session, ref: int | str) -> Region:
    """A region by id or code, with terrain eagerly loaded.

    Raises 404 rather than returning None: every caller wants the same
    message, and the ones that do not are better served by ``find_region``.
    """
    region = find_region(db, ref)
    if region is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No monitored region matches {ref!r}.",
        )
    return region


def find_region(db: Session, ref: int | str | None) -> Region | None:
    """A region by id or code, or None."""
    if ref is None:
        return None
    stmt = select(Region).options(selectinload(Region.terrain))
    text = str(ref).strip()
    if text.isdigit():
        stmt = stmt.where(Region.id == int(text))
    else:
        stmt = stmt.where(Region.code == text.upper())
    return db.scalars(stmt).first()


def region_from_path(
    region_id: Annotated[str, Path(description="Region id or code, e.g. 12 or WYD")],
    db: Session = Depends(get_db),
) -> Region:
    """Path-parameter form, used by /api/risk/{id}, /api/forecast/{id}, ..."""
    return resolve_region(db, region_id)


def active_scenario(
    scenario: Annotated[
        str | None,
        Query(description="Override the active scenario for this request only."),
    ] = None,
) -> str:
    """The scenario this request should be scored under.

    A query parameter wins over the platform-wide active scenario, so a client
    can preview a scenario without switching it for everyone - the demo uses
    the global switch, the frontend's scenario preview uses the parameter.
    An unknown key is a client error, not a silent fallback to NORMAL.
    """
    if scenario is None:
        return scenario_module.state.key
    normalised = scenario.strip().upper().replace(" ", "_")
    if normalised not in scenario_module.SCENARIOS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Unknown scenario {scenario!r}. Valid keys: "
                f"{', '.join(scenario_module.SCENARIOS)}."
            ),
        )
    return normalised


DbSession = Annotated[Session, Depends(get_db)]
ScenarioKey = Annotated[str, Depends(active_scenario)]

__all__ = [
    "DbSession",
    "ScenarioKey",
    "active_scenario",
    "find_region",
    "region_from_path",
    "resolve_region",
]
