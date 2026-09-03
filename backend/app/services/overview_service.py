"""The national picture, computed from stored data.

Every number on the national overview screen is derived here from the regions,
predictions, alerts, events, reports and sensors actually in the database. None
of it is hardcoded in the UI, and none of it is a constant chosen to look
impressive - which is why the figures move when the scenario changes, and why
they would move again if the region table were replaced with a different set of
districts.

One judgement call worth stating: the headline "national risk" figure is the
mean of the worst decile of regions, not the mean of all of them. A national
average is dominated by the many quiet districts and would read LOW on the day
one district is being evacuated - which is precisely when a national overview
needs to be loud.
"""
from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..clock import utcnow
from ..models import Alert, CitizenReport, LandslideEvent, Region, SimulatedSensorData
from . import alert_service, risk_engine
from . import scenario as scenario_module
from . import sensor_simulator

LOG = logging.getLogger("app.overview")

BAND_ORDER = ["VERY LOW", "LOW", "MODERATE", "HIGH", "CRITICAL"]


def build(db: Session, *, scenario_key: str | None = None, top_n: int = 10) -> dict[str, Any]:
    """Assemble the national overview."""
    scn = scenario_module.get(scenario_key)
    now = utcnow()

    regions = risk_engine.regions_query(db)
    payloads = risk_engine.score_regions(regions, scenario_key=scn.key)
    summary = risk_engine.summarise(payloads)

    scored = len(payloads)
    bands = [
        {
            "level": level,
            "count": summary["band_counts"].get(level, 0),
            "percent": round(summary["band_counts"].get(level, 0) / scored * 100.0, 1)
            if scored else 0.0,
        }
        for level in BAND_ORDER
    ]

    by_id = {r.id: r for r in regions}
    ranked = sorted(payloads, key=lambda p: -float(p["risk_score"]))[:top_n]
    top_regions = []
    for item in ranked:
        region = by_id.get(int(item["region_id"]))
        if region is None:
            continue
        top_regions.append(
            {
                "region_id": region.id,
                "region_code": region.code,
                "name": region.name,
                "district": region.district,
                "state": region.state,
                "latitude": region.latitude,
                "longitude": region.longitude,
                "risk_score": float(item["risk_score"]),
                "risk_level": str(item["risk_level"]),
                "confidence": float(item["confidence"]),
                "population_exposed": region.population_exposed,
                "historical_landslide_count": region.historical_landslide_count,
            }
        )

    alert_counts = alert_service.stats(db)
    events_total = db.scalar(select(func.count(LandslideEvent.id))) or 0
    events_this_year = db.scalar(
        select(func.count(LandslideEvent.id)).where(
            func.extract("year", LandslideEvent.event_date) == now.year
        )
    ) or 0
    reports_pending = db.scalar(
        select(func.count(CitizenReport.id)).where(
            CitizenReport.status.in_(("NEW", "UNDER REVIEW"))
        )
    ) or 0

    # Sensors are computed rather than read: the virtual network reports its
    # live state, and stored rows are only a history for the chart.
    network = sensor_simulator.network(db, scenario_key=scn.key)
    sensors_alerting = int(network["counts"].get("ALARM", 0))

    # Population under a HIGH or CRITICAL score - the number that decides how
    # many people a district actually has to reach.
    exposed = sum(
        int(by_id[int(p["region_id"])].population_exposed or 0)
        for p in payloads
        if p["risk_level"] in ("HIGH", "CRITICAL") and int(p["region_id"]) in by_id
    )

    states = sorted({r.state for r in regions})
    by_state: dict[str, dict[str, Any]] = {}
    for item in payloads:
        region = by_id.get(int(item["region_id"]))
        if region is None:
            continue
        bucket = by_state.setdefault(
            region.state, {"state": region.state, "regions": 0, "max_score": 0.0, "high": 0}
        )
        bucket["regions"] += 1
        bucket["max_score"] = max(bucket["max_score"], float(item["risk_score"]))
        if item["risk_level"] in ("HIGH", "CRITICAL"):
            bucket["high"] += 1

    return {
        "generated_at": now,
        "data_mode": scn.data_mode,
        "scenario": scn.key,
        "scenario_label": scn.label,
        "regions_total": len(regions),
        "regions_scored": scored,
        "bands": bands,
        "avg_score": summary["avg_score"],
        "max_score": summary["max_score"],
        "high_risk": summary["high_risk_count"],
        "critical": summary["critical_count"],
        "active_alerts": alert_counts["total"] - alert_counts["resolved"],
        "unresolved_alerts": alert_counts["new"] + alert_counts["acknowledged"]
        + alert_counts["in_progress"],
        "alert_counts": alert_counts,
        "events_total": int(events_total),
        "events_this_year": int(events_this_year),
        "reports_pending": int(reports_pending),
        "sensors_alerting": sensors_alerting,
        "sensors_total": int(network["counts"].get("total", 0)),
        "population_exposed": exposed,
        "states_monitored": len(states),
        "states": sorted(by_state.values(), key=lambda s: -s["max_score"]),
        "top_regions": top_regions,
        "country_risk": summary["country_risk"],
        "note": (
            f"All figures are computed from the platform's own data under the "
            f"{scn.label} scenario and are labelled {scn.data_mode}. "
            "They are not published national statistics."
        ),
    }


def counts_only(db: Session) -> dict[str, int]:
    """Cheap row counts for /api/health - no model inference."""
    return {
        "regions": int(db.scalar(select(func.count(Region.id))) or 0),
        "alerts": int(db.scalar(select(func.count(Alert.id))) or 0),
        "events": int(db.scalar(select(func.count(LandslideEvent.id))) or 0),
        "reports": int(db.scalar(select(func.count(CitizenReport.id))) or 0),
        "sensor_rows": int(db.scalar(select(func.count(SimulatedSensorData.id))) or 0),
    }


__all__ = ["BAND_ORDER", "build", "counts_only"]
