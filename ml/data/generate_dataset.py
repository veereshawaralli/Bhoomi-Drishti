"""Build the labelled training set.

    python ml/data/generate_dataset.py --rows 24000

SYNTHETIC / DEMO DATA - READ THIS
---------------------------------
The rows produced here are *simulated*, not observed. Terrain comes from the
approximate demo region table, weather from the hourly rainfall process in
ml/hydrology.py, and the label from the documented slope-stability model in
ml/physics.py (`y ~ Bernoulli(p)`). Any model trained on this file learns the
behaviour of that physical model, not the real landslide record of India.

The point of doing it this way rather than with `random()`:
  * accumulations are summed from one hourly series, so r1h <= r6h <= r24h
    <= r72h <= r7d always holds, exactly as it will at inference time;
  * soil moisture is the integral of infiltration minus drainage, so the
    antecedent-rainfall signal the model learns is a real physical signal;
  * labels are noisy draws, so the model has to generalise instead of
    inverting a formula, and SHAP attributions are informative.

Swap this file for a loader over the GSI landslide inventory joined to IMD
gridded rainfall and a DEM, and nothing downstream changes.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ml import hydrology as hyd
from ml.data.regions_seed import REGIONS
from ml.features import FEATURE_ORDER, LAND_COVER_CODES, SOIL_CODES
from ml.physics import hazard_probability

SERIES_HOURS = 336          # 14 days, so a 7-day window is always available
SAMPLE_OFFSETS = (168, 192, 216, 240, 264, 288, 312, 330)

# Rainfall regimes the training set must cover, as multipliers on the region's
# own seasonal normal. Anchors, measured at Wayanad in peak monsoon:
#   1.0 -> ordinary monsoon fortnight, peak 24 h total near 90 mm
#   2.0 -> active wet spell, peak near 180 mm
#   4.0 -> major event, peak near 350 mm / 570 mm per 72 h, which is the scale
#          of the rainfall that preceded the 2024 Wayanad failures
#   8.0 -> beyond any recorded total there, but ordinary for Sohra
# The upper buckets are deliberately over-sampled relative to how often such
# weather occurs, because the what-if simulator and the extreme-rainfall demo
# operate there and the model must not be extrapolating when they do.
INTENSITY_BUCKETS = (
    (0.14, 0.15, 0.60),
    (0.26, 0.60, 1.60),
    (0.24, 1.60, 3.00),
    (0.22, 3.00, 5.00),
    (0.14, 5.00, 9.00),
)


def _jitter_terrain(region: dict, rng: np.random.Generator) -> dict:
    """Perturb the region's terrain so the model sees a continuum of slopes.

    Without this the model could memorise 74 fixed terrain fingerprints; with
    it, the terrain features carry real signal and the what-if simulator can
    move slope or soil and get a sensible answer.
    """
    soil = SOIL_CODES[region["soil_type"]]
    cover = LAND_COVER_CODES[region["land_cover"]]
    if rng.random() < 0.30:
        soil = int(np.clip(soil + rng.integers(-1, 2), 0, 7))
    if rng.random() < 0.25:
        cover = int(np.clip(cover + rng.integers(-1, 2), 0, 7))
    return {
        "slope": float(np.clip(region["slope_deg"] + rng.normal(0, 5.5), 3.0, 72.0)),
        "elevation": float(np.clip(region["elevation_m"] * rng.uniform(0.75, 1.28), 40.0, 6200.0)),
        "vegetation_index": float(np.clip(region["vegetation_index"] + rng.normal(0, 0.10), 0.02, 0.95)),
        "distance_to_river": float(np.clip(region["distance_to_river_km"] * rng.uniform(0.3, 2.6), 0.05, 45.0)),
        "historical_landslide_count": float(
            max(0.0, round(region["historical_landslide_count"] * rng.uniform(0.35, 1.8)))
        ),
        "soil_type": float(soil),
        "land_cover": float(cover),
    }


def _sample_day(region: dict, rng: np.random.Generator) -> int:
    """Pick a start day, weighted towards the region's own wet season.

    Uniform sampling over the calendar would spend most of the training set on
    dry-season rows where nothing can happen, leaving the transition zone
    between LOW and CRITICAL - the part of the curve the platform is actually
    judged on - badly under-sampled. Weighting by the seasonal activity curve
    concentrates rows where landslides occur, and the additive floor keeps
    enough genuinely dry rows for contrast.
    """
    weights = 0.22 + hyd.seasonal_factor(np.arange(365), region["zone"])
    weights = weights / weights.sum()
    return int(rng.choice(365, p=weights))


def _intensity(rng: np.random.Generator) -> float:
    """Draw a rainfall regime from `INTENSITY_BUCKETS`."""
    roll = rng.random()
    cumulative = 0.0
    for weight, low, high in INTENSITY_BUCKETS:
        cumulative += weight
        if roll < cumulative:
            return float(rng.uniform(low, high))
    return float(rng.uniform(*INTENSITY_BUCKETS[-1][1:]))


def generate(rows: int = 24_000, seed: int = 20260902) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    per_series = len(SAMPLE_OFFSETS)
    n_series = int(np.ceil(rows / per_series))
    records: list[dict] = []

    for s in range(n_series):
        region = REGIONS[s % len(REGIONS)]
        terrain = _jitter_terrain(region, rng)
        day = _sample_day(region, rng)
        multiplier = _intensity(rng)
        series_seed = int(rng.integers(0, 2**31 - 1))

        rain = hyd.rainfall_series(
            seed=series_seed,
            hours=SERIES_HOURS,
            start_day_of_year=day,
            zone=region["zone"],
            monsoon_index=region["monsoon_index"],
            annual_rainfall_mm=region["annual_rainfall_mm"],
            intensity_multiplier=multiplier,
        )
        temp = hyd.temperature_series(
            hours=SERIES_HOURS,
            start_day_of_year=day,
            elevation_m=terrain["elevation"],
            latitude=region["latitude"],
            seed=series_seed,
        )
        humid = hyd.humidity_series(rain, temp, seed=series_seed)
        soil_moisture = hyd.soil_moisture_series(
            rain, soil_code=int(terrain["soil_type"]), temperature_c=temp
        )

        for offset in SAMPLE_OFFSETS:
            acc = hyd.accumulations(rain, offset)
            doy_now = (day + offset // 24) % 365
            row = dict(terrain)
            row.update(acc)
            row["rainfall_anomaly"] = hyd.rainfall_anomaly(
                acc["rainfall_7d"], region["annual_rainfall_mm"], doy_now, region["zone"]
            )
            row["soil_moisture"] = float(soil_moisture[offset])
            row["temperature"] = float(temp[offset])
            row["humidity"] = float(humid[offset])
            row["region_code"] = region["code"]
            row["zone"] = region["zone"]
            row["day_of_year"] = doy_now
            row["intensity_multiplier"] = round(multiplier, 3)
            records.append(row)

    df = pd.DataFrame.from_records(records).iloc[:rows].reset_index(drop=True)
    p = hazard_probability(df[FEATURE_ORDER].to_numpy(dtype=float))
    df["hazard_probability_true"] = np.round(p, 6)
    df["hazard_index_true"] = np.round(100.0 * p, 3)

    draw = rng.random(len(df))
    y = (draw < p).astype(int)
    flip = rng.random(len(df)) < 0.005          # observation noise both ways
    df["landslide_occurred"] = np.where(flip, 1 - y, y)
    return df


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate the synthetic training set")
    parser.add_argument("--rows", type=int, default=24_000)
    parser.add_argument("--seed", type=int, default=20260902)
    parser.add_argument("--out", type=Path, default=Path(__file__).with_name("training_data.csv"))
    args = parser.parse_args()

    df = generate(rows=args.rows, seed=args.seed)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(args.out, index=False)
    positives = int(df["landslide_occurred"].sum())
    print(f"wrote {len(df):,} rows -> {args.out}")
    print(f"  positive labels : {positives:,} ({100 * positives / len(df):.2f}%)")
    print(f"  hazard index    : mean {df.hazard_index_true.mean():.1f}, p95 {df.hazard_index_true.quantile(0.95):.1f}")
    print(f"  rainfall 24h    : mean {df.rainfall_24h.mean():.1f} mm, max {df.rainfall_24h.max():.1f} mm")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
