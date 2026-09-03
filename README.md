# Bhoomi-Drishti

**AI Landslide Early-Warning & Risk Monitoring System** ·

> **Predict. Explain. Warn. Respond.**

Bhoomi-Drishti watches 74 hill districts across 20 Indian states. It scores each
one from 0 to 100 for landslide hazard using a gradient-boosted model over 16
rainfall, terrain and soil features; it explains every score as a percentage
breakdown of causes rather than a list of feature names; it raises a graded alert
the moment a score crosses 60, with a recommended action attached; and it gives a
district officer somewhere to work that alert through to resolution. A 72-hour
curve says where the risk is going, a what-if simulator says what would happen if
the rain doubled, and a citizen portal lets the person who can see the crack in
the road tell somebody about it.

It runs on one ordinary laptop. There is no hardware of any kind.

---

## Software only

No Arduino, no Raspberry Pi, no physical IoT sensor, no physical device is
required, used or supported anywhere in this project. Where an operational system
would read an instrument on a slope, this one runs a documented software model of
what that instrument would report, writes the reading with `data_mode =
'SIMULATED'`, and labels it **SIMULATED SENSOR DATA** on every screen it appears
on. The whole platform is Python, TypeScript, a database, and — optionally — one
public weather API that needs no key.

## What is real, and what is not

Every value the platform stores carries a provenance label, stamped where the
value is produced rather than guessed at the edge, and the UI renders it verbatim.

| Label | Meaning | Where it comes from |
|---|---|---|
| **LIVE** | Fetched from an external service | Open-Meteo hourly forecast, only when `USE_LIVE_WEATHER=true` |
| **DEMO** | Deterministic modelled data shipped with the repository | `ml/hydrology.py` weather process, the approximate region and terrain table in `ml/data/regions_seed.py`, the historical inventory in `backend/app/seed.py` |
| **SIMULATED** | Produced by the platform's own simulators | Demo scenarios, the what-if simulator, the virtual sensor network |

The model is trained on **synthetic labels**. There is no public per-district
hourly landslide label set that can be shipped inside a repository, so the labels
are Bernoulli draws from the documented slope-stability model in `ml/physics.py`
rather than observed failures. Every metric in the model card therefore measures
how faithfully the model recovers that physical model from noisy samples of it —
not how well it predicts real landslides on real hillsides. `GET /api/model-info`
says so in its own `data_provenance` block, the administration screen prints the
limitations above the numbers, and `docs/ML.md` explains exactly what was done.

This is decision support for a demonstration, not an operational forecasting
service, and nothing here replaces assessment by a qualified engineer.

---

## Quick start

You need **Python 3.10 or newer** and **Node 18 or newer**. Nothing else — the
default database is a SQLite file the application creates for itself, and the
trained model is committed, so there is no server to install and no model to wait
for.

**Terminal 1 — the API**

```bash
cd landslide-ai
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
python -m pip install --upgrade pip
pip install -r backend/requirements.txt

cd backend
uvicorn app.main:app --reload --port 8000
```

That installs nine packages and none of the heavy machine-learning stack:
`ml/model.pkl` is a pure-NumPy ensemble, so the API scores, explains and
forecasts without scikit-learn, XGBoost or SHAP on the machine. Retraining is a
separate opt-in install — `pip install -r backend/requirements-ml.txt` — and
`backend/requirements-lock.txt` holds the exact versions this was verified
against if you want to reproduce the figures in `docs/ML.md` rather than just run
the platform.

> **If the install fails while compiling NumPy**, your Python is newer than the
> wheels a dependency publishes, and pip has fallen back to building from source.
> Upgrade pip first, and add `--only-binary=:all:` so a missing wheel is reported
> by name in a second instead of dying inside a C compiler minutes later. Failing
> that, create the virtual environment with Python 3.12 or 3.13, which every
> dependency ships wheels for.

The first start-up creates the tables, seeds 74 regions with their terrain, the
historical inventory and the demo accounts, then scores every region once to warm
the cache. It is idempotent: restarting never duplicates a row or resets an
officer's work. Interactive API documentation is at
<http://localhost:8000/docs>, and <http://localhost:8000/api/health> reports what
the platform thinks of itself.

**Terminal 2 — the web application**

```bash
cd landslide-ai/frontend
npm install
npm run dev
```

Open <http://localhost:5173>. The Vite dev server proxies `/api` and `/uploads`
to `127.0.0.1:8000`, so there is no CORS configuration to do and no base URL to
set. To point the frontend at a backend somewhere else, set `VITE_API_TARGET` for
the dev proxy or `VITE_API_BASE` for a production build.

