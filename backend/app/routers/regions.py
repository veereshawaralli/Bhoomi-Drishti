"""Regions, the risk map, and the detail panel for one region.

Three endpoints, in increasing depth: the region list (a catalogue, no
inference), the risk map (every region scored in one batched model call), and
the detail for a single region (score, explanation, weather, terrain, recent
alerts and nearby past events - everything the side panel shows).
"""
from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Query

from ..clock import utcnow
from ..config import settings
from ..services import (
    alert_service,
    forecast_service,
    history_service,
    report_service,
    risk_engine,
    terrain_service,
    weather_service,
)
from ..services import scenario as scenario_module
from .deps import DbSession, ScenarioKey, region_from_path
from fastapi import Depends
from ..models import Region

LOG = logging.getLogger("app.api.regions")

router = APIRouter(tags=["regions"])


@router.get("/regions", summary="All monitored regions")
def list_regions(
    db: DbSession,
    state: Annotated[str | None, Query(description="Filter by state name")] = None,
    q: Annotated[str | None, Query(description="Search name, district or code")] = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 500,
) -> dict[str, Any]:
    """The region catalogue.

    No model inference happens here - this is the list the search box and the
    filter dropdowns are built from, and it must stay fast.
    """
    regions = risk_engine.regions_query(db, state=state, limit=limit)
    if q:
        needle = q.strip().lower()
        regions = [
            r for r in regions
            if needle in r.name.lower()
            or needle in r.district.lower()
            or needle in r.code.lower()
            or needle in r.state.lower()
        ]
    return {
        "count": len(regions),
        "states": sorted({r.state for r in regions}),
        "regions": [
            {
                "id": r.id,
                "code": r.code,
                "name": r.name,
                "district": r.district,
                "state": r.state,
                "zone": r.zone,
                "latitude": r.latitude,
                "longitude": r.longitude,
                "historical_landslide_count": r.historical_landslide_count,
                "annual_rainfall_mm": r.annual_rainfall_mm,
                "population_exposed": r.population_exposed,
                "area_km2": r.area_km2,
                "data_source": r.data_source,
            }
            for r in regions
        ],
    }


@router.get("/risk-map", summary="Every region scored, for the map")
def risk_map(
    db: DbSession,
    scenario: ScenarioKey,
    state: Annotated[str | None, Query(description="Restrict to one state")] = None,
    min_score: Annotated[float | None, Query(ge=0, le=100)] = None,
    level: Annotated[str | None, Query(description="Only this risk band")] = None,
) -> dict[str, Any]:
    """Score every monitored region under the active scenario.

    One batched inference for the whole country. Filtering happens after
    scoring so that the band counts always describe the full picture - a map
    filtered to CRITICAL should still be able to say how many regions are not.
    """
    scn = scenario_module.get(scenario)
    regions = risk_engine.regions_query(db, state=state, limit=settings.max_map_regions)
    payloads = risk_engine.score_regions(regions, scenario_key=scn.key)
    summary = risk_engine.summarise(payloads)
    by_id = {r.id: r for r in regions}

    points = []
    for item in payloads:
        region = by_id.get(int(item["region_id"]))
        if region is None:
            continue
        if min_score is not None and float(item["risk_score"]) < min_score:
            continue
        if level and str(item["risk_level"]).upper() != level.strip().upper():
            continue
        points.append(
            {
                "region": {
                    "id": region.id,
                    "code": region.code,
                    "name": region.name,
                    "district": region.district,
                    "state": region.state,
                    "zone": region.zone,
                    "latitude": region.latitude,
                    "longitude": region.longitude,
                    "historical_landslide_count": region.historical_landslide_count,
                    "annual_rainfall_mm": region.annual_rainfall_mm,
                    "population_exposed": region.population_exposed,
                    "area_km2": region.area_km2,
                    "data_source": region.data_source,
                },
                "risk_score": float(item["risk_score"]),
                "risk_level": str(item["risk_level"]),
                "confidence": float(item["confidence"]),
                "scenario": str(item["scenario"]),
                "data_mode": str(item["data_mode"]),
                "predicted_at": item["predicted_at"],
                "rainfall_24h": float(item["features"].get("rainfall_24h") or 0.0),
                "soil_moisture": float(item["features"].get("soil_moisture") or 0.0),
                "slope_deg": float(item["features"].get("slope") or 0.0),
            }
        )

    points.sort(key=lambda p: -p["risk_score"])
    return {
        "generated_at": utcnow(),
        "data_mode": scn.data_mode,
        "scenario": scn.key,
        "scenario_label": scn.label,
        "count": len(points),
        "total_regions": len(regions),
        "points": points,
        "band_counts": summary["band_counts"],
        "high_risk_count": summary["high_risk_count"],
        "critical_count": summary["critical_count"],
        "country_risk": summary["country_risk"],
        "avg_score": summary["avg_score"],
        "max_score": summary["max_score"],
        "note": (
            f"Scores are produced by the trained model from {scn.data_mode} "
            f"inputs under the {scn.label} scenario. They are not an official "
            "government landslide warning."
        ),
    }


@router.get("/risk/{region_id}", summary="Full risk detail for one region")
def region_risk(
    db: DbSession,
    scenario: ScenarioKey,
    region: Annotated[Region, Depends(region_from_path)],
    explain: Annotated[bool, Query(description="Include the factor breakdown")] = True,
) -> dict[str, Any]:
    """Everything the region detail panel needs, in one round trip.

    The score is computed and *stored* here rather than only computed: this is
    the endpoint a user hits when they open a region, so it is the natural
    place to record what the model said at that moment. ``persist`` decides
    whether the row is worth keeping, so opening the same panel repeatedly
    does not fill the table.
    """
    payload = risk_engine.score_region(region, scenario_key=scenario, explain=explain)
    risk_engine.persist(db, payload)
    db.commit()

    forecast = forecast_service.build(region, scenario_key=scenario)
    nearby = history_service.near(db, region.latitude, region.longitude, radius_km=30.0)
    alerts = alert_service.recent_for_region(db, region.id)
    reports = report_service.listing(db, region_id=region.id, limit=10)

    return {
        "region": {
            "id": region.id,
            "code": region.code,
            "name": region.name,
            "district": region.district,
            "state": region.state,
            "zone": region.zone,
            "latitude": region.latitude,
            "longitude": region.longitude,
            "historical_landslide_count": region.historical_landslide_count,
            "annual_rainfall_mm": region.annual_rainfall_mm,
            "population_exposed": region.population_exposed,
            "area_km2": region.area_km2,
            "data_source": region.data_source,
        },
        "risk": {
            key: payload[key]
            for key in (
                "risk_score", "risk_level", "confidence", "probability",
                "model_backend", "model_name", "model_version", "scenario",
                "data_mode", "defaulted_fields", "top_factors", "features",
                "predicted_at",
            )
        },
        "explanation": payload.get("explanation"),
        "weather": payload.get("weather"),
        "terrain": terrain_service.describe(region),
        "forecast": {
            "points": forecast["points"],
            "peak": forecast["peak"],
            "summary": forecast["summary"],
        },
        "alerts": alert_service.many_to_dict(alerts),
        "recent_reports": report_service.many_to_dict(reports),
        "nearby_events": [history_service.to_dict(e) for e in nearby],
        "weather_provider": weather_service.provider_status(),
    }
