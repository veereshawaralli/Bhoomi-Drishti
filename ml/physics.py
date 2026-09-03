"""Physically-informed hazard model.

Why this exists
---------------
There is no public per-district hourly landslide label set that we can ship
inside a repository, so the training labels have to be generated. Generating
them with `random()` would make the whole project meaningless, so instead the
labels come from an explicit, documented, slope-stability-inspired model:

    predisposition  S  - terrain, soil, land cover, history      (static)
    hydrological load H - rain bursts, antecedent rain, soil water (dynamic)
    log-odds        z  = b0 + b1*S + b2*H + b3*S*H + climate terms
    failure prob    p  = sigmoid(z)

The interaction term S*H is the physics that matters: 200 mm of rain on a flat
forested valley floor is a flood, the same rain on a 40-degree laterite cut
slope is a landslide. The gradient-boosted model is then trained on *sampled
binary outcomes* y ~ Bernoulli(p), so it has to rediscover this structure from
noisy observations - which is exactly the job it would do on a real
inventory, and it is why SHAP produces meaningful attributions.

This module is also the resilience fallback: if no trained model.pkl is
present, the API serves scores from `hazard_score()` and labels the response
`model_backend = "physics-fallback"` so nothing is ever passed off as an ML
prediction when it is not.

Every coefficient below is a modelling assumption, not a measured constant.
See docs/ML.md for how to recalibrate against a real inventory.
"""
from __future__ import annotations

import numpy as np

from .features import FEATURE_ORDER

# Relative instability weight per ordinal soil / land-cover code.
SOIL_WEIGHT = np.array([0.55, 0.72, 0.85, 0.95, 1.00, 1.12, 1.18, 1.28])
LAND_COVER_WEIGHT = np.array([0.62, 0.78, 0.92, 1.00, 1.06, 1.12, 1.18, 1.25])

COEF = {
    "intercept": -5.27,
    "susceptibility": 1.30,
    "loading": 2.30,
    "interaction": 2.50,
    "humid": 0.30,
    "freeze_thaw": 0.25,
    # Water loading enters the log-odds through H**LOADING_EXPONENT. Once the
    # profile is near saturation, extra millimetres add progressively less
    # driving force (and any failure has usually already happened), so the
    # response is concave rather than linear.
    "loading_exponent": 0.75,
}

_IDX = {name: i for i, name in enumerate(FEATURE_ORDER)}


def _col(X: np.ndarray, name: str) -> np.ndarray:
    return X[:, _IDX[name]]


def as_matrix(X) -> np.ndarray:
    arr = np.asarray(X, dtype=float)
    if arr.ndim == 1:
        arr = arr.reshape(1, -1)
    if arr.shape[1] != len(FEATURE_ORDER):
        raise ValueError(f"expected {len(FEATURE_ORDER)} features, got {arr.shape[1]}")
    return arr


def susceptibility(X: np.ndarray) -> np.ndarray:
    """Static predisposition of the slope, roughly 0.1 - 1.6."""
    slope = _col(X, "slope")
    elev = _col(X, "elevation")
    ndvi = _col(X, "vegetation_index")
    river = _col(X, "distance_to_river")
    hist = _col(X, "historical_landslide_count")
    soil = np.clip(_col(X, "soil_type").astype(int), 0, 7)
    lc = np.clip(_col(X, "land_cover").astype(int), 0, 7)

    # Regolith-retention curve: instability rises steeply from ~8 deg, then
    # eases off on very steep faces where little soil remains.
    f_slope = np.clip((slope - 8.0) / 32.0, 0.0, 1.6) * (1.0 - 0.35 * np.clip((slope - 52.0) / 28.0, 0.0, 1.0))
    f_veg = 1.18 - 0.36 * np.clip(ndvi, 0.0, 1.0)
    f_elev = (
        0.85
        + 0.35 * np.exp(-0.5 * ((elev - 1800.0) / 1400.0) ** 2)
        - 0.25 * np.clip((elev - 3800.0) / 2000.0, 0.0, 1.0)
    )
    f_river = 1.0 + 0.28 * np.exp(-np.clip(river, 0.0, 60.0) / 2.2)
    f_hist = 1.0 + 0.30 * np.log1p(np.clip(hist, 0.0, 200.0)) / np.log1p(40.0)

    s = f_slope * SOIL_WEIGHT[soil] * LAND_COVER_WEIGHT[lc] * f_veg * f_elev * f_river * f_hist
    return s / 1.35