## Signing in

Reading the dashboard, the map, the forecast, the alert board and the history
archive needs no account, and **filing a citizen report needs no account either** —
requiring a login before somebody can warn you about a slope is a way of not being
warned. Everything else is gated by role.

| Username | Password | Role | Can do |
|---|---|---|---|
| `citizen` | `citizen123` | Citizen | File reports; read every public screen |
| `officer` | `officer123` | Officer | Triage reports, raise and move alerts, force sensor conditions |
| `officer2` | `officer123` | Officer | Same, seeded as a second district for the assignment demo |
| `admin` | `admin123` | Administrator | Everything above, plus the accounts list and the model card |

These passwords are published on purpose — a reviewer has to be able to open the
officer desk — and the sign-in page lists them too. Set `SEED_DEMO_USERS=false`
before this platform goes anywhere reachable.

## The full stack in one command

`docker compose up --build` brings up PostgreSQL 16 with PostGIS 3.4, the API and
the frontend behind nginx. The richer SQL schema in `database/schema.sql` is
applied automatically by the PostGIS image, which adds the `geography(Point,
4326)` columns and GiST indexes that SQLite cannot have; the application detects
that they already exist and leaves them alone. The model is trained inside the
backend image at build time.

```bash
docker compose up --build
# frontend  http://localhost:5173
# API docs  http://localhost:8000/docs
```

Both database paths are first-class. SQLite exists so the project starts on a bare
laptop in a hall with no Docker; PostGIS exists because a production deployment
needs spatial joins, and `docs/DATABASE.md` shows the queries that get faster when
it is there.

## Live weather

The default is DEMO weather, which is a deterministic physical model rather than a
random number generator — the same rainfall process, soil water balance and
temperature model the training data was built from, seeded by region and date, so
reloading the dashboard shows the same numbers and the features at inference time
have the same structure as the features the model was trained on.

To fetch real weather instead, set `USE_LIVE_WEATHER=true`. The provider is
Open-Meteo, which needs no API key. Hourly rainfall, temperature, humidity and
soil moisture then arrive labelled **LIVE**. If the call fails — no network, a
timeout, a rate limit — the service falls back to DEMO, records the reason, and the
UI shows the DEMO badge with that reason on it. It never presents modelled numbers
as observations, and it never leaves a screen blank because an upstream API was
down.

## Configuration

Copy `.env.example` to `.env` and edit. Every setting has a working default, so
the platform runs with no configuration at all.

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | `sqlite:///./landslide.db` | SQLite file, or `postgresql+psycopg://…` for PostGIS |
| `USE_LIVE_WEATHER` | `false` | `true` switches weather from DEMO to LIVE |
| `WEATHER_API_BASE` | Open-Meteo forecast endpoint | Change to point at another provider |
| `MODEL_PATH` | `../ml/model.pkl` | Resolved against `backend/`, the repository root, then the working directory |
| `JWT_SECRET` | a published demo value | **Change this.** The server logs a warning while it is unchanged |
| `JWT_EXPIRY_MINUTES` | `720` | Token lifetime |
| `SEED_DEMO_USERS` | `true` | `false` stops the demo accounts being created |
| `ALERT_HIGH_THRESHOLD` | `60` | Score at or above which a HIGH alert is raised |
| `ALERT_CRITICAL_THRESHOLD` | `80` | Score above which the alert is CRITICAL |
| `CORS_ORIGINS` | `http://localhost:5173,…` | Comma-separated, never a wildcard |
| `MAX_UPLOAD_MB` | `8` | Report photograph size limit |
| `LOG_LEVEL` | `INFO` | `DEBUG` also logs every successful request |

## The screens

**Command centre** (`/`) is the operational summary: national risk, the band
distribution, the worst regions ranked, the open alerts, and the selected region's
score with its full explanation. **Risk map** (`/map`) is the GIS view — 74 scored
discs sized by score and coloured by band, with five toggleable overlays for
alerts, past events, citizen reports, virtual sensors and labels, on either a
terrain or a satellite basemap. **Forecast & what-if** (`/forecast`) draws the
72-hour curve for one region and lets you move rainfall, soil moisture, slope,
vegetation, drainage distance and historical activity to see what the model does
about it. **Alerts** (`/alerts`) is the warning board with the full workflow.
**Virtual instruments** (`/sensors`) is the simulated sensor network, five
instrument types per region, with the control that forces an abnormal condition.
**Historical archive** (`/history`) filters the inventory by state, district, year
and severity and draws the four charts the brief asks for. **National overview**
(`/overview`) is the country-wide picture, every figure computed from stored data.
**Report a hazard** (`/report`) is the citizen portal. **Officer desk**
(`/officer`) and **Administration** (`/admin`) are role-gated: the report queue and
alert workflow for officers, the accounts list, the capability matrix, the model
card and the deployment's provenance for administrators.

