"""Prediction and the what-if simulator.

``POST /api/predict`` is the endpoint the specification names, and it returns
exactly what it asks for - ``risk_score``, ``risk_level``, ``confidence`` and
``top_factors`` - plus the full explanation, the feature vector it scored, and
which fields had to be defaulted. A caller can always see what the number was
made from.

``POST /api/what-if`` re-scores a region under changed conditions. Both go
through ``risk_engine``, so a what-if score is directly comparable with the
one on the map; the result is labelled SIMULATED so nobody mistakes a
hypothetical for a forecast.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, status

from ..schemas import PredictRequest, WhatIfIn
from ..services import risk_engine, terrain_service, whatif_service
from ..services import scenario as scenario_module
from .deps import DbSession, find_region

LOG = logging.getLogger("app.api.predict")

router = APIRouter(tags=["prediction"])


@router.post("/predict", summary="Score a region or an arbitrary point")
def predict(request: PredictRequest, db: DbSession) -> dict[str, Any]:
    """Run the model.

    Three ways to ask:

    * by ``region_id`` or ``region_code`` - stored terrain plus current
      weather, the normal path;
    * by ``latitude``/``longitude`` - the nearest monitored region's terrain is
      used, and the response says how far away it was, because a prediction
      made from terrain 40 km distant deserves to be read differently;
    * either of those with rainfall or soil-moisture overrides, which marks the
      result SIMULATED.

    Overrides are validated by the schema (no negative rainfall, moisture
    within 0-100), so anything arriving here is already in range.
    """
    overrides = {
        name: getattr(request, name)
        for name in (
            "rainfall_1h", "rainfall_6h", "rainfall_24h", "rainfall_72h",
            "rainfall_7d", "rainfall_anomaly", "soil_moisture",
        )
        if getattr(request, name) is not None
    }

    region = find_region(db, request.region_id or request.region_code)
    distance_km: float | None = None

    if region is None:
        if request.latitude is None or request.longitude is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Name a region (region_id or region_code) or give "
                    "latitude and longitude."
                ),
            )
        # An arbitrary point: borrow the nearest region's terrain and say so.
        from ..services.report_service import nearest_region

        region, distance_km = nearest_region(db, request.latitude, request.longitude)
        if region is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=(
                    "That point is more than 60 km from any monitored region, "
                    "so there is no terrain data to score it against."
                ),
            )

    scenario = scenario_module.get(request.scenario).key
    payload = risk_engine.score_region(
        region,
        scenario_key=scenario,
        explain=request.explain,
        overrides=overrides or None,
    )

    if overrides:
        # A score built on supplied numbers is a hypothesis, not an
        # observation, and it must not be filed as one.
        payload = dict(payload)
        payload["data_mode"] = "SIMULATED"
        payload["scenario"] = f"{scenario}+OVERRIDE"
    else:
        risk_engine.persist(db, payload)
        db.commit()

    response = {
        key: payload.get(key)
        for key in (
            "region_id", "region_code", "region_name", "risk_score", "risk_level",
            "confidence", "probability", "model_backend", "model_name",
            "model_version", "scenario", "data_mode", "defaulted_fields",
            "top_factors", "explanation", "features", "predicted_at",
        )
    }
    response["terrain"] = terrain_service.describe(region)
    response["overrides_applied"] = overrides or None
    if distance_km is not None:
        response["nearest_region_km"] = round(distance_km, 1)
        response["note"] = (
            f"Scored using terrain from {region.name}, {round(distance_km, 1)} km "
            "away. Treat as indicative for the requested point."
        )
    return response


@router.post("/what-if", summary="Re-score a region under changed conditions")
def what_if(request: WhatIfIn, db: DbSession) -> dict[str, Any]:
    """The simulator behind the What-If panel.

    Returns the baseline and the modified prediction side by side, the list of
    what changed, and a sentence saying what it means. Rainfall is scaled
    across all five accumulation windows with a realistic reach per window,
    and soil moisture follows rainfall unless it is pinned - so the model never
    sees a physically impossible combination it was not trained on.
    """
    region = find_region(db, request.region_id)
    if region is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No monitored region with id {request.region_id}.",
        )
    result = whatif_service.run(region, request.model_dump(exclude_none=True))
    return result
