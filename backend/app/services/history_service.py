"""The historical landslide inventory: filters and the charts built from it.

The inventory itself is described in ``app/seed.py``. This module is the read
side - filtering, the four charts the specification asks for, and the filter
option lists the UI populates its dropdowns from.

Both the charts and the option lists are computed from whatever is actually in
the table, so replacing the DEMO inventory with the GSI national inventory
changes the screen without changing a line of code here. The mixed provenance
is preserved: documented events and modelled events are both returned, each
carrying its own ``source``, and the response reports the split so a reader
knows how much of what they are looking at is on the record.
"""
from __future__ import annotations

import logging
from collections import Counter, defaultdict
from typing import Any, Sequence

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import LandslideEvent

LOG = logging.getLogger("app.history")

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

SEVERITY_ORDER = ["MINOR", "MODERATE", "MAJOR", "SEVERE"]

# Rainfall bins for the "rainfall vs landslides" chart, in mm over 24 hours.
RAIN_BINS: list[tuple[float, float, str]] = [
    (0.0, 50.0, "0-50"),
    (50.0, 100.0, "50-100"),
    (100.0, 150.0, "100-150"),
    (150.0, 200.0, "150-200"),
    (200.0, 300.0, "200-300"),
    (300.0, 450.0, "300-450"),
    (450.0, 1e9, "450+"),
]


def query(
    db: Session,
    *,
    state: str | None = None,
    district: str | None = None,
    year: int | None = None,
    severity: str | None = None,
    region_id: int | None = None,
    limit: int = 1000,
) -> list[LandslideEvent]:
    stmt = select(LandslideEvent).order_by(LandslideEvent.event_date.desc())
    if state:
        stmt = stmt.where(LandslideEvent.state == state)
    if district:
        stmt = stmt.where(LandslideEvent.district == district)
    if year:
        stmt = stmt.where(func.extract("year", LandslideEvent.event_date) == year)
    if severity:
        stmt = stmt.where(LandslideEvent.severity == severity.upper())
    if region_id:
        stmt = stmt.where(LandslideEvent.region_id == region_id)
    return list(db.scalars(stmt.limit(max(1, min(limit, 5000)))).all())


def filter_options(db: Session) -> dict[str, list[Any]]:
    """The dropdown contents - drawn from the data, never hardcoded."""
    states = [s for (s,) in db.execute(
        select(LandslideEvent.state).distinct().order_by(LandslideEvent.state)
    ).all() if s]
    districts = [d for (d,) in db.execute(
        select(LandslideEvent.district).distinct().order_by(LandslideEvent.district)
    ).all() if d]
    years = sorted(
        {
            row.year
            for (row,) in db.execute(select(LandslideEvent.event_date)).all()
            if row is not None
        },
        reverse=True,
    )
    return {
        "states": states,
        "districts": districts,
        "years": years,
        "severities": SEVERITY_ORDER,
    }