Every button on those screens performs a real action against the API. There are no
decorative controls, no hardcoded dashboard figures, and no random numbers.

## How a risk score is made

```
terrain (7 static features)  ─┐
                              ├─► preprocess.py ─► model.pkl ─► probability ─► score 0-100 ─► band
weather (9 dynamic features) ─┘        │                              │
   scenario modifiers applied here     │                              └─► explain.py ─► causes, %
                                       └─ same code path for the map, the region
                                          panel, the forecast, the what-if and
                                          every alert
```

The 16 features, their units and their bounds are defined once, in
`ml/features.py`, and used by the dataset generator, the trainer, the API and the
UI alike. Rainfall arrives as five nested accumulation windows plus an anomaly
ratio against the seasonal normal; terrain contributes elevation, slope, distance
to river, vegetation index, soil type, land cover and the historical event count;
soil moisture, temperature and humidity complete the row. `docs/ML.md` lists them
with units.

Scores fall into the five bands the brief specifies, and the same five colours are
used on every screen, chart and marker:

| Score | Band | What the platform does |
|---|---|---|
| 0–20 | VERY LOW | Monitor |
| 21–40 | LOW | Monitor |
| 41–60 | MODERATE | Watch — no major alert is raised below 60 |
| 61–80 | HIGH | **HIGH alert** with location, score, drivers and a recommended action |
| 81–100 | CRITICAL | **CRITICAL alert** — evacuation advisory language, highest priority |

## The model

A bagged ensemble of five gradient-boosted tree models, 300 trees each, trained on
24 000 synthetic rows and split **by region** rather than by row — 52 regions for
training, 11 for validation, 11 held back for the test set — so no district appears
on both sides of the divide and the test number is not inflated by having seen the
same hillside already.

On that held-out set it reaches **ROC AUC 0.825**, with an expected calibration
error of **0.009**, meaning that when it says 30% it is right about 30% of the
time. The number that matters more is the ceiling: because the labels are noisy
Bernoulli draws, the generating probability *itself* only scores 0.840 against
them, so **the model reaches 98.3% of what is achievable on this data** and
correlates 0.95 with the true hazard probability. A model that scored 0.99 here
would be memorising noise.

XGBoost is preferred at training time, scikit-learn is next, and a dependency-free
NumPy implementation of the same Newton boosting is the fallback — so `pip install
xgboost` failing on a judge's laptop degrades the backend name in the model card,
not the existence of a real model. The committed `model.pkl` was trained with the
NumPy backend; the model card records which one produced it.

Explanations are exact and additive. SHAP's `TreeExplainer` is used when `shap` is
installed, XGBoost's `pred_contribs` next, then exact tree-path attribution, and
finally a documented physical breakdown if no model is loaded at all. Whichever ran
is named in the response and shown in the UI. The reference is always *this same
slope on a calm, dry day*, which answers the question an officer actually asks —
why is this place elevated **now**.

Confidence is measured, not asserted: it comes from how much the five ensemble
members disagree on that specific row, scaled against the disagreement recorded on
held-out data at training time, and reduced further when input fields were missing
and had to be defaulted.

## Retraining and the smoke test

```bash
python ml/predict.py                     # score four documented weather regimes
python ml/train_model.py                 # regenerate the dataset if needed, retrain, rewrite the card
python ml/train_model.py --rows 60000 --members 7
python ml/train_model.py --backend numpy # force the dependency-free trainer
python ml/data/generate_dataset.py --rows 24000
```

`python ml/predict.py` is the fastest way to confirm the served model is sane. It
scores one Wayanad-like slope under four documented weather regimes and prints what
it found:

```
backend: numpy   loaded: True

scenario            score  level       conf   top driver
----------------------------------------------------------------------------------
dry season            1.9  VERY LOW     83%   Historical activity (6%)
normal monsoon       30.4  LOW          88%   Soil moisture (41%)
heavy rainfall       79.2  HIGH         89%   Soil moisture (52%)
extreme rainfall     86.1  CRITICAL     91%   Soil moisture (53%)
```

