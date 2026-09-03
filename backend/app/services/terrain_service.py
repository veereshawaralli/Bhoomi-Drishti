"""Terrain features per region.

Small on purpose. Terrain is the static half of the model input, it changes on
the timescale of a DEM refresh rather than an hour, and it lives in one table
with a one-to-one relationship to regions - so this module is a typed
projection with sensible fallbacks rather than a computation.

Where the numbers come from is stated in every response. Today they are the
documented approximate values in ``ml/data/regions_seed.py``, tagged ``DEMO``.
In production ``elevation``/``slope`` come off a Cartosat or SRTM DEM,
``land_cover`` and ``vegetation_index`` off NRSC land-use rasters or a Sentinel
NDVI composite, and ``soil_type`` off the NBSS&LUP soil map. Only the loader
changes; the feature contract does not.
"""
from __future__ import annotations

import logging
from typing import Any

from ..config import ensure_ml_importable
from ..models import Region, TerrainData

ensure_ml_importable()

from ml.features import LAND_COVER_CODES, SERVING_DEFAULTS, SOIL_CODES  # noqa: E402

LOG = logging.getLogger("app.terrain")

# Used only when a region has no terrain row at all, which should not happen
# after seeding. Deliberately unremarkable so a missing row biases the
# prediction downwards rather than inventing hazard.
FALLBACK = {
    "elevation": SERVING_DEFAULTS["elevation"],
    "slope": SERVING_DEFAULTS["slope"],
    "vegetation_index": SERVING_DEFAULTS["vegetation_index"],
    "distance_to_river": SERVING_DEFAULTS["distance_to_river"],
    "soil_type": SERVING_DEFAULTS["soil_type"],
    "land_cover": SERVING_DEFAULTS["land_cover"],
}


def features(region: Region) -> dict[str, float]:
    """The six terrain columns of the model's feature vector."""
    terrain: TerrainData | None = region.terrain
    if terrain is None:
        LOG.warning("region %s has no terrain row; using serving defaults", region.code)
        row = dict(FALLBACK)
    else:
        row = {
            "elevation": float(terrain.elevation_m),
            "slope": float(terrain.slope_deg),
            "vegetation_index": float(terrain.vegetation_index),
            "distance_to_river": float(terrain.distance_to_river_km),
            "soil_type": float(SOIL_CODES.get(terrain.soil_type, 4)),
            "land_cover": float(LAND_COVER_CODES.get(terrain.land_cover, 1)),
        }
    row["historical_landslide_count"] = float(region.historical_landslide_count or 0)
    return row


def describe(region: Region) -> dict[str, Any]:
    """Terrain as the API presents it, provenance included."""
    terrain = region.terrain
    if terrain is None:
        return {
            "available": False,
            "data_mode": "DEMO",
            "dem_source": "not available",
            "note": "No terrain record for this region; serving defaults are in use.",
        }
    return {
        "available": True,
        "elevation_m": terrain.elevation_m,
        "slope_deg": terrain.slope_deg,
        "aspect_deg": terrain.aspect_deg,
        "relief_m": terrain.relief_m,
        "curvature": terrain.curvature,
        "soil_type": terrain.soil_type,
        "soil_depth_m": terrain.soil_depth_m,
        "land_cover": terrain.land_cover,
        "vegetation_index": terrain.vegetation_index,
        "distance_to_river_km": terrain.distance_to_river_km,
        "distance_to_road_km": terrain.distance_to_road_km,
        "lithology": terrain.lithology,
        "dem_source": terrain.dem_source,
        "data_mode": terrain.data_mode,
    }


# What a production deployment would read instead. Surfaced by /api/model and
# documented in docs/ARCHITECTURE.md so the migration path is explicit rather
# than a claim in a slide.
SATELLITE_SOURCES = [
    {
        "layer": "Elevation and slope",
        "demo": "Approximate published values per district (ml/data/regions_seed.py)",
        "production": "Cartosat-1 / SRTM 30 m DEM via Bhuvan or USGS EarthExplorer",
        "derived": "slope, aspect, curvature, local relief",
    },
    {
        "layer": "Land cover",
        "demo": "One representative class per region",
        "production": "NRSC / Bhuvan LULC 50k, or ESA WorldCover 10 m",
        "derived": "land_cover class code",
    },
    {
        "layer": "Vegetation index",
        "demo": "Class-typical NDVI with a deterministic per-region offset",
        "production": "Sentinel-2 or Landsat-8 NDVI composite, 16-day cadence",
        "derived": "vegetation_index",
    },
    {
        "layer": "Soil",
        "demo": "One representative soil class per region",
        "production": "NBSS&LUP soil map, or SoilGrids 250 m",
        "derived": "soil_type, soil_depth_m",
    },
    {
        "layer": "Hydrography",
        "demo": "Deterministic per-region distance",
        "production": "Survey of India drainage network / HydroSHEDS",
        "derived": "distance_to_river",
    },
    {
        "layer": "Landslide inventory",
        "demo": "Documented events plus modelled minor events",
        "production": "GSI National Landslide Susceptibility Mapping inventory",
        "derived": "historical_landslide_count, model labels",
    },
]


def source_catalogue() -> dict[str, Any]:
    """Honest statement of what is connected and what is not."""
    return {
        "connected": False,
        "data_mode": "DEMO",
        "note": (
            "No satellite or GIS service is connected in this build. Terrain values "
            "are documented approximations shipped with the repository and are "
            "labelled DEMO throughout. The table below is the migration path, not a "
            "description of live connectivity."
        ),
        "layers": SATELLITE_SOURCES,
    }
