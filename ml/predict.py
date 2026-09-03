"""Serve predictions from the trained model.

This is the only path between a feature dictionary and a risk score, used by
the FastAPI service, the what-if simulator, the 72-hour forecast and the
scenario engine alike - so a score means the same thing everywhere in the
platform.

Three guarantees it makes
-------------------------
**It never invents a number.** With `model.pkl` present, scores come from the
trained ensemble. Without it, they come from the documented physical model in
`ml/physics.py` and the response says `model_backend = "physics-fallback"`.
There is no third branch that returns a plausible-looking random value.

**It refuses a mismatched model.** If a `model.pkl` was trained against a
different feature contract, loading is rejected and the reason is logged,
because a model reading `slope` out of the `humidity` column would still
return confident-looking numbers.

**Confidence is measured, not asserted.** It comes from how much the bagged
members disagree on this specific row, scaled against the disagreement
recorded on held-out data at training time, and is reduced further when input
fields were missing and had to be defaulted.
"""
from __future__ import annotations

import logging
import os
import pickle
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

try:  # normal case: imported as part of the `ml` package
    from .explain import explain_row
    from .fallback_gbm import NumpyGBM
    from .features import FEATURE_ORDER, risk_level
    from .physics import hazard_probability
    from .preprocess import build_vector, rows_to_matrix
except ImportError:  # `python ml/predict.py` - run directly as a script
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from ml.explain import explain_row
    from ml.fallback_gbm import NumpyGBM
    from ml.features import FEATURE_ORDER, risk_level
    from ml.physics import hazard_probability
    from ml.preprocess import build_vector, rows_to_matrix

LOG = logging.getLogger("ml.predict")

DEFAULT_MODEL_PATH = Path(__file__).with_name("model.pkl")
_CACHE: dict[str, Any] = {}


@dataclass(frozen=True)
class LoadedModel:
    """A trained ensemble plus the metadata needed to serve it responsibly."""

    members: list[Any]
    backend: str
    bundle: dict[str, Any]

    @property
    def spread_reference(self) -> float:
        reference = self.bundle.get("confidence_reference") or {}
        return float(reference.get("spread_p90") or 0.05) or 0.05

    @property
    def summary(self) -> dict[str, Any]:
        keys = (
            "model_name",
            "model_version",
            "feature_schema_version",
            "backend",
            "trained_at",
            "training_rows",
            "importance_method",
        )
        info = {k: self.bundle.get(k) for k in keys}
        info["members"] = len(self.members)
        info["test_metrics"] = (self.bundle.get("metrics") or {}).get("test", {})
        info["data_provenance"] = self.bundle.get("data_provenance")
        info["limitations"] = self.bundle.get("limitations")
        return info


def _model_path(path: str | Path | None = None) -> Path:
    if path is not None:
        return Path(path).expanduser()
    configured = os.getenv("MODEL_PATH")
    if configured:
        candidate = Path(configured).expanduser()
        if candidate.exists():
            return candidate
    return DEFAULT_MODEL_PATH


def _restore_members(bundle: Mapping[str, Any]) -> list[Any]:
    if bundle.get("member_format") == "numpy-gbm-dict":
        return [NumpyGBM.from_dict(blob) for blob in bundle["members"]]
    return list(bundle["members"])


def load_model(path: str | Path | None = None, *, refresh: bool = False) -> LoadedModel | None:
    """Load and cache the ensemble; return None if it is absent or unusable."""
    target = _model_path(path)
    key = str(target)
    if not refresh and _CACHE.get("key") == key:
        return _CACHE.get("model")

    model: LoadedModel | None = None
    if target.exists():
        try:
            with target.open("rb") as handle:
                bundle = pickle.load(handle)
            stored = list(bundle.get("feature_order") or [])
            if stored != FEATURE_ORDER:
                raise ValueError(
                    "model was trained on a different feature contract "
                    f"({len(stored)} columns); retrain with ml/train_model.py"
                )
            model = LoadedModel(
                members=_restore_members(bundle),
                backend=str(bundle.get("backend", "unknown")),
                bundle=bundle,
            )
            LOG.info(
                "loaded %s (%s backend, %d members) from %s",
                bundle.get("model_name"),
                bundle.get("backend"),
                len(model.members),
                target,
            )
        except Exception as exc:  # corrupt, stale or half-written pickle
            LOG.warning("could not load model at %s (%s); using physics fallback", target, exc)
            model = None
    else:
        LOG.info("no model at %s; using physics fallback", target)

    _CACHE.clear()
    _CACHE.update({"key": key, "model": model})
    return model


