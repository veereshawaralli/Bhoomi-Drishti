"""Demo scenarios - the switch that drives the whole platform.

The specification asks for four loadable scenarios, and for selecting one to
update every screen at once. That is implemented here as a single piece of
process state plus a set of *physical* modifiers. Choosing EXTREME_RAINFALL
does not paint numbers onto the dashboard; it multiplies the rainfall the
weather service produces, which changes soil moisture through the same water
balance, which changes the features the model sees, which changes the score,
which crosses the alert threshold. Every downstream number moves because the
input moved.

That matters for honesty as much as for engineering: a scenario is labelled
``SIMULATED`` end to end (except NORMAL, which is the ordinary DEMO baseline),
and the API says so in every response, so nobody can mistake a demonstration
for a live warning.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Any

LOG = logging.getLogger("app.scenario")


@dataclass(frozen=True)
class Scenario:
    """A named set of physical modifiers applied to the weather model."""

    key: str
    label: str
    description: str
    # Multiplier on wet-hour rainfall intensity. 1.0 = the region's own normal.
    rain_multiplier: float = 1.0
    # Absolute percentage points added to modelled soil moisture, after the
    # water balance has run. Represents antecedent wetness the short window
    # does not capture.
    soil_moisture_add: float = 0.0
    # Floor on the 24 h total (mm). Guarantees the demo shows a real storm
    # even in a region whose sampled fortnight happened to be quiet.
    min_rain_24h: float = 0.0
    min_rain_1h: float = 0.0
    # Multiplier on the rainfall anomaly ratio.
    anomaly_multiplier: float = 1.0
    data_mode: str = "SIMULATED"
    badge: str = "SIMULATED SCENARIO"
    detail: dict[str, Any] = field(default_factory=dict)

    def as_dict(self, *, active: bool) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "description": self.description,
            "changes": {
                "rainfall_intensity": f"x{self.rain_multiplier:g}",
                "soil_moisture_added": f"+{self.soil_moisture_add:g} percentage points",
                "minimum_24h_rainfall": f"{self.min_rain_24h:g} mm",
                "rainfall_anomaly": f"x{self.anomaly_multiplier:g}",
                **self.detail,
            },
            "active": active,
            "data_mode": self.data_mode,
        }


from ..config import settings as _settings

SCENARIOS: dict[str, Scenario] = {
    "NORMAL": Scenario(
        key="NORMAL",
        label="Normal Weather",
        description=(
            "Baseline conditions: each region's own weather for "
            "today's date, with no scenario applied."
        ),
        rain_multiplier=1.0,
        soil_moisture_add=0.0,
        data_mode=_settings.weather_mode,
        badge=f"{_settings.weather_mode} DATA",
        detail={"expected_effect": "Most regions VERY LOW to LOW"},
    ),
    "HEAVY_RAINFALL": Scenario(
        key="HEAVY_RAINFALL",
        label="Heavy Rainfall",
        description=(
            "An active monsoon spell: rainfall intensity roughly tripled and "
            "the soil already wet from preceding days."
        ),
        rain_multiplier=3.0,
        soil_moisture_add=7.0,
        min_rain_24h=95.0,
        min_rain_1h=8.0,
        anomaly_multiplier=2.4,
        detail={"expected_effect": "Wet-zone regions move into MODERATE and HIGH"},
    ),
    "EXTREME_RAINFALL": Scenario(
        key="EXTREME_RAINFALL",
        label="Extreme Rainfall",
        description=(
            "A cloudburst on already-saturated ground - the regime in which "
            "most Indian rainfall-triggered landslides occur."
        ),
        rain_multiplier=6.5,
        soil_moisture_add=14.0,
        min_rain_24h=230.0,
        min_rain_1h=26.0,
        anomaly_multiplier=4.2,
        detail={"expected_effect": "Several regions reach HIGH and CRITICAL"},
    ),
    "CRITICAL_RISK": Scenario(
        key="CRITICAL_RISK",
        label="Critical Landslide Risk",
        description=(
            "Sustained extreme rainfall over several days with the soil profile "
            "at saturation - the worst case the platform is designed to warn on."
        ),
        rain_multiplier=9.0,
        soil_moisture_add=20.0,
        min_rain_24h=340.0,
        min_rain_1h=42.0,
        anomaly_multiplier=5.5,
        detail={"expected_effect": "Steep high-history regions reach CRITICAL"},
    ),
}

DEFAULT_SCENARIO = "NORMAL"


class ScenarioState:
    """Which scenario the platform is currently showing.

    Process-level rather than per-user by design: this is a shared operations
    picture, and during a demo the presenter changes the scenario on one screen
    and the dashboard on the projector must follow. A multi-tenant deployment
    would move this into the session or a per-user row; nothing else changes.
    """

    def __init__(self) -> None:
        self._key = DEFAULT_SCENARIO
        self._lock = threading.Lock()
        self._version = 0

    @property
    def key(self) -> str:
        return self._key

    @property
    def version(self) -> int:
        """Bumped on every change - used to invalidate cached predictions."""
        return self._version

    @property
    def current(self) -> Scenario:
        return SCENARIOS[self._key]

    def set(self, key: str) -> Scenario:
        normalised = (key or "").strip().upper().replace(" ", "_")
        if normalised not in SCENARIOS:
            raise KeyError(normalised)
        with self._lock:
            if normalised != self._key:
                LOG.info("scenario changed: %s -> %s", self._key, normalised)
                self._key = normalised
                self._version += 1
        return SCENARIOS[normalised]

    def reset(self) -> Scenario:
        return self.set(DEFAULT_SCENARIO)

    def listing(self) -> list[dict[str, Any]]:
        return [s.as_dict(active=(k == self._key)) for k, s in SCENARIOS.items()]


state = ScenarioState()


def get(key: str | None = None) -> Scenario:
    """The named scenario, or the active one."""
    if key is None:
        return state.current
    normalised = (key or "").strip().upper().replace(" ", "_")
    return SCENARIOS.get(normalised, SCENARIOS[DEFAULT_SCENARIO])


def data_mode_for(key: str | None = None) -> str:
    """The provenance label a reading produced under this scenario carries."""
    return get(key).data_mode
