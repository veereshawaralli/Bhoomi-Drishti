"""The virtual sensor network.

Every reading on this screen is produced by software. There is no Arduino, no
Raspberry Pi, no gauge on a hillside - the readings come from a physical model
of how instruments would respond to the weather the platform is already using,
and every response carries the SIMULATED badge saying exactly that.

The point is not to pretend to have hardware. It is to show what the platform
does with instrument data when a deployment has it, and to let an operator
force an abnormal condition and watch the risk engine respond - which is
something you cannot do with a real slope on demand.
"""
from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status as http

from ..schemas import SimulateSensorIn
from ..security import Principal, require_officer
from ..services import scenario as scenario_module
from ..services import sensor_simulator
from .deps import DbSession, ScenarioKey, resolve_region

LOG = logging.getLogger("app.api.sensors")

router = APIRouter(tags=["virtual sensors"])


@router.get("/sensors", summary="The whole virtual network")
def sensors(
    db: DbSession,
    scenario: ScenarioKey,
    region_id: Annotated[int | None, Query(description="One region only")] = None,
    limit_regions: Annotated[int, Query(ge=1, le=40)] = 12,
) -> dict[str, Any]:
    """Current readings for every instrument, with status counts.

    Instruments are placed on the regions with the most recorded landslides,
    which is how a real network would be prioritised. Each reading carries its
    unit, its elevated and alarm thresholds, and the real instrument it stands
    in for - so a reader can see what the number would mean in the field.
    """
    scn = scenario_module.get(scenario)
    payload = sensor_simulator.network(
        db,
        scenario_key=scn.key,
        region_ids=[region_id] if region_id else None,
        limit_regions=limit_regions,
    )
    payload["scenario"] = scn.key
    payload["scenario_label"] = scn.label
    return payload


@router.get("/sensors/history", summary="One instrument's recent trace")
def sensor_history(
    db: DbSession,
    region_id: Annotated[int, Query()],
    sensor_type: Annotated[
        str, Query(description="RAIN_GAUGE, SOIL_MOISTURE, PORE_PRESSURE, TILT, VIBRATION")
    ],
    points: Annotated[int, Query(ge=2, le=500)] = 48,
) -> dict[str, Any]:
    """The stored trace for one instrument, oldest first, ready to plot."""
    key = (sensor_type or "").strip().upper()
    if key not in sensor_simulator.SPECS:
        raise HTTPException(
            status_code=http.HTTP_400_BAD_REQUEST,
            detail=(
                f"Unknown sensor type {sensor_type!r}. Known types: "
                + ", ".join(sensor_simulator.SENSOR_ORDER)
            ),
        )
    region = resolve_region(db, region_id)
    rows = sensor_simulator.history(db, region.id, key, points=points)
    spec = sensor_simulator.SPECS[key]
    return {
        "region_id": region.id,
        "region_name": region.name,
        "sensor_type": key,
        "label": spec.label,
        "unit": spec.unit,
        "elevated_at": spec.elevated,
        "alarm_at": spec.alarm,
        "purpose": spec.purpose,
        "real_world": spec.real_world,
        "count": len(rows),
        "readings": sensor_simulator.many_to_dict(rows),
        "mode": "SIMULATED",
        "note": sensor_simulator.SIMULATED_BADGE,
    }


@router.post("/sensors/simulate", summary="Force an abnormal condition (officer)")
def simulate_sensors(
    payload: SimulateSensorIn,
    db: DbSession,
    scenario: ScenarioKey,
    principal: Annotated[Principal, Depends(require_officer)],
) -> dict[str, Any]:
    """Drive one region's instruments into heavy-rain or pre-failure conditions.

    Writes an hourly trace across the window so the chart shows the condition
    developing rather than stepping, then scores the slope in the state the
    instruments describe - through the same risk engine as everything else, so
    the resulting number is directly comparable with the map.

    Requires the OFFICER role because it writes rows the whole platform reads.
    """
    region = resolve_region(db, payload.region_id)
    scn = scenario_module.get(scenario)
    try:
        result = sensor_simulator.simulate(
            db,
            region,
            condition=payload.condition,
            minutes=payload.minutes,
            scenario_key=scn.key,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=http.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc

    db.commit()
    LOG.info(
        "sensor simulation on %s (%s) by %s: %d rows, %d alarming",
        region.name, payload.condition, principal.username,
        result["inserted_rows"], len(result["alarming"]),
    )
    result["scenario_label"] = scn.label
    return result


@router.get("/sensors/conditions", summary="Conditions the operator can force")
def conditions() -> dict[str, Any]:
    """What the buttons on the Virtual Sensors page can do.

    Served rather than hardcoded in the UI so the control panel and the
    simulator cannot disagree about what is available.
    """
    return {
        "conditions": [
            {
                "key": key,
                "label": value["label"],
                "rainfall_multiplier": value["rain"],
                "soil_moisture_added_pct": value["moisture_add"],
            }
            for key, value in sensor_simulator.CONDITIONS.items()
        ],
        "sensor_types": [
            {
                "key": spec.key,
                "label": spec.label,
                "unit": spec.unit,
                "elevated_at": spec.elevated,
                "alarm_at": spec.alarm,
                "purpose": spec.purpose,
                "real_world": spec.real_world,
            }
            for spec in (sensor_simulator.SPECS[k] for k in sensor_simulator.SENSOR_ORDER)
        ],
        "mode": "SIMULATED",
        "note": sensor_simulator.SIMULATED_BADGE,
    }
