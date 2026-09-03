"""The risk engine: features in, a stored, explainable score out.

Every risk number the platform shows passes through here - the map, the region
panel, the forecast, the what-if simulator, the alerts. That is deliberate. One
path means one definition of a score, one place where provenance is stamped,
and one place where the 0-100 band boundaries are applied.

Shape of a scoring pass
-----------------------
1. ``terrain_service`` supplies the seven static features for the region.
2. ``weather_service`` supplies the nine dynamic ones for the requested moment,
   with the active scenario already applied to the rainfall.
3. ``ml.predict`` scores the assembled 16-feature row, returning the score, the
   band, a measured confidence and (optionally) the additive explanation.
4. The result is written to ``risk_predictions`` with the exact feature vector
   that produced it, so the score can be re-justified later.

Caching
-------
DEMO weather is deterministic per region per hour, so a score is too. A short
in-process cache keyed on (region, scenario version, hour, model path) keeps a
dashboard poll from re-running 74 inferences every sixty seconds, and it is
invalidated automatically when the scenario changes because the scenario
version is part of the key. Nothing is cached across an hour boundary, so the
platform still moves with time.

Persistence
-----------
Writing every inference for every region on every poll would grow the table
without adding information, so a row is persisted when the score is materially
new: a different band, a move of more than two points, a scenario change, or
more than ``refresh_seconds`` since the last stored row. Alert evaluation runs
on the persisted row.
"""
from __future__ import annotations

import json
import logging
import threading
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterable, Mapping, Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..clock import as_utc, floor_hour, utcnow
from ..config import ensure_ml_importable, settings
from ..models import Region, RiskPrediction
from . import scenario as scenario_module
from . import terrain_service, weather_service

ensure_ml_importable()

from ml.features import FEATURE_ORDER, SERVING_DEFAULTS, risk_level  # noqa: E402
from ml.predict import model_info, predict as ml_predict  # noqa: E402
from ml.predict import predict_batch as ml_predict_batch  # noqa: E402

LOG = logging.getLogger("app.risk")

# Weather keys -> model feature names. The weather service speaks in units
# ("_pct", "_c", "_mm"); the model speaks the feature contract.
_WEATHER_MAP = {
    "rainfall_1h": "rainfall_1h",
    "rainfall_6h": "rainfall_6h",
    "rainfall_24h": "rainfall_24h",
    "rainfall_72h": "rainfall_72h",
    "rainfall_7d": "rainfall_7d",
    "rainfall_anomaly": "rainfall_anomaly",
    "soil_moisture_pct": "soil_moisture",
    "temperature_c": "temperature",
    "humidity_pct": "humidity",
}


# --------------------------------------------------------------- assembly

def assemble_features(
    region: Region,
    weather: Mapping[str, Any],
    *,
    overrides: Mapping[str, Any] | None = None,
) -> dict[str, float]:
    """Build the 16-feature row for one region at one moment.

    Missing weather fields are left as ``None`` rather than filled here, so
    ``ml.predict`` records them in ``defaulted_fields`` and lowers the
    confidence accordingly. A gap in the input should be visible in the output.
    """
    row: dict[str, Any] = dict(terrain_service.features(region))
    for source, target in _WEATHER_MAP.items():
        value = weather.get(source)
        row[target] = None if value is None else float(value)
    if overrides:
        for key, value in overrides.items():
            if key in FEATURE_ORDER and value is not None:
                row[key] = float(value)
    return {name: row.get(name) for name in FEATURE_ORDER}


def _clean(row: Mapping[str, Any]) -> dict[str, float]:
    """The feature vector as stored - defaults substituted, floats rounded."""
    return {
        name: round(float(SERVING_DEFAULTS[name] if row.get(name) is None else row[name]), 4)
        for name in FEATURE_ORDER
    }


# ----------------------------------------------------------------- caching

@dataclass
class _Entry:
    key: tuple
    payload: dict[str, Any]
    created: float


