"""Weather: LIVE from a public API, or DEMO from the physical model.

Two modes, always labelled
--------------------------
``USE_LIVE_WEATHER=false`` (the default) serves weather from
``ml/hydrology.py`` - the same rainfall process, water balance and temperature
model the training data was built from. Rows are tagged ``DEMO``.

``USE_LIVE_WEATHER=true`` fetches hourly rainfall, temperature, humidity and
soil moisture from Open-Meteo (a public forecast API that needs no key) and
tags rows ``LIVE``. If the call fails - no network, rate limit, timeout - the
service falls back to DEMO, records why, and the UI shows the DEMO badge plus
the reason. It never presents modelled numbers as observations, and it never
leaves the dashboard blank because an upstream API was down.

Determinism in DEMO mode
------------------------
A region's weather is one year-long hourly series seeded from the region code
alone, sampled at the current hour. Reloading the dashboard gives the same
numbers; the 72-hour forecast is the same series read forwards, so "now" and
"+6 h" are physically consistent rather than two independent guesses. Building
one series costs about 60 ms and 0.3 MB, so all 74 are cached in process.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import numpy as np

from ..clock import day_of_year, floor_hour, utcnow
from ..config import ensure_ml_importable, settings
from ..models import Region
from . import scenario as scenario_module

ensure_ml_importable()

from ml import hydrology as hyd  # noqa: E402
from ml.features import SOIL_CODES  # noqa: E402

LOG = logging.getLogger("app.weather")

# One year plus a 72-hour horizon plus the 168-hour lookback the 7-day window
# needs, anchored at 1 January so any date in the year can be indexed directly.
SERIES_HOURS = 24 * (365 + 10)
LOOKBACK_HOURS = 168

_lock = threading.Lock()
_series_cache: dict[str, "RegionSeries"] = {}
_live_cache: dict[int, tuple[float, dict[str, Any]]] = {}
LIVE_TTL_SECONDS = 900.0

# Set when a live fetch fails, surfaced through /api/health and the UI badge.
_live_failure: str | None = None


@dataclass
class RegionSeries:
    """A region's full-year modelled hourly weather."""

    code: str
    rain: np.ndarray
    soil_moisture: np.ndarray
    temperature: np.ndarray
    humidity: np.ndarray
    annual_rainfall_mm: float
    zone: str

    def index_for(self, moment: datetime) -> int:
        """Hour offset into the series for a UTC moment.

        The series starts at 1 January hour 0, and `LOOKBACK_HOURS` of margin
        is prepended so the 7-day window at 1 January is real modelled rain
        rather than zeros.
        """
        stamp = floor_hour(moment)
        offset = (day_of_year(stamp) - 1) * 24 + stamp.hour
        return int(np.clip(offset + LOOKBACK_HOURS, 0, self.rain.size - 1))


def _region_seed(code: str) -> int:
    """Stable per-region seed so the demo is identical on every machine."""
    import hashlib

    return int.from_bytes(hashlib.sha256(code.encode("utf-8")).digest()[:4], "big")


def _build_series(region: Region, soil_code: int) -> RegionSeries:
    seed = _region_seed(region.code)
    annual = float(region.annual_rainfall_mm or 2000.0)
    # Start `LOOKBACK_HOURS` before 1 January so the antecedent windows at the
    # start of the year are populated.
    start_doy = 365 - LOOKBACK_HOURS // 24
    rain = hyd.rainfall_series(
        seed=seed,
        hours=SERIES_HOURS,
        start_day_of_year=start_doy,
        zone=region.zone,
        monsoon_index=float(region.monsoon_index or 1.0),
        annual_rainfall_mm=annual,
    )
    temperature = hyd.temperature_series(
        hours=SERIES_HOURS,
        start_day_of_year=start_doy,
        elevation_m=float(region.terrain.elevation_m if region.terrain else 800.0),
        latitude=float(region.latitude),
        seed=seed,
    )
    soil = hyd.soil_moisture_series(rain, soil_code=soil_code, temperature_c=temperature)
    humidity = hyd.humidity_series(rain, temperature, seed=seed)
    return RegionSeries(
        code=region.code,
        rain=rain,
        soil_moisture=soil,
        temperature=temperature,
        humidity=humidity,
        annual_rainfall_mm=annual,
        zone=region.zone,
    )


