# Database

Ten tables. Two conventions run through all of them: every row that holds an
observed or derived value carries its own provenance, and geometry is left to
PostGIS rather than mapped in the ORM.

The SQLAlchemy models in `backend/app/models.py` are the source of truth and work
on both SQLite and PostgreSQL. `database/schema.sql` is the PostgreSQL + PostGIS
version, applied automatically by Docker Compose, and adds the spatial columns,
GIST indexes and one convenience view that SQLite cannot have.

## The shape of it

```
users ─────────────────┐
  id PK                │ user_id  (nullable, SET NULL)
  username UQ          │
  role                 ▼
                  citizen_reports          field observations from the public
                       ▲
                       │ region_id (nullable, SET NULL)
                       │
regions ──1:1──► terrain_data              static slope, soil, land cover
  id PK        │
  code UQ      ├──1:N──► weather_data      hourly observed / forecast (see note)
  name         │
  district     ├──1:N──► risk_predictions ──1:N──► alerts
  state        │              one inference        prediction_id, SET NULL
  zone         │
  latitude     ├──1:N──► risk_forecasts    the 72-hour curve
  longitude    │
               ├──0:N──► landslide_events  historical inventory (region_id nullable)
               │
               ├──0:N──► citizen_reports   (region_id nullable)
               │
               └──1:N──► simulated_sensor_data   the virtual sensor network
```

Delete behaviour is not uniform, and the difference is deliberate. Removing a
region cascades to everything derived from it — terrain, weather, predictions,
forecasts, alerts, sensor rows — because none of that means anything without the
region. But `landslide_events.region_id` and `citizen_reports.region_id` are
`SET NULL`: a landslide that happened and a report a person filed are facts about
the world, and they survive a change to the administrative boundaries used for
monitoring. Likewise `citizen_reports.user_id` is `SET NULL`, so deleting an
account does not delete the warnings that account filed.

## The two conventions

**Provenance is a column, not a disclaimer.** Six tables carry `data_mode`, one of
`LIVE`, `DEMO` or `SIMULATED`, constrained by a `CHECK`. It is written by whatever
produced the value and rendered verbatim in the UI. Because it lives on the row,
a score stored last Tuesday still says what kind of data made it, and no amount of
later querying can make a demo reading look like real-world monitoring.

**Geometry belongs to the database.** The ORM maps `latitude` and `longitude` as
plain floats and nothing else. PostgreSQL adds `geom geography(Point, 4326)` as a
`GENERATED ALWAYS AS (...) STORED` column on `regions`, `landslide_events` and
`citizen_reports`, derived by the database from those two numbers. Mapping a
generated column in the ORM would break inserts on PostGIS and would not exist on
SQLite at all, so it is left in SQL. Nothing in the API depends on it — the one
proximity query that matters, `/api/history/near`, is computed in the service layer
and can be pushed down to `ST_DWithin` when PostGIS is present.

## 1 · users

Accounts and roles. The password column stores a PBKDF2 hash, never a password.
Rows exist only if `SEED_DEMO_USERS=true`; the platform is fully usable without
signing in.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | int PK | |
| `username` | varchar(64) | unique, not null |
| `full_name` | varchar(128) | nullable |
| `password_hash` | varchar(256) | not null · PBKDF2 |
| `role` | varchar(16) | not null, default `CITIZEN` · `CHECK` in `CITIZEN`, `OFFICER`, `ADMIN` |
| `organisation` | varchar(128) | nullable · e.g. "Wayanad DDMA" |
| `phone` | varchar(24) | nullable |
| `created_at` | timestamptz | not null, default now |

Indexed on `role`.

## 2 · regions