def charts(events: Sequence[LandslideEvent]) -> dict[str, Any]:
    """The four charts the specification names, plus the provenance split."""
    per_year: dict[int, Counter] = defaultdict(Counter)
    per_month = Counter()
    per_rain = Counter()
    per_region: dict[str, dict[str, Any]] = {}
    per_severity = Counter()
    documented = 0

    for event in events:
        year = event.event_date.year
        per_year[year][event.severity] += 1
        per_year[year]["total"] += 1
        per_month[event.event_date.month] += 1
        per_severity[event.severity] += 1
        if event.data_mode == "DEMO" and "Compiled from public reports" in (event.source or ""):
            documented += 1

        rain = float(event.rainfall_mm or 0.0)
        for low, high, label in RAIN_BINS:
            if low <= rain < high:
                per_rain[label] += 1
                break

        key = f"{event.district or event.location}, {event.state or ''}".strip(", ")
        bucket = per_region.setdefault(
            key,
            {
                "location": key,
                "district": event.district,
                "state": event.state,
                "count": 0,
                "severe": 0,
                "latitude": event.latitude,
                "longitude": event.longitude,
                "max_rainfall_mm": 0.0,
            },
        )
        bucket["count"] += 1
        if event.severity in ("MAJOR", "SEVERE"):
            bucket["severe"] += 1
        bucket["max_rainfall_mm"] = max(bucket["max_rainfall_mm"], rain)

    years = sorted(per_year)
    events_per_year = [
        {
            "year": year,
            "total": per_year[year]["total"],
            **{level: per_year[year][level] for level in SEVERITY_ORDER},
        }
        for year in years
    ]

    seasonal = [
        {"month": MONTHS[m - 1], "month_number": m, "events": per_month.get(m, 0)}
        for m in range(1, 13)
    ]

    rainfall_vs_events = [
        {"band": label, "events": per_rain.get(label, 0)}
        for _, _, label in RAIN_BINS
    ]

    high_risk_regions = sorted(
        per_region.values(), key=lambda r: (-r["count"], -r["severe"])
    )[:15]

    return {
        "events_per_year": events_per_year,
        "seasonal_pattern": seasonal,
        "rainfall_vs_events": rainfall_vs_events,
        "high_risk_regions": high_risk_regions,
        "severity_split": [
            {"severity": level, "count": per_severity.get(level, 0)}
            for level in SEVERITY_ORDER
        ],
        "provenance": {
            "documented": documented,
            "modelled": len(events) - documented,
            "note": (
                "Documented events are compiled from public reports of real Indian "
                "landslides (figures approximate). Modelled events are generated "
                "minor events used to give the inventory realistic density; both "
                "are labelled per row."
            ),
        },
    }


def to_dict(event: LandslideEvent) -> dict[str, Any]:
    return {
        "id": event.id,
        "event_id": event.event_id,
        "region_id": event.region_id,
        "region_code": event.region.code if event.region else None,
        "event_date": event.event_date,
        "location": event.location,
        "district": event.district,
        "state": event.state,
        "latitude": event.latitude,
        "longitude": event.longitude,
        "rainfall_mm": event.rainfall_mm,
        "slope_deg": event.slope_deg,
        "elevation_m": event.elevation_m,
        "severity": event.severity,
        "trigger": event.trigger,
        "fatalities": event.fatalities,
        "description": event.description,
        "source": event.source,
        "data_mode": event.data_mode,
    }


def build(
    db: Session,
    *,
    state: str | None = None,
    district: str | None = None,
    year: int | None = None,
    severity: str | None = None,
    region_id: int | None = None,
    limit: int = 1000,
) -> dict[str, Any]:
    """The /api/history payload: filtered rows, options and charts together."""
    total = int(db.scalar(select(func.count(LandslideEvent.id))) or 0)
    events = query(
        db, state=state, district=district, year=year,
        severity=severity, region_id=region_id, limit=limit,
    )
    return {
        "total": total,
        "filtered": len(events),
        "events": [to_dict(e) for e in events],
        "filter_options": filter_options(db),
        "charts": charts(events),
        "data_mode": "DEMO",
    }


def near(db: Session, latitude: float, longitude: float, *, radius_km: float = 25.0,
         limit: int = 20) -> list[LandslideEvent]:
    """Past events near a point - the "has this happened here before" panel.

    A bounding-box filter in SQL followed by an exact distance check in Python.
    On PostGIS this becomes a ``ST_DWithin`` against the generated geography
    column; the result is identical and the box keeps it fast on SQLite too.
    """
    import math

    delta_lat = radius_km / 111.0
    delta_lon = radius_km / max(1e-6, 111.0 * math.cos(math.radians(latitude)))
    candidates = db.scalars(
        select(LandslideEvent).where(
            LandslideEvent.latitude.between(latitude - delta_lat, latitude + delta_lat),
            LandslideEvent.longitude.between(longitude - delta_lon, longitude + delta_lon),
        )
    ).all()

    def distance(event: LandslideEvent) -> float:
        dy = (event.latitude - latitude) * 111.0
        dx = (event.longitude - longitude) * 111.0 * math.cos(math.radians(latitude))
        return math.hypot(dx, dy)

    inside = [(distance(e), e) for e in candidates]
    inside = [(d, e) for d, e in inside if d <= radius_km]
    inside.sort(key=lambda pair: pair[0])
    return [e for _, e in inside[:limit]]


__all__ = ["MONTHS", "RAIN_BINS", "SEVERITY_ORDER", "build", "charts",
           "filter_options", "near", "query", "to_dict"]
