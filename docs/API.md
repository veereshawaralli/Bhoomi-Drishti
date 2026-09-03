# API

Thirty-five endpoints across twelve routers, all under `/api`. Every one of them
validates its input, returns a documented shape, and fails in the same way as the
others.

FastAPI generates live documentation from the same source as this file: with the
backend running, `http://localhost:8000/docs` is browsable and every endpoint below
can be executed from it.

## Conventions

**Base path.** Everything is `/api/...`. In development Vite proxies `/api` to
`http://127.0.0.1:8000`, so the frontend calls relative URLs and never learns a
hostname.

**Region identifiers are interchangeable.** Anywhere a path takes `{region_id}` it
accepts the numeric id or the region code: `/api/risk/12` and `/api/risk/WYD` are the
same request. An unknown identifier is a 404.

**The scenario can be overridden per request.** Endpoints that produce scores accept
`?scenario=NORMAL|HEAVY_RAINFALL|EXTREME_RAINFALL|CRITICAL_RISK`. Without it, the
platform's active scenario applies. An unrecognised value is a 400, never a silent
fall back to normal.

**Provenance is in the response.** Anything derived carries `data_mode` — `LIVE`,
`DEMO` or `SIMULATED` — and usually a human-readable `note` or badge explaining it.
This is not decoration: it is how a reader tells a demonstration from monitoring.

**Times are UTC, ISO 8601.** Scores are `0`–`100` floats. `confidence` is a
percentage (`0`–`100`) in API responses, though it is stored `0`–`1`.

**Every response carries `X-Request-ID` and `X-Response-Time-Ms`.** Quote the request
id when reporting a problem; it appears in the server log next to the failure.

## Authentication

Sign in at `POST /api/auth/login` and send the token as a bearer header:

```bash
TOKEN=$(curl -s -X POST http://localhost:8000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"officer","password":"officer123"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

curl -s http://localhost:8000/api/auth/me -H "Authorization: Bearer $TOKEN"
```

Tokens are HS256, stateless, and expire after `ACCESS_TOKEN_MINUTES`. There is no
revocation list — see the deployment caveats in `README.md`.

Three roles, ranked `CITIZEN` < `OFFICER` < `ADMIN`. An endpoint marked *officer*
below needs at least that rank. Missing token is `401` with "Sign in to perform this
action."; insufficient rank is `403` with "This action requires the OFFICER role."

Most of the platform is readable without signing in, and filing a citizen report
needs no account at all.

## Errors

One shape, for everything:

```json
{
  "error": true,
  "status": 400,
  "message": "Unknown scenario 'MONSOON'. Known: NORMAL, HEAVY_RAINFALL, EXTREME_RAINFALL, CRITICAL_RISK.",
  "path": "/api/risk-map"
}
```

A `422` adds `fields`, listing what failed validation so a form can mark the offending
input. Where the raw payload matters, `detail` carries it.

| Status | When |
| --- | --- |
| `200` | success |
| `201` | a report or an alert was created |
| `400` | bad input a schema could not catch — unknown scenario, unknown sensor type, neither region nor coordinates |
| `401` | no token, or an expired or malformed one |
| `403` | signed in, but the role is not high enough |
| `404` | no such region, alert or report |
| `409` | an illegal alert transition — e.g. moving a `RESOLVED` alert back to `NEW` |
| `413` | uploaded image exceeds `MAX_UPLOAD_MB` |
| `415` | uploaded file is not an accepted image type |
| `422` | schema validation failed — includes `fields` |
| `503` | the database is unreachable |
| `500` | anything unexpected, logged against the request id |

## The endpoints at a glance

