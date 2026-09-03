"""The virtual sensor network - software only, no hardware anywhere.

This project uses no Arduino, no Raspberry Pi and no physical instrument. What
it has instead is a software model of what an instrumented slope would report,
so the platform can demonstrate the full sensing -> risk -> warning chain and
so a real telemetry feed can be plugged in later without changing anything
downstream. Every row this module writes carries ``data_mode = 'SIMULATED'``
and the UI labels it SIMULATED SENSOR DATA.

Why the readings are derived, not invented
------------------------------------------
Each of the five instrument types is computed from the same physical state the
risk engine is looking at, using the relationships the real instruments
measure:

* **rain gauge** - the hourly rainfall itself;
* **soil moisture probe** - the modelled volumetric water content, plus a
  small depth offset because a buried probe lags the surface;
* **pore pressure (piezometer)** - rises with the square of wetness above
  field capacity, which is why saturated slopes fail suddenly rather than
  gradually; expressed as head in kPa;
* **tiltmeter** - creep accumulates when pore pressure is high on a steep
  slope, so tilt is driven by pore pressure x sin(slope);
* **geophone / vibration** - background ground noise rises as material begins
  to move, so it tracks the rate of change of tilt.

The consequence is that "the tiltmeter is alarming" and "the model says
CRITICAL" are two views of one physical situation, which is exactly the
property a real deployment needs. A random-number generator behind each dial
would have looked the same on screen and taught nobody anything.

Determinism
-----------
No ``random`` anywhere. Instrument noise is a deterministic function of the
sensor code and the hour, so a reload shows the same instrument reading and
two officers looking at the same slope see the same number.
"""
from __future__ import annotations

import hashlib
import logging
import math
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterable, Mapping, Sequence

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session, selectinload

from ..clock import floor_hour, hours_since_epoch, plus_hours, utcnow
from ..models import Region, SimulatedSensorData
from . import risk_engine
from . import scenario as scenario_module
from . import weather_service

LOG = logging.getLogger("app.sensors")

SIMULATED_BADGE = "SIMULATED SENSOR DATA - software model, no physical hardware"


@dataclass(frozen=True)
class SensorSpec:
    """One instrument type: units, thresholds and what it is for."""

    key: str
    label: str
    unit: str
    elevated: float
    alarm: float
    purpose: str
    real_world: str


SPECS: dict[str, SensorSpec] = {
    "RAIN_GAUGE": SensorSpec(
        key="RAIN_GAUGE",
        label="Rain gauge",
        unit="mm/h",
        elevated=8.0,
        alarm=25.0,
        purpose="Rainfall intensity - the trigger for most Indian landslides.",
        real_world="Tipping-bucket rain gauge, IMD AWS network",
    ),
    "SOIL_MOISTURE": SensorSpec(
        key="SOIL_MOISTURE",
        label="Soil moisture probe",
        unit="% vol",
        elevated=35.0,
        alarm=45.0,
        purpose="Water stored in the slope - the state that turns rain into failure.",
        real_world="Capacitance / TDR probe at 30-60 cm depth",
    ),
    "PORE_PRESSURE": SensorSpec(
        key="PORE_PRESSURE",
        label="Piezometer",
        unit="kPa",
        elevated=18.0,
        alarm=35.0,
        purpose="Water pressure in the pores - what actually reduces shear strength.",
        real_world="Vibrating-wire piezometer in a borehole",
    ),
    "TILT": SensorSpec(
        key="TILT",
        label="Tiltmeter",
        unit="deg",
        elevated=0.35,
        alarm=1.20,
        purpose="Slow ground movement - the clearest warning that a slope is creeping.",
        real_world="MEMS biaxial tiltmeter on a slope anchor",
    ),
    "VIBRATION": SensorSpec(
        key="VIBRATION",
        label="Geophone",
        unit="mm/s",
        elevated=1.5,
        alarm=4.0,
        purpose="Ground vibration - rises sharply as material begins to detach.",
        real_world="Triaxial geophone / seismic node",
    ),
}

SENSOR_ORDER = ["RAIN_GAUGE", "SOIL_MOISTURE", "PORE_PRESSURE", "TILT", "VIBRATION"]

# Conditions the operator can force from the Virtual Sensors screen.
CONDITIONS = {
    "NORMAL": {"label": "Normal", "rain": 1.0, "moisture_add": 0.0},
    "HEAVY_RAIN": {"label": "Heavy rain", "rain": 3.5, "moisture_add": 8.0},
    "CRITICAL": {"label": "Critical / pre-failure", "rain": 8.0, "moisture_add": 18.0},
}


