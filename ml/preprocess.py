"""Feature assembly - the one place raw inputs become a model matrix.

Training and serving must build features identically or the model silently
degrades, so both go through this module: `ml/train_model.py` calls
`frame_to_matrix`, and the API calls `rows_to_matrix` on whatever the weather,
terrain and simulator services produced.

Three rules are enforced here rather than scattered around the codebase:

1. **Column order is `FEATURE_ORDER`, always.** Tree models index features
   positionally; a reordered column is not an error, it is a wrong answer.
2. **Out-of-range values are clipped, never rejected.** The what-if simulator
   exists to ask "what if it rained 500 mm", and a 500 mm answer is more useful
   than a validation error. `BOUNDS` are wide enough to cover real extremes.
3. **Categoricals are ordinal by physical instability.** `soil_type` and
   `land_cover` arrive as either a name ("LATERITE") or a code (5); both map to
   the same integer, ordered so that a larger code means a less stable slope.
   That ordering is what lets a single tree split carry meaning.
"""
from __future__ import annotations

from typing import Any, Iterable, Mapping, Sequence

import numpy as np

from .features import (
    BOUNDS,
    FEATURE_ORDER,
    LAND_COVER_CODES,
    SERVING_DEFAULTS,
    SOIL_CODES,
)

LABEL_COLUMN = "landslide_occurred"
GROUP_COLUMN = "region_code"


class FeatureError(ValueError):
    """Raised when a feature vector cannot be built at all."""


def clip_matrix(X: np.ndarray) -> np.ndarray:
    """Clip every column into its documented physical range, in place-safe form."""
    out = np.array(X, dtype=float, copy=True)
    if out.ndim == 1:
        out = out.reshape(1, -1)
    if out.shape[1] != len(FEATURE_ORDER):
        raise FeatureError(
            f"expected {len(FEATURE_ORDER)} features in FEATURE_ORDER order, got {out.shape[1]}"
        )
    for i, name in enumerate(FEATURE_ORDER):
        low, high = BOUNDS[name]
        column = out[:, i]
        np.nan_to_num(column, copy=False, nan=SERVING_DEFAULTS[name])
        out[:, i] = np.clip(column, low, high)
    # Accumulation windows are nested, so a longer window can never hold less
    # water than a shorter one. Clipping columns independently can break that,
    # and a model trained on consistent data would see an impossible row.
    order = ["rainfall_1h", "rainfall_6h", "rainfall_24h", "rainfall_72h", "rainfall_7d"]
    idx = [FEATURE_ORDER.index(n) for n in order]
    out[:, idx] = np.maximum.accumulate(out[:, idx], axis=1)
    return out


def _code(value: Any, table: Mapping[str, int], field: str) -> float:
    """Accept either a category name or an already-encoded ordinal code."""
    if value is None:
        return float(SERVING_DEFAULTS[field])
    if isinstance(value, str):
        key = value.strip().upper().replace(" ", "_").replace("-", "_")
        if key not in table:
            raise FeatureError(f"unknown {field} '{value}'; expected one of {sorted(table)}")
        return float(table[key])
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise FeatureError(f"{field} must be a name or a numeric code, got {value!r}") from exc


def build_vector(row: Mapping[str, Any], *, strict: bool = False) -> np.ndarray:
    """Turn one mapping into a single feature vector in `FEATURE_ORDER`.

    Missing keys fall back to `SERVING_DEFAULTS` (documented calm-weather
    values) unless `strict`, which the training path uses so that a renamed
    column fails loudly instead of quietly becoming a default.
    """
    values: list[float] = []
    for name in FEATURE_ORDER:
        if name == "soil_type":
            values.append(_code(row.get(name), SOIL_CODES, name))
            continue
        if name == "land_cover":
            values.append(_code(row.get(name), LAND_COVER_CODES, name))
            continue
        raw = row.get(name)
        if raw is None:
            if strict:
                raise FeatureError(f"missing required feature '{name}'")
            raw = SERVING_DEFAULTS[name]
        try:
            values.append(float(raw))
        except (TypeError, ValueError) as exc:
            raise FeatureError(f"feature '{name}' must be numeric, got {raw!r}") from exc
    return clip_matrix(np.asarray(values, dtype=float))[0]


def rows_to_matrix(rows: Iterable[Mapping[str, Any]], *, strict: bool = False) -> np.ndarray:
    """Stack `build_vector` over many rows; the serving entry point."""
    stacked = [build_vector(row, strict=strict) for row in rows]
    if not stacked:
        raise FeatureError("no rows to featurise")
    return np.vstack(stacked)


def frame_to_matrix(df, *, strict: bool = True) -> np.ndarray:
    """Featurise a pandas DataFrame that already has the feature columns."""
    missing = [c for c in FEATURE_ORDER if c not in df.columns]
    if missing and strict:
        raise FeatureError(f"training frame is missing columns: {missing}")
    if missing:
        return rows_to_matrix(df.to_dict("records"), strict=False)
    return clip_matrix(df.loc[:, list(FEATURE_ORDER)].to_numpy(dtype=float))


def labels(df) -> np.ndarray:
    if LABEL_COLUMN not in df.columns:
        raise FeatureError(f"training frame has no '{LABEL_COLUMN}' column")
    return df[LABEL_COLUMN].to_numpy(dtype=int)


def group_split(
    groups: Sequence[Any],
    *,
    fractions: tuple[float, float, float] = (0.70, 0.15, 0.15),
    seed: int = 7,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Split row indices by group so no region appears in two splits.

    Rows from one region share terrain and often share a weather series, so a
    plain random split would put near-duplicates on both sides and report a
    validation score the model has not earned. Splitting on `region_code`
    instead measures what we actually care about: does the model generalise to
    a slope it has never seen?
    """
    labels_arr = np.asarray(groups, dtype=object)
    unique = np.unique(labels_arr)
    rng = np.random.default_rng(seed)
    order = rng.permutation(unique.size)
    shuffled = unique[order]

    n_train = max(1, int(round(fractions[0] * shuffled.size)))
    n_val = max(1, int(round(fractions[1] * shuffled.size)))
    n_train = min(n_train, shuffled.size - 2)
    n_val = min(n_val, shuffled.size - n_train - 1)

    buckets = (
        set(shuffled[:n_train].tolist()),
        set(shuffled[n_train : n_train + n_val].tolist()),
        set(shuffled[n_train + n_val :].tolist()),
    )
    return tuple(  # type: ignore[return-value]
        np.flatnonzero([g in bucket for g in labels_arr]) for bucket in buckets
    )


def summarise(X: np.ndarray) -> list[dict[str, float]]:
    """Per-feature summary, stored in the model card so drift is detectable."""
    X = np.asarray(X, dtype=float)
    return [
        {
            "feature": name,
            "mean": round(float(X[:, i].mean()), 4),
            "std": round(float(X[:, i].std()), 4),
            "min": round(float(X[:, i].min()), 4),
            "p50": round(float(np.percentile(X[:, i], 50)), 4),
            "max": round(float(X[:, i].max()), 4),
        }
        for i, name in enumerate(FEATURE_ORDER)
    ]