If `model.pkl` is missing or was trained against a different feature contract, the
API refuses to load it, serves the documented physics model instead, and reports
`model_backend = "physics-fallback"` everywhere — including on the dashboard. It
never silently substitutes a plausible-looking number.

## Demo mode

Four scenarios can be loaded from the header of any screen, and the one that is
active applies to the whole platform until it is reset.

| Scenario | What it changes | What you should see |
|---|---|---|
| **Normal Weather** | Nothing — each region's own modelled weather for today | Most regions VERY LOW to LOW |
| **Heavy Rainfall** | Rainfall intensity ×3, soil already 7 points wetter, 24 h floor 95 mm | Wet-zone regions move into MODERATE and HIGH |
| **Extreme Rainfall** | Intensity ×6.5, soil +14 points, 24 h floor 230 mm | Several regions reach HIGH and CRITICAL |
| **Critical Landslide Risk** | Intensity ×9, soil +20 points, 24 h floor 340 mm | The worst case the platform is designed to warn on |

A scenario does not paint numbers onto the dashboard. It multiplies the rainfall
the weather service produces, which changes soil moisture through the same water
balance, which changes the features the model sees, which changes the score, which
crosses the alert threshold. Every downstream number moves because the input moved
— and every one of them is labelled SIMULATED end to end.

**SIMULATE EXTREME RAINFALL**, the large button in the *Demonstration* panel — which
sits on the dashboard, the map, the forecast, the alerts and the sensors screens, so
it is never more than zero clicks away — is the same mechanism wired to one press for
a live demonstration. It raises rainfall across
all 74 regions, re-scores every one of them through the model, updates the map, the
charts and the national figures, raises the alerts that the new scores justify,
highlights the regions that changed band, and prints the recommended response for
the worst band reached. **Reset** returns the platform to normal conditions and
re-scores again. Both report exactly what they did: regions scored, predictions
stored, alerts raised, worst region, and the new band distribution.

## Repository layout

```
landslide-ai/
├── frontend/               React 18 + TypeScript + Vite + Tailwind + Leaflet + Recharts
│   └── src/
│       ├── pages/          One file per screen (11 screens)
│       ├── components/     Panels, tables, chips, readouts, factor breakdown
│       ├── maps/           Leaflet map, overlay layers, markers, basemaps
│       ├── charts/         Recharts forecast, history and sensor charts
│       ├── services/api.ts The only place the frontend touches the network
│       ├── state/          Platform context (scenario, health, auth) and useResource
│       ├── lib/            Risk palette and banding, formatters
│       └── types/api.ts    Every response shape, mirroring the backend schemas
├── backend/
│   ├── app/
│   │   ├── main.py         App assembly, CORS, request logging, error shapes
│   │   ├── config.py       Environment settings with working defaults
│   │   ├── models.py       The 10 SQLAlchemy tables
│   │   ├── schemas.py      Pydantic request and response models
│   │   ├── security.py     PBKDF2 password hashing, HS256 tokens, role gates
│   │   ├── seed.py         Regions, terrain, inventory, demo accounts
│   │   ├── routers/        12 routers, 35 endpoints
│   │   └── services/       Risk engine, weather, terrain, forecast, alerts,
│   │                       what-if, scenarios, sensors, reports, image screening
│   ├── tests/              Calibration tests for the photograph screening
│   ├── requirements.txt    Runtime dependencies — nine packages, no ML stack
│   ├── requirements-ml.txt Optional: pandas, scikit-learn, XGBoost, SHAP
│   ├── requirements-lock.txt  Exact verified versions, for reproducibility
│   └── requirements-postgres.txt  Optional: the psycopg driver
├── ml/
│   ├── features.py         The feature contract: names, order, units, bounds, bands
│   ├── physics.py          The documented slope-stability model
│   ├── hydrology.py        Rainfall, soil water balance, temperature
│   ├── data/               Dataset generator, region reference table, training CSV
│   ├── preprocess.py       The one place raw inputs become a model matrix
│   ├── train_model.py      Training, evaluation, calibration, the model card
│   ├── fallback_gbm.py     NumPy-only gradient boosting
│   ├── explain.py          SHAP / pred_contribs / tree-path / physics explanations
│   ├── predict.py          Serving, confidence, and the smoke test
│   ├── model.pkl           The trained ensemble
│   └── model_card.json     Metrics, provenance, limitations
├── database/schema.sql     PostgreSQL + PostGIS schema with geography columns
├── docs/                   Architecture, database, API, ML, demo, scalability
└── docker-compose.yml      PostGIS + API + nginx frontend
```