def _noise(sensor_code: str, hour: int, span: float) -> float:
    """Deterministic instrument noise in [-span, +span].

    Real instruments are not perfectly smooth, and a dashboard where five dials
    move in lockstep looks synthetic. This adds character without adding
    randomness: the same sensor at the same hour always reads the same.
    """
    digest = hashlib.sha256(f"{sensor_code}:{hour}".encode("utf-8")).digest()
    unit = int.from_bytes(digest[:4], "big") / 0xFFFFFFFF
    return (unit * 2.0 - 1.0) * span


def sensor_code(region: Region, sensor_type: str) -> str:
    """Stable, readable identifier: VS-WYD-TILT."""
    suffix = "".join(ch for ch in region.code if ch.isalnum())[-6:].upper()
    short = {"RAIN_GAUGE": "RAIN", "SOIL_MOISTURE": "SOIL", "PORE_PRESSURE": "PORE",
             "TILT": "TILT", "VIBRATION": "VIB"}[sensor_type]
    return f"VS-{suffix}-{short}"


def status_for(spec: SensorSpec, reading: float) -> str:
    if reading >= spec.alarm:
        return "ALARM"
    if reading >= spec.elevated:
        return "ELEVATED"
    return "NORMAL"


# ------------------------------------------------------------- the physics

def _pore_pressure(moisture_pct: float, soil_depth_m: float) -> float:
    """Pore water pressure head, in kPa.

    Below field capacity (about 25% by volume for most of these soils) the
    profile is unsaturated and pressure stays near zero. Above it the response
    is strongly non-linear - which is the physical reason a slope that has
    coped with days of rain can fail within an hour.
    """
    excess = max(0.0, moisture_pct - 25.0)
    saturation_fraction = min(1.0, excess / 25.0)
    head_m = saturation_fraction ** 2 * max(0.6, soil_depth_m)
    return round(9.81 * head_m, 2)


def _tilt(pore_kpa: float, slope_deg: float, history: int) -> float:
    """Accumulated tilt in degrees.

    Creep needs three things together: water pressure, a slope steep enough for
    gravity to drive movement, and material that has moved before. A gentle,
    stable slope reads near zero however wet it gets, which is the correct
    behaviour and the reason a tilt alarm means something.
    """
    driving = math.sin(math.radians(min(80.0, slope_deg)))
    memory = 1.0 + min(0.6, history / 60.0)
    return round(max(0.0, (pore_kpa / 30.0) ** 1.8 * driving * memory), 3)


def _vibration(tilt_deg: float, rain_mm_h: float) -> float:
    """Ground velocity in mm/s.

    Dominated by movement once the slope is creeping; rainfall alone
    contributes a small amount of impact noise.
    """
    return round(0.05 + tilt_deg * 3.4 + rain_mm_h * 0.035, 3)


def readings_for(
    region: Region,
    *,
    scenario_key: str | None = None,
    weather: Mapping[str, Any] | None = None,
    moment: datetime | None = None,
    condition: str | None = None,
) -> list[dict[str, Any]]:
    """The five instrument readings for one region at one moment."""
    scn = scenario_module.get(scenario_key)
    stamp = floor_hour(moment or utcnow())
    reading = dict(weather) if weather is not None else weather_service.current(
        region, scenario_key=scn.key
    )

    forced = CONDITIONS.get((condition or "").upper()) if condition else None
    rain = float(reading.get("rainfall_1h") or 0.0)
    moisture = float(reading.get("soil_moisture_pct") or 18.0)
    if forced:
        rain = max(rain * float(forced["rain"]), 0.0)
        moisture = min(62.0, moisture + float(forced["moisture_add"]))

    terrain = region.terrain
    slope = float(terrain.slope_deg) if terrain else 20.0
    depth = float(terrain.soil_depth_m or 1.5) if terrain else 1.5
    history = int(region.historical_landslide_count or 0)
    hour = hours_since_epoch(stamp)

    pore = _pore_pressure(moisture, depth)
    tilt = _tilt(pore, slope, history)
    vibration = _vibration(tilt, rain)

    raw = {
        "RAIN_GAUGE": max(0.0, rain + _noise(sensor_code(region, "RAIN_GAUGE"), hour, 0.15)),
        "SOIL_MOISTURE": max(
            2.0, moisture + _noise(sensor_code(region, "SOIL_MOISTURE"), hour, 0.6)
        ),
        "PORE_PRESSURE": max(0.0, pore + _noise(sensor_code(region, "PORE_PRESSURE"), hour, 0.4)),
        "TILT": max(0.0, tilt + _noise(sensor_code(region, "TILT"), hour, 0.01)),
        "VIBRATION": max(0.0, vibration + _noise(sensor_code(region, "VIBRATION"), hour, 0.05)),
    }

    out: list[dict[str, Any]] = []
    for key in SENSOR_ORDER:
        spec = SPECS[key]
        value = round(float(raw[key]), 3)
        out.append(
            {
                "sensor_code": sensor_code(region, key),
                "region_id": region.id,
                "region_name": region.name,
                "region_code": region.code,
                "sensor_type": key,
                "label": spec.label,
                "reading": value,
                "unit": spec.unit,
                "status": status_for(spec, value),
                "recorded_at": stamp,
                "data_mode": "SIMULATED",
                "purpose": spec.purpose,
                "real_world": spec.real_world,
                "elevated_at": spec.elevated,
                "alarm_at": spec.alarm,
            }
        )
    return out