The unit of prediction: 74 hill districts and towns across 20 states. Every score,
forecast, alert and sensor reading hangs off a row here. `code` is the short
mnemonic (`WYD` for Wayanad) and the API accepts it interchangeably with the
numeric id.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | int PK | |
| `code` | varchar(24) | unique, not null |
| `name` | varchar(96) | not null |
| `district` | varchar(96) | not null |
| `state` | varchar(96) | not null |
| `zone` | varchar(48) | not null · e.g. Western Ghats, Western Himalaya |
| `latitude` | float | not null |
| `longitude` | float | not null |
| `area_km2` | float | nullable |
| `population_exposed` | int | nullable · drives the exposure figures on the overview |
| `annual_rainfall_mm` | float | nullable · the climatological normal |
| `monsoon_index` | float | nullable · how monsoon-dominated the rainfall is |
| `historical_landslide_count` | int | not null, default 0 · a model feature |
| `data_source` | varchar(160) | not null, default `DEMO reference dataset` |
| `created_at` | timestamptz | not null, default now |
| `geom` | geography(Point,4326) | PostgreSQL only · generated from lon/lat · GIST |

Indexed on `state` and on `zone`.

## 3 · terrain_data

One row per region — the slope's permanent character. In production these values
come from a DEM for elevation, slope, aspect and curvature, a land-cover raster,
and a soil survey. Here they are the documented approximate values in
`ml/data/regions_seed.py`, labelled `DEMO`, and `dem_source` says so on every row.
Replacing the loader is the entire migration; the column contract does not change.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | int PK | |
| `region_id` | int FK → regions | not null · unique (`uq_terrain_region`) · CASCADE |
| `elevation_m` | float | not null · **model feature** |
| `slope_deg` | float | not null · **model feature** |
| `aspect_deg` | float | nullable · slope facing, 0–360 |
| `relief_m` | float | nullable · local height range |
| `curvature` | float | nullable · convergent (negative) collects water |
| `soil_type` | varchar(32) | not null · **model feature** (categorical) |
| `soil_depth_m` | float | nullable |
| `land_cover` | varchar(32) | not null · **model feature** (categorical) |
| `vegetation_index` | float | not null · **model feature** · NDVI-like, 0–1 |
| `distance_to_river_km` | float | not null · **model feature** |
| `distance_to_road_km` | float | nullable · cut slopes matter, but not in the 16 |
| `lithology` | varchar(64) | nullable |
| `dem_source` | varchar(96) | not null, default `DEMO (approximate public values)` |
| `data_mode` | varchar(12) | not null, default `DEMO` · CHECK |
| `updated_at` | timestamptz | not null · set on insert and on update |

Indexed on `region_id`.

## 4 · weather_data

Hourly weather, observed when `is_forecast` is false and predicted when it is true.
The five rainfall accumulations are stored next to the hourly total rather than
derived on read, because the model consumes windows, not instants.

One thing to be straight about: **the running application does not currently write to
this table.** `weather_service` builds a region's year-long hourly series from the
physical model in `ml/hydrology.py`, seeded from the region code alone, and caches it
in process — about 60 ms and 0.3 MB per region, all 74 held in memory. A series
regenerated deterministically from a seed is cheaper than a database round-trip and
cannot drift between "now" and "+6 h", which is exactly the property the forecast
needs. In `LIVE` mode the Open-Meteo response is cached in process for 15 minutes for
the same reason.

The table is not vestigial, though. It is the landing place for real ingested
observations — IMD gridded rainfall, a state AWS network, anything with a history
worth keeping — and its columns are the contract that ingestion would write and
`weather_service` would read instead of generating. That substitution is described in
[`SCALABILITY.md`](SCALABILITY.md).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | int PK | |
| `region_id` | int FK → regions | not null · CASCADE |
| `observed_at` | timestamptz | not null · the hour this row describes |
| `is_forecast` | bool | not null, default false |
| `rainfall_mm` | float | not null, default 0 · this hour's total |
| `rainfall_1h` | float | not null, default 0 · **model feature** |
| `rainfall_6h` | float | not null, default 0 · **model feature** |
| `rainfall_24h` | float | not null, default 0 · **model feature** |
| `rainfall_72h` | float | not null, default 0 · **model feature** |
| `rainfall_7d` | float | not null, default 0 · **model feature** |
| `rainfall_anomaly` | float | not null, default 0 · **model feature** · ratio to normal |
| `temperature_c` | float | nullable · **model feature** |
| `humidity_pct` | float | nullable · **model feature** |
| `soil_moisture_pct` | float | nullable · **model feature** |
| `provider` | varchar(48) | not null, default `demo-model` · `open-meteo` when live |
| `data_mode` | varchar(12) | not null, default `DEMO` · CHECK |
| `created_at` | timestamptz | not null, default now |

