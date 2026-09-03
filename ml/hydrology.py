"""Physical environment model: rainfall, soil water balance, air temperature.

This module is the single source of truth for "what the weather is doing".
It is used twice:

1. offline, by ml/data/generate_dataset.py, to build training samples whose
   rainfall accumulations are internally consistent (r1h <= r6h <= r24h ...)
   because they are summed from one synthetic hourly series;
2. online, by backend/app/services/weather_service.py, when the platform runs
   in DEMO mode - the same functions, seeded by region and date, so the demo
   is reproducible and the features the model sees at inference time have the
   same structure as the features it was trained on.

Nothing here is random at run time: every series is a pure function of its
seed, so reloading the dashboard shows the same numbers.
"""
from __future__ import annotations

import numpy as np

# (peak day-of-year, spread in days, dry-season floor) per landslide zone
ZONE_SEASON: dict[str, tuple[float, float, float]] = {
    "WESTERN_GHATS": (185.0, 42.0, 0.06),
    "HIMALAYA_WEST": (205.0, 38.0, 0.10),
    "HIMALAYA_CENTRAL": (200.0, 36.0, 0.08),
    "HIMALAYA_EAST": (190.0, 46.0, 0.10),
    "NORTHEAST": (175.0, 58.0, 0.14),
    "EASTERN_GHATS": (215.0, 40.0, 0.05),
}

# soil code -> (wilting point %, capacity %, daily drainage fraction)
# The drainage fraction is the share of the water held above wilting point
# that leaves the profile per day at moderate wetness; it sets the recession
# rate after a storm (fast on rock and gravel, slow in clay), which is what
# makes antecedent rainfall persist for days in fine-textured soils.
SOIL_WATER: dict[int, tuple[float, float, float]] = {
    0: (4.0, 26.0, 0.55),   # ROCKY
    1: (5.0, 30.0, 0.45),   # GRAVEL
    2: (6.0, 34.0, 0.38),   # SANDY
    3: (8.0, 42.0, 0.28),   # ALLUVIAL
    4: (10.0, 48.0, 0.22),  # LOAM
    5: (11.0, 52.0, 0.19),  # LATERITE
    6: (12.0, 54.0, 0.16),  # SILT
    7: (14.0, 58.0, 0.11),  # CLAY
}

# Percentage points of volumetric water added per mm of infiltrating rain,
# before the texture scaling and the saturation cut-off in
# `soil_moisture_series`. See that function's docstring for the derivation.
INFIL_PER_MM = 0.105


def seasonal_factor(day_of_year: int | np.ndarray, zone: str) -> np.ndarray:
    """0-1 monsoon activity curve for a zone (Gaussian around the peak)."""
    peak, spread, floor = ZONE_SEASON.get(zone, ZONE_SEASON["WESTERN_GHATS"])
    d = np.asarray(day_of_year, dtype=float)
    diff = np.abs(((d - peak + 182.5) % 365.0) - 182.5)
    return floor + (1.0 - floor) * np.exp(-0.5 * (diff / spread) ** 2)


_SEASON_MEAN: dict[str, float] = {}


def season_mean(zone: str) -> float:
    """Year-average of `seasonal_factor`, used to normalise the annual total."""
    key = zone if zone in ZONE_SEASON else "WESTERN_GHATS"
    if key not in _SEASON_MEAN:
        _SEASON_MEAN[key] = float(np.mean(seasonal_factor(np.arange(365), key)))
    return _SEASON_MEAN[key]


def _spell_envelope(rng: np.random.Generator, hours: int) -> np.ndarray:
    """Slow multiplicative envelope for monsoon active and break spells.

    The Indian monsoon does not rain evenly: it swings between active spells
    and breaks on 3-20 day timescales (the intra-seasonal oscillation). Without
    that modulation a 14-day hourly series averages out and every day looks
    like the seasonal mean, which would rob the model of exactly the pattern
    that matters - several wet days in a row followed by a heavy burst.

    Built from a few random Fourier components in log space and renormalised
    so its expectation is 1, which leaves the annual rainfall total intact.
    """
    t = np.arange(hours, dtype=float)
    amplitudes = (0.55, 0.50, 0.45, 0.40)
    periods_days = (3.0, 6.0, 11.0, 19.0)
    log_env = np.zeros(hours)
    for amp, period in zip(amplitudes, periods_days):
        phase = rng.uniform(0.0, 2.0 * np.pi)
        log_env += amp * np.sin(2.0 * np.pi * t / (24.0 * period) + phase)
    variance = 0.5 * sum(a * a for a in amplitudes)
    return np.exp(log_env - variance)