def series_for(region: Region) -> RegionSeries:
    """Cached modelled series for a region (built once per process)."""
    cached = _series_cache.get(region.code)
    if cached is not None:
        return cached
    soil_code = SOIL_CODES.get(region.terrain.soil_type if region.terrain else "LOAM", 4)
    built = _build_series(region, soil_code)
    with _lock:
        _series_cache[region.code] = built
    return built


# --------------------------------------------------------------- scenario

def _apply_scenario(reading: dict[str, Any], scn: scenario_module.Scenario) -> dict[str, Any]:
    """Push a modelled reading into the scenario's rainfall regime.

    Multiplying every accumulation window by the same factor keeps the
    ordering invariant the model was trained on (1 h <= 6 h <= 24 h <= 72 h
    <= 7 d) intact, which a per-window random bump would break. The floors are
    applied afterwards and propagated upwards through the longer windows for
    the same reason.
    """
    if scn.rain_multiplier == 1.0 and scn.soil_moisture_add == 0.0 and scn.min_rain_24h == 0.0:
        return reading

    out = dict(reading)
    m = scn.rain_multiplier
    for key in ("rainfall_mm", "rainfall_1h", "rainfall_6h", "rainfall_24h",
                "rainfall_72h", "rainfall_7d"):
        out[key] = round(float(out.get(key, 0.0)) * m, 2)

    # Floors: guarantee the scenario is visible even in a quiet fortnight.
    out["rainfall_1h"] = max(out["rainfall_1h"], scn.min_rain_1h)
    out["rainfall_6h"] = max(out["rainfall_6h"], scn.min_rain_1h * 3.6, out["rainfall_1h"])
    out["rainfall_24h"] = max(out["rainfall_24h"], scn.min_rain_24h, out["rainfall_6h"])
    out["rainfall_72h"] = max(out["rainfall_72h"], out["rainfall_24h"] * 1.55)
    out["rainfall_7d"] = max(out["rainfall_7d"], out["rainfall_72h"] * 1.35)
    out["rainfall_mm"] = max(out["rainfall_mm"], out["rainfall_1h"])

    out["rainfall_anomaly"] = round(
        min(12.0, float(out.get("rainfall_anomaly", 1.0)) * scn.anomaly_multiplier), 3
    )
    if out.get("soil_moisture_pct") is not None:
        # Cap at 62%: beyond that the profile is saturated and extra water
        # runs off rather than being stored.
        out["soil_moisture_pct"] = round(
            min(62.0, float(out["soil_moisture_pct"]) + scn.soil_moisture_add), 2
        )
    if out.get("humidity_pct") is not None:
        out["humidity_pct"] = round(min(100.0, float(out["humidity_pct"]) + 6.0 * (m > 1.0)), 1)
    out["scenario_applied"] = scn.key
    return out


# ------------------------------------------------------------------ demo

def _demo_reading(region: Region, moment: datetime, offset_hours: int = 0) -> dict[str, Any]:
    series = series_for(region)
    idx = int(np.clip(series.index_for(moment) + offset_hours, 0, series.rain.size - 1))
    acc = hyd.accumulations(series.rain, idx)
    stamp = floor_hour(moment)
    doy = day_of_year(stamp)
    anomaly = hyd.rainfall_anomaly(
        acc["rainfall_7d"], series.annual_rainfall_mm, doy, series.zone
    )
    return {
        "region_id": region.id,
        "region_code": region.code,
        "observed_at": stamp,
        "is_forecast": offset_hours > 0,
        "provider": "demo-model (ml/hydrology.py)",
        "data_mode": "DEMO",
        "rainfall_mm": float(series.rain[idx]),
        **acc,
        "rainfall_anomaly": anomaly,
        "temperature_c": float(series.temperature[idx]),
        "humidity_pct": float(series.humidity[idx]),
        "soil_moisture_pct": float(series.soil_moisture[idx]),
    }