class _Cache:
    """Tiny keyed cache. Bounded, thread-safe, no external dependency."""

    def __init__(self, limit: int = 4096) -> None:
        self._items: dict[tuple, _Entry] = {}
        self._limit = limit
        self._lock = threading.Lock()

    def get(self, key: tuple) -> dict[str, Any] | None:
        entry = self._items.get(key)
        return entry.payload if entry else None

    def put(self, key: tuple, payload: dict[str, Any]) -> None:
        with self._lock:
            if len(self._items) >= self._limit:
                # Cheapest sane eviction: drop the oldest quarter.
                oldest = sorted(self._items.values(), key=lambda e: e.created)
                for entry in oldest[: self._limit // 4]:
                    self._items.pop(entry.key, None)
            self._items[key] = _Entry(key, payload, utcnow().timestamp())

    def clear(self) -> None:
        with self._lock:
            self._items.clear()


_cache = _Cache()


def _cache_key(region_id: int, scenario_key: str, moment: datetime, explain: bool) -> tuple:
    return (
        region_id,
        scenario_key,
        scenario_module.state.version,
        int(floor_hour(moment).timestamp()),
        explain,
        str(settings.resolved_model_path),
    )


def reset_cache() -> None:
    """Drop cached scores - after a scenario change, retrain or settings edit."""
    _cache.clear()


# ---------------------------------------------------------------- scoring

def _model_names() -> tuple[str, str]:
    info = model_info(settings.resolved_model_path)
    if info.get("loaded"):
        return (
            str(info.get("model_name") or "landslide-risk-ensemble"),
            str(info.get("model_version") or "1.0.0"),
        )
    return ("physics-fallback", "physics-1.0.0")


def model_status() -> dict[str, Any]:
    """A short answer to "what is scoring these regions right now".

    Used by the health check and by the model badge in the UI header. Kept
    small on purpose - the full card is ``model_card()``.
    """
    info = model_info(settings.resolved_model_path)
    loaded = bool(info.get("loaded"))
    name, version = _model_names()
    return {
        "loaded": loaded,
        "backend": info.get("backend", "physics-fallback"),
        "model_name": name,
        "model_version": version,
        "members": info.get("members"),
        "feature_count": len(FEATURE_ORDER),
        "trained_at": info.get("trained_at"),
        "explanation": info.get(
            "explanation",
            "Trained gradient-boosted ensemble; explanations are exact additive "
            "contributions read from the trees.",
        ),
    }


def model_card() -> dict[str, Any]:
    """The full model card, provenance and limitations first.

    Reads ``ml/model_card.json`` when it is present - written by the training
    run, so it always describes the model actually on disk rather than a
    hand-maintained copy that can drift. If the file is missing the response
    says what is scoring instead, rather than returning nothing.
    """
    status = model_status()
    card_path = settings.resolved_model_path.with_name("model_card.json")
    card: dict[str, Any] = {}
    if card_path.exists():
        try:
            card = json.loads(card_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            LOG.warning("could not read model card %s (%s)", card_path, exc)

    if not card:
        return {
            **status,
            "card_available": False,
            "note": (
                "No model card found beside the model file. Run "
                "`python ml/train_model.py` to produce both."
            ),
        }

    return {
        "card_available": True,
        "status": status,
        "intended_use": card.get("intended_use"),
        "limitations": card.get("limitations", []),
        "data_provenance": card.get("data_provenance", {}),
        "model_name": card.get("model_name"),
        "model_version": card.get("model_version"),
        "feature_schema_version": card.get("feature_schema_version"),
        "feature_order": card.get("feature_order", []),
        "members": card.get("members"),
        "hyperparams": card.get("hyperparams", {}),
        "trained_at": card.get("trained_at"),
        "training_rows": card.get("training_rows"),
        "split_sizes": card.get("split_sizes", {}),
        "regions": card.get("regions", {}),
        "metrics": card.get("metrics", {}),
        "label_noise_ceiling": card.get("label_noise_ceiling", {}),
        "importance_method": card.get("importance_method"),
        "feature_importance": card.get("feature_importance", []),
        "band_distribution": card.get("band_distribution", {}),
        "confidence_reference": card.get("confidence_reference", {}),
        "training_summary": card.get("training_summary", []),
        "note": (
            "Metrics measure how faithfully the model recovers the documented "
            "slope-stability model it was trained against. They are not evidence "
            "of real-world landslide prediction accuracy."
        ),
    }



def score_region(
    region: Region,
    *,
    scenario_key: str | None = None,
    explain: bool = True,
    weather: Mapping[str, Any] | None = None,
    overrides: Mapping[str, Any] | None = None,
    use_cache: bool = True,
) -> dict[str, Any]:
    """Score one region now. The single entry point for a current risk number."""
    scn = scenario_module.get(scenario_key)
    now = utcnow()

    cacheable = use_cache and weather is None and not overrides
    key = _cache_key(region.id, scn.key, now, explain)
    if cacheable:
        hit = _cache.get(key)
        if hit is not None:
            return hit

    reading = dict(weather) if weather is not None else weather_service.current(
        region, scenario_key=scn.key
    )
    row = assemble_features(region, reading, overrides=overrides)
    result = ml_predict(
        row,
        data_mode=scn.data_mode,
        explain=explain,
        path=settings.resolved_model_path,
    )
    model_name, model_version = _model_names()

    payload: dict[str, Any] = {
        "region_id": region.id,
        "region_code": region.code,
        "region_name": region.name,
        "risk_score": result["risk_score"],
        "risk_level": result["risk_level"],
        "confidence": result["confidence"],
        "probability": result["probability"],
        "model_backend": result["model_backend"],
        "model_name": model_name,
        "model_version": model_version,
        "scenario": scn.key,
        "data_mode": scn.data_mode,
        "defaulted_fields": result["defaulted_fields"],
        "top_factors": _factors_out(result.get("top_factors") or [], row),
        "features": _clean(row),
        "predicted_at": now,
        "weather": reading,
    }
    if explain and result.get("explanation"):
        payload["explanation"] = _explanation_out(result["explanation"], row)

    if cacheable:
        _cache.put(key, payload)
    return payload


def score_regions(
    regions: Sequence[Region],
    *,
    scenario_key: str | None = None,
    use_cache: bool = True,
) -> list[dict[str, Any]]:
    """Score many regions in one model call - the risk-map path.

    Explanations are skipped: the map needs every region's score quickly, and
    only the selected region is ever explained. Cache hits are reused and only
    the misses are batched, so a steady dashboard costs almost nothing.
    """
    scn = scenario_module.get(scenario_key)
    now = utcnow()
    results: dict[int, dict[str, Any]] = {}
    pending: list[tuple[Region, dict[str, Any], dict[str, Any]]] = []

    for region in regions:
        key = _cache_key(region.id, scn.key, now, False)
        hit = _cache.get(key) if use_cache else None
        if hit is not None:
            results[region.id] = hit
            continue
        reading = weather_service.current(region, scenario_key=scn.key)
        pending.append((region, reading, assemble_features(region, reading)))

    if pending:
        scored = ml_predict_batch(
            [row for _, _, row in pending],
            data_mode=scn.data_mode,
            path=settings.resolved_model_path,
        )
        model_name, model_version = _model_names()
        for (region, reading, row), outcome in zip(pending, scored):
            payload = {
                "region_id": region.id,
                "region_code": region.code,
                "region_name": region.name,
                "risk_score": outcome["risk_score"],
                "risk_level": outcome["risk_level"],
                "confidence": outcome["confidence"],
                "probability": outcome["probability"],
                "model_backend": outcome["model_backend"],
                "model_name": model_name,
                "model_version": model_version,
                "scenario": scn.key,
                "data_mode": scn.data_mode,
                "defaulted_fields": [n for n in FEATURE_ORDER if row.get(n) is None],
                "top_factors": [],
                "features": _clean(row),
                "predicted_at": now,
                "weather": reading,
            }
            results[region.id] = payload
            if use_cache:
                _cache.put(_cache_key(region.id, scn.key, now, False), payload)

    return [results[r.id] for r in regions if r.id in results]


def score_features(
    row: Mapping[str, Any],
    *,
    data_mode: str = "SIMULATED",
    explain: bool = True,
) -> dict[str, Any]:
    """Score a raw feature dictionary - the what-if and arbitrary-point path."""
    complete = {name: row.get(name) for name in FEATURE_ORDER}
    result = ml_predict(
        complete,
        data_mode=data_mode,
        explain=explain,
        path=settings.resolved_model_path,
    )
    model_name, model_version = _model_names()
    payload: dict[str, Any] = {
        "region_id": None,
        "region_code": None,
        "region_name": None,
        "risk_score": result["risk_score"],
        "risk_level": result["risk_level"],
        "confidence": result["confidence"],
        "probability": result["probability"],
        "model_backend": result["model_backend"],
        "model_name": model_name,
        "model_version": model_version,
        "scenario": "CUSTOM",
        "data_mode": data_mode,
        "defaulted_fields": result["defaulted_fields"],
        "top_factors": _factors_out(result.get("top_factors") or [], complete),
        "features": _clean(complete),
        "predicted_at": utcnow(),
    }
    if explain and result.get("explanation"):
        payload["explanation"] = _explanation_out(result["explanation"], complete)
    return payload


# ------------------------------------------------------------ presentation

_GROUP_VALUE_FEATURE = {
    "Heavy rainfall": "rainfall_24h",
    "Antecedent rainfall": "rainfall_7d",
    "Soil moisture": "soil_moisture",
    "Slope steepness": "slope",
    "Historical activity": "historical_landslide_count",
    "Soil and land cover": "vegetation_index",
    "Terrain relief": "elevation",
    "Weather conditions": "humidity",
}

_GROUP_VALUE_TEXT = {
    "Heavy rainfall": "{:.0f} mm in 24 h",
    "Antecedent rainfall": "{:.0f} mm over 7 days",
    "Soil moisture": "{:.0f}% water by volume",
    "Slope steepness": "{:.0f} degree slope",
    "Historical activity": "{:.0f} recorded landslides",
    "Soil and land cover": "vegetation index {:.2f}",
    "Terrain relief": "{:.0f} m elevation",
    "Weather conditions": "{:.0f}% humidity",
}


def _representative(group: str, row: Mapping[str, Any]) -> tuple[float, str]:
    feature = _GROUP_VALUE_FEATURE.get(group, "slope")
    raw = row.get(feature)
    value = float(SERVING_DEFAULTS[feature] if raw is None else raw)
    return value, _GROUP_VALUE_TEXT.get(group, "{:.1f}").format(value)


def _factors_out(factors: Iterable[Mapping[str, Any]], row: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Reshape ``ml.explain`` groups into the API's FactorOut contract.

    ``ml.explain`` reports two different numbers per group and both are worth
    keeping: ``log_odds`` is the signed effect on the model's decision, and
    ``contribution`` is that effect as a percentage of the total movement the
    model weighed in *both* directions. The percentage is what the UI draws,
    because "rainfall accounts for 46% of why this slope is at risk" needs no
    machine-learning vocabulary to read; the signed log-odds is kept so the
    number can be audited against ``baseline_log_odds`` and ``total_log_odds``.
    """
    out: list[dict[str, Any]] = []
    for item in factors:
        name = str(item.get("factor", ""))
        value, text = _representative(name, row)
        share = float(item.get("contribution", 0.0))
        direction = str(item.get("direction", "neutral"))
        out.append(
            {
                "feature": name.lower().replace(" ", "_"),
                "label": name,
                # Signed: negative means this group argued the slope was safer.
                "contribution": round(float(item.get("log_odds", 0.0)), 4),
                "direction": {"reduces": "lowering", "increases": "raising"}.get(
                    direction, "neutral"
                ),
                "share_percent": round(share, 1),
                "value": round(value, 3),
                "value_text": text,
                "evidence": item.get("evidence"),
            }
        )
    return out


def _explanation_out(detail: Mapping[str, Any], row: Mapping[str, Any]) -> dict[str, Any]:
    feature_detail = [
        {
            "feature": item["feature"],
            "label": item["feature"].replace("_", " ").capitalize(),
            "value": float(item["value"]),
            "value_text": f"{item['value']:g} {item['unit']}",
            "contribution": float(item["log_odds"]),
            "share_percent": 0.0,
        }
        for item in detail.get("feature_detail", [])
    ]
    total = sum(abs(f["contribution"]) for f in feature_detail) or 1.0
    for item in feature_detail:
        item["share_percent"] = round(abs(item["contribution"]) / total * 100.0, 1)

    return {
        "method": detail.get("method", "physics"),
        "method_label": detail.get("method_label", ""),
        "reference": detail.get("reference", ""),
        "additive": bool(detail.get("additive", True)),
        "share_basis": detail.get("share_basis", ""),
        "baseline_log_odds": float(detail.get("baseline_log_odds", 0.0)),
        "total_log_odds": float(detail.get("total_log_odds", 0.0)),
        "top_factors": _factors_out(detail.get("top_factors") or [], row),
        "protective_factors": _factors_out(detail.get("protective_factors") or [], row),
        "factors": _factors_out(detail.get("factors") or [], row),
        "feature_detail": feature_detail,
        "summary": detail.get("summary", ""),
        "disclaimer": detail.get("disclaimer", ""),
    }


# ----------------------------------------------------------- persistence

def latest_prediction(db: Session, region_id: int) -> RiskPrediction | None:
    return db.scalars(
        select(RiskPrediction)
        .where(RiskPrediction.region_id == region_id)
        .order_by(RiskPrediction.predicted_at.desc())
        .limit(1)
    ).first()


def _worth_storing(previous: RiskPrediction | None, payload: Mapping[str, Any]) -> bool:
    """Is this score new information, or the same picture a minute later?"""
    if previous is None:
        return True
    if previous.risk_level != payload["risk_level"]:
        return True
    if previous.scenario != payload["scenario"]:
        return True
    if abs(float(previous.risk_score) - float(payload["risk_score"])) > 2.0:
        return True
    stamp = as_utc(previous.predicted_at)
    if stamp is None:
        return True
    return (utcnow() - stamp).total_seconds() >= max(60, settings.refresh_seconds)


def persist(
    db: Session, payload: Mapping[str, Any], *, force: bool = False
) -> tuple[RiskPrediction | None, bool]:
    """Store a prediction if it carries new information.

    Returns ``(row, created)``. When the score is not materially new the
    previous row is returned with ``created=False``, so callers can report how
    many inferences actually changed the record.
    """
    region_id = payload.get("region_id")
    if region_id is None:
        return None, False
    previous = latest_prediction(db, int(region_id))
    if not force and not _worth_storing(previous, payload):
        return previous, False

    explanation = payload.get("explanation") or {}
    record = RiskPrediction(
        region_id=int(region_id),
        predicted_at=payload["predicted_at"],
        risk_score=float(payload["risk_score"]),
        risk_level=str(payload["risk_level"]),
        # The API reports confidence 0-100; the column stores 0-1.
        confidence=round(float(payload["confidence"]) / 100.0, 4),
        model_name=str(payload["model_name"]),
        model_version=str(payload["model_version"]),
        model_backend=str(payload["model_backend"]),
        explainer=explanation.get("method"),
        scenario=str(payload["scenario"]),
        data_mode=str(payload["data_mode"]),
        features=payload.get("features"),
        top_factors=payload.get("top_factors") or [],
        contributions={
            "baseline_log_odds": explanation.get("baseline_log_odds"),
            "total_log_odds": explanation.get("total_log_odds"),
            "factors": [
                {"label": f["label"], "share_percent": f["share_percent"],
                 "direction": f["direction"]}
                for f in (explanation.get("factors") or [])
            ],
        } if explanation else None,
    )
    db.add(record)
    db.flush()
    return record, True


def score_and_store(
    db: Session,
    region: Region,
    *,
    scenario_key: str | None = None,
    explain: bool = True,
    force: bool = False,
) -> tuple[dict[str, Any], RiskPrediction | None]:
    """Score a region and persist the result. Used wherever alerts may follow."""
    payload = score_region(region, scenario_key=scenario_key, explain=explain)
    record, _ = persist(db, payload, force=force)
    return payload, record


# ------------------------------------------------------------- map helpers

def regions_query(db: Session, *, state: str | None = None, limit: int | None = None):
    """Regions with terrain eagerly loaded - one query, not 74."""
    stmt = select(Region).options(selectinload(Region.terrain)).order_by(Region.name)
    if state:
        stmt = stmt.where(Region.state == state)
    stmt = stmt.limit(limit or settings.max_map_regions)
    return list(db.scalars(stmt).all())


def band_counts(payloads: Iterable[Mapping[str, Any]]) -> dict[str, int]:
    counts = {"VERY LOW": 0, "LOW": 0, "MODERATE": 0, "HIGH": 0, "CRITICAL": 0}
    for item in payloads:
        counts[str(item["risk_level"])] = counts.get(str(item["risk_level"]), 0) + 1
    return counts


def summarise(payloads: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Headline numbers for the map response and the national overview."""
    if not payloads:
        return {
            "count": 0,
            "band_counts": band_counts([]),
            "high_risk_count": 0,
            "critical_count": 0,
            "avg_score": 0.0,
            "max_score": 0.0,
            "country_risk": 0.0,
        }
    scores = [float(p["risk_score"]) for p in payloads]
    counts = band_counts(payloads)
    # The national figure is the mean of the worst decile rather than the
    # national mean: a country-level average is dominated by the many quiet
    # regions and would read "LOW" on the day a district is being evacuated.
    top_n = max(1, len(scores) // 10)
    worst = sorted(scores, reverse=True)[:top_n]
    return {
        "count": len(scores),
        "band_counts": counts,
        "high_risk_count": counts["HIGH"] + counts["CRITICAL"],
        "critical_count": counts["CRITICAL"],
        "avg_score": round(sum(scores) / len(scores), 1),
        "max_score": round(max(scores), 1),
        "country_risk": round(sum(worst) / len(worst), 1),
    }


__all__ = [
    "assemble_features",
    "band_counts",
    "latest_prediction",
    "model_card",
    "model_status",
    "persist",
    "regions_query",
    "reset_cache",
    "risk_level",
    "score_and_store",
    "score_features",
    "score_region",
    "score_regions",
    "summarise",
]