def rainfall_series(
    *,
    seed: int,
    hours: int,
    start_day_of_year: int,
    zone: str,
    monsoon_index: float,
    annual_rainfall_mm: float = 2000.0,
    intensity_multiplier: float = 1.0,
) -> np.ndarray:
    """Hourly rainfall in mm from a clustered wet/dry Markov-gamma process.

    Three properties make this usable as a physical driver rather than noise:

    * **Storms persist.** A wet hour makes the next hour far more likely to be
      wet, which produces the multi-hour bursts that trigger slope failures -
      the thing independent hourly draws cannot reproduce.
    * **Spells persist.** A slow envelope (`_spell_envelope`) turns the monsoon
      on and off over days, so antecedent rainfall varies the way it really
      does instead of hovering at the seasonal mean.
    * **The annual total is honoured.** The gamma scale is derived from the
      region's own `annual_rainfall_mm`, redistributed over the year by the
      zone's seasonal curve, so at `intensity_multiplier = 1.0` the series
      integrates to roughly that region's normal rainfall (verified to within
      a couple of percent). This is what makes `rainfall_anomaly` meaningful
      and lets Sohra (11 000 mm) and Reckong Peo (700 mm) behave differently
      with no per-region tuning.

    `intensity_multiplier` scales wet-hour intensity while leaving the wet/dry
    pattern alone - "the same monsoon week, but with this much more water" -
    and is how the scenario engine builds a cloudburst.
    """
    rng = np.random.default_rng(int(seed) & 0x7FFFFFFF)
    doy = (np.arange(hours) / 24.0 + start_day_of_year).astype(int) % 365
    season = seasonal_factor(doy, zone)
    mi = float(np.clip(monsoon_index, 0.2, 2.0))

    hour_of_day = np.arange(hours) % 24
    diurnal = 1.0 + 0.30 * np.sin((hour_of_day - 15) / 24.0 * 2 * np.pi)
    envelope = _spell_envelope(rng, hours)

    # Two-state chain: p01 = dry->wet, p_ww = wet->wet (storm persistence).
    # An active spell rains both more often and harder, so the envelope is
    # split between the wet-hour frequency and the wet-hour intensity.
    p_dry_to_wet = np.clip(
        (0.020 + 0.22 * season * mi) * diurnal * envelope**0.35, 0.002, 0.72
    )
    p_wet_to_wet = np.clip(0.40 + 0.35 * season, 0.25, 0.88)
    fraction_wet = p_dry_to_wet / np.maximum(1e-6, p_dry_to_wet + (1.0 - p_wet_to_wet))

    # Low gamma shape = heavily skewed intensities, so ordinary drizzle and
    # 60 mm/h cloudburst hours come out of the same distribution.
    shape = 0.55 + 0.15 * season
    daily_normal = annual_rainfall_mm * season / max(1e-6, season_mean(zone) * 365.0)
    scale = (daily_normal / 24.0) * envelope**0.65 / np.maximum(1e-6, fraction_wet * shape)

    # Rescale so the series' expected total is exactly the seasonal normal for
    # these hours. Splitting the envelope across frequency and intensity, and
    # clipping the transition probabilities, both bias the total downwards by
    # 15-20%; correcting against the analytic expectation removes that instead
    # of leaving the annual rainfall quietly wrong.
    expected = fraction_wet * shape * scale
    target = float(np.sum(daily_normal) / 24.0)
    total_expected = float(np.sum(expected))
    if total_expected > 1e-9:
        scale = scale * (target / total_expected)
    scale = scale * max(0.05, float(intensity_multiplier))

    # Draw all randomness vectorised, then run the (cheap) chain over states.
    uniforms = rng.random(hours)
    intensities = rng.gamma(shape, scale)
    p_dry = p_dry_to_wet.tolist()
    p_wet = np.broadcast_to(p_wet_to_wet, (hours,)).tolist()
    u = uniforms.tolist()
    g = intensities.tolist()

    rain = [0.0] * hours
    wet = False
    for t in range(hours):
        p = p_wet[t] if wet else p_dry[t]
        wet = u[t] < min(0.97, p)
        if wet:
            rain[t] = g[t]
    return np.round(np.asarray(rain, dtype=float), 2)