# ------------------------------------------------------------------ live

def _open_meteo_url(region: Region) -> tuple[str, dict[str, Any]]:
    params = {
        "latitude": round(float(region.latitude), 4),
        "longitude": round(float(region.longitude), 4),
        "hourly": ",".join(
            [
                "precipitation",
                "temperature_2m",
                "relative_humidity_2m",
                "soil_moisture_3_to_9cm",
            ]
        ),
        "past_days": 7,
        "forecast_days": 4,
        "timezone": "UTC",
    }
    return settings.weather_api_base, params


def _parse_open_meteo(payload: dict[str, Any], region: Region) -> list[dict[str, Any]]:
    """Turn the provider's hourly arrays into our accumulation contract."""
    hourly = payload.get("hourly") or {}
    times = hourly.get("time") or []
    if not times:
        raise ValueError("weather provider returned no hourly data")

    rain = np.asarray(hourly.get("precipitation") or [0.0] * len(times), dtype=float)
    rain = np.nan_to_num(rain, nan=0.0)
    temp = np.asarray(hourly.get("temperature_2m") or [np.nan] * len(times), dtype=float)
    humid = np.asarray(hourly.get("relative_humidity_2m") or [np.nan] * len(times), dtype=float)
    # Open-Meteo reports volumetric soil moisture as m3/m3; the model wants %.
    soil_raw = np.asarray(
        hourly.get("soil_moisture_3_to_9cm") or [np.nan] * len(times), dtype=float
    )
    soil = soil_raw * 100.0

    out: list[dict[str, Any]] = []
    now = floor_hour(utcnow())
    annual = float(region.annual_rainfall_mm or 2000.0)
    for i, stamp_text in enumerate(times):
        stamp = datetime.fromisoformat(stamp_text).replace(tzinfo=timezone.utc)
        acc = hyd.accumulations(rain, i)
        out.append(
            {
                "region_id": region.id,
                "region_code": region.code,
                "observed_at": stamp,
                "is_forecast": stamp > now,
                "provider": f"{settings.weather_provider} (live)",
                "data_mode": "LIVE",
                "rainfall_mm": float(rain[i]),
                **acc,
                "rainfall_anomaly": hyd.rainfall_anomaly(
                    acc["rainfall_7d"], annual, day_of_year(stamp), region.zone
                ),
                "temperature_c": None if np.isnan(temp[i]) else float(temp[i]),
                "humidity_pct": None if np.isnan(humid[i]) else float(humid[i]),
                "soil_moisture_pct": None if np.isnan(soil[i]) else round(float(soil[i]), 2),
            }
        )
    return out


def _fetch_live(region: Region) -> list[dict[str, Any]] | None:
    """One live fetch, cached for 15 minutes per region. None on any failure."""
    global _live_failure

    cached = _live_cache.get(region.id)
    now_ts = utcnow().timestamp()
    if cached and now_ts - cached[0] < LIVE_TTL_SECONDS:
        return cached[1]["rows"]

    try:
        import httpx
    except ImportError:
        _live_failure = "httpx is not installed; live weather is unavailable"
        LOG.warning(_live_failure)
        return None

    url, params = _open_meteo_url(region)
    try:
        with httpx.Client(timeout=settings.weather_timeout_seconds) as client:
            response = client.get(url, params=params)
            response.raise_for_status()
            rows = _parse_open_meteo(response.json(), region)
    except Exception as exc:
        _live_failure = f"{type(exc).__name__}: {exc}"
        LOG.warning("live weather fetch failed for %s (%s); using DEMO data", region.code, exc)
        return None

    _live_failure = None
    with _lock:
        _live_cache[region.id] = (now_ts, {"rows": rows})
    return rows