Indexed on `(region_id, observed_at)` and on `is_forecast`.

## 5 · risk_predictions

One row per inference, stored with the exact inputs that produced it. `features`,
`top_factors` and `contributions` are kept rather than recomputed, because an early
warning that cannot be justified six hours later is not a usable early warning —
and by then the weather has moved on and the inputs are gone. The row also records
which model and which explainer ran, so a score from before a retrain is still
interpretable.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | int PK | |
| `region_id` | int FK → regions | not null · CASCADE |
| `predicted_at` | timestamptz | not null, default now |
| `risk_score` | float | not null · CHECK 0–100 |
| `risk_level` | varchar(12) | not null · CHECK in the five bands |
| `confidence` | float | not null · CHECK 0–1 · the API presents it as a percentage |
| `model_name` | varchar(64) | not null |
| `model_version` | varchar(32) | not null |
| `model_backend` | varchar(32) | not null · `xgboost`, `sklearn` or `numpy` |
| `explainer` | varchar(32) | nullable · which attribution method ran |
| `scenario` | varchar(32) | not null, default `NORMAL` |
| `data_mode` | varchar(12) | not null, default `DEMO` · CHECK |
| `features` | JSON / JSONB | the 16 feature values, as fed to the model |
| `top_factors` | JSON / JSONB | the ranked driver list shown in the UI |
| `contributions` | JSON / JSONB | the full additive attribution |

Indexed on `(region_id, predicted_at)` and on `risk_level`.

Rows are written only when a score is materially new — a different band, a move of
more than two points, a scenario change, or the previous row aged out. So this table
is a record of what changed, not a log of who was looking at a screen.

## 6 · risk_forecasts

One row per region, issue time and horizon. Issuing a forecast replaces that
region's curve — `forecast_service` deletes the region's existing rows and inserts
the new ones — so the chart reads a single coherent line instead of several
generations of points overlaid. The uniqueness constraint enforces that from below.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | int PK | |
| `region_id` | int FK → regions | not null · CASCADE |
| `issued_at` | timestamptz | not null, default now |
| `horizon_hours` | int | not null · CHECK 0–168 · 0, 6, 12, 24, 48, 72 in practice |
| `valid_at` | timestamptz | not null · `issued_at + horizon_hours` |
| `risk_score` | float | not null |
| `risk_level` | varchar(12) | not null · CHECK |
| `confidence` | float | not null · widens with horizon |
| `rainfall_mm` | float | not null, default 0 · forecast rain for that step |
| `soil_moisture_pct` | float | nullable · the routed soil state |
| `scenario` | varchar(32) | not null, default `NORMAL` |
| `data_mode` | varchar(12) | not null, default `DEMO` · CHECK |

Unique on `(region_id, issued_at, horizon_hours)`; indexed on the same three
columns.

## 7 · landslide_events

The inventory of what actually happened. Twenty rows are documented Indian
landslide events with their sources named; the rest are deterministic modelled minor
events, and `source` together with `data_mode` says which any given row is. Swapping
in the GSI National Landslide Susceptibility Mapping inventory changes nothing
downstream.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | int PK | |
| `event_id` | varchar(32) | unique, not null · e.g. `LS-2018-KL-004` |
| `region_id` | int FK → regions | **nullable** · SET NULL |
| `event_date` | date | not null |
| `location` | varchar(160) | not null |
| `district` | varchar(96) | nullable |
| `state` | varchar(96) | nullable |
| `latitude` | float | not null |
| `longitude` | float | not null |
| `rainfall_mm` | float | nullable · rainfall associated with the event |
| `slope_deg` | float | nullable |
| `elevation_m` | float | nullable |
| `severity` | varchar(12) | not null · CHECK in `MINOR`, `MODERATE`, `MAJOR`, `SEVERE` |
| `trigger` | varchar(48) | nullable · quoted, because `trigger` is a SQL keyword |
| `fatalities` | int | **nullable**, default 0 |
| `description` | text | nullable |
| `source` | varchar(160) | not null, default `DEMO inventory` |
| `data_mode` | varchar(12) | not null, default `DEMO` · CHECK |
| `geom` | geography(Point,4326) | PostgreSQL only · generated · GIST |