# ----------------------------------------------------------- persistence

MAX_ROWS_PER_SENSOR = 240  # ten days of hourly readings; enough for the chart


def record(
    db: Session,
    region: Region,
    rows: Sequence[Mapping[str, Any]],
) -> list[SimulatedSensorData]:
    """Write readings to the database, then trim the tail.

    The trim keeps the table from growing without bound during a long demo.
    A production telemetry store would partition by time instead; that is in
    the scalability plan.
    """
    created: list[SimulatedSensorData] = []
    for row in rows:
        entity = SimulatedSensorData(
            sensor_code=str(row["sensor_code"]),
            region_id=region.id,
            sensor_type=str(row["sensor_type"]),
            reading=float(row["reading"]),
            unit=str(row["unit"]),
            status=str(row["status"]),
            recorded_at=row["recorded_at"],
            data_mode="SIMULATED",
        )
        db.add(entity)
        created.append(entity)
    db.flush()
    _trim(db, region.id)
    return created


def _trim(db: Session, region_id: int) -> None:
    total = db.scalar(
        select(func.count(SimulatedSensorData.id)).where(
            SimulatedSensorData.region_id == region_id
        )
    ) or 0
    cap = MAX_ROWS_PER_SENSOR * len(SENSOR_ORDER)
    if total <= cap:
        return
    keep_ids = select(SimulatedSensorData.id).where(
        SimulatedSensorData.region_id == region_id
    ).order_by(SimulatedSensorData.recorded_at.desc()).limit(cap)
    db.execute(
        delete(SimulatedSensorData).where(
            SimulatedSensorData.region_id == region_id,
            SimulatedSensorData.id.not_in(keep_ids),
        )
    )


def latest(
    db: Session, *, region_id: int | None = None, limit: int = 400
) -> list[SimulatedSensorData]:
    stmt = (
        select(SimulatedSensorData)
        .options(selectinload(SimulatedSensorData.region))
        .order_by(SimulatedSensorData.recorded_at.desc())
        .limit(max(1, min(limit, 2000)))
    )
    if region_id:
        stmt = stmt.where(SimulatedSensorData.region_id == region_id)
    return list(db.scalars(stmt).all())


def history(
    db: Session, region_id: int, sensor_type: str, *, points: int = 48
) -> list[SimulatedSensorData]:
    rows = list(
        db.scalars(
            select(SimulatedSensorData)
            .where(
                SimulatedSensorData.region_id == region_id,
                SimulatedSensorData.sensor_type == sensor_type.upper(),
            )
            .order_by(SimulatedSensorData.recorded_at.desc())
            .limit(max(1, min(points, 500)))
        ).all()
    )
    return list(reversed(rows))


# --------------------------------------------------------------- network

def network(
    db: Session,
    *,
    scenario_key: str | None = None,
    region_ids: Sequence[int] | None = None,
    limit_regions: int = 12,
) -> dict[str, Any]:
    """The whole virtual network as the Virtual Sensors page shows it.

    Instruments are placed on the regions that would actually be instrumented
    first: those with the most recorded landslides. That is how a real
    deployment is prioritised, and it means the demo network sits on the
    slopes the rest of the platform is talking about.
    """
    regions = risk_engine.regions_query(db)
    if region_ids:
        wanted = set(region_ids)
        chosen = [r for r in regions if r.id in wanted]
    else:
        chosen = sorted(
            regions, key=lambda r: -(r.historical_landslide_count or 0)
        )[:limit_regions]

    sensors: list[dict[str, Any]] = []
    for region in chosen:
        sensors.extend(readings_for(region, scenario_key=scenario_key))

    counts = {"NORMAL": 0, "ELEVATED": 0, "ALARM": 0, "OFFLINE": 0}
    for sensor in sensors:
        counts[sensor["status"]] += 1

    return {
        "sensors": sensors,
        "counts": {**counts, "total": len(sensors), "regions": len(chosen)},
        "mode": "SIMULATED",
        "note": SIMULATED_BADGE,
        "types": [
            {
                "key": spec.key,
                "label": spec.label,
                "unit": spec.unit,
                "elevated_at": spec.elevated,
                "alarm_at": spec.alarm,
                "purpose": spec.purpose,
                "real_world": spec.real_world,
            }
            for spec in (SPECS[k] for k in SENSOR_ORDER)
        ],
    }