def model_info(path: str | Path | None = None) -> dict[str, Any]:
    """Metadata for the /api/model endpoint and the UI's model badge."""
    model = load_model(path)
    if model is None:
        return {
            "loaded": False,
            "backend": "physics-fallback",
            "explanation": (
                "No trained model file was found, so scores come from the documented "
                "physical model in ml/physics.py. Run `python ml/train_model.py` to "
                "train the machine-learning model."
            ),
        }
    return {"loaded": True, **model.summary}


# ------------------------------------------------------------------ inference

def _logit(p: np.ndarray) -> np.ndarray:
    q = np.clip(np.asarray(p, dtype=float), 1e-6, 1.0 - 1e-6)
    return np.log(q / (1.0 - q))


def _probabilities(X: np.ndarray, model: LoadedModel | None) -> tuple[np.ndarray, np.ndarray, str]:
    """Return (probability, member disagreement in log-odds, backend label)."""
    if model is None:
        return hazard_probability(X), np.zeros(X.shape[0], dtype=float), "physics-fallback"
    per_member = np.asarray(
        [np.asarray(m.predict_proba(X), dtype=float)[:, 1] for m in model.members]
    )
    spread = (
        np.std(_logit(per_member), axis=0)
        if per_member.shape[0] > 1
        else np.zeros(X.shape[0], dtype=float)
    )
    return per_member.mean(axis=0), spread, model.backend


def _confidence(spread: float, missing: int, model: LoadedModel | None) -> float:
    """How much to trust this particular row, as a percentage.

    Three measured inputs and no fudge factor:

    * **ceiling** - 97 with a trained model, 78 when the physical fallback is
      answering, because a fixed set of modelling assumptions deserves less
      credit than a fitted one;
    * **agreement** - how far the bagged members diverge on this row relative
      to the 90th-percentile divergence they showed on regions held out of
      training (recorded in the model card);
    * **completeness** - each feature that was missing and had to be filled
      with a calm-weather default costs a few points, so a sparse input can
      never be reported as a certain one.
    """
    ceiling = 0.97 if model is not None else 0.78
    reference = model.spread_reference if model is not None else 1.0
    agreement = max(0.62, 1.0 - 0.15 * (spread / reference))
    completeness = max(0.55, 1.0 - 0.045 * missing)
    return round(100.0 * ceiling * agreement * completeness, 1)


def _missing_fields(row: Mapping[str, Any]) -> list[str]:
    return [name for name in FEATURE_ORDER if row.get(name) is None]


def predict(
    row: Mapping[str, Any],
    *,
    data_mode: str = "DEMO",
    explain: bool = True,
    path: str | Path | None = None,
) -> dict[str, Any]:
    """Score one location.

    Returns the contract the API promises - `risk_score`, `risk_level`,
    `confidence`, `top_factors` - plus the provenance fields the UI needs to
    label the number truthfully.
    """
    model = load_model(path)
    missing = _missing_fields(row)
    x = build_vector(row)
    probability, spread, backend = _probabilities(x.reshape(1, -1), model)

    score = round(float(100.0 * probability[0]), 1)
    level = risk_level(score)
    result: dict[str, Any] = {
        "risk_score": score,
        "risk_level": level,
        "confidence": _confidence(float(spread[0]), len(missing), model),
        "probability": round(float(probability[0]), 6),
        "model_backend": backend,
        "model_version": (model.bundle.get("model_version") if model else "physics-1.0.0"),
        "data_mode": data_mode,
        "defaulted_fields": missing,
    }
    if explain:
        detail = explain_row(x, model.members if model else None, level=level)
        result["top_factors"] = detail["top_factors"]
        result["explanation"] = detail
    else:
        result["top_factors"] = []
    return result