| Area | Endpoints |
| --- | --- |
| Meta | `GET /health` · `GET /info` · `GET /model-info` |
| Auth | `POST /auth/login` · `GET /auth/me` · `GET /auth/roles` · `GET /auth/demo-accounts` · `GET /auth/users` |
| Regions | `GET /regions` · `GET /risk-map` · `GET /risk/{region_id}` |
| Prediction | `POST /predict` · `POST /what-if` |
| Forecast | `GET /forecast/{region_id}` |
| Weather | `GET /weather/{region_id}` |
| Alerts | `GET /alerts` · `POST /alerts` · `PUT /alerts/{alert_id}` · `POST /alerts/sweep` |
| History | `GET /history` · `GET /history/near` |
| Citizen reports | `POST /citizen-report` · `GET /citizen-report` · `PUT /citizen-report/{report_id}` · `POST /image-analysis` · `GET /citizen-report/options` |
| Virtual sensors | `GET /sensors` · `GET /sensors/history` · `POST /sensors/simulate` · `GET /sensors/conditions` |
| Simulation | `GET /scenarios` · `POST /simulation` · `POST /simulation/reset` · `GET /simulation/playbook` |
| Overview | `GET /overview` |

The brief asked for seventeen endpoints. The extra eighteen are not scope creep in
the feature sense: they are the small supporting endpoints that let the frontend
avoid hardcoding anything the backend already knows — `GET /auth/roles`,
`GET /citizen-report/options`, `GET /sensors/conditions`,
`GET /simulation/playbook`, `GET /scenarios` and so on. Every dropdown, threshold and
recommended action in the UI is fetched rather than duplicated in TypeScript.

## Meta

### `GET /api/health`

Is the platform up. No parameters, no authentication. This is the endpoint to poll,
and the one the frontend's health indicator uses.

Returns `status`, `database`, `model`, `weather`, `scenario`, `ready` and `detail`.
`database` names the dialect actually in use, `model` says whether a trained model is
loaded or scoring is in physics fallback, and `weather` says whether live weather is
configured and — if a live fetch has failed — why.

```bash
curl -s http://localhost:8000/api/health
```

Returns `503` through the standard error shape if the database is unreachable.

### `GET /api/info`

What this platform is and where its data comes from. No parameters.

Returns `name`, `version`, `tagline`, `purpose`, `model`, `weather`, `scenario`,
`data_mode`, `data_provenance`, `risk_bands`, `thresholds`, `refresh_seconds`,
`max_upload_mb` and `disclaimer`.

The frontend reads `risk_bands` and `thresholds` from here rather than defining them
in TypeScript, which is why moving a band boundary in Python moves it everywhere. The
bands themselves are derived from `ml.features.RISK_BANDS`, so the legend cannot drift
from the engine that assigns the levels. Each entry carries `min` and `max` as
half-open comparison bounds — a score is `HIGH` from 60.0 up to but not including 80.0
— plus a `range` string (`61-80`) for display. Band a bare score with `min`/`max`, not
with `range`.

### `GET /api/model-info`

The model card, as trained — not as claimed. No parameters.

Returns `card_available`, `status`, `intended_use`, `limitations`,
`data_provenance`, `model_name`, `model_version`, `feature_schema_version`,
`feature_order`, `members`, `hyperparams`, `trained_at`, `training_rows`,
`split_sizes`, `regions`, `metrics`, `label_noise_ceiling`, `importance_method`,
`feature_importance`, `band_distribution`, `confidence_reference`,
`training_summary` and `note`.

If no model card is present the response still returns `200` with
`card_available: false` and a `note` saying what is being used instead.

```bash
curl -s http://localhost:8000/api/model-info | python3 -m json.tool | head -40
```

`metrics` and `label_noise_ceiling` together are the honest part: the test ROC AUC
next to the score the true generating probability achieves on the same labels. See
[`ML.md`](ML.md).

## Auth

### `POST /api/auth/login`

Body: `username` (2–64 chars) and `password` (1–128). Returns `access_token`,
`token_type`, `expires_in_minutes`, `user` and `capabilities`. Wrong credentials are
`401`, deliberately without saying which half was wrong.

