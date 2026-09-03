"""SQLAlchemy ORM models - the ten tables the specification calls for.

Table map
---------
=========================  ====================================================
users                      role-based access (CITIZEN / OFFICER / ADMIN)
regions                    monitored districts and hill towns
terrain_data               static slope, soil, land cover per region  (1:1)
weather_data               hourly observed and forecast weather       (1:N)
risk_predictions           one row per model inference
risk_forecasts             the 72-hour horizon curve
landslide_events           historical inventory
alerts                     early-warning output plus response workflow
citizen_reports            crowdsourced field observations
simulated_sensor_data      the virtual (software-only) sensor network
=========================  ====================================================

Two conventions run through the whole schema.

**Provenance.** Every table holding observed or derived values carries a
``data_mode`` column - ``LIVE``, ``DEMO`` or ``SIMULATED``. It is written at
the point the value is produced and rendered verbatim in the UI, so a demo
reading can never be mistaken for real-world monitoring.

**No geometry in the ORM.** PostgreSQL adds generated ``geography(Point,4326)``
columns and GIST indexes (see ``database/schema.sql``); they are derived from
``latitude``/``longitude`` by the database itself. Mapping them here would
break inserts on PostGIS and would not exist on SQLite, so they are left to
SQL. Nothing in the API needs them - proximity queries that matter are done in
the service layer and can be pushed down to PostGIS later.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from .clock import utcnow

# JSONB where it is available (indexable, binary), plain JSON on SQLite.
JSONColumn = JSON().with_variant(JSONB, "postgresql")
Timestamp = DateTime(timezone=True)


class Base(DeclarativeBase):
    """Declarative base for every table."""


# --------------------------------------------------------------------------
# Controlled vocabularies. These are duplicated as CHECK constraints so the
# database rejects a bad value even if it arrives from outside the API.
# --------------------------------------------------------------------------
ROLES = ("CITIZEN", "OFFICER", "ADMIN")
RISK_LEVELS = ("VERY LOW", "LOW", "MODERATE", "HIGH", "CRITICAL")
DATA_MODES = ("LIVE", "DEMO", "SIMULATED")
ALERT_SEVERITIES = ("HIGH", "CRITICAL")
ALERT_STATUSES = ("NEW", "ACKNOWLEDGED", "IN PROGRESS", "RESOLVED")
EVENT_SEVERITIES = ("MINOR", "MODERATE", "MAJOR", "SEVERE")
REPORT_TYPES = (
    "GROUND CRACK",
    "ROAD CRACK",
    "ROCKFALL",
    "SOIL MOVEMENT",
    "POSSIBLE LANDSLIDE",
    "OTHER",
)
REPORT_SEVERITIES = ("LOW", "MEDIUM", "HIGH")
REPORT_STATUSES = ("NEW", "UNDER REVIEW", "VERIFIED", "DISMISSED")
SENSOR_TYPES = ("SOIL_MOISTURE", "RAIN_GAUGE", "TILT", "VIBRATION", "PORE_PRESSURE")
SENSOR_STATUSES = ("NORMAL", "ELEVATED", "ALARM", "OFFLINE")


def _in(column: str, allowed: tuple[str, ...]) -> str:
    values = ", ".join(f"'{v}'" for v in allowed)
    return f"{column} IN ({values})"


# ---------------------------------------------------------------- 1. users

class User(Base):
    """An account. Role decides which parts of the platform are reachable."""

    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint(_in("role", ROLES), name="ck_users_role"),
        Index("idx_users_role", "role"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    full_name: Mapped[str | None] = mapped_column(String(128))
    password_hash: Mapped[str] = mapped_column(String(256), nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="CITIZEN")
    organisation: Mapped[str | None] = mapped_column(String(128))
    phone: Mapped[str | None] = mapped_column(String(24))
    created_at: Mapped[datetime] = mapped_column(Timestamp, default=utcnow, nullable=False)

    reports: Mapped[list["CitizenReport"]] = relationship(back_populates="user")

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<User {self.username} ({self.role})>"


# -------------------------------------------------------------- 2. regions

class Region(Base):
    """A monitored administrative / terrain unit - the unit of prediction."""

    __tablename__ = "regions"
    __table_args__ = (
        Index("idx_regions_state", "state"),
        Index("idx_regions_zone", "zone"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(24), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(96), nullable=False)
    district: Mapped[str] = mapped_column(String(96), nullable=False)
    state: Mapped[str] = mapped_column(String(96), nullable=False)
    zone: Mapped[str] = mapped_column(String(48), nullable=False)
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)
    area_km2: Mapped[float | None] = mapped_column(Float)
    population_exposed: Mapped[int | None] = mapped_column(Integer)
    annual_rainfall_mm: Mapped[float | None] = mapped_column(Float)
    monsoon_index: Mapped[float | None] = mapped_column(Float)
    historical_landslide_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    data_source: Mapped[str] = mapped_column(
        String(160), default="DEMO reference dataset", nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(Timestamp, default=utcnow, nullable=False)

    terrain: Mapped["TerrainData | None"] = relationship(
        back_populates="region", uselist=False, cascade="all, delete-orphan"
    )
    weather: Mapped[list["WeatherData"]] = relationship(
        back_populates="region", cascade="all, delete-orphan"
    )
    predictions: Mapped[list["RiskPrediction"]] = relationship(
        back_populates="region", cascade="all, delete-orphan"
    )
    forecasts: Mapped[list["RiskForecast"]] = relationship(
        back_populates="region", cascade="all, delete-orphan"
    )
    events: Mapped[list["LandslideEvent"]] = relationship(back_populates="region")
    alerts: Mapped[list["Alert"]] = relationship(
        back_populates="region", cascade="all, delete-orphan"
    )
    reports: Mapped[list["CitizenReport"]] = relationship(back_populates="region")
    sensors: Mapped[list["SimulatedSensorData"]] = relationship(
        back_populates="region", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Region {self.code} {self.name}>"


# --------------------------------------------------------- 3. terrain_data

class TerrainData(Base):
    """Static terrain attributes.

    In production these rows come from a DEM (slope, elevation, curvature),
    a land-cover raster and a soil survey. In this repository they are the
    documented approximate values in ``ml/data/regions_seed.py`` and are
    labelled ``DEMO``. Replacing the loader is the whole migration - the
    column contract does not change.
    """

    __tablename__ = "terrain_data"
    __table_args__ = (
        UniqueConstraint("region_id", name="uq_terrain_region"),
        CheckConstraint(_in("data_mode", DATA_MODES), name="ck_terrain_mode"),
        Index("idx_terrain_region", "region_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    region_id: Mapped[int] = mapped_column(
        ForeignKey("regions.id", ondelete="CASCADE"), nullable=False
    )
    elevation_m: Mapped[float] = mapped_column(Float, nullable=False)
    slope_deg: Mapped[float] = mapped_column(Float, nullable=False)
    aspect_deg: Mapped[float | None] = mapped_column(Float)
    relief_m: Mapped[float | None] = mapped_column(Float)
    curvature: Mapped[float | None] = mapped_column(Float)
    soil_type: Mapped[str] = mapped_column(String(32), nullable=False)
    soil_depth_m: Mapped[float | None] = mapped_column(Float)
    land_cover: Mapped[str] = mapped_column(String(32), nullable=False)
    vegetation_index: Mapped[float] = mapped_column(Float, nullable=False)
    distance_to_river_km: Mapped[float] = mapped_column(Float, nullable=False)
    distance_to_road_km: Mapped[float | None] = mapped_column(Float)
    lithology: Mapped[str | None] = mapped_column(String(64))
    dem_source: Mapped[str] = mapped_column(
        String(96), default="DEMO (approximate public values)", nullable=False
    )
    data_mode: Mapped[str] = mapped_column(String(12), default="DEMO", nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        Timestamp, default=utcnow, onupdate=utcnow, nullable=False
    )

    region: Mapped["Region"] = relationship(back_populates="terrain")


# --------------------------------------------------------- 4. weather_data

class WeatherData(Base):
    """One hourly weather record - observed (``is_forecast=False``) or forecast.

    Rainfall accumulations are stored alongside the hourly total because the
    model consumes windows, not instants, and recomputing five windows for
    every region on every request would dominate the response time.
    """

    __tablename__ = "weather_data"
    __table_args__ = (
        CheckConstraint(_in("data_mode", DATA_MODES), name="ck_weather_mode"),
        Index("idx_weather_region_time", "region_id", "observed_at"),
        Index("idx_weather_forecast", "is_forecast"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    region_id: Mapped[int] = mapped_column(
        ForeignKey("regions.id", ondelete="CASCADE"), nullable=False
    )
    observed_at: Mapped[datetime] = mapped_column(Timestamp, nullable=False)
    is_forecast: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    rainfall_mm: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    rainfall_1h: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    rainfall_6h: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    rainfall_24h: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    rainfall_72h: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    rainfall_7d: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    rainfall_anomaly: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    temperature_c: Mapped[float | None] = mapped_column(Float)
    humidity_pct: Mapped[float | None] = mapped_column(Float)
    soil_moisture_pct: Mapped[float | None] = mapped_column(Float)
    provider: Mapped[str] = mapped_column(String(48), default="demo-model", nullable=False)
    data_mode: Mapped[str] = mapped_column(String(12), default="DEMO", nullable=False)
    created_at: Mapped[datetime] = mapped_column(Timestamp, default=utcnow, nullable=False)

    region: Mapped["Region"] = relationship(back_populates="weather")


# ----------------------------------------------------- 5. risk_predictions

class RiskPrediction(Base):
    """One model inference, kept with the exact inputs that produced it.

    ``features``, ``top_factors`` and ``contributions`` are stored rather than
    recomputed so a past score can always be re-explained. An early warning
    that cannot be justified six hours later is not a usable early warning.
    """

    __tablename__ = "risk_predictions"
    __table_args__ = (
        CheckConstraint("risk_score >= 0 AND risk_score <= 100", name="ck_pred_score"),
        CheckConstraint("confidence >= 0 AND confidence <= 1", name="ck_pred_confidence"),
        CheckConstraint(_in("risk_level", RISK_LEVELS), name="ck_pred_level"),
        CheckConstraint(_in("data_mode", DATA_MODES), name="ck_pred_mode"),
        Index("idx_pred_region_time", "region_id", "predicted_at"),
        Index("idx_pred_level", "risk_level"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    region_id: Mapped[int] = mapped_column(
        ForeignKey("regions.id", ondelete="CASCADE"), nullable=False
    )
    predicted_at: Mapped[datetime] = mapped_column(Timestamp, default=utcnow, nullable=False)
    risk_score: Mapped[float] = mapped_column(Float, nullable=False)
    risk_level: Mapped[str] = mapped_column(String(12), nullable=False)
    # Stored 0-1; the API presents it as a percentage.
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    model_name: Mapped[str] = mapped_column(String(64), nullable=False)
    model_version: Mapped[str] = mapped_column(String(32), nullable=False)
    model_backend: Mapped[str] = mapped_column(String(32), nullable=False)
    explainer: Mapped[str | None] = mapped_column(String(32))
    scenario: Mapped[str] = mapped_column(String(32), default="NORMAL", nullable=False)
    data_mode: Mapped[str] = mapped_column(String(12), default="DEMO", nullable=False)
    features: Mapped[dict[str, Any] | None] = mapped_column(JSONColumn)
    top_factors: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONColumn)
    contributions: Mapped[dict[str, Any] | None] = mapped_column(JSONColumn)

    region: Mapped["Region"] = relationship(back_populates="predictions")
    alerts: Mapped[list["Alert"]] = relationship(back_populates="prediction")


# ------------------------------------------------------- 6. risk_forecasts

class RiskForecast(Base):
    """A point on the 72-hour risk curve for one region.

    One row per (region, issue time, horizon). The uniqueness constraint means
    re-issuing a forecast updates the curve in place instead of stacking
    duplicate points behind the chart.
    """

    __tablename__ = "risk_forecasts"
    __table_args__ = (
        UniqueConstraint("region_id", "issued_at", "horizon_hours", name="uq_forecast"),
        CheckConstraint("horizon_hours >= 0 AND horizon_hours <= 168", name="ck_forecast_horizon"),
        CheckConstraint(_in("risk_level", RISK_LEVELS), name="ck_forecast_level"),
        CheckConstraint(_in("data_mode", DATA_MODES), name="ck_forecast_mode"),
        Index("idx_forecast_region", "region_id", "issued_at", "horizon_hours"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    region_id: Mapped[int] = mapped_column(
        ForeignKey("regions.id", ondelete="CASCADE"), nullable=False
    )
    issued_at: Mapped[datetime] = mapped_column(Timestamp, default=utcnow, nullable=False)
    horizon_hours: Mapped[int] = mapped_column(Integer, nullable=False)
    valid_at: Mapped[datetime] = mapped_column(Timestamp, nullable=False)
    risk_score: Mapped[float] = mapped_column(Float, nullable=False)
    risk_level: Mapped[str] = mapped_column(String(12), nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    rainfall_mm: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    soil_moisture_pct: Mapped[float | None] = mapped_column(Float)
    scenario: Mapped[str] = mapped_column(String(32), default="NORMAL", nullable=False)
    data_mode: Mapped[str] = mapped_column(String(12), default="DEMO", nullable=False)

    region: Mapped["Region"] = relationship(back_populates="forecasts")


# ----------------------------------------------------- 7. landslide_events

class LandslideEvent(Base):
    """Historical inventory entry - the "what actually happened" table.

    Shipped rows are a DEMO inventory built from documented Indian landslide
    events plus modelled minor events, and every row says which it is through
    ``source`` and ``data_mode``. Swap in the GSI National Landslide
    Susceptibility Mapping inventory and nothing downstream changes.
    """

    __tablename__ = "landslide_events"
    __table_args__ = (
        CheckConstraint(_in("severity", EVENT_SEVERITIES), name="ck_event_severity"),
        CheckConstraint(_in("data_mode", DATA_MODES), name="ck_event_mode"),
        Index("idx_events_date", "event_date"),
        Index("idx_events_state", "state", "severity"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_id: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    region_id: Mapped[int | None] = mapped_column(ForeignKey("regions.id", ondelete="SET NULL"))
    event_date: Mapped[date] = mapped_column(Date, nullable=False)
    location: Mapped[str] = mapped_column(String(160), nullable=False)
    district: Mapped[str | None] = mapped_column(String(96))
    state: Mapped[str | None] = mapped_column(String(96))
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)
    rainfall_mm: Mapped[float | None] = mapped_column(Float)
    slope_deg: Mapped[float | None] = mapped_column(Float)
    elevation_m: Mapped[float | None] = mapped_column(Float)
    severity: Mapped[str] = mapped_column(String(12), nullable=False)
    trigger: Mapped[str | None] = mapped_column("trigger", String(48))
    # Nullable on purpose: for several documented disasters the published
    # toll was revised repeatedly, and NULL ("not stated") is more honest
    # than 0 ("nobody died").
    fatalities: Mapped[int | None] = mapped_column(Integer, default=0)
    description: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(160), default="DEMO inventory", nullable=False)
    data_mode: Mapped[str] = mapped_column(String(12), default="DEMO", nullable=False)

    region: Mapped["Region | None"] = relationship(back_populates="events")


# --------------------------------------------------------------- 8. alerts

class Alert(Base):
    """An early warning and the response workflow attached to it.

    Created by the warning engine when a score crosses the HIGH or CRITICAL
    threshold, then moved through NEW -> ACKNOWLEDGED -> IN PROGRESS ->
    RESOLVED by an officer. ``prediction_id`` links every alert back to the
    exact inference that raised it.
    """

    __tablename__ = "alerts"
    __table_args__ = (
        CheckConstraint(_in("severity", ALERT_SEVERITIES), name="ck_alert_severity"),
        CheckConstraint(_in("status", ALERT_STATUSES), name="ck_alert_status"),
        CheckConstraint(_in("data_mode", DATA_MODES), name="ck_alert_mode"),
        Index("idx_alerts_status", "status", "created_at"),
        Index("idx_alerts_region", "region_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    alert_code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    region_id: Mapped[int] = mapped_column(
        ForeignKey("regions.id", ondelete="CASCADE"), nullable=False
    )
    prediction_id: Mapped[int | None] = mapped_column(
        ForeignKey("risk_predictions.id", ondelete="SET NULL")
    )
    severity: Mapped[str] = mapped_column(String(12), nullable=False)
    risk_score: Mapped[float] = mapped_column(Float, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="NEW", nullable=False)
    cause: Mapped[str] = mapped_column(Text, nullable=False)
    recommended_action: Mapped[str] = mapped_column(Text, nullable=False)
    scenario: Mapped[str] = mapped_column(String(32), default="NORMAL", nullable=False)
    data_mode: Mapped[str] = mapped_column(String(12), default="DEMO", nullable=False)
    assigned_to: Mapped[str | None] = mapped_column(String(128))
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(Timestamp, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        Timestamp, default=utcnow, onupdate=utcnow, nullable=False
    )
    acknowledged_at: Mapped[datetime | None] = mapped_column(Timestamp)
    resolved_at: Mapped[datetime | None] = mapped_column(Timestamp)

    region: Mapped["Region"] = relationship(back_populates="alerts")
    prediction: Mapped["RiskPrediction | None"] = relationship(back_populates="alerts")


# ------------------------------------------------------ 9. citizen_reports

class CitizenReport(Base):
    """A field observation submitted from the public portal.

    ``image_analysis`` holds the screening result when a photo was attached.
    It is advisory: the officer sees the model's reading and the photo, and
    decides. Reports are never auto-verified.

    ``description`` is the citizen's own words and nothing in the application
    writes to it after the insert. Triage notes go to ``officer_note``, which
    exists precisely so that they cannot: a review process that edits the
    evidence it is reviewing destroys the only independent account of what was
    seen, and leaves no way to tell the observation from the interpretation.
    """

    __tablename__ = "citizen_reports"
    __table_args__ = (
        CheckConstraint(_in("observation_type", REPORT_TYPES), name="ck_report_type"),
        CheckConstraint(_in("severity", REPORT_SEVERITIES), name="ck_report_severity"),
        CheckConstraint(_in("status", REPORT_STATUSES), name="ck_report_status"),
        Index("idx_reports_status", "status", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    report_code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    region_id: Mapped[int | None] = mapped_column(ForeignKey("regions.id", ondelete="SET NULL"))
    reporter_name: Mapped[str | None] = mapped_column(String(128))
    reporter_phone: Mapped[str | None] = mapped_column(String(24))
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    location_text: Mapped[str] = mapped_column(String(200), nullable=False)
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)
    observation_type: Mapped[str] = mapped_column(String(32), nullable=False)
    severity: Mapped[str] = mapped_column(String(12), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    image_path: Mapped[str | None] = mapped_column(String(256))
    image_analysis: Mapped[dict[str, Any] | None] = mapped_column(JSONColumn)
    observed_on: Mapped[date] = mapped_column(Date, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="NEW", nullable=False)
    officer_note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(Timestamp, default=utcnow, nullable=False)

    region: Mapped["Region | None"] = relationship(back_populates="reports")
    user: Mapped["User | None"] = relationship(back_populates="reports")


# ----------------------------------------------- 10. simulated_sensor_data

class SimulatedSensorData(Base):
    """A reading from the VIRTUAL sensor network.

    There is no hardware anywhere in this project. These rows are produced by
    ``app/services/sensor_simulator.py`` from the same physical model that
    drives the weather, and they are always stored with
    ``data_mode = 'SIMULATED'`` so the UI can label them as such. They exist to
    demonstrate how a real instrumented slope would feed the risk engine.
    """

    __tablename__ = "simulated_sensor_data"
    __table_args__ = (
        CheckConstraint(_in("sensor_type", SENSOR_TYPES), name="ck_sensor_type"),
        CheckConstraint(_in("status", SENSOR_STATUSES), name="ck_sensor_status"),
        Index("idx_sensor_region_time", "region_id", "recorded_at"),
        Index("idx_sensor_code", "sensor_code"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    sensor_code: Mapped[str] = mapped_column(String(32), nullable=False)
    region_id: Mapped[int] = mapped_column(
        ForeignKey("regions.id", ondelete="CASCADE"), nullable=False
    )
    sensor_type: Mapped[str] = mapped_column(String(24), nullable=False)
    reading: Mapped[float] = mapped_column(Float, nullable=False)
    unit: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(12), default="NORMAL", nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(Timestamp, default=utcnow, nullable=False)
    data_mode: Mapped[str] = mapped_column(String(12), default="SIMULATED", nullable=False)

    region: Mapped["Region"] = relationship(back_populates="sensors")


__all__ = [
    "Base",
    "User",
    "Region",
    "TerrainData",
    "WeatherData",
    "RiskPrediction",
    "RiskForecast",
    "LandslideEvent",
    "Alert",
    "CitizenReport",
    "SimulatedSensorData",
    "ROLES",
    "RISK_LEVELS",
    "DATA_MODES",
    "ALERT_SEVERITIES",
    "ALERT_STATUSES",
    "EVENT_SEVERITIES",
    "REPORT_TYPES",
    "REPORT_SEVERITIES",
    "REPORT_STATUSES",
    "SENSOR_TYPES",
    "SENSOR_STATUSES",
]
