"""Turn a prediction into an explanation an officer can act on.

Why this is its own module
--------------------------
The specification calls explainable AI a critical feature, and the panel it
feeds has to make sense to someone who has never heard of gradient boosting.
Two things follow from that:

* the numbers must be genuinely *additive*, so "these drivers account for the
  score" is literally true rather than a figure of speech;
* they must survive whichever backend trained the model - and the case where
  there is no trained model at all.

So four strategies are tried in order, and the one actually used is always
reported back to the caller and shown in the UI:

  1. ``shap.TreeExplainer`` - exact Shapley values, when shap is installed.
  2. XGBoost's built-in ``pred_contribs`` - the same TreeSHAP algorithm,
     without needing the shap package.
  3. Tree path attribution - each split's change in predicted value charged to
     the feature that caused it (Saabas). Exactly additive, pure NumPy, and it
     works on the bundled fallback model.
  4. ``ml.physics.physics_contributions`` - used when no model is loaded, so
     the panel degrades to a documented physical breakdown rather than going
     blank.

Everything is measured against the same reference: **this same slope on a calm,
dry day**. That answers the question an officer actually asks - why is this
place elevated *now* - instead of comparing it against an average slope
somewhere else in the country.
"""
from __future__ import annotations

from typing import Any, Sequence

import numpy as np

from .features import (
    FACTOR_GROUPS,
    FEATURE_ORDER,
    GROUP_ORDER,
    LAND_COVERS,
    SOIL_TYPES,
    UNITS,
)
from .physics import calm_baseline, log_odds, physics_contributions

IDX = {name: i for i, name in enumerate(FEATURE_ORDER)}

METHOD_LABELS = {
    "shap": "SHAP (exact Shapley values)",
    "xgboost-treeshap": "TreeSHAP (XGBoost built-in)",
    "tree-path": "Tree path attribution",
    "physics": "Physical model breakdown (no ML model loaded)",
}

# What each method measures the contribution *against*. Stating it matters: a
# driver's share is only meaningful relative to a reference point, and the two
# families use different ones.
METHOD_REFERENCE = {
    "shap": "the average location in the training set",
    "xgboost-treeshap": "the average location in the training set",
    "tree-path": "the average location in the training set",
    "physics": "this same location in calm, dry conditions",
}

DISCLAIMER = (
    "Explanations describe why the model produced this score. They are decision "
    "support and do not replace assessment by a qualified geotechnical engineer."
)


# ------------------------------------------------------------------- evidence

def _wetness_word(value: float) -> str:
    if value < 15.0:
        return "dry"
    if value < 25.0:
        return "moist"
    if value < 35.0:
        return "wet"
    if value < 45.0:
        return "very wet"
    return "near saturation"


def evidence(x: np.ndarray) -> dict[str, str]:
    """One plain-language line of evidence per driver group.

    The contribution number says *how much* a driver mattered; this says *what
    was observed*. Both are needed - a bar labelled "34%" means nothing to a
    district officer without "412 mm of rain fell over the last 7 days".
    """
    x = np.asarray(x, dtype=float).ravel()

    def v(name: str) -> float:
        return float(x[IDX[name]])

    soil = SOIL_TYPES[int(np.clip(v("soil_type"), 0, 7))].replace("_", " ").lower()
    cover = LAND_COVERS[int(np.clip(v("land_cover"), 0, 7))].replace("_", " ").lower()
    return {
        "Heavy rainfall": (
            f"{v('rainfall_24h'):.0f} mm in 24 h, {v('rainfall_6h'):.0f} mm in the last 6 h"
        ),
        "Antecedent rainfall": (
            f"{v('rainfall_7d'):.0f} mm over 7 days, "
            f"{v('rainfall_anomaly'):.1f}x the seasonal normal"
        ),
        "Soil moisture": (
            f"{v('soil_moisture'):.0f}% water by volume - {_wetness_word(v('soil_moisture'))}"
        ),
        "Slope steepness": f"{v('slope'):.0f} degree slope",
        "Historical activity": (
            f"{v('historical_landslide_count'):.0f} landslides on record in this region"
        ),
        "Soil and land cover": (
            f"{soil} soil under {cover} cover, vegetation index {v('vegetation_index'):.2f}"
        ),
        "Terrain relief": (
            f"{v('elevation'):.0f} m elevation, {v('distance_to_river'):.1f} km to the nearest river"
        ),
        "Weather conditions": f"{v('temperature'):.0f} C air temperature, {v('humidity'):.0f}% humidity",
    }