```bash
curl -s -X POST http://localhost:8000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"officer","password":"officer123"}'
```

### `GET /api/auth/me`

Who the bearer token belongs to. Returns `authenticated`, `id`, `username`,
`full_name`, `role`, `rank` and `capabilities`. Unauthenticated callers get a
response with `authenticated: false` rather than an error, so the frontend can render
a signed-out state without treating it as a failure.

### `GET /api/auth/roles`

The role model itself: for each of the three roles, `can_manage_alerts`,
`can_review_reports` and `is_admin`, plus a `note`. The frontend uses this instead of
hardcoding what each role may do.

### `GET /api/auth/demo-accounts`

The seeded demo credentials, so a judge or a reviewer does not have to find them in
a file. Returns `accounts` and a `note`. If `SEED_DEMO_USERS=false` the list is empty
and the note says so.

```bash
curl -s http://localhost:8000/api/auth/demo-accounts
```

### `GET /api/auth/users` — *administrator*

All accounts. Returns `count` and `users`, never any password material.

## Regions

### `GET /api/regions`

The monitored regions. All parameters optional: `state` filters by state name, `q`
searches name, district and code, `limit` is 1–1000 (default 500).

Returns `count`, `states` (the distinct list, for a dropdown) and `regions`.

```bash
curl -s 'http://localhost:8000/api/regions?state=Kerala'
curl -s 'http://localhost:8000/api/regions?q=wayanad'
```

### `GET /api/risk-map`

Every region scored under the active scenario — one batched inference for the whole
country, and the endpoint the map is built on.

| Parameter | Type | Notes |
| --- | --- | --- |
| `scenario` | string | optional override |
| `state` | string | restrict to one state |
| `min_score` | float 0–100 | only regions at or above |
| `level` | string | only this band |

Returns `generated_at`, `data_mode`, `scenario`, `scenario_label`, `count`,
`total_regions`, `points`, `band_counts`, `high_risk_count`, `critical_count`,
`country_risk`, `avg_score`, `max_score` and `note`.

Filtering happens *after* scoring, deliberately: a map filtered to `CRITICAL` can
still tell you how many regions are not, because `band_counts` describes the full
picture while `points` describes the filtered one.

```bash
curl -s 'http://localhost:8000/api/risk-map' | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["count"],d["band_counts"],d["data_mode"])'
curl -s 'http://localhost:8000/api/risk-map?scenario=EXTREME_RAINFALL&min_score=61'
```

### `GET /api/risk/{region_id}`

Everything about one region on one screen. `{region_id}` accepts an id or a code.
`explain` (default `true`) includes the factor breakdown; `scenario` overrides.

Returns `region`, `risk`, `explanation`, `weather`, `terrain`, `forecast`, `alerts`,
`recent_reports`, `nearby_events` and `weather_provider` — the detail panel in one
request rather than seven.

```bash
curl -s http://localhost:8000/api/risk/WYD
curl -s 'http://localhost:8000/api/risk/12?scenario=CRITICAL_RISK&explain=false'
```

## Prediction

### `POST /api/predict`

The endpoint the brief specifies. Three ways to ask:

- by `region_id` or `region_code` — stored terrain plus current weather, the normal path;
- by `latitude` and `longitude` — the nearest monitored region's terrain is borrowed, and the response says how far away it was, because a prediction made from terrain 40 km distant deserves to be read differently;
- either of those with rainfall or soil-moisture overrides, which marks the result `SIMULATED`.

| Field | Type | Notes |
| --- | --- | --- |
| `region_id` | int | optional |
| `region_code` | string | optional |
| `latitude` | float −90…90 | optional |
| `longitude` | float −180…180 | optional |
| `rainfall_1h` … `rainfall_7d` | float ≥ 0 | optional overrides, five windows |
| `rainfall_anomaly` | float ≥ 0 | optional override |
| `soil_moisture` | float 0–100 | optional override |
| `scenario` | one of the four keys | default `NORMAL`; `heavy rainfall` is accepted for `HEAVY_RAINFALL` |
| `explain` | bool | default `true` |

