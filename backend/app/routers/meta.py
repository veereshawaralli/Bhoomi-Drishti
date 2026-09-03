"""Health, platform information, and the model card.

These three endpoints exist so that nothing about the platform's provenance has
to be taken on trust. ``/api/health`` says whether the database and the model
are actually there. ``/api/info`` states which data mode every screen is in and
where the numbers come from. ``/api/model-info`` returns the model card: how it
was trained, on what, how well it scored, and - stated plainly - that it was
trained on simulated labels and has not been validated against the observed
landslide record.

That last point is the one that matters most. A model card that only lists
favourable metrics is a sales document. This one leads with what the metrics do
not prove.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter

from ..config import ensure_ml_importable, settings
from ..database import healthcheck
from ..services import overview_service, risk_engine
from ..services import scenario as scenario_module
from ..services import weather_service
from .deps import DbSession

ensure_ml_importable()

from ml.features import RISK_BANDS as ENGINE_BANDS  # noqa: E402

LOG = logging.getLogger("app.api.meta")

router = APIRouter(tags=["meta"])

# The legend is derived from the engine's own boundaries rather than retyped, because
# the two drifting apart is exactly the bug that puts a score of 60.0 in MODERATE on
# one screen and HIGH on another. `ml.features.RISK_BANDS` is half-open — a score is
# HIGH from 60.0 up to but not including 80.0 — so `min`/`max` here are the real
# comparison bounds and `range` is the inclusive-integer label the brief uses for
# display. Anything banding a bare score should use `min`/`max`.
_BAND_MEANING = {
    "VERY LOW": "No action needed beyond routine monitoring.",
    "LOW": "Conditions are being watched; nothing to act on.",
    "MODERATE": "Worth attention. Review again within six hours.",
    "HIGH": "High alert. Warn residents, place teams on standby.",
    "CRITICAL": "Critical alert. Consider evacuation and road closures.",
}
_BAND_COLOUR = {
    "VERY LOW": "emerald",
    "LOW": "lime",
    "MODERATE": "amber",
    "HIGH": "orange",
    "CRITICAL": "red",
}

RISK_BANDS = [
    {
        "level": level,
        "min": round(low, 2),
        "max": round(min(high, 100.0), 2),
        "range": f"{int(low) + (1 if low > 0 else 0)}-{int(min(high, 100.0))}",
        "colour": _BAND_COLOUR[level],
        "meaning": _BAND_MEANING[level],
    }
    for low, high, level in ENGINE_BANDS
]


@router.get("/health", summary="Is the platform up")
def health(db: DbSession) -> dict[str, Any]:
    """Liveness plus the two things that decide whether answers are meaningful.

    Cheap by design: row counts and a model-file check, no inference. A
    monitoring probe should not cost 74 model evaluations every thirty seconds.
    """
    probe = healthcheck()
    db_ok = bool(probe.get("connected"))
    model = risk_engine.model_status()
    counts = overview_service.counts_only(db) if db_ok else {}
    ready = db_ok and counts.get("regions", 0) > 0

    return {
        "status": "ok" if ready else "degraded",
        "database": {
            "connected": db_ok,
            "dialect": probe.get("dialect"),
            "error": probe.get("error"),
            "rows": counts,
        },
        "model": {
            "loaded": bool(model.get("loaded")),
            "backend": model.get("backend"),
            "path": str(settings.resolved_model_path),
        },
        "weather": weather_service.provider_status(),
        "scenario": scenario_module.state.key,
        "ready": ready,
        "detail": (
            "Ready."
            if ready
            else "Database reachable but empty - run the seed step, or check DATABASE_URL."
            if db_ok
            else "Database unreachable. Check DATABASE_URL."
        ),
    }


@router.get("/info", summary="What this platform is and where its data comes from")
def info() -> dict[str, Any]:
    """Identity, data provenance, risk bands and thresholds.

    The frontend reads its band colours, band boundaries and alert thresholds
    from here rather than defining its own copy, so the legend on the map cannot
    disagree with the engine that assigns the bands.
    """
    model = risk_engine.model_status()
    weather = weather_service.provider_status()
    return {
        "name": settings.app_name,
        "version": settings.app_version,
        "tagline": "Predict. Explain. Warn. Respond.",
        "purpose": (
            "Landslide early warning for Indian hill districts: continuous "
            "monitoring, explainable AI prediction, a 72-hour forecast, and an "
            "alert-to-response workflow."
        ),
        "model": model,
        "weather": weather,
        "scenario": {
            "active": scenario_module.state.key,
            "label": scenario_module.state.current.label,
            "version": scenario_module.state.version,
        },
        "data_mode": scenario_module.data_mode_for(),
        "data_provenance": {
            "weather": weather["note"],
            "terrain": (
                "DEMO - approximate elevation, slope, soil and land-cover values "
                "compiled per region. Replace with SRTM/Cartosat DEM and "
                "Bhuvan/ESA land cover for production."
            ),
            "history": (
                "MIXED - documented events are real, publicly reported Indian "
                "landslides; the remainder are modelled for spatial density and "
                "labelled as such per row."
            ),
            "sensors": (
                "SIMULATED - a software model of instrument response. No physical "
                "hardware is involved anywhere in this platform."
            ),
            "labels": (
                "SYNTHETIC - the model was trained on labels drawn from a "
                "documented slope-stability model, not on the observed landslide "
                "record. See /api/model-info."
            ),
        },
        "risk_bands": RISK_BANDS,
        "thresholds": {
            "high": settings.alert_high_threshold,
            "critical": settings.alert_critical_threshold,
        },
        "refresh_seconds": settings.refresh_seconds,
        "max_upload_mb": settings.max_upload_mb,
        "disclaimer": (
            "Demonstration platform. Predictions are produced from modelled "
            "weather and synthetic training labels, and are not operational "
            "forecasts. Do not use for real evacuation decisions."
        ),
    }


@router.get("/model-info", summary="The model card")
def model_info() -> dict[str, Any]:
    """How the model was built, how it performs, and what that does not prove.

    ``limitations`` and ``data_provenance`` are returned before the metrics on
    purpose. The headline test ROC AUC is high, but it measures how faithfully
    the model recovers the physical model it was trained against - not how well
    it predicts real landslides, which nothing here can claim.
    """
    return risk_engine.model_card()
