"""The what-if simulator: counterfactual scoring through the real model.

An officer asks "what happens here if the rain doubles?", or "would this slope
still be safe if we cleared the plantation above the road?". This module
answers by changing the input and running the same model, then reporting both
scores side by side with the difference explained.

Two things it is careful about
------------------------------
**Rainfall windows move together.** Doubling the hourly rate without moving the
6, 24, 72-hour and 7-day totals would produce a feature vector no real storm
ever generated - the model would be extrapolating outside its training
distribution and the answer would be meaningless. So a multiplier is applied
across the accumulation windows with a shorter reach on the long ones (a
cloudburst changes the last hour completely and the last week only a little),
and the monotonic ordering the model was trained on is preserved.

**Soil moisture follows rainfall unless it is pinned.** More rain on the same
ground means wetter ground. If the user has not set the moisture slider
explicitly, it rises with the added rainfall through the same storage
relationship the water balance uses, capped at saturation.

Everything here is labelled SIMULATED. A what-if result is a question the
officer asked, not a forecast.
"""
from __future__ import annotations

import logging
from typing import Any, Mapping

from ..models import Region
from . import risk_engine
from . import scenario as scenario_module
from . import weather_service

LOG = logging.getLogger("app.whatif")

# How far a rainfall multiplier reaches into each accumulation window. A
# cloudburst replaces this hour's rain entirely; it changes the seven-day total
# much less, because most of that water already fell.
_WINDOW_REACH = {
    "rainfall_1h": 1.00,
    "rainfall_6h": 0.85,
    "rainfall_24h": 0.65,
    "rainfall_72h": 0.40,
    "rainfall_7d": 0.25,
}

# Keyed on the *request* field names in ``WhatIfIn``, not on the model feature
# names they end up affecting - these labels are read straight off the slider a
# user moved, and "soil_moisture_pct" on screen would be a leak of the wire
# format into the interface.
_LABELS = {
    "rainfall_multiplier": ("Rainfall intensity", "x"),
    "rainfall_add_mm_h": ("Added rainfall", " mm/h"),
    "soil_moisture_pct": ("Soil moisture", "%"),
    "slope_deg": ("Slope angle", "°"),
    "vegetation_index": ("Vegetation cover", ""),
    "distance_to_river_km": ("Distance to river", " km"),
    "historical_landslide_count": ("Recorded landslides", ""),
    "future_hours": ("Lead time", " h"),
}


def _input_label(field: str) -> str:
    """The human name for a changed input, falling back to a readable form."""
    entry = _LABELS.get(field)
    if entry is not None:
        return entry[0]
    return field.replace("_", " ").capitalize()


def _input_text(field: str, value: Any) -> str:
    """The value as the slider expressed it, with its unit."""
    entry = _LABELS.get(field)
    unit = entry[1] if entry is not None else ""
    if isinstance(value, float) and not value.is_integer():
        rendered = f"{value:g}"
    else:
        rendered = f"{int(value)}" if isinstance(value, (int, float)) else str(value)
    return f"{rendered}{unit}" if unit != "x" else f"{rendered}x"


def _scaled_rainfall(base: Mapping[str, Any], multiplier: float, add_mm_h: float) -> dict[str, float]:
    """Apply a multiplier and an absolute addition across the five windows."""
    out: dict[str, float] = {}
    for name, reach in _WINDOW_REACH.items():
        current = float(base.get(name) or 0.0)
        effective = 1.0 + (multiplier - 1.0) * reach
        # An absolute addition in mm/h accumulates over the window it covers.
        hours = {"rainfall_1h": 1, "rainfall_6h": 6, "rainfall_24h": 24,
                 "rainfall_72h": 72, "rainfall_7d": 168}[name]
        added = add_mm_h * min(hours, 24) * reach
        out[name] = round(max(0.0, current * effective + added), 2)

    # Preserve the ordering the model was trained on.
    out["rainfall_6h"] = max(out["rainfall_6h"], out["rainfall_1h"])
    out["rainfall_24h"] = max(out["rainfall_24h"], out["rainfall_6h"])
    out["rainfall_72h"] = max(out["rainfall_72h"], out["rainfall_24h"])
    out["rainfall_7d"] = max(out["rainfall_7d"], out["rainfall_72h"])
    return out


def _moisture_response(base_pct: float, extra_24h_mm: float) -> float:
    """How much wetter the ground gets from extra rain over a day.

    Storage response saturates: the first 50 mm on dry ground raises volumetric
    water content sharply, the next 200 mm mostly runs off. Modelled as a
    diminishing curve towards the same 62% saturation ceiling the water balance
    in ``ml/hydrology.py`` uses.
    """
    if extra_24h_mm <= 0.0:
        return base_pct
    headroom = max(0.0, 62.0 - base_pct)
    uptake = 1.0 - pow(2.718281828, -extra_24h_mm / 90.0)
    return round(min(62.0, base_pct + headroom * uptake), 2)


def _changes(baseline: Mapping[str, Any], modified: Mapping[str, Any],
             request: Mapping[str, Any]) -> dict[str, Any]:
    """What the user changed, what it did, and by how much."""
    base_features = baseline["features"]
    mod_features = modified["features"]
    moved = []
    for name in base_features:
        before, after = float(base_features[name]), float(mod_features[name])
        if abs(after - before) > 1e-6:
            moved.append(
                {
                    "feature": name,
                    "label": name.replace("_", " ").capitalize(),
                    "before": round(before, 3),
                    "after": round(after, 3),
                    "delta": round(after - before, 3),
                }
            )
    moved.sort(key=lambda m: -abs(m["delta"]))

    delta_score = round(float(modified["risk_score"]) - float(baseline["risk_score"]), 1)
    return {
        "risk_score_before": float(baseline["risk_score"]),
        "risk_score_after": float(modified["risk_score"]),
        "risk_score_delta": delta_score,
        "risk_level_before": baseline["risk_level"],
        "risk_level_after": modified["risk_level"],
        "band_changed": baseline["risk_level"] != modified["risk_level"],
        "confidence_before": float(baseline["confidence"]),
        "confidence_after": float(modified["confidence"]),
        "inputs_changed": [
            {
                "field": k,
                "label": _input_label(k),
                "value": v,
                "value_text": _input_text(k, v),
            }
            for k, v in request.items()
            if v is not None and k not in ("region_id",)
        ],
        "features_changed": moved,
    }