Returns `region_id`, `region_code`, `region_name`, `risk_score`, `risk_level`,
`confidence`, `probability`, `model_backend`, `model_name`, `model_version`,
`scenario`, `data_mode`, `defaulted_fields`, `top_factors`, `explanation`,
`features`, `predicted_at`, `terrain`, `overrides_applied`, and — for a coordinate
request — `nearest_region_km` and a `note`.

The brief's required four fields are all there: `risk_score`, `risk_level`,
`confidence`, `top_factors`. The rest is what makes the number auditable.

Naming neither a region nor coordinates is a `400`. A point more than 60 km from any
monitored region is a `404`, because there is no terrain to score it against and
inventing some would be worse than refusing. An unrecognised `scenario` is a `422`
naming the four valid keys — never a silent fall back to `NORMAL`, because answering
`200` with calm-weather numbers to somebody who asked about extreme rainfall is the
one failure mode worse than an error.

When overrides are supplied the result is **not persisted** and is labelled
`SIMULATED` with scenario `<SCENARIO>+OVERRIDE`. A score built on supplied numbers is
a hypothesis, not an observation, and it must not be filed as one.

```bash
curl -s -X POST http://localhost:8000/api/predict \
  -H 'Content-Type: application/json' \
  -d '{"region_code":"WYD"}'

curl -s -X POST http://localhost:8000/api/predict \
  -H 'Content-Type: application/json' \
  -d '{"region_code":"WYD","rainfall_24h":210,"rainfall_1h":24,"soil_moisture":88}'

curl -s -X POST http://localhost:8000/api/predict \
  -H 'Content-Type: application/json' \
  -d '{"latitude":11.68,"longitude":76.13}'
```

A `top_factors` entry, and the shape the percentage breakdown in the UI is built
from:

```json
{
  "feature": "soil_moisture",
  "label": "Soil moisture",
  "contribution": 1.42,
  "direction": "raising",
  "share_percent": 52.0,
  "value": 88.0,
  "value_text": "88% saturated",
  "evidence": "Near saturation; the slope has little capacity left to absorb rain."
}
```

`explanation` wraps those with `method`, `method_label`, `reference`, `additive`,
`share_basis`, `baseline_log_odds`, `total_log_odds`, `top_factors`,
`protective_factors`, `factors`, `feature_detail`, `summary` and `disclaimer`. The
`method` field names whichever attribution actually ran — SHAP, XGBoost
contributions, exact tree-path, or physics fallback — so an explanation never
overstates its own provenance.

### `POST /api/what-if`

The simulator behind the What-If panel. Returns the baseline and the modified
prediction side by side, so the comparison is the model's, not the reader's
arithmetic.

| Field | Type | Notes |
| --- | --- | --- |
| `region_id` | int | required |
| `rainfall_multiplier` | float 0–6 | scale all five rainfall windows |
| `rainfall_add_mm_h` | float 0–300 | add an hourly rate |
| `soil_moisture_pct` | float 0–100 | pin soil moisture |
| `slope_deg` | float 0–80 | ask about a different slope |
| `vegetation_index` | float 0–1 | ask about deforestation |
| `distance_to_river_km` | float 0–60 | |
| `historical_landslide_count` | int 0–200 | |
| `future_hours` | int 0–72 | default 6 |

Returns `region`, `baseline`, `modified`, `changes`, `interpretation`, `scenario`,
`scenario_label`, `data_mode` and `note`.

Rainfall is scaled across all five accumulation windows with a realistic reach per
window, and soil moisture follows rainfall unless it is pinned — so the model is
never asked about a physically impossible combination it was not trained on. That is
the difference between a simulator and a set of sliders.

