# The three-minute demonstration

Fourteen steps, roughly three minutes, ending on one line: **Predict. Explain.
Warn. Respond.**

The script below is written to be read while you drive. Each step says what to do,
what will appear, and — in italics — roughly what to say. Say it in your own words;
the timings assume you talk while things load rather than waiting in silence.

## Before you start

Five minutes of preparation buys you the whole three minutes.

1. Both servers running: `uvicorn app.main:app --port 8000` and `npm run dev`.
2. Open <http://localhost:8000/api/health> once. It should say `ready: true` with
   the model loaded. If it does not, fix that now, not on stage.
3. **Reset the scenario.** `POST /api/simulation/reset`, or the Reset button in the
   *Demonstration* panel on the dashboard. A demo that starts in EXTREME_RAINFALL
   has nowhere to go.
4. Sign in as `officer` / `officer123` in the browser you will present from, then
   navigate back to `/`. Signing in live costs twenty seconds and can fail.
5. Optional but worth it: open `/map`, `/forecast`, `/alerts` and `/history` once so
   Vite has compiled them and the tiles are cached.
6. Full screen, browser zoom at 100%, notifications off.

If the hall has no internet, nothing changes. There is no CDN, no external tile
requirement you cannot survive, no live API you depend on: the default weather mode
is DEMO, the database is a local SQLite file, and the model is committed to the
repository.

## The script

### 1 · Open on the command centre — 15s

Start at `/`. The national figure, the band distribution, the ranked worst regions
and the open alerts are all on screen at once.

*"This is Bhoomi-Drishti. 74 monitored regions across 20 states, every one of them
scored right now by a trained model. National risk here, the distribution across
five bands here, the worst regions ranked, and the live alert count. Nothing on
this screen is typed in — it is all computed from the database and the model."*

Point at the provenance badge in the header. This is the single most important
thing you say all demo:

*"And this badge says DEMO DATA. It will say SIMULATED in a moment. It would say
LIVE if this deployment had a weather key. We never let you mistake which one you
are looking at."*

### 2 · Select a region and read its score — 15s

Click the worst region in the ranked list. The row highlights and the dashboard
map flies to that region — the selection is shared, so every screen you open from
here is already looking at the same slope.

*"One region, one score out of 100, banded — very low, low, moderate, high,
critical. Beside it, the two columns that decide whether anyone acts: how many
people are exposed, and how many times this region has failed before."*

### 3 · Open the explanation — 20s

Go to `/map`. The region you just picked is already selected, and the rail on the
right is its full record.

*"Score, band, and a confidence figure that is measured rather than decorative: it
comes from how much the five models in the ensemble disagree about this specific
slope."*

Read the *Why this score* panel.

*"This is the part that matters for a district officer. Not 'the model says 64' but
why: soil moisture accounting for this much of the model's reasoning, antecedent
rainfall this much, slope this much. Percentages, adding up, in plain language —
and every one of them carries the observation behind it, so '41%' comes with '412
millimetres over seven days, three times the seasonal normal'."*

Point at *What is holding this slope up*, under the bars.

*"It also tells you what is keeping the score down. The forest cover here is the
reason this is not worse. A panel that only ever reports bad news is easy to stop
believing."*

### 4 · The overlays — 15s

Stay on `/map` and open the layer switch.

*"The same 74 scores, geographically — disc size is the score, colour is the band.
Eight overlays on top: alert radii, open alerts, past landslides, citizen reports,
the virtual instruments, population exposed, region names."*

Switch the basemap to Terrain, then toggle *Past landslides* on.

*"And that is contour and hillshade cartography drawn from SRTM elevation. It is
not a satellite pass and we do not call it one. What you are looking at now is past
failures on top of present risk — the overlap is the sanity check a geologist asks
for first."*

### 5 · The 72-hour forecast — 20s

Go to `/forecast` with the same region selected.

*"Now, +6, +12, +24, +48, +72 hours. Current risk, forecast risk, and the rainfall
driving it on the same axis. Peak risk is called out — that time is the answer to
the only question that matters operationally: when do we need to have moved
people?"*

### 6 · The what-if simulator — 25s

Same page, below the chart. Drag rainfall up.