Indexed on `event_date` (descending in SQL) and on `(state, severity)`.

`fatalities` is nullable on purpose. For several documented disasters the published
toll was revised repeatedly over weeks, and `NULL` — "not stated" — is more honest
than `0`, which reads as "nobody died".

## 8 · alerts

The early-warning engine's output, plus the response workflow attached to it.
`prediction_id` links every alert to the exact inference that raised it, so an
officer looking at an alert can see the score, the features and the explanation
behind it rather than being asked to trust a severity label.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | int PK | |
| `alert_code` | varchar(32) | unique, not null · the Alert ID shown in the UI |
| `region_id` | int FK → regions | not null · CASCADE |
| `prediction_id` | int FK → risk_predictions | nullable · SET NULL |
| `severity` | varchar(12) | not null · CHECK in `HIGH`, `CRITICAL` only |
| `risk_score` | float | not null · the score at the moment of raising |
| `status` | varchar(16) | not null, default `NEW` · CHECK in the four statuses |
| `cause` | text | not null · why, in plain language |
| `recommended_action` | text | not null · what to do about it |
| `scenario` | varchar(32) | not null, default `NORMAL` |
| `data_mode` | varchar(12) | not null, default `DEMO` · CHECK |
| `assigned_to` | varchar(128) | nullable |
| `note` | text | nullable · the officer's own note |
| `created_at` | timestamptz | not null, default now |
| `updated_at` | timestamptz | not null · set on update |
| `acknowledged_at` | timestamptz | nullable |
| `resolved_at` | timestamptz | nullable |

Indexed on `(status, created_at)` and on `region_id`.

The severity CHECK admits only `HIGH` and `CRITICAL`. That is the warning policy
expressed as a constraint: nothing below 60 raises an alert, so no row below that
threshold can exist even if a caller tries to create one.

## 9 · citizen_reports

Field observations from the public portal. Both `user_id` and the reporter's name
and phone are nullable, because filing a report requires no account — the reporter
can leave a way to be contacted, or not.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | int PK | |
| `report_code` | varchar(32) | unique, not null · quoted back to the reporter |
| `region_id` | int FK → regions | nullable · SET NULL · nearest region if resolvable |
| `reporter_name` | varchar(128) | nullable |
| `reporter_phone` | varchar(24) | nullable |
| `user_id` | int FK → users | nullable · SET NULL |
| `location_text` | varchar(200) | not null · as the person described it |
| `latitude` | float | not null |
| `longitude` | float | not null |
| `observation_type` | varchar(32) | not null · CHECK in the six types |
| `severity` | varchar(12) | not null · CHECK in `LOW`, `MEDIUM`, `HIGH` |
| `description` | text | not null · the citizen's own words · written once, at insert |
| `image_path` | varchar(256) | nullable · served under `/uploads` |
| `image_analysis` | JSON / JSONB | nullable · the screening result, if a photo came |
| `observed_on` | date | not null · when they saw it, not when they filed |
| `status` | varchar(16) | not null, default `NEW` · CHECK in the four statuses |
| `officer_note` | text | nullable · triage notes, ` \| `-separated, each stamped and attributed |
| `created_at` | timestamptz | not null, default now |
| `geom` | geography(Point,4326) | PostgreSQL only · generated · GIST |

Indexed on `(status, created_at)`.

`description` and `officer_note` are two columns rather than one because they are
two kinds of statement. The first is what somebody says they saw; the second is
what the office made of it. `report_service.set_status` only ever appends to the
second, so a report that has been through three officers still contains the
citizen's account exactly as it was filed — which is the only version worth
anything when a slope does fail and someone asks what was known beforehand.