```bash
curl -s -X POST http://localhost:8000/api/what-if \
  -H 'Content-Type: application/json' \
  -d '{"region_id":12,"rainfall_multiplier":3.5,"future_hours":24}'
```

## Forecast

### `GET /api/forecast/{region_id}`

The 72-hour curve: `NOW`, `+6`, `+12`, `+24`, `+48`, `+72`. `store` (default `true`)
persists the curve; `scenario` overrides.

Returns `region_id`, `region_code`, `region_name`, `district`, `state`, `issued_at`,
`scenario`, `scenario_label`, `data_mode`, `model_backend`, `points`, `peak`,
`summary` and `note`. Each point carries `label`, `hours`, `valid_at`, `risk_score`,
`risk_level`, `confidence`, `rainfall_mm` and `soil_moisture_pct`.

`peak` is what an officer actually needs — when the worst of it arrives, not just
that it will.

```bash
curl -s http://localhost:8000/api/forecast/WYD | python3 -c 'import sys,json;d=json.load(sys.stdin);[print(p["label"],p["risk_score"],p["risk_level"]) for p in d["points"]]'
```

## Weather

### `GET /api/weather/{region_id}`

Current conditions plus the hourly series behind them. `back_hours` (0–168, default
24) and `forward_hours` (0–168, default 48); `scenario` overrides.

Returns `region_id`, `region_code`, `region_name`, `scenario`, `scenario_label`,
`data_mode`, `provider`, `live_configured`, `current`, `hourly` and `note`.

`provider` is `open-meteo` when a live fetch succeeded and `demo-model` otherwise;
`live_configured` says whether live weather was even asked for, so `DEMO` because the
network failed is distinguishable from `DEMO` by choice.

```bash
curl -s 'http://localhost:8000/api/weather/WYD?back_hours=48&forward_hours=72'
```

## Alerts

### `GET /api/alerts`

The alert list with counts. `status` (the query parameter is `status`, aliased
internally), `severity`, `region_id`, and `limit` 1–1000 (default 200).

Returns `count`, `alerts`, `stats` and `thresholds`. Each alert carries `id`,
`alert_code`, `region_id`, `region_name`, `region_code`, `severity`, `risk_score`,
`status`, `cause`, `recommended_action`, `scenario`, `data_mode`, `assigned_to`,
`note`, `created_at`, `updated_at`, `acknowledged_at` and `resolved_at` — which is
the full table the Alerts page renders, including the recommended action.

```bash
curl -s 'http://localhost:8000/api/alerts?status=NEW&severity=CRITICAL'
```

### `POST /api/alerts` — *officer* · `201`

An officer raising a warning from a field observation rather than from a model score.
Body: `region_id`, `severity` (`HIGH` or `CRITICAL`), `risk_score` 0–100, `cause`
(8–1000 chars), `recommended_action` (8–1000), `scenario` (default `MANUAL`).

Returns the created alert. It is marked `data_mode: LIVE`, because it records a human
observation rather than a model output, and tagged with who raised it.

```bash
curl -s -X POST http://localhost:8000/api/alerts \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"region_id":12,"severity":"HIGH","risk_score":72,
       "cause":"Fresh tension cracks reported above the school approach road.",
       "recommended_action":"Inspect the slope and close the approach road to heavy vehicles."}'
```

### `PUT /api/alerts/{alert_id}` — *officer*

Acknowledge, assign or resolve. Body: `status` (one of the four), optional
`assigned_to` (≤128 chars) and `note` (≤2000).

Returns the updated alert. `404` if there is no such alert; `409` on an illegal
transition, with the reason.

The permitted moves are `NEW → ACKNOWLEDGED | IN PROGRESS | RESOLVED`,
`ACKNOWLEDGED → IN PROGRESS | RESOLVED`, `IN PROGRESS → ACKNOWLEDGED | RESOLVED`, and
`RESOLVED → IN PROGRESS` (reopening, which clears `resolved_at`). Re-sending an alert's
current status is also legal in every state, because that is how an officer adds a note
without pretending the situation moved. Every change is stamped with the officer's name
and appended to the alert's note, so the record shows who did what and when.