*"Rainfall intensity and an absolute top-up, soil moisture, slope, vegetation,
distance to drainage, how often this ground has failed before — and a lead time, so
you can ask the question against the forecast weather forty-eight hours out rather
than today's. Move any of them and the score is recomputed — through the same model,
not a formula in the browser. Watch the band change, and watch the explanation
re-rank as soil moisture takes over from slope."*

*"This is what a district officer does the evening before a forecast wet spell:
'the forecast says 200 millimetres — what does that do to us?'"*

### 7 · The big red button — 20s

Press **SIMULATE EXTREME RAINFALL** in the *Demonstration* panel — it is on the
right of this page, and of the dashboard, map, alerts and sensors screens, so you
never have to navigate to find it. Stay put while it completes.

*"One press. Rainfall raised across all 74 regions, every region re-scored through
the model, the map redrawn, the charts updated, alerts raised for everything that
crossed the threshold, the regions that changed band highlighted, and the
recommended response printed for the worst band reached."*

Point at the badge in the header again, now reading SIMULATED DATA.

*"And the badge changed. Every number downstream of this is labelled SIMULATED —
in the API responses, in the database rows, and on screen. This is a simulation of
plausible extreme rainfall. It is not a forecast, and we never let it look like
one."*

### 8 · The map under stress — 10s

`/map`, without touching anything else.

*"Same map, thirty seconds later. The Ghats and the Himalayan foothills have gone
red. Nothing was painted on — the rainfall moved, so soil moisture moved through the
water balance, so the features moved, so the model's answer moved."*

### 9 · The alerts it raised — 20s

Go to `/alerts`.

*"These alerts did not exist ninety seconds ago. Each one has an ID, a location, a
score, a severity, the time it was created, the cause in plain language, and a
recommended action. High alert above 60, critical above 80 — and below 60 the system
deliberately says nothing, because an early-warning platform that cries wolf gets
switched off."*

### 10 · Work an alert — 20s

You are signed in as an officer. Acknowledge the top alert, assign it, add a note.

*"Acknowledge. Assign. Note. Resolve. New, acknowledged, in progress, resolved —
with the illegal transitions actually refused, not just hidden. Every note is
stamped with who wrote it and when. This is the difference between a dashboard and
an operational tool: somebody is accountable for each of these."*

### 11 · A citizen report — 20s

Go to `/report`. Fill it quickly — location, type, severity, description — and
optionally attach a photo. Submit.

*"Anybody can file this. No login, because requiring an account before somebody can
warn you about a crack in a road is a way of not being told. Location, what they
saw, how bad it looks, a photo."*

If you attached a photo:

*"The image is screened automatically — measured edge density, gradient
orientation, texture — and it says out loud that it is deterministic measurement and
not a trained network, with a confidence and the runner-up categories. And the
disclaimer travels with the result: this is decision support, and it does not
replace a qualified geotechnical assessment."*

### 12 · It arrives on the officer desk — 15s

Go to `/officer`.

*"And there it is, in the officer's queue, with the map location and the photo.
Under review, verified, dismissed — a person decides. Nothing here is
auto-verified."*

### 13 · The virtual instruments and the archive — 20s

Go to `/sensors`.

*"Five instrument types per region — soil moisture, rain gauge, tilt, vibration,
pore pressure — and this is entirely software. There is no hardware anywhere in
this project. Every reading is labelled SIMULATED, every one carries the real
instrument it stands in for, and the readings feed the same risk engine, so the
architecture is ready the day a real telemetry feed arrives."*

Then `/history`.

*"And the historical inventory: filter by state, district, year and severity, and
every chart re-cuts to the filter — events per year stacked by severity, rainfall
against landslides, the seasonal pattern, the severity split, and the places the
record keeps returning to. That last one is history, not a forecast, and it is
titled that way on purpose. It is also where the historical count the model uses as
a feature comes from."*

### 14 · Reset, and close — 15s

Return to `/` and press **Reset** in the *Demonstration* panel. Let the badge in
the header return to DEMO DATA and the national figure settle back down.

*"Reset — back to normal conditions, everything re-scored."*

Then close:

*"So: a trained gradient-boosted model, 24 000 samples, evaluated on regions it
never saw, reaching 98% of the discriminative ceiling that noisy labels allow.
Explanations that are additive, so the percentages are real. A warning engine with
a workflow behind it. A citizen channel that reaches an officer's desk. All
software — it runs on this laptop, with no hardware, no cloud account and no
internet."*