`image_analysis` is advisory and stored as such. The officer sees the model's
reading *and* the photograph, and decides. No report is ever auto-verified, and
`status` only moves because a person moved it.

## 10 · simulated_sensor_data

The virtual sensor network. There is no hardware anywhere in this project: these
rows are produced by `app/services/sensor_simulator.py` from the same physical model
that drives the demo weather, and `data_mode` defaults to `SIMULATED` so the UI can
label them. They exist to demonstrate how an instrumented slope would feed the risk
engine, and to give the demonstration something that visibly moves.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | int PK | |
| `sensor_code` | varchar(32) | not null · e.g. `WYD-SM-01` |
| `region_id` | int FK → regions | not null · CASCADE |
| `sensor_type` | varchar(24) | not null · CHECK in the five types |
| `reading` | float | not null |
| `unit` | varchar(16) | not null · `%`, `mm/h`, `deg`, `mm/s`, `kPa` |
| `status` | varchar(12) | not null, default `NORMAL` · CHECK in the four states |
| `recorded_at` | timestamptz | not null, default now |
| `data_mode` | varchar(12) | not null, default `SIMULATED` |

Indexed on `(region_id, recorded_at)` and on `sensor_code`.

Note that this is the one table whose `data_mode` has no `CHECK` constraint and no
path to `LIVE`. If real instrumentation ever existed, `sensor_simulator` would
become an ingestion adapter and the label would change there — not here.

## The controlled vocabularies

Every one of these lists is defined once in `backend/app/models.py`, duplicated as a
`CHECK` constraint, and re-used by the Pydantic schemas — so the database rejects a
bad value even if it arrives from outside the API, and the API rejects it before it
gets that far.

| Name | Values |
| --- | --- |
| `ROLES` | `CITIZEN`, `OFFICER`, `ADMIN` |
| `RISK_LEVELS` | `VERY LOW`, `LOW`, `MODERATE`, `HIGH`, `CRITICAL` |
| `DATA_MODES` | `LIVE`, `DEMO`, `SIMULATED` |
| `ALERT_SEVERITIES` | `HIGH`, `CRITICAL` |
| `ALERT_STATUSES` | `NEW`, `ACKNOWLEDGED`, `IN PROGRESS`, `RESOLVED` |
| `EVENT_SEVERITIES` | `MINOR`, `MODERATE`, `MAJOR`, `SEVERE` |
| `REPORT_TYPES` | `GROUND CRACK`, `ROAD CRACK`, `ROCKFALL`, `SOIL MOVEMENT`, `POSSIBLE LANDSLIDE`, `OTHER` |
| `REPORT_SEVERITIES` | `LOW`, `MEDIUM`, `HIGH` |
| `REPORT_STATUSES` | `NEW`, `UNDER REVIEW`, `VERIFIED`, `DISMISSED` |
| `SENSOR_TYPES` | `SOIL_MOISTURE`, `RAIN_GAUGE`, `TILT`, `VIBRATION`, `PORE_PRESSURE` |
| `SENSOR_STATUSES` | `NORMAL`, `ELEVATED`, `ALARM`, `OFFLINE` |

Storing these as strings rather than as a database `ENUM` type is deliberate: an
`ENUM` on PostgreSQL needs a migration to extend and does not exist on SQLite, while
a `VARCHAR` plus `CHECK` behaves identically on both and is readable in a raw
`SELECT`.

## What the two databases do differently

| | SQLite (default) | PostgreSQL 16 + PostGIS 3.4 |
| --- | --- | --- |
| Setup | nothing — a file appears | Docker Compose, or a server |
| JSON columns | `JSON` (text) | `JSONB`, indexable |
| Geometry | none; lat/lon floats only | generated `geography(Point,4326)` + GIST |
| Proximity | Python, in `history_service` | can be pushed down to `ST_DWithin` |
| Timestamps | `DateTime(timezone=True)` | `TIMESTAMPTZ` |
| Connection | `check_same_thread=False`, WAL, FK pragma | `pool_pre_ping`, `pool_size=10` |
| `v_current_risk` view | not created | created |