```bash
curl -s -X PUT http://localhost:8000/api/alerts/3 \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"ACKNOWLEDGED","assigned_to":"S. Menon","note":"Team dispatched."}'
```

### `POST /api/alerts/sweep`

Re-score every region and update the alert set accordingly: raise what has crossed a
threshold, leave what has not. `scenario` overrides.

Returns `scenario`, `data_mode`, `regions_scored`, `predictions_stored`,
`alerts_raised` and `alerts`.

This is the periodic job an operational deployment would run on a timer, exposed as
an endpoint so the demonstration can trigger it deliberately. It is callable
anonymously today, which `README.md` flags as something to close before deployment.

## History

### `GET /api/history`

Past landslide events, the filter options for the page, and the charts — in one
request, because a page that fetches its filters separately from its data can show
them disagreeing.

| Parameter | Type | Notes |
| --- | --- | --- |
| `state` | string | |
| `district` | string | |
| `year` | int 1900–2100 | |
| `severity` | string | `MINOR`, `MODERATE`, `MAJOR`, `SEVERE` |
| `region_id` | int | |
| `limit` | int 1–5000 | default 1000 |

Returns `total` (the whole inventory), `filtered` (this query), `events`,
`filter_options` and `charts`, plus `data_mode`. `charts` carries the four the brief
asks for: events per year, rainfall against landslides, the highest-risk regions, and
the seasonal pattern.

```bash
curl -s 'http://localhost:8000/api/history?state=Kerala&severity=SEVERE'
curl -s 'http://localhost:8000/api/history?year=2018' | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["filtered"],"of",d["total"])'
```

### `GET /api/history/near`

Past events near a point. `lat` (−90…90) and `lon` (−180…180) are required;
`radius_km` 1–200 (default 25) and `limit` 1–100 (default 20).

Returns `count`, `radius_km` and `events`. Used by the citizen report form: showing
somebody that three landslides happened within 10 km of where they are standing is
better context than any risk score.

```bash
curl -s 'http://localhost:8000/api/history/near?lat=11.68&lon=76.13&radius_km=50'
```

## Citizen reports

### `POST /api/citizen-report` — `201`

**Multipart form**, open to everyone, no account needed.

| Field | Type | Notes |
| --- | --- | --- |
| `location_text` | string 4–200 | required |
| `latitude` | float −90…90 | required |
| `longitude` | float −180…180 | required |
| `observation_type` | string | required · one of the six types |
| `severity` | string | required · `LOW`, `MEDIUM`, `HIGH` |
| `description` | string 10–3000 | required |
| `reporter_name` | string ≤128 | optional |
| `reporter_phone` | string ≤24 | optional |
| `observed_on` | date string | optional, defaults to today |
| `region_id` | int | optional; otherwise the nearest region is matched |
| `image` | file | optional |

Returns the stored report plus an `acknowledgement` — the report code to quote. If an
image is attached it is screened and the result stored on the report.

`422` with `fields` on a bad value; `413` if the image exceeds `MAX_UPLOAD_MB`.

```bash
curl -s -X POST http://localhost:8000/api/citizen-report \
  -F 'location_text=Below the temple road, Meppadi' \
  -F 'latitude=11.55' -F 'longitude=76.13' \
  -F 'observation_type=GROUND CRACK' -F 'severity=HIGH' \
  -F 'description=A crack about 20 m long opened across the slope after last night rain.' \
  -F 'reporter_name=K. Joseph' \
  -F 'image=@slope.jpg'
```

### `GET /api/citizen-report` — *officer*

The report queue. `status`, `region_id`, `severity`, `limit` 1–1000 (default 200).
Returns `count`, `reports` and `stats`.

