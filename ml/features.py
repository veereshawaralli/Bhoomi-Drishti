"""Canonical feature contract.

Everything in the system - dataset generation, training, the FastAPI service
and the React UI - agrees on the names, order, units and encodings defined
here. Changing this file changes the model input, so it is versioned.
"""
from __future__ import annotations

FEATURE_SCHEMA_VERSION = "1.0.0"

# Order matters: the model receives a matrix with exactly these columns.
FEATURE_ORDER: list[str] = [
    "rainfall_1h",
    "rainfall_6h",
    "rainfall_24h",
    "rainfall_72h",
    "rainfall_7d",
    "rainfall_anomaly",
    "elevation",
    "slope",
    "soil_moisture",
    "temperature",
    "humidity",
    "vegetation_index",
    "historical_landslide_count",
    "distance_to_river",
    "soil_type",
    "land_cover",
]

UNITS: dict[str, str] = {
    "rainfall_1h": "mm",
    "rainfall_6h": "mm",
    "rainfall_24h": "mm",
    "rainfall_72h": "mm",
    "rainfall_7d": "mm",
    "rainfall_anomaly": "ratio vs seasonal normal",
    "elevation": "m",
    "slope": "degrees",
    "soil_moisture": "% volumetric",
    "temperature": "degC",
    "humidity": "%",
    "vegetation_index": "NDVI-like 0-1",
    "historical_landslide_count": "events on record",
    "distance_to_river": "km",
    "soil_type": "ordinal code",
    "land_cover": "ordinal code",
}

# Plausible physical bounds. Inputs outside these are clipped (not rejected)
# so that an extreme what-if scenario still produces a usable prediction.
BOUNDS: dict[str, tuple[float, float]] = {
    "rainfall_1h": (0.0, 200.0),
    "rainfall_6h": (0.0, 600.0),
    "rainfall_24h": (0.0, 1200.0),
    "rainfall_72h": (0.0, 2500.0),
    "rainfall_7d": (0.0, 4000.0),
    "rainfall_anomaly": (0.0, 12.0),
    "elevation": (0.0, 8000.0),
    "slope": (0.0, 80.0),
    "soil_moisture": (2.0, 65.0),
    "temperature": (-25.0, 50.0),
    "humidity": (5.0, 100.0),
    "vegetation_index": (0.0, 1.0),
    "historical_landslide_count": (0.0, 200.0),
    "distance_to_river": (0.0, 60.0),
    "soil_type": (0.0, 7.0),
    "land_cover": (0.0, 7.0),
}

# Categories are ordinal-encoded in ascending order of their physical
# contribution to instability, so a single tree split separates
# "weak materials" from "strong materials" without one-hot expansion.
SOIL_TYPES: list[str] = [
    "ROCKY",      # 0 - competent rock, most stable
    "GRAVEL",     # 1
    "SANDY",      # 2
    "ALLUVIAL",   # 3
    "LOAM",       # 4
    "LATERITE",   # 5 - deep weathered profile, common in Western Ghats
    "SILT",       # 6
    "CLAY",       # 7 - swelling, low permeability, least stable when wet
]

LAND_COVERS: list[str] = [
    "SNOW_ICE",      # 0
    "FOREST",        # 1 - deep root cohesion
    "SCRUB",         # 2
    "GRASSLAND",     # 3
    "AGRICULTURE",   # 4
    "PLANTATION",    # 5 - shallow-rooted tea/coffee/rubber
    "BUILT_UP",      # 6 - cut slopes, drainage disruption
    "BARREN",        # 7 - no root reinforcement
]

SOIL_CODES = {name: i for i, name in enumerate(SOIL_TYPES)}
LAND_COVER_CODES = {name: i for i, name in enumerate(LAND_COVERS)}

# Values substituted when a feature is absent at serving time - a calm,
# unremarkable slope in fair weather. Chosen so that a missing field biases a
# prediction *downwards* rather than inventing hazard that was never observed;
# the API reports which fields it had to fill so the gap is never silent.
SERVING_DEFAULTS: dict[str, float] = {
    "rainfall_1h": 0.0,
    "rainfall_6h": 0.0,
    "rainfall_24h": 0.0,
    "rainfall_72h": 0.0,
    "rainfall_7d": 0.0,
    "rainfall_anomaly": 1.0,
    "elevation": 800.0,
    "slope": 20.0,
    "soil_moisture": 18.0,
    "temperature": 24.0,
    "humidity": 60.0,
    "vegetation_index": 0.55,
    "historical_landslide_count": 0.0,
    "distance_to_river": 5.0,
    "soil_type": 4.0,
    "land_cover": 1.0,
}

# Risk banding required by the specification.
RISK_BANDS: list[tuple[float, float, str]] = [
    (0.0, 20.0, "VERY LOW"),
    (20.0, 40.0, "LOW"),
    (40.0, 60.0, "MODERATE"),
    (60.0, 80.0, "HIGH"),
    (80.0, 100.01, "CRITICAL"),
]


def risk_level(score: float) -> str:
    """Map a 0-100 risk score onto the five specified bands."""
    s = max(0.0, min(100.0, float(score)))
    for low, high, label in RISK_BANDS:
        if low <= s < high:
            return label
    return "CRITICAL"


# Feature -> human-readable driver group, used by the explainability panel.
FACTOR_GROUPS: dict[str, str] = {
    "rainfall_1h": "Heavy rainfall",
    "rainfall_6h": "Heavy rainfall",
    "rainfall_24h": "Heavy rainfall",
    "rainfall_72h": "Antecedent rainfall",
    "rainfall_7d": "Antecedent rainfall",
    "rainfall_anomaly": "Antecedent rainfall",
    "soil_moisture": "Soil moisture",
    "slope": "Slope steepness",
    "elevation": "Terrain relief",
    "distance_to_river": "Terrain relief",
    "historical_landslide_count": "Historical activity",
    "soil_type": "Soil and land cover",
    "land_cover": "Soil and land cover",
    "vegetation_index": "Soil and land cover",
    "temperature": "Weather conditions",
    "humidity": "Weather conditions",
}

GROUP_ORDER: list[str] = [
    "Heavy rainfall",
    "Antecedent rainfall",
    "Soil moisture",
    "Slope steepness",
    "Historical activity",
    "Soil and land cover",
    "Terrain relief",
    "Weather conditions",
]
