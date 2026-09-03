"""Pydantic v2 request / response contracts.

One rule governs this file: **every response that describes data carries a
``data_mode`` field** (LIVE / DEMO / SIMULATED) so the UI never has to guess
whether a number is an observation or a model. Where a response aggregates
several rows of mixed provenance a single ``data_mode`` is reported only when
it is uniform; otherwise a per-row field wins.

``risk_score`` is always on the specified 0-100 scale, ``confidence`` is a
percentage (0-100) in API responses - the database stores it 0-1 and the
services convert.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

DataMode = Literal["LIVE", "DEMO", "SIMULATED"]
RiskLevel = Literal["VERY LOW", "LOW", "MODERATE", "HIGH", "CRITICAL"]
ScenarioKey = Literal["NORMAL", "HEAVY_RAINFALL", "EXTREME_RAINFALL", "CRITICAL_RISK"]


class ORMModel(BaseModel):
    """Base for schema objects projected straight from ORM rows."""

    model_config = ConfigDict(from_attributes=True)


class ModelFields(BaseModel):
    """Base for responses that carry ``model_*`` fields.

    Pydantic v2 reserves the ``model_`` prefix for its own methods and warns on
    any field that uses it. The specification names these fields, and renaming
    them would make the API less clear than the warning is worth, so the guard
    is switched off for the handful of schemas that need it.
    """

    model_config = ConfigDict(protected_namespaces=())


# --------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------

class LoginRequest(BaseModel):
    username: str = Field(min_length=2, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class RoleOut(BaseModel):
    role: str
    can_manage_alerts: bool
    can_review_reports: bool
    is_admin: bool


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in_minutes: int
    user: "UserOut"


class UserOut(ORMModel):
    id: int
    username: str
    full_name: str | None = None
    role: str
    organisation: str | None = None
    phone: str | None = None


class AppInfo(ModelFields):
    name: str
    version: str
    tagline: str
    model: dict[str, Any]
    data_provenance: dict[str, Any]
    data_mode: DataMode
    thresholds: dict[str, float]


# --------------------------------------------------------------------------
# Regions and risk map
# --------------------------------------------------------------------------

class RegionOut(ORMModel):
    id: int
    code: str
    name: str
    district: str
    state: str
    zone: str
    latitude: float
    longitude: float
    historical_landslide_count: int
    annual_rainfall_mm: float | None = None
    population_exposed: int | None = None
    area_km2: float | None = None
    data_source: str


class RegionTerrainOut(ORMModel):
    elevation_m: float
    slope_deg: float
    aspect_deg: float | None = None
    relief_m: float | None = None
    soil_type: str
    land_cover: str
    vegetation_index: float
    distance_to_river_km: float
    distance_to_road_km: float | None = None
    dem_source: str
    data_mode: DataMode


class RiskMapPoint(BaseModel):
    region: RegionOut
    risk_score: float
    risk_level: RiskLevel
    confidence: float
    scenario: str
    data_mode: DataMode
    predicted_at: datetime | None = None


class RiskMapResponse(BaseModel):
    generated_at: datetime
    data_mode: DataMode
    count: int
    points: list[RiskMapPoint]
    band_counts: dict[str, int]
    high_risk_count: int
    critical_count: int
    note: str


class RegionDetail(BaseModel):
    region: RegionOut
    terrain: RegionTerrainOut | None = None
    current_risk: dict[str, Any] | None = None
    weather: dict[str, Any] | None = None
    latest_alerts: list["AlertOut"] = Field(default_factory=list)


# --------------------------------------------------------------------------
# Prediction and explanation
# --------------------------------------------------------------------------

class PredictRequest(BaseModel):
    """POST /api/predict.

    `region_id` or `region_code` selects a monitored region whose stored
    terrain plus current weather are used; alternatively `latitude` /
    `longitude` name an arbitrary point (a lower-quality prediction, made
    from nearby terrain defaults - reported via `defaulted_fields`).
    Rainfall and soil moisture can be overridden for what-if use, though the
    dedicated /api/what-if endpoint is the intended path for that.
    """

    region_id: int | None = None
    region_code: str | None = None
    latitude: float | None = Field(default=None, ge=-90.0, le=90.0)
    longitude: float | None = Field(default=None, ge=-180.0, le=180.0)
    rainfall_1h: float | None = Field(default=None, ge=0.0)
    rainfall_6h: float | None = Field(default=None, ge=0.0)
    rainfall_24h: float | None = Field(default=None, ge=0.0)
    rainfall_72h: float | None = Field(default=None, ge=0.0)
    rainfall_7d: float | None = Field(default=None, ge=0.0)
    rainfall_anomaly: float | None = Field(default=None, ge=0.0)
    soil_moisture: float | None = Field(default=None, ge=0.0, le=100.0)
    scenario: ScenarioKey = "NORMAL"
    explain: bool = True

    @field_validator("scenario", mode="before")
    @classmethod
    def _scenario_upper(cls, value: Any) -> Any:
        """Accept `heavy rainfall` as well as `HEAVY_RAINFALL`.

        Normalising *before* the `Literal` check is deliberate: an unknown key must
        reach the client as a 422 naming the four valid scenarios. Letting it through
        to `scenario.get()` would score it as NORMAL and answer 200, which is the
        worst outcome — a caller asking for extreme rainfall and quietly being told
        about a calm day. `GET /api/risk-map?scenario=…` already refuses unknown keys
        with a 400, and these two paths must not disagree.
        """
        if isinstance(value, str):
            return value.strip().upper().replace(" ", "_")
        return value


class FactorOut(BaseModel):
    feature: str
    label: str
    # Signed log-odds: how far this group of features moved the model's
    # decision, negative when the group argued the slope was safer.
    contribution: float
    direction: Literal["raising", "lowering", "neutral"]
    # The same effect as a percentage of the total movement the model weighed,
    # in both directions - this is the number the explanation panel draws.
    share_percent: float
    value: float
    value_text: str
    evidence: str | None = None


class FeatureDetail(BaseModel):
    feature: str
    label: str
    value: float
    value_text: str
    contribution: float
    share_percent: float


class ExplanationOut(BaseModel):
    method: str
    method_label: str
    reference: str
    additive: bool
    share_basis: str
    baseline_log_odds: float
    total_log_odds: float
    top_factors: list[FactorOut]
    protective_factors: list[FactorOut]
    factors: list[FactorOut]
    feature_detail: list[FeatureDetail]
    summary: str
    disclaimer: str


class PredictResponse(ModelFields):
    region_id: int | None
    region_code: str | None
    region_name: str | None
    risk_score: float
    risk_level: RiskLevel
    confidence: float
    probability: float
    model_backend: str
    model_name: str
    model_version: str
    scenario: str
    data_mode: DataMode
    defaulted_fields: list[str]
    top_factors: list[FactorOut]
    explanation: ExplanationOut | None = None
    features: dict[str, float]
    predicted_at: datetime


# --------------------------------------------------------------------------
# Forecast
# --------------------------------------------------------------------------

class ForecastPoint(BaseModel):
    label: str
    hours: int
    valid_at: datetime
    risk_score: float
    risk_level: RiskLevel
    confidence: float
    rainfall_mm: float
    soil_moisture_pct: float | None = None


class ForecastResponse(ModelFields):
    region_id: int
    region_code: str
    region_name: str
    issued_at: datetime
    scenario: str
    data_mode: DataMode
    model_backend: str
    points: list[ForecastPoint]
    peak: ForecastPoint
    summary: str


# --------------------------------------------------------------------------
# Weather
# --------------------------------------------------------------------------

class WeatherOut(BaseModel):
    region_id: int
    region_code: str
    observed_at: datetime
    is_forecast: bool
    provider: str
    data_mode: DataMode
    rainfall_mm: float
    rainfall_1h: float
    rainfall_6h: float
    rainfall_24h: float
    rainfall_72h: float
    rainfall_7d: float
    rainfall_anomaly: float
    temperature_c: float | None = None
    humidity_pct: float | None = None
    soil_moisture_pct: float | None = None


class WeatherSeriesResponse(BaseModel):
    region_id: int
    region_code: str
    mode: DataMode
    provider: str
    hourly: list[WeatherOut]
    note: str | None = None


# --------------------------------------------------------------------------
# Alerts
# --------------------------------------------------------------------------

class AlertOut(ORMModel):
    id: int
    alert_code: str
    region_id: int
    region_name: str | None = None
    region_code: str | None = None
    severity: Literal["HIGH", "CRITICAL"]
    risk_score: float
    status: Literal["NEW", "ACKNOWLEDGED", "IN PROGRESS", "RESOLVED"]
    cause: str
    recommended_action: str
    scenario: str
    data_mode: DataMode
    assigned_to: str | None = None
    note: str | None = None
    created_at: datetime
    updated_at: datetime
    acknowledged_at: datetime | None = None
    resolved_at: datetime | None = None


class AlertUpdate(BaseModel):
    status: Literal["NEW", "ACKNOWLEDGED", "IN PROGRESS", "RESOLVED"]
    assigned_to: str | None = Field(default=None, max_length=128)
    note: str | None = Field(default=None, max_length=2000)


class ManualAlertIn(BaseModel):
    region_id: int
    severity: Literal["HIGH", "CRITICAL"]
    risk_score: float = Field(ge=0.0, le=100.0)
    cause: str = Field(min_length=8, max_length=1000)
    recommended_action: str = Field(min_length=8, max_length=1000)
    scenario: str = "MANUAL"


class AlertStats(BaseModel):
    total: int
    new: int
    acknowledged: int
    in_progress: int
    resolved: int
    high: int
    critical: int


# --------------------------------------------------------------------------
# History (landslide events)
# --------------------------------------------------------------------------

class EventOut(ORMModel):
    id: int
    event_id: str
    region_id: int | None = None
    region_code: str | None = None
    event_date: date
    location: str
    district: str | None = None
    state: str | None = None
    latitude: float
    longitude: float
    rainfall_mm: float | None = None
    slope_deg: float | None = None
    elevation_m: float | None = None
    severity: Literal["MINOR", "MODERATE", "MAJOR", "SEVERE"]
    trigger: str | None = None
    fatalities: int | None = None
    description: str | None = None
    source: str
    data_mode: DataMode


class HistoryResponse(BaseModel):
    total: int
    filtered: int
    events: list[EventOut]
    filter_options: dict[str, list[Any]]
    charts: dict[str, Any]
    data_mode: DataMode


# --------------------------------------------------------------------------
# Citizen reports
# --------------------------------------------------------------------------

class CitizenReportIn(BaseModel):
    location_text: str = Field(min_length=4, max_length=200)
    latitude: float = Field(ge=-90.0, le=90.0)
    longitude: float = Field(ge=-180.0, le=180.0)
    observation_type: Literal[
        "GROUND CRACK", "ROAD CRACK", "ROCKFALL", "SOIL MOVEMENT",
        "POSSIBLE LANDSLIDE", "OTHER",
    ]
    severity: Literal["LOW", "MEDIUM", "HIGH"]
    description: str = Field(min_length=10, max_length=3000)
    reporter_name: str | None = Field(default=None, max_length=128)
    reporter_phone: str | None = Field(default=None, max_length=24)
    observed_on: date | None = None
    region_id: int | None = None


class ImageAnalysisOut(BaseModel):
    category: str
    category_label: str
    confidence: float
    features: list[str]
    recommendation: str
    method: str
    disclaimer: str


class CitizenReportOut(ORMModel):
    id: int
    report_code: str
    region_id: int | None = None
    region_name: str | None = None
    reporter_name: str | None = None
    location_text: str
    latitude: float
    longitude: float
    observation_type: str
    severity: str
    description: str
    # The citizen's words and the officer's notes are separate fields because
    # they are separate kinds of statement. `description` is written once, at
    # submission; triage appends here instead, timestamped and attributed.
    officer_note: str | None = None
    has_image: bool
    image_analysis: ImageAnalysisOut | None = None
    observed_on: date
    status: Literal["NEW", "UNDER REVIEW", "VERIFIED", "DISMISSED"]
    created_at: datetime


class ReportStatusUpdate(BaseModel):
    status: Literal["NEW", "UNDER REVIEW", "VERIFIED", "DISMISSED"]
    note: str | None = Field(default=None, max_length=2000)


# --------------------------------------------------------------------------
# Virtual sensors
# --------------------------------------------------------------------------

class SensorOut(ORMModel):
    id: int
    sensor_code: str
    region_id: int
    region_name: str | None = None
    region_code: str | None = None
    sensor_type: str
    reading: float
    unit: str
    status: Literal["NORMAL", "ELEVATED", "ALARM", "OFFLINE"]
    recorded_at: datetime
    data_mode: DataMode


class SensorStatusOut(BaseModel):
    sensor_code: str
    sensor_type: str
    region_id: int
    region_name: str
    unit: str
    reading: float
    status: str
    healthy: bool
    alerting: bool
    note: str


class SensorSummaryOut(BaseModel):
    sensors: list[SensorStatusOut]
    counts: dict[str, int]
    mode: DataMode
    note: str


class SimulateSensorIn(BaseModel):
    region_id: int
    condition: Literal["NORMAL", "HEAVY_RAIN", "CRITICAL"] = "HEAVY_RAIN"
    minutes: int = Field(default=60, ge=10, le=720)


class SimulationResult(BaseModel):
    region_id: int
    region_name: str
    scenario: str
    data_mode: DataMode
    inserted_rows: int
    applied_condition: str
    risk: dict[str, Any]
    sensors: list[SensorOut]
    note: str


# --------------------------------------------------------------------------
# What-if simulator
# --------------------------------------------------------------------------

class WhatIfIn(BaseModel):
    region_id: int
    rainfall_multiplier: float | None = Field(default=None, ge=0.0, le=6.0)
    rainfall_add_mm_h: float | None = Field(default=None, ge=0.0, le=300.0)
    soil_moisture_pct: float | None = Field(default=None, ge=0.0, le=100.0)
    slope_deg: float | None = Field(default=None, ge=0.0, le=80.0)
    vegetation_index: float | None = Field(default=None, ge=0.0, le=1.0)
    distance_to_river_km: float | None = Field(default=None, ge=0.0, le=60.0)
    historical_landslide_count: int | None = Field(default=None, ge=0, le=200)
    future_hours: int = Field(default=6, ge=0, le=72)

    @field_validator("soil_moisture_pct", "slope_deg", "vegetation_index",
                     "distance_to_river_km")
    @classmethod
    def _non_negative(cls, value: float | None, info) -> float | None:
        if value is not None and value < 0:
            raise ValueError("must be >= 0")
        return value


class WhatIfOut(BaseModel):
    baseline: PredictResponse
    modified: PredictResponse
    changes: dict[str, Any]
    interpretation: str
    region: RegionOut
    data_mode: DataMode


# --------------------------------------------------------------------------
# Scenario control
# --------------------------------------------------------------------------

class ScenarioOut(BaseModel):
    key: ScenarioKey
    label: str
    description: str
    changes: dict[str, Any]
    active: bool
    data_mode: DataMode


class SimulationRequest(BaseModel):
    """Load a scenario across the whole platform.

    ``compare_with`` is scored alongside but never stored, so the response can
    say how far each region *moved* rather than only where it ended up - which
    is the difference between "Wayanad is at 87" and "Wayanad went from 58 to
    87 when rainfall tripled".
    """

    scenario: ScenarioKey = "EXTREME_RAINFALL"
    compare_with: ScenarioKey = "NORMAL"


class SimulationRegionDelta(BaseModel):
    region_id: int
    region_code: str
    region_name: str
    district: str | None = None
    state: str | None = None
    latitude: float
    longitude: float
    before_score: float
    before_level: RiskLevel
    risk_score: float
    risk_level: RiskLevel
    confidence: float
    delta: float
    escalated: bool
    top_factors: list[FactorOut] = Field(default_factory=list)


# --------------------------------------------------------------------------
# National overview
# --------------------------------------------------------------------------

class OverviewBand(BaseModel):
    level: RiskLevel
    count: int
    percent: float


class OverviewOut(BaseModel):
    generated_at: datetime
    data_mode: DataMode
    regions_total: int
    regions_scored: int
    bands: list[OverviewBand]
    avg_score: float
    max_score: float
    high_risk: int
    critical: int
    active_alerts: int
    unresolved_alerts: int
    events_total: int
    events_this_year: int
    reports_pending: int
    sensors_alerting: int
    top_regions: list[dict[str, Any]]
    country_risk: float
    note: str


TokenResponse.model_rebuild()