### `PUT /api/citizen-report/{report_id}` — *officer*

Triage. Body: `status` (`NEW`, `UNDER REVIEW`, `VERIFIED`, `DISMISSED`) and an
optional `note` (≤2000). Returns the updated report. `404` if there is no such report.

The note is appended to the report's `officer_note` field, stamped with the time and
the officer's username and separated from earlier notes by ` | `. It is a different
field from `description`, which holds the citizen's own words and is written once, at
submission — triage never edits the account it is triaging, so a report that has
passed three officers still carries the original observation verbatim.

No report is ever auto-verified — status moves because a person moved it.

### `POST /api/image-analysis`

Screen a photograph on its own, without filing a report. Multipart, field `image`.

Returns `category`, `category_label`, `confidence`, `features`, `recommendation`,
`method`, `disclaimer`, `measurements` and `alternatives`. Categories are normal
terrain, ground crack, rockfall, possible landslide and severe landslide.

`400` if the upload is empty; `415` if the bytes are not a readable image.

This is deterministic image measurement — edge density, gradient orientation, texture
and colour statistics computed with NumPy and PIL — not a trained convolutional
network, and `method` says so. `alternatives` gives the runner-up categories with
their scores, because a screening tool that reports only its first choice hides how
close the call was. The `disclaimer` travels with every response so it stays attached
wherever the result is displayed: **this is decision support and does not replace
professional geotechnical assessment.**

```bash
curl -s -X POST http://localhost:8000/api/image-analysis -F 'image=@slope.jpg'
```

### `GET /api/citizen-report/options`

Everything the public form needs: `observation_types`, `severities`, `statuses`,
`image_note`, `accepted_image_types`, `snap_radius_km` and
`screening_disclaimer`. The form is built from this rather than from hardcoded
option lists, so the six observation types exist in exactly one place.

## Virtual sensors

There is no hardware anywhere in this project. Everything under this heading is a
software simulation, labelled `SIMULATED` in every response.

### `GET /api/sensors`

The whole virtual network. `region_id` for one region; `limit_regions` 1–40 (default
12); `scenario` overrides.

Returns `sensors`, `counts` (`NORMAL`, `ELEVATED`, `ALARM`, `OFFLINE`, plus `total`
and `regions`), `types`, `mode`, `note`, `scenario` and `scenario_label`.

Instruments are placed on the regions with the most recorded landslides, which is how
a real network would be prioritised. Each reading carries its unit, its elevated and
alarm thresholds, and the real instrument it stands in for — so a reader can see what
the number would mean in the field.

```bash
curl -s 'http://localhost:8000/api/sensors?limit_regions=6' | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["counts"],d["mode"])'
```

### `GET /api/sensors/history`

One instrument's recent trace, oldest first, ready to plot. `region_id` and
`sensor_type` are required; `points` 2–500 (default 48).

Returns `region_id`, `region_name`, `sensor_type`, `label`, `unit`, `elevated_at`,
`alarm_at`, `purpose`, `real_world`, `count`, `readings`, `mode` and `note`.

An unknown `sensor_type` is a `400` that lists the known types.

```bash
curl -s 'http://localhost:8000/api/sensors/history?region_id=12&sensor_type=PORE_PRESSURE&points=96'
```

### `POST /api/sensors/simulate` — *officer*

Force an abnormal condition, the way a drill would. Body: `region_id`, `condition`
(`NORMAL`, `HEAVY_RAIN`, `CRITICAL`; default `HEAVY_RAIN`), `minutes` 10–720 (default
60).

Returns `region_id`, `region_name`, `scenario`, `data_mode`, `inserted_rows`,
`applied_condition`, `risk`, `sensors`, `alarming` and `note`.

The readings it writes feed the risk engine, so `risk` in the response is a real
re-score under the simulated instrument readings, not a separate display value.

### `GET /api/sensors/conditions`