# --------------------------------------------------------------- attribution

def _shap_values(members: Sequence[Any], X: np.ndarray) -> tuple[np.ndarray, float] | None:
    """Exact Shapley values and expected value, averaged over the bagged members."""
    try:
        import shap
    except Exception:
        return None
    try:
        stacked: list[np.ndarray] = []
        bases: list[float] = []
        for model in members:
            explainer = shap.TreeExplainer(model)
            raw = explainer.shap_values(X)
            arr = np.asarray(raw[1] if isinstance(raw, list) else raw, dtype=float)
            if arr.ndim == 3:  # (rows, features, classes)
                arr = arr[..., -1]
            stacked.append(arr)
            expected = explainer.expected_value
            bases.append(float(np.asarray(expected, dtype=float).ravel()[-1]))
        return np.mean(stacked, axis=0), float(np.mean(bases))
    except Exception:
        # shap is installed but does not understand this estimator; the caller
        # will fall through to the next strategy rather than fail the request.
        return None


def _xgboost_contribs(members: Sequence[Any], X: np.ndarray) -> tuple[np.ndarray, float] | None:
    """XGBoost's own TreeSHAP; the final column is the bias term."""
    try:
        import xgboost as xgb
    except Exception:
        return None
    try:
        matrix = xgb.DMatrix(X)
        stacked = [
            np.asarray(m.get_booster().predict(matrix, pred_contribs=True), dtype=float)
            for m in members
        ]
        mean = np.mean(stacked, axis=0)
        return mean[:, :-1], float(mean[0, -1])
    except Exception:
        return None


def _path_values(members: Sequence[Any], x: np.ndarray) -> tuple[np.ndarray, float]:
    """Mean path attribution over members of the bundled NumPy model."""
    total = np.zeros(len(FEATURE_ORDER), dtype=float)
    baseline = 0.0
    for model in members:
        vector, base = model.contributions(x)
        total += vector
        baseline += base
    n = max(1, len(members))
    return total / n, baseline / n


def feature_contributions(
    x: np.ndarray, members: Sequence[Any] | None = None
) -> tuple[np.ndarray, float, str]:
    """Per-feature contribution to the log-odds, its baseline, and the method used.

    Whatever comes back is additive: `contributions.sum() + baseline` is the
    model's log-odds for this row. That is what lets the UI present a
    percentage breakdown a reader can take at face value.
    """
    x = np.asarray(x, dtype=float).ravel()
    if members:
        from .fallback_gbm import NumpyGBM

        if all(isinstance(m, NumpyGBM) for m in members):
            vector, baseline = _path_values(members, x)
            return vector, baseline, "tree-path"

        row = x.reshape(1, -1)
        found = _shap_values(members, row)
        if found is not None:
            return np.asarray(found[0], dtype=float).ravel(), found[1], "shap"
        found = _xgboost_contribs(members, row)
        if found is not None:
            return np.asarray(found[0], dtype=float).ravel(), found[1], "xgboost-treeshap"

    return physics_contributions(x), float(log_odds(calm_baseline(x))[0]), "physics"


# -------------------------------------------------------------------- shaping

def group_totals(vector: np.ndarray) -> dict[str, float]:
    """Collapse 16 machine features into the 8 human driver groups."""
    totals = {name: 0.0 for name in GROUP_ORDER}
    for i, feature in enumerate(FEATURE_ORDER):
        totals[FACTOR_GROUPS[feature]] += float(vector[i])
    return totals


def _join(parts: list[str]) -> str:
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0]
    return ", ".join(parts[:-1]) + " and " + parts[-1]


