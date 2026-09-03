-- ===========================================================================
--  Bhoomi-Drishti - AI Landslide Early-Warning & Risk Monitoring System
--  PostgreSQL 14+ / PostGIS 3.x schema
--
--  This file is applied automatically by docker-compose (mounted into the
--  postgis image's initdb directory). The application also works on plain
--  SQLite, in which case SQLAlchemy creates the same logical tables minus
--  the PostGIS geometry columns and spatial indexes.
--
--  Data-provenance convention: every table that stores observed or derived
--  values carries a `data_mode` column with one of
--      'LIVE'      - fetched from an external API / real dataset
--      'DEMO'      - deterministic modelled demo data shipped with the repo
--      'SIMULATED' - produced by the built-in scenario / sensor simulator
--  The UI renders this value verbatim so a demo is never mistaken for
--  real-world monitoring.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------------
-- 1. users - role based access control
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,
    username        VARCHAR(64)  NOT NULL UNIQUE,
    full_name       VARCHAR(128),
    password_hash   VARCHAR(256) NOT NULL,
    role            VARCHAR(16)  NOT NULL DEFAULT 'CITIZEN'
                    CHECK (role IN ('CITIZEN', 'OFFICER', 'ADMIN')),
    organisation    VARCHAR(128),
    phone           VARCHAR(24),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

-- ---------------------------------------------------------------------------
-- 2. regions - monitored administrative / terrain units
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS regions (
    id                          SERIAL PRIMARY KEY,
    code                        VARCHAR(24)  NOT NULL UNIQUE,
    name                        VARCHAR(96)  NOT NULL,
    district                    VARCHAR(96)  NOT NULL,
    state                       VARCHAR(96)  NOT NULL,
    zone                        VARCHAR(48)  NOT NULL,
    latitude                    DOUBLE PRECISION NOT NULL,
    longitude                   DOUBLE PRECISION NOT NULL,
    geom                        geography(Point, 4326)
                                GENERATED ALWAYS AS
                                (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography)
                                STORED,
    area_km2                    DOUBLE PRECISION,
    population_exposed          INTEGER,
    annual_rainfall_mm          DOUBLE PRECISION,
    monsoon_index               DOUBLE PRECISION,
    historical_landslide_count  INTEGER      NOT NULL DEFAULT 0,
    data_source                 VARCHAR(160) NOT NULL DEFAULT 'DEMO reference dataset',
    created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_regions_geom  ON regions USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_regions_state ON regions (state);
CREATE INDEX IF NOT EXISTS idx_regions_zone  ON regions (zone);

-- ---------------------------------------------------------------------------
-- 3. terrain_data - static / slowly varying terrain attributes per region
--    (in production these rows are populated from DEM, land-cover and soil
--     rasters; see "The seams" in docs/ARCHITECTURE.md and docs/SCALABILITY.md)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS terrain_data (
    id                    SERIAL PRIMARY KEY,
    region_id             INTEGER NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
    elevation_m           DOUBLE PRECISION NOT NULL,
    slope_deg             DOUBLE PRECISION NOT NULL,
    aspect_deg            DOUBLE PRECISION,
    relief_m              DOUBLE PRECISION,
    curvature             DOUBLE PRECISION,
    soil_type             VARCHAR(32) NOT NULL,
    soil_depth_m          DOUBLE PRECISION,
    land_cover            VARCHAR(32) NOT NULL,
    vegetation_index      DOUBLE PRECISION NOT NULL,
    distance_to_river_km  DOUBLE PRECISION NOT NULL,
    distance_to_road_km   DOUBLE PRECISION,
    lithology             VARCHAR(64),
    dem_source            VARCHAR(96) NOT NULL DEFAULT 'DEMO (approximate public values)',
    data_mode             VARCHAR(12) NOT NULL DEFAULT 'DEMO',
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_terrain_region UNIQUE (region_id)
);
CREATE INDEX IF NOT EXISTS idx_terrain_region ON terrain_data (region_id);

-- ---------------------------------------------------------------------------
-- 4. weather_data - hourly observed / forecast weather per region
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS weather_data (
    id                  BIGSERIAL PRIMARY KEY,
    region_id           INTEGER NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
    observed_at         TIMESTAMPTZ NOT NULL,
    is_forecast         BOOLEAN NOT NULL DEFAULT FALSE,
    rainfall_mm         DOUBLE PRECISION NOT NULL DEFAULT 0,
    rainfall_1h         DOUBLE PRECISION NOT NULL DEFAULT 0,
    rainfall_6h         DOUBLE PRECISION NOT NULL DEFAULT 0,
    rainfall_24h        DOUBLE PRECISION NOT NULL DEFAULT 0,
    rainfall_72h        DOUBLE PRECISION NOT NULL DEFAULT 0,
    rainfall_7d         DOUBLE PRECISION NOT NULL DEFAULT 0,
    rainfall_anomaly    DOUBLE PRECISION NOT NULL DEFAULT 0,
    temperature_c       DOUBLE PRECISION,
    humidity_pct        DOUBLE PRECISION,
    soil_moisture_pct   DOUBLE PRECISION,
    provider            VARCHAR(48) NOT NULL DEFAULT 'demo-model',
    data_mode           VARCHAR(12) NOT NULL DEFAULT 'DEMO',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_weather_region_time
    ON weather_data (region_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_weather_forecast ON weather_data (is_forecast);

-- ---------------------------------------------------------------------------
-- 5. risk_predictions - one row per model inference ("now" prediction)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS risk_predictions (
    id                BIGSERIAL PRIMARY KEY,
    region_id         INTEGER NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
    predicted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    risk_score        DOUBLE PRECISION NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
    risk_level        VARCHAR(12) NOT NULL
                      CHECK (risk_level IN ('VERY LOW','LOW','MODERATE','HIGH','CRITICAL')),
    confidence        DOUBLE PRECISION NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    model_name        VARCHAR(64)  NOT NULL,
    model_version     VARCHAR(32)  NOT NULL,
    model_backend     VARCHAR(32)  NOT NULL,
    explainer         VARCHAR(32),
    scenario          VARCHAR(32)  NOT NULL DEFAULT 'NORMAL',
    data_mode         VARCHAR(12)  NOT NULL DEFAULT 'DEMO',
    features          JSONB,
    top_factors       JSONB,
    contributions     JSONB
);
CREATE INDEX IF NOT EXISTS idx_pred_region_time
    ON risk_predictions (region_id, predicted_at DESC);
CREATE INDEX IF NOT EXISTS idx_pred_level ON risk_predictions (risk_level);

-- ---------------------------------------------------------------------------
-- 6. risk_forecasts - 72-hour horizon forecast produced from the same model
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS risk_forecasts (
    id             BIGSERIAL PRIMARY KEY,
    region_id      INTEGER NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
    issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    horizon_hours  INTEGER NOT NULL CHECK (horizon_hours BETWEEN 0 AND 168),
    valid_at       TIMESTAMPTZ NOT NULL,
    risk_score     DOUBLE PRECISION NOT NULL,
    risk_level     VARCHAR(12) NOT NULL,
    confidence     DOUBLE PRECISION NOT NULL,
    rainfall_mm    DOUBLE PRECISION NOT NULL DEFAULT 0,
    soil_moisture_pct DOUBLE PRECISION,
    scenario       VARCHAR(32) NOT NULL DEFAULT 'NORMAL',
    data_mode      VARCHAR(12) NOT NULL DEFAULT 'DEMO',
    CONSTRAINT uq_forecast UNIQUE (region_id, issued_at, horizon_hours)
);
CREATE INDEX IF NOT EXISTS idx_forecast_region
    ON risk_forecasts (region_id, issued_at DESC, horizon_hours);

-- ---------------------------------------------------------------------------
-- 7. landslide_events - historical landslide inventory
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS landslide_events (
    id            SERIAL PRIMARY KEY,
    event_id      VARCHAR(32) NOT NULL UNIQUE,
    region_id     INTEGER REFERENCES regions(id) ON DELETE SET NULL,
    event_date    DATE NOT NULL,
    location      VARCHAR(160) NOT NULL,
    district      VARCHAR(96),
    state         VARCHAR(96),
    latitude      DOUBLE PRECISION NOT NULL,
    longitude     DOUBLE PRECISION NOT NULL,
    geom          geography(Point, 4326)
                  GENERATED ALWAYS AS
                  (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography)
                  STORED,
    rainfall_mm   DOUBLE PRECISION,
    slope_deg     DOUBLE PRECISION,
    elevation_m   DOUBLE PRECISION,
    severity      VARCHAR(12) NOT NULL
                  CHECK (severity IN ('MINOR','MODERATE','MAJOR','SEVERE')),
    trigger       VARCHAR(48),
    fatalities    INTEGER DEFAULT 0,
    description   TEXT,
    source        VARCHAR(160) NOT NULL DEFAULT 'DEMO inventory',
    data_mode     VARCHAR(12) NOT NULL DEFAULT 'DEMO'
);
CREATE INDEX IF NOT EXISTS idx_events_geom  ON landslide_events USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_events_date  ON landslide_events (event_date DESC);
CREATE INDEX IF NOT EXISTS idx_events_state ON landslide_events (state, severity);

-- ---------------------------------------------------------------------------
-- 8. alerts - early-warning engine output and its response workflow
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
    id                 SERIAL PRIMARY KEY,
    alert_code         VARCHAR(32) NOT NULL UNIQUE,
    region_id          INTEGER NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
    prediction_id      BIGINT REFERENCES risk_predictions(id) ON DELETE SET NULL,
    severity           VARCHAR(12) NOT NULL CHECK (severity IN ('HIGH','CRITICAL')),
    risk_score         DOUBLE PRECISION NOT NULL,
    status             VARCHAR(16) NOT NULL DEFAULT 'NEW'
                       CHECK (status IN ('NEW','ACKNOWLEDGED','IN PROGRESS','RESOLVED')),
    cause              TEXT NOT NULL,
    recommended_action TEXT NOT NULL,
    scenario           VARCHAR(32) NOT NULL DEFAULT 'NORMAL',
    data_mode          VARCHAR(12) NOT NULL DEFAULT 'DEMO',
    assigned_to        VARCHAR(128),
    note               TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_at    TIMESTAMPTZ,
    resolved_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_region ON alerts (region_id);

-- ---------------------------------------------------------------------------
-- 9. citizen_reports - crowdsourced field observations
--
--    `description` holds the citizen's own words and is written once, at
--    insert. Triage notes go to `officer_note` so that reviewing a report
--    cannot alter the evidence being reviewed - keeping the observation and
--    the interpretation in separate columns is what makes the record worth
--    anything later.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS citizen_reports (
    id              SERIAL PRIMARY KEY,
    report_code     VARCHAR(32) NOT NULL UNIQUE,
    region_id       INTEGER REFERENCES regions(id) ON DELETE SET NULL,
    reporter_name   VARCHAR(128),
    reporter_phone  VARCHAR(24),
    user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    location_text   VARCHAR(200) NOT NULL,
    latitude        DOUBLE PRECISION NOT NULL,
    longitude       DOUBLE PRECISION NOT NULL,
    geom            geography(Point, 4326)
                    GENERATED ALWAYS AS
                    (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography)
                    STORED,
    observation_type VARCHAR(32) NOT NULL
                     CHECK (observation_type IN ('GROUND CRACK','ROAD CRACK','ROCKFALL',
                                                 'SOIL MOVEMENT','POSSIBLE LANDSLIDE','OTHER')),
    severity        VARCHAR(12) NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH')),
    description     TEXT NOT NULL,
    image_path      VARCHAR(256),
    image_analysis  JSONB,
    observed_on     DATE NOT NULL,
    status          VARCHAR(16) NOT NULL DEFAULT 'NEW'
                    CHECK (status IN ('NEW','UNDER REVIEW','VERIFIED','DISMISSED')),
    officer_note    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reports_geom   ON citizen_reports USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_reports_status ON citizen_reports (status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 10. simulated_sensor_data - VIRTUAL sensor network (software only).
--     There is no hardware anywhere in this project; these rows are produced
--     by app/services/sensor_simulator.py and are always labelled SIMULATED.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS simulated_sensor_data (
    id            BIGSERIAL PRIMARY KEY,
    sensor_code   VARCHAR(32) NOT NULL,
    region_id     INTEGER NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
    sensor_type   VARCHAR(24) NOT NULL
                  CHECK (sensor_type IN ('SOIL_MOISTURE','RAIN_GAUGE','TILT',
                                         'VIBRATION','PORE_PRESSURE')),
    reading       DOUBLE PRECISION NOT NULL,
    unit          VARCHAR(16) NOT NULL,
    status        VARCHAR(12) NOT NULL DEFAULT 'NORMAL'
                  CHECK (status IN ('NORMAL','ELEVATED','ALARM','OFFLINE')),
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    data_mode     VARCHAR(12) NOT NULL DEFAULT 'SIMULATED'
);
CREATE INDEX IF NOT EXISTS idx_sensor_region_time
    ON simulated_sensor_data (region_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_sensor_code ON simulated_sensor_data (sensor_code);

-- ---------------------------------------------------------------------------
-- Convenience view: the most recent stored prediction per region.
--
-- For SQL-level inspection and for external BI tools, not used by the API:
-- /api/risk-map scores every region live through the risk engine rather than
-- reading stored rows, so that the map cannot show a stale picture. DISTINCT ON
-- is PostgreSQL-specific, which is why this stays in SQL and out of the ORM.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_current_risk AS
SELECT DISTINCT ON (p.region_id)
       p.region_id, r.code, r.name, r.district, r.state, r.zone,
       r.latitude, r.longitude,
       p.risk_score, p.risk_level, p.confidence, p.scenario,
       p.data_mode, p.predicted_at
FROM   risk_predictions p
JOIN   regions r ON r.id = p.region_id
ORDER  BY p.region_id, p.predicted_at DESC;

-- Spatial helper: regions within N km of a point (PostGIS only).
--   SELECT * FROM regions
--   WHERE ST_DWithin(geom, ST_MakePoint(76.13, 11.68)::geography, 50000);