What the operator can force, for the buttons on the page: `conditions`,
`sensor_types`, `mode` and `note`.

## Simulation

The demo mode. Four scenarios, one process-wide switch.

### `GET /api/scenarios`

`active`, `active_label`, `version`, `scenarios`, `note`. Each scenario carries its
key, label, description, badge and data mode, so the scenario selector in the
*Demonstration* panel is built from the server's list rather than from a hardcoded
array in the client.

`version` increments on every change. The frontend watches it and refetches
everything when it moves, which is why switching a scenario updates the map, the
charts, the alerts and the sensors together rather than page by page.

### `POST /api/simulation`

The button the demo is built around. Body: `scenario` (default `EXTREME_RAINFALL`) and
`compare_with` (default `NORMAL`).

Sets the process scenario, then rescores every region, stores the predictions, runs
the alert engine and returns the whole before-and-after picture in one response:
`scenario`, `scenario_label`, `scenario_description`, `compared_with`, `data_mode`,
`badge`, `version`, `changes`, `regions_scored`, `regions_escalated`,
`predictions_stored`, `alerts_raised`, `alerts`, `band_counts`, `country_risk`,
`max_score`, `regions`, `highlighted`, `worst_region`, `overview`,
`recommended_response`, `headline_level` and `note`.

One call is enough for the whole page to update, which is deliberate: on stage there
is no time for six sequential requests, and a single response cannot show a map and a
chart that disagree with each other.

An unknown scenario key is a `400` listing the valid keys.

```bash
curl -s -X POST http://localhost:8000/api/simulation \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"EXTREME_RAINFALL","compare_with":"NORMAL"}' \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["headline_level"],d["max_score"],d["alerts_raised"],d["data_mode"])'
```

### `POST /api/simulation/reset`

Back to `NORMAL`, rescore, restore. Returns `scenario`, `scenario_label`,
`data_mode`, `version`, `regions_scored`, `predictions_stored`, `band_counts`,
`overview` and `note`.

Worth running before a demo as well as after one — it guarantees a known starting
state.

### `GET /api/simulation/playbook`

The recommended response actions per risk band: `playbook`, `note`. The response
guidance shown next to an alert comes from here, so the advice is identical wherever
it appears.

## Overview

### `GET /api/overview`

The national picture, computed rather than stored. `top_n` 1–50 (default 10) sets how
many regions come back in `top_regions`; `scenario` overrides.

Returns `generated_at`, `data_mode`, `scenario`, `scenario_label`, `regions_total`,
`regions_scored`, `bands`, `avg_score`, `max_score`, `high_risk`, `critical`,
`active_alerts`, `unresolved_alerts`, `alert_counts`, `events_total`,
`events_this_year`, `reports_pending`, `sensors_alerting`, `sensors_total`,
`population_exposed`, `states_monitored`, `states`, `top_regions`, `country_risk` and
`note`.

Every figure on the overview page comes from this one call. Nothing on that page is a
constant typed into the UI — if a number there is wrong, it is wrong in the model or
the database, which is the only place worth fixing it.

## Interactive documentation

FastAPI generates a live reference from the same Pydantic models this document was
written from. With the backend running:

- Swagger UI — <http://localhost:8000/docs>
- ReDoc — <http://localhost:8000/redoc>
- OpenAPI JSON — <http://localhost:8000/openapi.json>

If the two ever disagree, believe `/openapi.json`: it is generated, this file is
written by hand.

## Reading further

| Document | What it covers |
| --- | --- |
| [`../README.md`](../README.md) | Install, run, and what the system is |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How a request becomes a risk score |
| [`DATABASE.md`](DATABASE.md) | All ten tables, column by column |
| [`ML.md`](ML.md) | The features, the model, and the explanations |
| [`DEMO.md`](DEMO.md) | The three-minute demonstration script |
| [`SCALABILITY.md`](SCALABILITY.md) | Replacing demo sources with real ones |