def soil_moisture_series(
    rain: np.ndarray,
    *,
    soil_code: int,
    temperature_c: np.ndarray | float = 22.0,
    initial_pct: float | None = None,
) -> np.ndarray:
    """Single-layer water balance: infiltration in, drainage + ET out.

    sm[t] = sm[t-1] + infiltration(rain, saturation) - drainage - ET

    Infiltration falls off as the profile saturates (the rest becomes runoff),
    so the same 100 mm of rain raises pore pressure much more on an already
    wet slope. That non-linearity is the physical reason antecedent rainfall
    matters, and it is why the model can distinguish the third day of a wet
    spell from an equally heavy but isolated storm.

    Units: `sm` is volumetric water content in percent. `INFIL_PER_MM` lumps
    together the depth of the modelled profile and its porosity - 1 mm of rain
    over a ~1.5 m column is on the order of 0.1 percentage points - and is
    scaled by texture so fine soils bank more of each millimetre.
    """
    wilting, capacity, drain = SOIL_WATER.get(int(soil_code), SOIL_WATER[4])
    rain_list = np.asarray(rain, dtype=float).tolist()
    n = len(rain_list)
    temp_list = np.broadcast_to(np.asarray(temperature_c, dtype=float), (n,)).tolist()
    span = max(1e-6, capacity - wilting)
    hourly_drain = drain / 24.0
    infil_scale = INFIL_PER_MM * (capacity / 48.0)

    cur = float(initial_pct if initial_pct is not None else wilting + 0.35 * span)
    out = [0.0] * n
    for t in range(n):
        saturation = (cur - wilting) / span
        saturation = 0.0 if saturation < 0.0 else (1.0 if saturation > 1.0 else saturation)
        infiltration = infil_scale * rain_list[t] * (1.0 - 0.75 * saturation)
        drainage = hourly_drain * (cur - wilting) * (0.4 + 1.6 * saturation)
        et = 0.0035 * max(0.0, temp_list[t] - 4.0) * (0.3 + 0.7 * saturation)
        cur += infiltration - drainage - et
        if cur < wilting:
            cur = wilting
        elif cur > capacity * 1.06:
            cur = capacity * 1.06
        out[t] = cur
    return np.round(np.asarray(out, dtype=float), 2)



def temperature_series(
    *, hours: int, start_day_of_year: int, elevation_m: float, latitude: float, seed: int = 0
) -> np.ndarray:
    """Air temperature: annual cycle + diurnal cycle + dry-adiabatic lapse."""
    rng = np.random.default_rng((int(seed) ^ 0x5EED) & 0x7FFFFFFF)
    t = np.arange(hours)
    doy = (t / 24.0 + start_day_of_year) % 365
    annual = 26.0 - 0.42 * abs(latitude - 12.0) + 6.5 * np.sin((doy - 110) / 365.0 * 2 * np.pi)
    diurnal = 4.6 * np.sin((t % 24 - 15) / 24.0 * 2 * np.pi)
    lapse = 6.5 * (elevation_m / 1000.0)
    noise = rng.normal(0.0, 0.7, hours)
    return np.round(annual + diurnal - lapse + noise, 2)


def humidity_series(rain: np.ndarray, temperature: np.ndarray, *, seed: int = 0) -> np.ndarray:
    """Relative humidity driven by recent rainfall and temperature."""
    rng = np.random.default_rng((int(seed) ^ 0xB0D1) & 0x7FFFFFFF)
    kernel = np.exp(-np.arange(12) / 5.0)
    recent = np.convolve(rain, kernel, mode="full")[: rain.size]
    base = 58.0 + 34.0 * (1.0 - np.exp(-recent / 6.0))
    return np.round(np.clip(base - 0.45 * (temperature - 22.0) + rng.normal(0, 1.6, rain.size), 18.0, 100.0), 1)


def accumulations(rain: np.ndarray, idx: int) -> dict[str, float]:
    """Rainfall totals for the windows ending at hour `idx` (inclusive)."""
    idx = int(np.clip(idx, 0, rain.size - 1))

    def total(window: int) -> float:
        return float(np.round(rain[max(0, idx - window + 1) : idx + 1].sum(), 2))

    return {
        "rainfall_1h": total(1),
        "rainfall_6h": total(6),
        "rainfall_24h": total(24),
        "rainfall_72h": total(72),
        "rainfall_7d": total(168),
    }


def rainfall_anomaly(rainfall_7d: float, annual_rainfall_mm: float, day_of_year: int, zone: str) -> float:
    """Observed 7-day total divided by the seasonal normal for that week.

    1.0 means "exactly normal for this week of the year"; 3.0 means three
    times the seasonal normal, which is the regime in which most Indian
    rainfall-triggered landslides occur.
    """
    season = float(seasonal_factor(day_of_year, zone))
    weight = season / max(1e-6, float(np.mean(seasonal_factor(np.arange(365), zone))))
    normal_7d = max(4.0, annual_rainfall_mm * (7.0 / 365.0) * weight)
    return float(np.round(np.clip(rainfall_7d / normal_7d, 0.0, 12.0), 3))