def _narrative(
    level: str | None,
    raising: list[dict[str, Any]],
    protective: list[dict[str, Any]],
    *,
    up: float,
    down: float,
) -> str:
    """One sentence a district officer can read without any ML background.

    Which half of the story leads depends on which half is larger. On a calm
    day the honest sentence is "dry soil is keeping this stable", not a list of
    the three weak things nudging risk upwards.
    """
    prefix = f"Risk is {level}" if level else "This score"
    if raising and up >= down:
        named = [f"{f['factor'].lower()} ({f['contribution']:.0f}%)" for f in raising[:3]]
        return f"{prefix} mainly because of {_join(named)}."
    if protective:
        held = _join([f["factor"].lower() for f in protective[:2]])
        if raising:
            top = raising[0]
            return (
                f"{prefix}: {held} are keeping this slope stable, and the strongest "
                f"upward pressure is {top['factor'].lower()} ({top['contribution']:.0f}%)."
            )
        return f"{prefix}: {held} are keeping this slope stable."
    if raising:
        named = [f"{f['factor'].lower()} ({f['contribution']:.0f}%)" for f in raising[:3]]
        return f"{prefix} mainly because of {_join(named)}."
    return f"{prefix}, with no single driver standing out."


def explain_row(
    x: np.ndarray,
    members: Sequence[Any] | None = None,
    *,
    level: str | None = None,
    top_k: int = 5,
) -> dict[str, Any]:
    """Full explanation payload for one prediction.

    `top_factors` answers "what is pushing this up", ranked by how much of the
    model's total consideration each driver accounted for. Factors that
    *reduce* risk are reported separately instead of being netted off and
    hidden - "the forest cover here is the reason this is not worse" is useful
    information, and hiding it would make the panel look like it only ever
    finds bad news.
    """
    x = np.asarray(x, dtype=float).ravel()
    vector, baseline, method = feature_contributions(x, members)
    totals = group_totals(vector)
    notes = evidence(x)

    # Shares are taken over the *total* movement the model weighed, in both
    # directions, so a bar means the same thing wherever it appears. Sharing
    # only the upward push out of 100 would have made a single small protective
    # factor read as "100% of what is holding this slope stable".
    movement = sum(abs(value) for value in totals.values())
    floor = 0.02 * movement
    denominator = movement if movement > 1e-9 else 1.0

    factors: list[dict[str, Any]] = []
    for name in GROUP_ORDER:
        value = totals[name]
        if value > floor:
            direction = "increases"
        elif value < -floor:
            direction = "reduces"
        else:
            direction = "neutral"
        factors.append(
            {
                "factor": name,
                "contribution": round(float(abs(value) / denominator * 100.0), 1),
                "log_odds": round(float(value), 4),
                "direction": direction,
                "evidence": notes[name],
            }
        )

    raising = sorted(
        (f for f in factors if f["direction"] == "increases"),
        key=lambda f: -f["contribution"],
    )[:top_k]
    protective = sorted(
        (f for f in factors if f["direction"] == "reduces"),
        key=lambda f: -f["contribution"],
    )[:top_k]

    detail = sorted(
        (
            {
                "feature": name,
                "value": round(float(x[i]), 3),
                "unit": UNITS[name],
                "group": FACTOR_GROUPS[name],
                "log_odds": round(float(vector[i]), 4),
            }
            for i, name in enumerate(FEATURE_ORDER)
        ),
        key=lambda row: -abs(row["log_odds"]),
    )

    return {
        "method": method,
        "method_label": METHOD_LABELS.get(method, method),
        "reference": METHOD_REFERENCE.get(method, "the model baseline"),
        "additive": True,
        "share_basis": "percent of the total influence the model weighed for this location",
        "baseline_log_odds": round(float(baseline), 4),
        "total_log_odds": round(float(baseline + vector.sum()), 4),
        "top_factors": raising,
        "protective_factors": protective,
        "factors": sorted(factors, key=lambda f: -abs(f["log_odds"])),
        "feature_detail": detail,
        "summary": _narrative(
            level,
            raising,
            protective,
            up=sum(v for v in totals.values() if v > 0.0),
            down=sum(-v for v in totals.values() if v < 0.0),
        ),
        "disclaimer": DISCLAIMER,
    }