def simulate(
    db: Session,
    region: Region,
    *,
    condition: str = "HEAVY_RAIN",
    minutes: int = 60,
    scenario_key: str | None = None,
) -> dict[str, Any]:
    """Force an abnormal condition on one region's instruments and score it.

    Writes an hourly trace over the requested window so the sensor chart shows
    the condition developing rather than jumping, then runs the risk engine on
    the resulting slope state so the operator can see what the instruments
    imply. This is the software stand-in for walking up to a slope and watching
    the tiltmeter move.
    """
    key = (condition or "HEAVY_RAIN").upper()
    if key not in CONDITIONS:
        raise ValueError(f"unknown condition {condition!r}")

    scn = scenario_module.get(scenario_key)
    now = floor_hour(utcnow())
    steps = max(1, min(12, round(minutes / 60) or 1))

    written: list[SimulatedSensorData] = []
    latest_rows: list[dict[str, Any]] = []
    for step in range(steps):
        moment = plus_hours(now, step - steps + 1)
        # Ramp the condition in over the window: instruments respond to a
        # developing storm, they do not step to a new value instantly.
        ramp = (step + 1) / steps
        base = weather_service.current(region, scenario_key=scn.key)
        blended = dict(base)
        forced = CONDITIONS[key]
        blended["rainfall_1h"] = float(base.get("rainfall_1h") or 0.0) * (
            1.0 + (float(forced["rain"]) - 1.0) * ramp
        )
        blended["soil_moisture_pct"] = min(
            62.0,
            float(base.get("soil_moisture_pct") or 18.0)
            + float(forced["moisture_add"]) * ramp,
        )
        rows = readings_for(region, weather=blended, moment=moment, scenario_key=scn.key)
        written.extend(record(db, region, rows))
        latest_rows = rows

    # Score the slope in the state the instruments now describe. The engine
    # sees the elevated rainfall and moisture as weather overrides, so the
    # number is produced by the same model as every other score on the
    # platform - not a special case for the sensor screen.
    final = {s["sensor_type"]: s["reading"] for s in latest_rows}
    weather = dict(weather_service.current(region, scenario_key=scn.key))
    weather["rainfall_1h"] = final["RAIN_GAUGE"]
    weather["rainfall_6h"] = max(float(weather.get("rainfall_6h") or 0.0),
                                 final["RAIN_GAUGE"] * 4.2)
    weather["rainfall_24h"] = max(float(weather.get("rainfall_24h") or 0.0),
                                  final["RAIN_GAUGE"] * 12.0)
    weather["rainfall_72h"] = max(float(weather.get("rainfall_72h") or 0.0),
                                  weather["rainfall_24h"] * 1.5)
    weather["rainfall_7d"] = max(float(weather.get("rainfall_7d") or 0.0),
                                 weather["rainfall_72h"] * 1.3)
    weather["soil_moisture_pct"] = final["SOIL_MOISTURE"]

    risk = risk_engine.score_region(
        region, scenario_key=scn.key, weather=weather, use_cache=False
    )
    risk["data_mode"] = "SIMULATED"

    alarms = [s["sensor_code"] for s in latest_rows if s["status"] == "ALARM"]
    return {
        "region_id": region.id,
        "region_name": region.name,
        "scenario": scn.key,
        "data_mode": "SIMULATED",
        "inserted_rows": len(written),
        "applied_condition": CONDITIONS[key]["label"],
        "risk": risk,
        "sensors": latest_rows,
        "alarming": alarms,
        "note": (
            f"{SIMULATED_BADGE}. Condition '{CONDITIONS[key]['label']}' applied to "
            f"{region.name} over {steps} h; "
            f"{len(alarms)} instrument(s) in ALARM."
        ),
    }


def to_dict(row: SimulatedSensorData) -> dict[str, Any]:
    return {
        "id": row.id,
        "sensor_code": row.sensor_code,
        "region_id": row.region_id,
        "region_name": row.region.name if row.region else None,
        "region_code": row.region.code if row.region else None,
        "sensor_type": row.sensor_type,
        "reading": row.reading,
        "unit": row.unit,
        "status": row.status,
        "recorded_at": row.recorded_at,
        "data_mode": row.data_mode,
    }


def many_to_dict(rows: Iterable[SimulatedSensorData]) -> list[dict[str, Any]]:
    return [to_dict(r) for r in rows]


__all__ = [
    "CONDITIONS",
    "SENSOR_ORDER",
    "SIMULATED_BADGE",
    "SPECS",
    "history",
    "latest",
    "many_to_dict",
    "network",
    "readings_for",
    "record",
    "sensor_code",
    "simulate",
    "status_for",
    "to_dict",
]