def _interpretation(region: Region, changes: Mapping[str, Any]) -> str:
    delta = float(changes["risk_score_delta"])
    after = float(changes["risk_score_after"])
    before = float(changes["risk_score_before"])
    level_after = changes["risk_level_after"]

    if abs(delta) < 0.5:
        return (
            f"These changes barely move {region.name}: {before:.0f}/100 becomes "
            f"{after:.0f}/100, still {level_after}. The dominant drivers here are "
            "the ones you did not change."
        )

    direction = "rises" if delta > 0 else "falls"
    sentence = (
        f"{region.name} {direction} from {before:.0f}/100 "
        f"({changes['risk_level_before']}) to {after:.0f}/100 ({level_after}), "
        f"a change of {delta:+.1f} points."
    )
    if changes["band_changed"] and delta > 0:
        if level_after == "CRITICAL":
            sentence += (
                " That crosses the CRITICAL threshold - under these conditions the "
                "platform would raise a critical alert and recommend evacuation of "
                "households below unstable slopes."
            )
        elif level_after == "HIGH":
            sentence += (
                " That crosses the HIGH threshold - the platform would raise a high "
                "alert and place response teams on standby."
            )
        else:
            sentence += f" That moves the region into the {level_after} band."
    elif changes["band_changed"]:
        sentence += f" That brings the region back down into the {level_after} band."

    return sentence + " SIMULATED - a hypothetical, not a forecast."


def run(region: Region, request: Mapping[str, Any], *, scenario_key: str | None = None) -> dict[str, Any]:
    """Score a region as it is, then as the user has described it.

    Both scores come from the same model and the same feature contract, so the
    difference between them is attributable entirely to the inputs the user
    changed.
    """
    scn = scenario_module.get(scenario_key)
    future_hours = int(request.get("future_hours") or 0)

    if future_hours > 0:
        readings = weather_service.forecast_hours(region, (0, future_hours), scenario_key=scn.key)
        base_weather, target_weather = readings[0], readings[1]
    else:
        base_weather = weather_service.current(region, scenario_key=scn.key)
        target_weather = base_weather

    baseline = risk_engine.score_region(
        region, scenario_key=scn.key, weather=base_weather, use_cache=False
    )

    # --- build the modified weather -------------------------------------
    multiplier = request.get("rainfall_multiplier")
    add_mm_h = float(request.get("rainfall_add_mm_h") or 0.0)
    modified_weather = dict(target_weather)

    if multiplier is not None or add_mm_h > 0.0:
        scaled = _scaled_rainfall(target_weather, float(multiplier or 1.0), add_mm_h)
        modified_weather.update(scaled)
        base_24h = float(target_weather.get("rainfall_24h") or 0.0)
        extra_24h = max(0.0, scaled["rainfall_24h"] - base_24h)
        if request.get("soil_moisture_pct") is None and extra_24h > 0.0:
            modified_weather["soil_moisture_pct"] = _moisture_response(
                float(target_weather.get("soil_moisture_pct") or 18.0), extra_24h
            )
        # The anomaly ratio is 7-day rainfall against the seasonal normal, so
        # it has to move with the rainfall or the model sees a contradiction.
        base_7d = float(target_weather.get("rainfall_7d") or 0.0)
        if base_7d > 1.0:
            ratio = scaled["rainfall_7d"] / base_7d
            modified_weather["rainfall_anomaly"] = round(
                min(12.0, float(target_weather.get("rainfall_anomaly") or 1.0) * ratio), 3
            )

    if request.get("soil_moisture_pct") is not None:
        modified_weather["soil_moisture_pct"] = float(request["soil_moisture_pct"])

    # --- terrain overrides ----------------------------------------------
    overrides: dict[str, float] = {}
    for field, feature in (
        ("slope_deg", "slope"),
        ("vegetation_index", "vegetation_index"),
        ("distance_to_river_km", "distance_to_river"),
        ("historical_landslide_count", "historical_landslide_count"),
    ):
        if request.get(field) is not None:
            overrides[feature] = float(request[field])

    modified = risk_engine.score_region(
        region,
        scenario_key=scn.key,
        weather=modified_weather,
        overrides=overrides or None,
        use_cache=False,
    )
    modified["data_mode"] = "SIMULATED"
    modified["scenario"] = f"{scn.key}+WHATIF"

    changes = _changes(baseline, modified, request)
    if future_hours > 0:
        changes["lead_time_hours"] = future_hours

    return {
        "region": {
            "id": region.id,
            "code": region.code,
            "name": region.name,
            "district": region.district,
            "state": region.state,
            "latitude": region.latitude,
            "longitude": region.longitude,
            "population_exposed": region.population_exposed,
        },
        "baseline": baseline,
        "modified": modified,
        "changes": changes,
        "interpretation": _interpretation(region, changes),
        "scenario": scn.key,
        "scenario_label": scn.label,
        "data_mode": "SIMULATED",
        "note": (
            "A what-if result is a hypothesis produced by the same model from "
            "conditions you supplied. It is labelled SIMULATED and is never "
            "stored as a prediction or used to raise an alert."
        ),
    }


__all__ = ["run"]