## Documentation

| Document | What is in it |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The architecture diagram, what each layer owns, and the life of one scoring request |
| [`docs/DATABASE.md`](docs/DATABASE.md) | The ER diagram and a column-by-column reference for all 10 tables |
| [`docs/API.md`](docs/API.md) | All 35 endpoints with parameters, responses, status codes and `curl` examples |
| [`docs/ML.md`](docs/ML.md) | The 16 features, the physical model behind the labels, training, calibration, the label-noise ceiling, and how explanations are computed |
| [`docs/DEMO.md`](docs/DEMO.md) | The three-minute demonstration script, step by step |
| [`docs/SCALABILITY.md`](docs/SCALABILITY.md) | Replacing every demo source with a real one, and what it takes to run this for a state |

## Verifying the build

```bash
python -m compileall -q backend/app ml            # every module parses
python ml/predict.py                              # the served model, end to end
pytest backend/tests/test_image_analysis.py       # photograph screening calibration
cd frontend && npm run typecheck                  # tsc --noEmit, strict
cd frontend && npm run build                      # typecheck plus production bundle
```

## Before this is deployed anywhere reachable

This build is configured for a demonstration on a laptop, and several of those
choices are wrong for a public deployment. Stated plainly rather than buried:

The demo accounts have published passwords — set `SEED_DEMO_USERS=false`. The
`JWT_SECRET` default is published in this repository, and the server logs a warning
on every start-up until it is changed. `POST /api/citizen-report` and `POST
/api/image-analysis` accept anonymous callers by design, and so do `POST
/api/simulation`, `POST /api/simulation/reset` and `POST /api/alerts/sweep` — the
scenario controls have to work for a reviewer who has not signed in. On a public
host, those five need either authentication or a rate limit in front of them, since
each one is a way to make the server do work. There is no rate limiting, no request
size limit beyond `MAX_UPLOAD_MB`, and no antivirus scanning of uploaded
photographs; uploads are served back as static files from `/uploads`, so the
directory should not be writable by anything else. Tokens are HS256 and stateless,
so there is no revocation list — shortening `JWT_EXPIRY_MINUTES` is the only lever.
Everything should sit behind TLS, which nothing in this repository provides.

## Troubleshooting

**The dashboard says the backend is offline.** The frontend calls `/api` on its own
origin and Vite proxies that to `127.0.0.1:8000`. Check the API terminal, then
<http://localhost:8000/api/health>. If the API is on another port, set
`VITE_API_TARGET` before `npm run dev`.

**Every screen says `physics-fallback`.** `model.pkl` was not found or was rejected
for a feature-contract mismatch. Run `python ml/train_model.py`. The platform keeps
working in the meantime — scores come from the documented physical model — but the
model card, the SHAP explanations and the measured confidence are unavailable, and
the UI says so rather than hiding it.

**`pip install xgboost` fails.** Nothing to do. The trainer falls back to the NumPy
implementation and prints which backend it used; `shap` is optional in the same way,
and explanations fall back to exact tree-path attribution.

**Weather shows DEMO even with `USE_LIVE_WEATHER=true`.** Hover the badge: the
reason the live fetch failed is on it. Usually no outbound network, a proxy, or a
timeout shorter than the provider's response.

**`database is locked` on SQLite.** Two processes are writing the same file. Run one
API at a time, or move to the Docker stack.

**Port 8000 or 5173 already in use.** `uvicorn app.main:app --port 8001` and
`VITE_API_TARGET=http://127.0.0.1:8001 npm run dev`.

**A fresh clone shows no regions.** Seeding failed. The API stays up on purpose so
it can tell you why: check the start-up log and `/api/health`, which reports the
row counts it can see.

## What this is, honestly

Every figure on every screen is read from the running backend. Nothing in the UI is
hardcoded, no risk score is random, and every panel handles its own loading and
failure states. The scores are produced by a real gradient-boosted model over a
real feature pipeline, and they move for physical reasons.

They are also produced from modelled weather over approximate terrain, trained
against labels drawn from a documented physical model rather than from the observed
landslide record of India. That is stated in the API, in the model card, on the
administration screen and here. Replace the three demo sources — the GSI landslide
inventory for labels, IMD gridded rainfall for weather, a Cartosat or SRTM DEM for
terrain — and the rest of the platform does not change; `docs/SCALABILITY.md` is the
map for that work.

Until then: decision support for a demonstration. Not an operational warning
service, and no substitute for a qualified engineer standing on the slope.