def _nearest(rows: list[dict[str, Any]], moment: datetime) -> dict[str, Any]:
    target = floor_hour(moment)
    return min(rows, key=lambda r: abs((r["observed_at"] - target).total_seconds()))


# --------------------------------------------------------------- public API

def current(region: Region, *, scenario_key: str | None = None) -> dict[str, Any]:
    """Weather for this region right now, with the active scenario applied."""
    scn = scenario_module.get(scenario_key)
    reading: dict[str, Any] | None = None

    if settings.use_live_weather:
        rows = _fetch_live(region)
        if rows:
            reading = dict(_nearest(rows, utcnow()))

    if reading is None:
        reading = _demo_reading(region, utcnow())
        if settings.use_live_weather:
            reading["fallback_reason"] = _live_failure or "live weather unavailable"

    return _apply_scenario(reading, scn)


def forecast_hours(
    region: Region, horizons: tuple[int, ...], *, scenario_key: str | None = None
) -> list[dict[str, Any]]:
    """Weather at each horizon, from the same series as `current`.

    Reading forward through one physical series is what makes the 72-hour risk
    curve coherent: the +24 h soil moisture is the result of the rain that fell
    at +6 h and +12 h, not an independent draw.
    """
    scn = scenario_module.get(scenario_key)
    now = utcnow()
    rows: list[dict[str, Any]] = []

    live_rows = _fetch_live(region) if settings.use_live_weather else None
    for hours in horizons:
        moment = now.replace(minute=0, second=0, microsecond=0)
        target = moment.timestamp() + hours * 3600
        if live_rows:
            reading = dict(_nearest(live_rows, datetime.fromtimestamp(target, tz=timezone.utc)))
        else:
            reading = _demo_reading(region, now, offset_hours=hours)
            reading["observed_at"] = datetime.fromtimestamp(target, tz=timezone.utc)
            reading["is_forecast"] = hours > 0
        reading["horizon_hours"] = hours
        rows.append(_apply_scenario(reading, scn))
    return rows


def hourly_window(
    region: Region, *, back_hours: int = 24, forward_hours: int = 48,
    scenario_key: str | None = None,
) -> list[dict[str, Any]]:
    """A contiguous hourly window around now - the weather chart's data."""
    scn = scenario_module.get(scenario_key)
    now = utcnow()
    live_rows = _fetch_live(region) if settings.use_live_weather else None

    rows: list[dict[str, Any]] = []
    for offset in range(-abs(back_hours), abs(forward_hours) + 1):
        target = datetime.fromtimestamp(
            floor_hour(now).timestamp() + offset * 3600, tz=timezone.utc
        )
        if live_rows:
            reading = dict(_nearest(live_rows, target))
        else:
            reading = _demo_reading(region, now, offset_hours=offset)
            reading["observed_at"] = target
            reading["is_forecast"] = offset > 0
        rows.append(_apply_scenario(reading, scn))
    return rows


def provider_status() -> dict[str, Any]:
    """What /api/health and the UI badge report about the weather source."""
    if not settings.use_live_weather:
        return {
            "mode": "DEMO",
            "provider": "demo-model (ml/hydrology.py)",
            "live_configured": False,
            "note": (
                "DEMO DATA - weather is produced by the documented physical model in "
                "ml/hydrology.py. Set USE_LIVE_WEATHER=true to use the Open-Meteo "
                "public forecast API instead."
            ),
        }
    if _live_failure:
        return {
            "mode": "DEMO",
            "provider": "demo-model (fallback)",
            "live_configured": True,
            "note": (
                "Live weather was requested but the provider could not be reached, so "
                f"DEMO data is being served. Reason: {_live_failure}"
            ),
        }
    return {
        "mode": "LIVE",
        "provider": settings.weather_provider,
        "live_configured": True,
        "note": f"LIVE DATA - hourly weather from {settings.weather_provider}.",
    }


def reset_cache() -> None:
    """Drop cached series - used by tests and after a settings change."""
    with _lock:
        _series_cache.clear()
        _live_cache.clear()