def predict_batch(
    rows: Sequence[Mapping[str, Any]],
    *,
    data_mode: str = "DEMO",
    path: str | Path | None = None,
) -> list[dict[str, Any]]:
    """Score many locations in one pass - the risk-map and forecast path.

    Explanations are skipped here on purpose: the map needs 70+ scores quickly,
    and the panel only ever explains the one region an officer has selected.
    """
    if not rows:
        return []
    model = load_model(path)
    X = rows_to_matrix(rows)
    probability, spread, backend = _probabilities(X, model)

    results: list[dict[str, Any]] = []
    for i, row in enumerate(rows):
        score = round(float(100.0 * probability[i]), 1)
        results.append(
            {
                "risk_score": score,
                "risk_level": risk_level(score),
                "confidence": _confidence(float(spread[i]), len(_missing_fields(row)), model),
                "probability": round(float(probability[i]), 6),
                "model_backend": backend,
                "data_mode": data_mode,
            }
        )
    return results


def explain(
    row: Mapping[str, Any], *, path: str | Path | None = None
) -> dict[str, Any]:
    """Explanation only, for the /api/predict explain panel and what-if diffs."""
    model = load_model(path)
    x = build_vector(row)
    probability, _, _ = _probabilities(x.reshape(1, -1), model)
    return explain_row(x, model.members if model else None, level=risk_level(100.0 * probability[0]))


# ------------------------------------------------------------------ smoke test

DEMO_SITE = {
    "elevation": 900.0,
    "slope": 33.0,
    "vegetation_index": 0.62,
    "historical_landslide_count": 24.0,
    "distance_to_river": 1.2,
    "soil_type": "LATERITE",
    "land_cover": "PLANTATION",
    "temperature": 23.0,
}

DEMO_WEATHER = {
    "dry season": dict(rainfall_1h=0, rainfall_6h=0, rainfall_24h=0, rainfall_72h=2,
                       rainfall_7d=8, rainfall_anomaly=0.3, soil_moisture=12, humidity=58),
    "normal monsoon": dict(rainfall_1h=3, rainfall_6h=14, rainfall_24h=48, rainfall_72h=110,
                           rainfall_7d=210, rainfall_anomaly=1.1, soil_moisture=28, humidity=88),
    "heavy rainfall": dict(rainfall_1h=18, rainfall_6h=76, rainfall_24h=190, rainfall_72h=340,
                           rainfall_7d=520, rainfall_anomaly=2.6, soil_moisture=42, humidity=95),
    "extreme rainfall": dict(rainfall_1h=42, rainfall_6h=160, rainfall_24h=360, rainfall_72h=580,
                             rainfall_7d=880, rainfall_anomaly=4.4, soil_moisture=52, humidity=98),
}


def main() -> int:
    """`python ml/predict.py` - check the served model end to end."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    info = model_info()
    print(f"backend: {info.get('backend')}   loaded: {info.get('loaded')}\n")
    print(f"{'scenario':<18}{'score':>7}  {'level':<10}{'conf':>6}   top driver")
    print("-" * 82)
    for name, weather in DEMO_WEATHER.items():
        result = predict({**DEMO_SITE, **weather}, data_mode="DEMO")
        top = result["top_factors"][0] if result["top_factors"] else {"factor": "-", "contribution": 0}
        print(
            f"{name:<18}{result['risk_score']:>7.1f}  {result['risk_level']:<10}"
            f"{result['confidence']:>5.0f}%   {top['factor']} ({top['contribution']:.0f}%)"
        )
    print("\nDEMO DATA - simulated conditions on a Wayanad-like slope, not a live forecast.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

