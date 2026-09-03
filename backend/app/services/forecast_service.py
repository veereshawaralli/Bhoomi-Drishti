"""The 72-hour risk forecast.

What the curve actually is
--------------------------
Six model inferences on the same region, at NOW, +6, +12, +24, +48 and +72
hours. What changes between them is the weather: the rainfall accumulations
and the soil moisture read forward through the same physical series that
produced "now". So the +24 h point is high because the rain forecast at +6 and
+12 has soaked the ground by then - not because a curve was drawn through two
endpoints.

That distinction matters for the demo and for the truth of the thing. A
smoothed interpolation between "now" and "worst case" would look identical on
screen and would mean nothing.

Confidence with distance
------------------------
Forecast skill decays with lead time, so each horizon's confidence is reduced
against the model's own confidence at that point - about 3% per 12 hours,
floored at 55%. A 72-hour warning presented with the same certainty as a
nowcast would be misleading, and officers who notice that stop trusting the
whole system.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Sequence

from sqlalchemy import delete
from sqlalchemy.orm import Session

from ..clock import plus_hours, utcnow
from ..models import Region, RiskForecast
from . import risk_engine
from . import scenario as scenario_module
from . import weather_service

LOG = logging.getLogger("app.forecast")

# The horizons the specification names.
HORIZONS: tuple[int, ...] = (0, 6, 12, 24, 48, 72)
LABELS: dict[int, str] = {0: "NOW", 6: "+6h", 12: "+12h", 24: "+24h", 48: "+48h", 72: "+72h"}


def _confidence_decay(hours: int) -> float:
    """Multiplier applied to model confidence at a given lead time."""
    return max(0.55, 1.0 - 0.03 * (hours / 12.0))


def _peak(points: Sequence[dict[str, Any]]) -> dict[str, Any]:
    return max(points, key=lambda p: (p["risk_score"], -p["hours"]))


def _summary(region: Region, points: Sequence[dict[str, Any]], scenario_label: str) -> str:
    """One sentence describing the curve, in the language an officer uses."""
    now_point = points[0]
    peak = _peak(points)
    rise = peak["risk_score"] - now_point["risk_score"]

    if peak["hours"] == 0 or rise < 3.0:
        if now_point["risk_level"] in ("HIGH", "CRITICAL"):
            return (
                f"{region.name} is at {now_point['risk_level']} risk now "
                f"({now_point['risk_score']:.0f}/100) and the model does not show it "
                "easing over the next 72 hours."
            )
        return (
            f"{region.name} stays around {now_point['risk_level']} risk for the next "
            f"72 hours, peaking at {peak['risk_score']:.0f}/100."
        )
    return (
        f"{region.name} rises from {now_point['risk_score']:.0f}/100 "
        f"({now_point['risk_level']}) to a peak of {peak['risk_score']:.0f}/100 "
        f"({peak['risk_level']}) at {peak['label']}, driven by "
        f"{peak['rainfall_mm']:.0f} mm/h rainfall and soil moisture reaching "
        f"{(peak.get('soil_moisture_pct') or 0):.0f}%. Scenario: {scenario_label}."
    )


def build(
    region: Region,
    *,
    scenario_key: str | None = None,
    horizons: Sequence[int] = HORIZONS,
) -> dict[str, Any]:
    """Compute the forecast curve for one region.

    Pure computation - no database writes - so it can be called from the
    what-if simulator and the map preview without side effects.
    """
    scn = scenario_module.get(scenario_key)
    issued = utcnow()

    readings = weather_service.forecast_hours(region, tuple(horizons), scenario_key=scn.key)
    rows = [risk_engine.assemble_features(region, reading) for reading in readings]

    from ml.predict import predict_batch  # local import: ml path set by risk_engine

    from ..config import settings

    scored = predict_batch(rows, data_mode=scn.data_mode, path=settings.resolved_model_path)

    points: list[dict[str, Any]] = []
    for hours, reading, outcome in zip(horizons, readings, scored):
        points.append(
            {
                "label": LABELS.get(hours, f"+{hours}h"),
                "hours": int(hours),
                "valid_at": plus_hours(issued, hours),
                "risk_score": float(outcome["risk_score"]),
                "risk_level": str(outcome["risk_level"]),
                "confidence": round(float(outcome["confidence"]) * _confidence_decay(hours), 1),
                "rainfall_mm": round(float(reading.get("rainfall_1h", 0.0)), 2),
                "soil_moisture_pct": (
                    None if reading.get("soil_moisture_pct") is None
                    else round(float(reading["soil_moisture_pct"]), 1)
                ),
            }
        )

    peak = _peak(points)
    return {
        "region_id": region.id,
        "region_code": region.code,
        "region_name": region.name,
        "issued_at": issued,
        "scenario": scn.key,
        "data_mode": scn.data_mode,
        "model_backend": str(scored[0]["model_backend"]) if scored else "unknown",
        "points": points,
        "peak": peak,
        "summary": _summary(region, points, scn.label),
    }


def store(db: Session, forecast: dict[str, Any]) -> int:
    """Persist a forecast curve, replacing any earlier curve for this region.

    Only the newest curve is kept per region. Forecast verification (holding
    old curves and scoring them against what happened) is a real feature and
    is listed in the scalability plan, but keeping every 60-second curve
    without a verification step would just be an unbounded table.
    """
    region_id = int(forecast["region_id"])
    db.execute(delete(RiskForecast).where(RiskForecast.region_id == region_id))
    issued: datetime = forecast["issued_at"]
    for point in forecast["points"]:
        db.add(
            RiskForecast(
                region_id=region_id,
                issued_at=issued,
                horizon_hours=int(point["hours"]),
                valid_at=point["valid_at"],
                risk_score=float(point["risk_score"]),
                risk_level=str(point["risk_level"]),
                confidence=round(float(point["confidence"]) / 100.0, 4),
                rainfall_mm=float(point["rainfall_mm"]),
                soil_moisture_pct=point.get("soil_moisture_pct"),
                scenario=str(forecast["scenario"]),
                data_mode=str(forecast["data_mode"]),
            )
        )
    db.flush()
    return len(forecast["points"])


def build_and_store(
    db: Session, region: Region, *, scenario_key: str | None = None
) -> dict[str, Any]:
    forecast = build(region, scenario_key=scenario_key)
    store(db, forecast)
    return forecast


def peak_within(forecast: dict[str, Any], hours: int) -> dict[str, Any]:
    """Worst point inside a lead time - used by the alert wording."""
    inside = [p for p in forecast["points"] if p["hours"] <= hours]
    return _peak(inside or forecast["points"])


__all__ = ["HORIZONS", "LABELS", "build", "build_and_store", "peak_within", "store"]