Both answer the same API. That is what lets the quick start be `pip install` plus one
`uvicorn` command while leaving a real spatial database available for a deployment
that needs one. `/api/health` reports which dialect is actually in use, so there is
never a guess about it.

The PostgreSQL schema also ships one view:

```sql
CREATE OR REPLACE VIEW v_current_risk AS
SELECT DISTINCT ON (p.region_id)
       p.region_id, r.code, r.name, r.district, r.state, r.zone,
       r.latitude, r.longitude,
       p.risk_score, p.risk_level, p.confidence, p.scenario,
       p.data_mode, p.predicted_at
FROM   risk_predictions p
JOIN   regions r ON r.id = p.region_id
ORDER  BY p.region_id, p.predicted_at DESC;
```

`DISTINCT ON` is PostgreSQL-specific, which is why this lives in `schema.sql` and
not in the ORM. Nothing in the API reads it: `/api/risk-map` scores every region
live through the risk engine rather than reading stored rows, so the map cannot show
a stale picture. The view is there for SQL-level inspection and for a BI tool
pointed at the database, and `latest_prediction` — the one place the backend does
want the newest stored row — is an ordinary `ORDER BY predicted_at DESC LIMIT 1`
that works identically on both databases.

## What is in there after a first run

`backend/app/seed.py` runs at startup and is idempotent — it fills gaps rather than
truncating, so restarting the backend never destroys work done through the UI.

| Table | After seeding |
| --- | --- |
| `regions` | 74 rows across 20 states |
| `terrain_data` | 74 rows, one per region, all `DEMO` |
| `landslide_events` | 20 documented events plus deterministic modelled minor events |
| `users` | 4 demo accounts, only if `SEED_DEMO_USERS=true` |
| `weather_data` | empty — weather is generated and cached in process, see above |
| `risk_predictions` | empty until something is scored |
| `risk_forecasts` | empty until a forecast is requested |
| `alerts` | empty until a score crosses 60 |
| `citizen_reports` | empty |
| `simulated_sensor_data` | empty until the sensor page or the simulator runs |

The empty tables are worth noticing. Nothing is pre-populated to make a dashboard
look busy: every score, forecast, alert and sensor reading you see was produced by
the model or the simulator while you were watching.

## Growth, and what to do about it

`risk_predictions`, `risk_forecasts` and `simulated_sensor_data` are the three tables
that grow without bound. For a demonstration this does not matter — the conditional
write rules keep predictions to a handful of rows per region per day, and a SQLite
file stays in the low megabytes.

For a real deployment the shape of the answer is ordinary: keep full resolution for
a few weeks, then roll older prediction rows up to daily maxima per region, and move
sensor readings to a time-series store or a partitioned table. `risk_forecasts` is
already self-limiting because of its uniqueness constraint. None of that changes any
column, which is the point of documenting it now rather than discovering it later.

## Inspecting it

```bash
# SQLite (the default, sqlite:///./landslide.db relative to backend/)
sqlite3 backend/landslide.db ".tables"
sqlite3 backend/landslide.db "SELECT code, name, state FROM regions LIMIT 5;"
sqlite3 backend/landslide.db \
  "SELECT r.name, p.risk_score, p.risk_level, p.data_mode
     FROM risk_predictions p JOIN regions r ON r.id = p.region_id
    ORDER BY p.predicted_at DESC LIMIT 10;"

# PostgreSQL, under Docker Compose
docker compose exec db psql -U landslide -d landslide -c "\dt"
docker compose exec db psql -U landslide -d landslide -c "SELECT * FROM v_current_risk LIMIT 10;"
```

The path comes from `DATABASE_URL`, so it moves if you change that; `/api/health`
reports the dialect actually in use.

## Reading further

| Document | What it covers |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The layers, the single scoring path, provenance propagation |
| [`API.md`](API.md) | All 35 endpoints, with parameters, responses and `curl` examples |
| [`ML.md`](ML.md) | The 16 features these tables feed, and what the model does with them |
| [`SCALABILITY.md`](SCALABILITY.md) | Replacing the demo rows with real datasets |