def hydrological_loading(X: np.ndarray) -> np.ndarray:
    """Dynamic water loading, roughly 0.05 (dry) - 1.3 (cloudburst).

    Denominators are the rainfall totals at which each window is contributing
    its full weight; they are set from published Indian rainfall-threshold
    studies of the order of 200-300 mm/24 h for triggering in the Ghats and
    Himalayan foothills, and are the first thing to recalibrate per region
    when a real inventory is available.

    The weights deliberately favour the slowly varying terms - 24 h and 72 h
    totals, and above all soil moisture - over the 1 h burst. That matches the
    landslide literature (antecedent wetness is the dominant control; the
    burst is the trigger, not the cause) and it also keeps the hazard index a
    smooth function of time instead of flickering with every rain gauge tick.
    """
    burst = np.clip(_col(X, "rainfall_1h") / 70.0, 0.0, 1.8)
    short = np.clip(_col(X, "rainfall_6h") / 180.0, 0.0, 2.0)
    daily = np.clip(_col(X, "rainfall_24h") / 320.0, 0.0, 2.2)
    antecedent = np.clip(_col(X, "rainfall_72h") / 600.0, 0.0, 1.8)
    week = np.clip(_col(X, "rainfall_7d") / 1000.0, 0.0, 1.6)
    wetness = np.clip((_col(X, "soil_moisture") - 8.0) / 48.0, 0.0, 1.2)
    anomaly = np.clip((_col(X, "rainfall_anomaly") - 1.0) / 4.0, 0.0, 1.5)

    return (
        0.10 * burst
        + 0.14 * short
        + 0.26 * daily
        + 0.24 * antecedent
        + 0.14 * week
        + 0.30 * wetness
        + 0.14 * anomaly
    )


def term_breakdown(X) -> dict[str, np.ndarray]:
    """Every additive term of the log-odds, kept separately for explanations."""
    M = as_matrix(X)
    S = susceptibility(M)
    H = hydrological_loading(M)
    # Concave in water: the first 100 mm on a dry slope changes far more than
    # the tenth 100 mm on an already-saturated one.
    Hc = np.power(np.clip(H, 0.0, None), COEF["loading_exponent"])
    humidity = np.clip((_col(M, "humidity") - 60.0) / 40.0, 0.0, 1.0)
    # Freeze-thaw weakening matters only on high-altitude slopes near 0 degC.
    freeze = np.exp(-0.5 * ((_col(M, "temperature") - 2.0) / 4.0) ** 2) * np.clip(
        (_col(M, "elevation") - 2500.0) / 1500.0, 0.0, 1.0
    )
    return {
        "intercept": np.full(M.shape[0], COEF["intercept"]),
        "susceptibility": COEF["susceptibility"] * S,
        "loading": COEF["loading"] * Hc,
        "interaction": COEF["interaction"] * S * Hc,
        "humid": COEF["humid"] * humidity,
        "freeze_thaw": COEF["freeze_thaw"] * freeze,
        "_S": S,
        "_H": H,
    }


def hazard_probability(X) -> np.ndarray:
    """Modelled probability of a rainfall-triggered slope failure (24 h)."""
    return 1.0 / (1.0 + np.exp(-log_odds(X)))


def log_odds(X) -> np.ndarray:
    """Log-odds of failure - the additive scale used for explanations."""
    t = term_breakdown(X)
    z = t["intercept"] + t["susceptibility"] + t["loading"] + t["interaction"] + t["humid"] + t["freeze_thaw"]
    return np.clip(z, -30.0, 30.0)



def hazard_score(X) -> np.ndarray:
    """0-100 hazard index = 100 x hazard probability."""
    return np.round(100.0 * hazard_probability(X), 2)


def calm_baseline(x: np.ndarray) -> np.ndarray:
    """The same place on a calm day: no rain, drained soil, normal weather.

    Explanations are always relative to a reference point. Using "this slope
    in calm conditions" answers the question an officer actually asks - why is
    this region elevated *now* - rather than comparing it to an average slope
    somewhere else in the country.
    """
    b = np.array(x, dtype=float).copy()
    for name, value in (
        ("rainfall_1h", 0.0),
        ("rainfall_6h", 0.0),
        ("rainfall_24h", 0.0),
        ("rainfall_72h", 2.0),
        ("rainfall_7d", 8.0),
        ("rainfall_anomaly", 0.25),
        ("soil_moisture", 12.0),
        ("humidity", 55.0),
    ):
        b[_IDX[name]] = value
    return b


def physics_contributions(x: np.ndarray) -> np.ndarray:
    """Additive per-feature contribution to the log-odds, vs `calm_baseline`.

    Each feature is moved from its baseline value to its actual value one at a
    time, and the residual left by feature interactions is redistributed in
    proportion to those single-feature effects, so the parts always sum to the
    whole (the property that makes SHAP values readable).
    """
    x = np.asarray(x, dtype=float).ravel()
    base = calm_baseline(x)
    stack = np.vstack([base, x] + [_substitute(base, x, i) for i in range(x.size)])
    z = log_odds(stack)
    z_base, z_full, z_probe = z[0], z[1], z[2:]

    raw = z_probe - z_base
    total = z_full - z_base
    magnitude = np.abs(raw).sum()
    if magnitude < 1e-9:
        return raw
    return raw + (total - raw.sum()) * (np.abs(raw) / magnitude)


def _substitute(base: np.ndarray, x: np.ndarray, i: int) -> np.ndarray:
    probe = base.copy()
    probe[i] = x[i]
    return probe