*"Predict. Explain. Warn. Respond."*

## Timing

| Steps | What | Budget |
| --- | --- | --- |
| 1–3 | Command centre, a score, the explanation | 50s |
| 4–6 | Map, 72-hour forecast, what-if | 60s |
| 7–10 | Extreme rainfall, the map under stress, alerts, workflow | 70s |
| 11–14 | Citizen report, officer desk, sensors and archive, reset and close | 70s |

That totals four minutes six seconds read at a comfortable pace, which is the
point: **you will not get through all fourteen steps in three minutes, and you
should not try.** Three minutes buys you about ten of them. Decide in advance which
four you will drop and drop them cleanly rather than rushing everything.

## If you only have ninety seconds

Steps 1, 3, 7, 8, 9. National picture, the explanation, the big button, the map
turning red, the alerts that appeared. That is the whole argument —
predict, explain, warn — and it is the sequence that survives compression best.

## If you have five minutes

Add the full alert workflow (step 10), the citizen report round trip (11–12), and
`/admin`: the model card, the metrics, the limitations printed above the numbers,
and the deployment's provenance. Technical judges tend to ask for exactly that
screen, and it is better to open it deliberately than to be taken there by a
question.

## What to drop first

In order: the archive half of step 13, then the sensors half, then step 4 (the map
reappears in step 8 anyway), then step 5. Keep the explanation and keep the big
button — those two are the demo.

## Questions you should expect

**"Is this real data?"** No, and the platform says so on every screen. Terrain
values are approximate public figures, weather is a modelled hourly series unless a
key is configured, and the training labels are drawn from a documented physical
model. `/admin` and `GET /api/model-info` state the provenance in full.

**"So the predictions are random?"** No. They come from a gradient-boosted ensemble
trained on 24 000 samples, evaluated on regions held out of training entirely.
There is no `random()` anywhere in the prediction path — the demo scenarios are
deterministic multipliers, and the weather series is a pure function of its seed, so
the same region shows the same number on every reload.

**"How do you know 0.83 AUC is good?"** Because the ceiling is measurable. The
labels are Bernoulli draws, so even the true generating probability only scores
0.8397 against them. The model reaches 0.8254 — 98.3% of what is achievable — and
its output correlates with the true probability at 0.95. `docs/ML.md` has the
working.

**"What would it take to make this real?"** Three data swaps and a recalibration:
the GSI landslide inventory for labels, IMD gridded rainfall for weather, a
DEM plus a land-cover product for terrain. The feature contract does not change, so
nothing downstream of `ml/preprocess.py` changes either. `docs/SCALABILITY.md` is
the detail.

**"Where is the hardware?"** There is none. Every instrument in `/sensors` is
software, labelled SIMULATED, and documented as standing in for a named real
instrument. The point of building it that way is that the ingestion path already
exists for the day real telemetry arrives.

**"Can it run offline?"** Yes — that is how it is designed. SQLite by default, the
model committed to the repository, DEMO weather mode when no key is present, and no
build-time CDN dependency.

## If something breaks on stage

**A screen is empty or spinning.** Every page has a real error state; read what it
says. Nine times out of ten the API restarted — reload once.

**The scenario is stuck.** Press Reset. If the header badge disagrees with the
page, reload: the frontend refetches on the scenario version, and a reload
resynchronises it.

**Nothing scored, everything reads VERY LOW.** Check
<http://localhost:8000/api/health>. If `model` is not loaded you are on the physics
fallback — say so plainly, because the platform is already saying so, then continue.
It is a better moment than it sounds: the system degrading honestly instead of
faking a number is the thing the whole design is built around.

**The map has no tiles.** No internet. Carry on — the discs, the overlays and every
score render without a basemap, and the point of the map is the data on it.

## Reading further

| Document | What it covers |
| --- | --- |
| [`../README.md`](../README.md) | Install, run, and what the system is |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How a request becomes a risk score |
| [`DATABASE.md`](DATABASE.md) | All ten tables, column by column |
| [`API.md`](API.md) | All 35 endpoints with parameters and examples |
| [`ML.md`](ML.md) | The features, the model, and the explanations |
| [`SCALABILITY.md`](SCALABILITY.md) | Replacing demo sources with real ones |
