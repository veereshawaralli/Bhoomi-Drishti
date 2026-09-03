# The model

How a slope becomes a number between 0 and 100, why that number is believable,
and exactly how far it should be trusted.

Read the last part first if you read nothing else: **the model is trained on
simulated data.** It learns a documented physical model of slope stability, not
the observed landslide record of India. Every metric on this page measures how
well it recovers that physical model from noisy samples of it. None of them is
evidence of real-world forecast skill, and nothing this system outputs should be
presented as an observed or verified forecast. That statement is not a footnote
added for safety — it is stored inside `model.pkl` itself, returned by
`GET /api/model-info`, and printed at the end of every training run.

## The problem, honestly stated

A landslide early-warning model needs three things: terrain, weather, and a
record of what failed and when. The first two are obtainable. The third is not
— there is no public, per-district, hourly landslide label set that can be
shipped inside a repository.

That leaves three options. Ship no model, and the project becomes a UI over
nothing. Ship a model trained on labels from `random()`, and every number it
produces is meaningless while looking exactly as convincing as a real one. Or
write down a physical hazard model explicitly, generate labels from it, train on
those, and be completely clear about what has been done.

This project takes the third route, and the seam is deliberately narrow: replace
`ml/data/generate_dataset.py` with a loader over a real inventory and nothing
downstream changes — not the feature contract, not the training script, not the
API, not the UI.

## The sixteen features

The contract lives in `ml/features.py` and is versioned (`1.0.0`). Column order
is part of it: tree models index features positionally, so a reordered column is
not an error, it is a wrong answer. Everything — dataset generation, training,
the API, the what-if simulator, the forecast — builds its matrix through
`ml/preprocess.py`, which is the only place raw inputs become model input.

| # | Feature | Unit | Range | Where it comes from |
| --- | --- | --- | --- | --- |
| 1 | `rainfall_1h` | mm | 0–200 | Weather service — the trigger burst |
| 2 | `rainfall_6h` | mm | 0–600 | Weather service |
| 3 | `rainfall_24h` | mm | 0–1200 | Weather service |
| 4 | `rainfall_72h` | mm | 0–2500 | Weather service — antecedent wetness |
| 5 | `rainfall_7d` | mm | 0–4000 | Weather service — antecedent wetness |
| 6 | `rainfall_anomaly` | ratio vs seasonal normal | 0–12 | 7-day total ÷ that week's normal |
| 7 | `elevation` | m | 0–8000 | Terrain table (DEM in production) |
| 8 | `slope` | degrees | 0–80 | Terrain table (DEM in production) |
| 9 | `soil_moisture` | % volumetric | 2–65 | Water-balance model or sensor feed |
| 10 | `temperature` | °C | −25–50 | Weather service |
| 11 | `humidity` | % | 5–100 | Weather service |
| 12 | `vegetation_index` | NDVI-like 0–1 | 0–1 | Terrain table (satellite in production) |
| 13 | `historical_landslide_count` | events on record | 0–200 | `landslide_events` inventory |
| 14 | `distance_to_river` | km | 0–60 | Terrain table |
| 15 | `soil_type` | ordinal code | 0–7 | Terrain table |
| 16 | `land_cover` | ordinal code | 0–7 | Terrain table |

Three rules are enforced in `preprocess.py` rather than scattered around the
codebase.

**Out-of-range values are clipped, never rejected.** The what-if simulator exists
so someone can ask "what if 500 mm fell", and a saturated answer is more useful
than a validation error. The bounds above are wide enough to contain real
extremes, so clipping only bites on deliberately absurd input.

**Nested rainfall windows stay nested.** A 6-hour total can never be less than
the 1-hour total inside it. Clipping columns independently can break that, and
the model has never seen an impossible row, so the five accumulation columns get
a running maximum applied after clipping.

**Categoricals are ordinal by physical instability, not alphabetical.** Soil runs
`ROCKY` (0), `GRAVEL`, `SANDY`, `ALLUVIAL`, `LOAM`, `LATERITE`, `SILT`, `CLAY`
(7) — competent rock through swelling clay. Land cover runs `SNOW_ICE` (0),
`FOREST`, `SCRUB`, `GRASSLAND`, `AGRICULTURE`, `PLANTATION`, `BUILT_UP`,
`BARREN` (7) — deep root cohesion through no reinforcement at all. Because the
codes are ordered, one tree split separates weak materials from strong ones and
no one-hot expansion is needed. Both encodings accept either the name
(`"LATERITE"`) or the code (`5`).

Missing features fall back to `SERVING_DEFAULTS` — a calm, unremarkable slope in
fair weather (no rain, `rainfall_anomaly` 1.0, 18% soil moisture, 20° slope, 800 m,
NDVI 0.55, loam under forest). Two things about that choice matter: the defaults
bias a prediction *downwards*, so a gap can never invent hazard that was never
observed; and the API returns `defaulted_fields`, so the gap is never silent.
Confidence drops for each one.

## The physical model behind the labels

`ml/physics.py` is the honest centre of this project. It is a slope-stability-
inspired hazard model written down as an explicit formula, with every coefficient
visible and every coefficient labelled a modelling assumption rather than a
measured constant.

```
predisposition        S  =  f(slope) · soil · land cover · vegetation
                              · elevation · proximity to river · history
hydrological loading  H  =  weighted rainfall windows + soil wetness + anomaly

log-odds              z  =  −5.27 + 1.30·S + 2.30·H^0.75 + 2.50·S·H^0.75
                                 + 0.30·humidity + 0.25·freeze-thaw
probability           p  =  sigmoid(z)
hazard index             =  100 · p
```

**The interaction term is the physics that matters.** 200 mm of rain on a flat
forested valley floor is a flood; the same rain on a 40° laterite cut slope is a
landslide. A model with only additive rainfall and slope terms cannot express
that difference, which is why `S·H` carries the largest coefficient in the whole
formula.

**Water enters concavely.** `H^0.75` rather than `H`: once a profile is near
saturation, extra millimetres add progressively less driving force, and any
failure has usually already happened. The first 100 mm on a dry slope changes far
more than the tenth 100 mm on a saturated one.

**Susceptibility follows a regolith-retention curve.** Instability rises steeply
from about 8°, then *eases off* above roughly 52°, because very steep faces have
already shed the soil that fails. A monotone slope term would predict the worst
hazard on cliffs, which is not what the record shows.

**Loading weights favour the slow terms.** Soil wetness carries 0.30, the 24-hour
total 0.26, the 72-hour total 0.24 — and the 1-hour burst only 0.10. That matches
the landslide literature, where antecedent wetness is the dominant control and
the burst is the trigger rather than the cause. It also keeps the hazard index a
smooth function of time instead of flickering with every rain-gauge tick.

The denominators that normalise each rainfall window — 70 mm for 1 h, 320 mm for
24 h, 600 mm for 72 h, 1000 mm for 7 d — are set from published Indian
rainfall-threshold studies of the order of 200–300 mm/24 h for triggering in the
Ghats and Himalayan foothills. They are the first thing to recalibrate against a
real regional inventory.

Two smaller terms only fire where they should: a humidity term above 60%, and a
freeze-thaw term that is a Gaussian around 2 °C multiplied by an elevation ramp
starting at 2500 m, so it contributes nothing at all on a warm coastal slope.

This module is also the resilience floor. With no `model.pkl` present the API
serves scores straight from `hazard_score()` and labels them
`model_backend = "physics-fallback"`, so a missing model file degrades the answer
instead of faking one.

## The training data

`ml/data/generate_dataset.py` builds `ml/data/training_data.csv` — 24 000 rows,
one header line, deterministic from seed `20260902`.

Each row is a real point in a simulated fortnight, not an independent draw of
sixteen numbers. For each of 3000 series it picks one of the 74 regions, jitters
its terrain, picks a start day weighted by that region's own monsoon curve, picks
a rainfall intensity regime, and then runs `ml/hydrology.py` forward for 336
hours: an hourly Markov-gamma rainfall process with storm persistence and a
multi-day active/break envelope, a single-layer soil-water balance where
infiltration falls off as the profile saturates, air temperature with annual,
diurnal and lapse-rate components, and humidity driven by recent rain. Eight
samples are then taken at hours 168 through 330, so a full 7-day window is always
available behind each one.

Two properties come out of doing it this way rather than with independent draws.
Accumulations are summed from one series, so `r1h ≤ r6h ≤ r24h ≤ r72h ≤ r7d`
holds by construction — exactly as it will at inference time. And soil moisture
is the integral of infiltration minus drainage and evapotranspiration, so the
antecedent-rainfall signal the model learns is a genuine physical signal: the
third day of a wet spell is distinguishable from an equally heavy isolated storm.

Sampling is deliberately skewed in two ways, both to serve the part of the curve
the platform is judged on. Start days are weighted by seasonal activity with an
additive floor, because uniform calendar sampling would spend most of the set on
dry-season rows where nothing can happen. And the heavy rainfall buckets are
over-sampled relative to how often such weather actually occurs — 36% of series
draw a multiplier above 3× the seasonal normal — because the what-if simulator
and the extreme-rainfall demo operate there, and the model must not be
extrapolating when they do.

Labels are then `y ~ Bernoulli(p)` with `p` from `physics.py`, plus 0.5% two-way
observation noise. The resulting positive rate is 11.5% in train, 9.9% in
validation, 10.4% in test.

Sampling the labels rather than thresholding them is the point. A model trained
on `p > 0.5` would be inverting a formula; a model trained on noisy draws has to
generalise, which is the job it would do on a real inventory — and it is what
makes the attributions in the explanation panel informative rather than circular.
The CSV keeps `hazard_probability_true` alongside the sampled label, which is
what makes the noise ceiling below measurable.

## Training

```bash
python ml/train_model.py                  # 24 000 rows, best available backend
python ml/train_model.py --rows 60000     # regenerate a larger set
python ml/train_model.py --backend numpy  # force the dependency-free one
python ml/train_model.py --regenerate     # rebuild the CSV even if present
```

It writes two files: `ml/model.pkl`, holding the ensemble plus everything needed
to serve and audit it, and `ml/model_card.json`, the same metadata minus the trees
in readable form. `GET /api/model-info` returns the card.

**Three backends, one code path.** XGBoost is preferred, scikit-learn's
`HistGradientBoostingClassifier` is next, and `ml/fallback_gbm.NumpyGBM` — the
same second-order Newton boosting on histogram-binned features, NumPy only — is
last. All three are fitted, scored and explained by identical code.

That last one is not defensive over-engineering. This project has to train and
serve a real model on a judge's laptop, and `pip install xgboost` is the single
most likely step to fail there: no wheel for the platform, no compiler, a
corporate proxy, an offline hall. The fallback implements the same objective and
the same split criterion as XGBoost —

```
per node    G = Σ gᵢ,  H = Σ hᵢ            (logloss gradient and hessian)
leaf value  w* = −G / (H + λ)
split gain  = G_L²/(H_L+λ) + G_R²/(H_R+λ) − G²/(H+λ)
```

— on quantile-binned features (64 bins, quantiles rather than equal width because
rainfall is heavily skewed and equal-width bins can only ever split "some rain"
from "a cloudburst"). **The committed `model.pkl` was trained by this NumPy
backend**, so what ships in this repository is what a laptop with no ML stack
would produce. The card names the backend, so nobody has to guess.

This is why `backend/requirements.txt` does not install scikit-learn, XGBoost,
SHAP or even pandas: serving the model needs none of them, and every package left
out of the runtime install is a package that cannot fail on somebody's machine
half an hour before a demonstration. They live in `requirements-ml.txt`, which is
needed only to regenerate the dataset or retrain.

Hyperparameters are shared across backends so the comparison is like-for-like:
300 trees, learning rate 0.09, max depth 4, `min_child_weight` 12,
`reg_lambda` 2.0, `subsample` 0.85, `colsample_bytree` 0.9. Depth is modest and
`min_child_weight` high because grouped validation showed deeper trees memorising
individual regions without improving unseen-region AUC.

**Five members, bootstrap-resampled.** This is real bagging, and for backends
without row subsampling of their own it is the only source of member diversity —
without it the "ensemble" would be five identical models and the confidence
derived from their disagreement would be meaningless.

**The split is grouped by region, not random.** Rows from one region share terrain
and often share a weather series, so a random split would put near-duplicates on
both sides of the line and report a score the model has not earned. Splitting on
`region_code` measures the thing that actually matters: does this generalise to a
slope it has never seen? Of 74 regions, 52 are in train, 11 in validation, 11 in
test — 16 880 / 3560 / 3560 rows.

**Metrics are implemented in NumPy, not imported.** ROC AUC (tie-corrected
Mann-Whitney), average precision, Brier, log-loss and the calibration table are
all written out in `train_model.py`, because the whole point of the fallback
backend is that the pipeline still runs and still reports honest numbers when
scikit-learn is not installed.

Training the committed model took 20.79 seconds.

## How it scored

Every figure below is from `ml/model_card.json` as committed, so it can be checked
against the file rather than taken on trust.

| | Train | Validation | Test |
| --- | --- | --- | --- |
| Rows | 16 880 | 3 560 | 3 560 |
| Regions | 52 | 11 | 11 |
| Positive rate | 0.1149 | 0.0986 | 0.1037 |
| ROC AUC | 0.9144 | 0.7836 | **0.8254** |
| PR AUC | 0.6666 | 0.4171 | **0.5245** |
| Brier | 0.0624 | 0.0724 | 0.0681 |
| Log-loss | 0.2144 | 0.2630 | 0.2474 |
| Calibration error (ECE) | 0.0263 | 0.0107 | **0.0093** |
| Mean predicted | 0.1126 | 0.0933 | 0.0944 |

Read the test column, not the train column: those are eleven regions that were
never in any training bootstrap.

PR AUC matters more than ROC AUC here. Only about 10% of rows are positive, and
the job is ranking the rare events — a metric that rewards correctly calling the
9000 quiet rows quiet is measuring the easy part.

The validation-test gap (0.78 vs 0.83) is not tuning gone wrong. It is eleven
regions against eleven other regions: with grouped splits this small, which
particular slopes land in which bucket moves the number by several points. It is
reported as measured rather than smoothed.

### The number to actually look at

An ROC AUC of 0.8254 is meaningless without knowing what is achievable. The labels
are Bernoulli draws, so **even the generating probability itself cannot score a
perfect AUC against them.** Because the CSV keeps `hazard_probability_true`, that
ceiling is measurable:

| | |
| --- | --- |
| ROC AUC of the true probability vs the sampled labels | **0.8397** |
| ROC AUC of the model | 0.8254 |
| Fraction of the achievable ceiling reached | **0.983** |
| Correlation of model output with the true probability | **0.9522** |

So the model recovers 98.3% of the discriminative power that exists in this data,
and its output tracks the generating probability at *r* = 0.95. That is the honest
way to say whether 0.83 is a good number or a poor one — and it is why the answer
is "close to the limit", not "mediocre".

### Calibration

AUC only says the ordering is right. Calibration says a score of 70 really does
correspond to roughly a 70% chance in the modelled world — which is the property
that makes a 0–100 risk score meaningful at all rather than merely rankable.

The card stores a ten-decile table of predicted versus observed frequency for
each split. On the test split the expected calibration error is **0.0093**, i.e.
under one percentage point of average disagreement between what the model
predicted and what was observed. Mean predicted probability is 0.0944 against an
observed positive rate of 0.1037, so it is very slightly under-confident overall
— which is the safer direction for an early-warning system to err, though not so
far that it matters.

### Does it use the whole scale?

A model that never leaves one band would demo badly and warn worse, so the card
records where predictions actually land across the five specified bands, on the
held-out split:

| Band | Share of test rows |
| --- | --- |
| VERY LOW (0–20) | 88.57% |
| LOW (21–40) | 5.90% |
| MODERATE (41–60) | 3.20% |
| HIGH (61–80) | 1.74% |
| CRITICAL (81–100) | 0.59% |

Score range 0.24 to **92.96**, median 4.57, 95th percentile 42.91.

The heavy concentration at the bottom is correct rather than a defect: most hours
on most slopes are not dangerous, and a model that spread its mass evenly across
five bands would be crying wolf 20% of the time. What matters is that CRITICAL is
reachable and reached — a top score of 92.96 on unseen regions, which is why the
extreme-rainfall demo produces a genuine CRITICAL rather than a staged one.

### What it learned to use

Split-gain importance, averaged over the five members, from the card:

| Feature | Share | Driver group |
| --- | --- | --- |
| `soil_moisture` | 9.65% | Soil moisture |
| `slope` | 9.12% | Slope steepness |
| `distance_to_river` | 9.06% | Terrain relief |
| `rainfall_anomaly` | 8.78% | Antecedent rainfall |
| `rainfall_7d` | 8.35% | Antecedent rainfall |
| `rainfall_72h` | 7.18% | Antecedent rainfall |
| `elevation` | 6.99% | Terrain relief |
| `temperature` | 6.71% | Weather conditions |
| `humidity` | 6.34% | Weather conditions |
| `vegetation_index` | 6.32% | Soil and land cover |
| `rainfall_24h` | 5.92% | Heavy rainfall |
| `rainfall_6h` | 4.35% | Heavy rainfall |
| `historical_landslide_count` | 4.34% | Historical activity |
| `land_cover` | 3.46% | Soil and land cover |
| `rainfall_1h` | 2.31% | Heavy rainfall |
| `soil_type` | 1.14% | Soil and land cover |

Soil moisture and slope on top, the antecedent windows (anomaly, 7 d, 72 h)
together at 24.3%, and the 1-hour burst last at 2.31%. That is the ordering
`physics.py` was written with, rediscovered from noisy binary labels — which is a
useful sanity check that the pipeline is wired up correctly, because a bug in
`preprocess.py` column ordering would show up here as nonsense.

Importances are flatter than they would be on real data because the terrain
jitter gives every terrain feature genuine variance to exploit. `soil_type` looks
weak at 1.14% mostly because it is an 8-level ordinal that correlates with land
cover and vegetation, so gain gets shared between them.

Where a backend exposes no native importances — scikit-learn's
`HistGradientBoostingClassifier` does not — the script falls back to permutation
importance, measured as AUC lost when one column is shuffled, and the card records
`importance_method` so the two are never confused. The committed card says
`split-gain`.

## Serving

`ml/predict.py` is the only path between a feature dictionary and a risk score.
The API, the what-if simulator, the 72-hour forecast and the scenario engine all
go through it, so a score of 64 means the same thing everywhere in the platform.

It makes three promises.

**It never invents a number.** With `model.pkl` present, scores come from the
trained ensemble. Without it, from `ml/physics.py`, and the response says
`model_backend = "physics-fallback"`. There is no third branch returning a
plausible-looking random value.

**It refuses a mismatched model.** If a `model.pkl` was trained against a
different feature contract, loading is rejected and the reason logged — a model
reading `slope` out of the `humidity` column would still return
confident-looking numbers. A corrupt or half-written pickle is caught the same
way and falls through to the physics model rather than failing the request.

**Confidence is measured, not asserted.** Three inputs, no fudge factor:

- a *ceiling* of 97 with a trained model and 78 with the physics fallback,
  because a fixed set of modelling assumptions deserves less credit than a fitted
  one;
- *agreement* — how far the five bagged members diverge on this specific row,
  relative to the 90th-percentile divergence they showed on held-out regions at
  training time (0.6675 in log-odds, recorded in the card; median 0.429, max
  1.3046), floored at 0.62;
- *completeness* — each feature that was missing and had to be defaulted costs
  4.5%, floored at 0.55, so a sparse input can never be reported as a certain one.

Disagreement is measured in log-odds rather than probability on purpose.
Probability spread shrinks automatically near 0 and 1: two members at 0.001 and
0.02 differ by a factor of twenty but only 0.019 in probability. Compared against
a reference dominated by low-risk rows, that would report false certainty on
exactly the rows an officer cares about.

The score itself is simply `100 × mean member probability`, rounded to one
decimal, banded by `risk_level()`. There is no post-hoc rescaling, no curve fitted
to make the demo look better; the calibration numbers above are what make that
defensible.

`predict_batch` skips explanations deliberately — the map needs 70-plus scores
quickly, and the panel only ever explains the one region an officer selected.

## Explanations

The brief calls explainable AI a critical feature, and the panel it feeds has to
make sense to someone who has never heard of gradient boosting. Two requirements
follow. The numbers must be genuinely **additive**, so "these drivers account for
the score" is literally true rather than a figure of speech. And they must survive
whichever backend trained the model — including the case where there is no trained
model at all.

`ml/explain.py` therefore tries four strategies in order, and **the one that
actually ran is always reported back and shown in the UI**:

| Order | Method | What it is | When it runs |
| --- | --- | --- | --- |
| 1 | `shap` | `shap.TreeExplainer` — exact Shapley values | `shap` installed and it understands the estimator |
| 2 | `xgboost-treeshap` | XGBoost's built-in `pred_contribs` | XGBoost model, no `shap` package |
| 3 | `tree-path` | Saabas path attribution, pure NumPy | The bundled NumPy model — what ships here |
| 4 | `physics` | `physics_contributions` | No model loaded at all |

Path attribution works because every node of every tree stores the prediction it
*would* make if the tree stopped there. Walking root to leaf, each step is caused
by exactly one feature, so the change in node value it produces is charged to that
feature — and the parts sum exactly to (leaf value − root value). Summed over 300
trees and averaged over 5 members, `contributions.sum() + baseline` is exactly the
model's log-odds for that row. It is a weaker attribution than Shapley values,
which consider every ordering of features rather than the one the tree happened to
take, but it is exact rather than approximate about additivity, and it costs one
tree traversal instead of an exponential sum.

The fourth strategy exists so the panel degrades to a documented physical
breakdown rather than going blank. It moves each feature from a calm-day baseline
to its actual value one at a time, then redistributes the interaction residual in
proportion to those single-feature effects — so the parts still sum to the whole,
which is the property that makes the bars readable.

### The reference point

Contributions are meaningless without saying what they are measured *against*, and
the two families of method use different references, so the response says which:
the tree methods report against the average location in the training set; the
physics method against **this same location in calm, dry conditions** — no rain,
2 mm over 72 h, 12% soil moisture, 55% humidity.

The second framing is the one an officer actually asks for. "Why is this region
elevated *now*" is a question about this slope today versus this slope on a quiet
day, not about this slope versus an average slope somewhere else in the country.

### From sixteen features to eight readable drivers

Nobody wants to read `rainfall_72h: +0.41 log-odds`. The sixteen features collapse
into eight driver groups — Heavy rainfall, Antecedent rainfall, Soil moisture,
Slope steepness, Historical activity, Soil and land cover, Terrain relief, Weather
conditions — and each group gets a share:

```
share = |group total| / Σ|all group totals| × 100
```

Shares are taken over the **total movement in both directions**, not just the
upward push. That is a deliberate choice: sharing only the upward push out of 100
would make a single small protective factor read as "100% of what is holding this
slope stable". Because the denominator is the same for both directions, a bar
means the same thing wherever it appears.

Groups within ±2% of total movement are marked `neutral` rather than being forced
into a direction they do not have.

**Protective factors are reported separately, not netted off.** "The forest cover
here is the reason this is not worse" is useful information, and hiding it inside a
net figure would make the panel look like it only ever finds bad news.

### Evidence, not just numbers

A bar labelled 34% means nothing to a district officer without the observation
behind it, so every group carries one plain-language line of evidence built from
the actual feature values — "412 mm over 7 days, 3.1× the seasonal normal", "43%
water by volume — very wet", "33 degree slope", "laterite soil under plantation
cover, vegetation index 0.62".

And one sentence leads the panel, with the choice of which half of the story to
tell depending on which half is larger. On a dangerous day: *"Risk is HIGH mainly
because of soil moisture (52%), antecedent rainfall (21%) and slope steepness
(11%)."* On a calm day the honest sentence is not a list of the three weak things
nudging risk upwards, it is *"Risk is VERY LOW: soil moisture and antecedent
rainfall are keeping this slope stable."*

Every explanation carries the same disclaimer, and it travels with the payload
rather than living in the UI: explanations describe why the model produced this
score; they are decision support and do not replace assessment by a qualified
geotechnical engineer.

## Does it behave sensibly?

Metrics are aggregate. The quickest check that the served model responds to weather
the way it should is to run it on one fixed slope under four weather regimes:

```bash
python ml/predict.py
```

```
loaded bhoomi-drishti-landslide-hazard (numpy backend, 5 members) from ml/model.pkl
backend: numpy   loaded: True

scenario            score  level       conf   top driver
----------------------------------------------------------------------------------
dry season            1.9  VERY LOW     83%   Historical activity (6%)
normal monsoon       30.4  LOW          88%   Soil moisture (41%)
heavy rainfall       79.2  HIGH         89%   Soil moisture (52%)
extreme rainfall     86.1  CRITICAL     91%   Soil moisture (53%)

DEMO DATA - simulated conditions on a Wayanad-like slope, not a live forecast.
```

The slope is fixed throughout — 33°, 900 m, laterite under plantation, NDVI 0.62,
1.2 km to a river, 24 landslides on record, roughly a Wayanad profile. Only the
weather changes.

Four things are worth noticing. The whole scale gets used, 1.9 to 86.1, on one
slope. The response is non-linear: normal to heavy monsoon moves the score 49
points, heavy to extreme only 7 more, because the profile is already near
saturation — the concave loading term doing its job. On the dry-season row the top
driver is *historical activity at 6%*, which is the model correctly saying nothing
much is driving this; soil moisture only takes over once there is water to talk
about. And confidence rises with severity, from 83% to 91%, because the five
members agree more readily on an unambiguous case than on a marginal one.

This is a smoke test, not evidence of skill. It confirms the served model responds
to weather monotonically and plausibly; it says nothing about whether those numbers
match reality, because the ground truth here is `physics.py`.

## Limitations

Stored in `model.pkl`, returned by `GET /api/model-info`, and shown in the UI:

- Trained on simulated data, so it reproduces a physical model rather than the
  observed landslide record.
- Hourly resolution and regional terrain averages — it cannot resolve an individual
  slope or a specific building.
- No earthquake, reservoir drawdown, blasting or excavation triggers are
  represented.
- Rainfall beyond the training range is clipped at the documented bounds, so
  extreme what-if answers saturate rather than extrapolate.
- Decision support only: it does not replace inspection by a qualified geotechnical
  engineer.

Two more worth stating plainly. The 74 regions are point locations with
representative terrain, not polygons, so "Wayanad is HIGH" means the modelled
Wayanad profile is HIGH — not that every slope in the district is. And the
scenario simulator multiplies rainfall to produce a *plausible* extreme, not a
forecast of one; anything it produces is labelled `SIMULATED` end to end.

## Replacing the synthetic data

The whole point of the feature contract is that the model can be retrained on real
data without touching anything downstream. In order of value:

**Labels — replace `ml/data/generate_dataset.py`.** The GSI National Landslide
Susceptibility Mapping inventory is the reference source for India. Join it to
gridded rainfall and a DEM, emit a frame with the sixteen feature columns plus
`landslide_occurred` and `region_code`, and `train_model.py` runs unchanged. Expect
the honest metrics to drop, and expect the label set to be severely imbalanced and
spatially clustered — real inventories are.

**Weather — IMD gridded rainfall** for history, a forecast API for the forward
window. `ml/hydrology.py` stops being a generator and becomes only the DEMO-mode
fallback.

**Terrain — Bhuvan, SRTM or Cartosat DEM** for elevation, slope, aspect and
curvature; a land-cover product and satellite NDVI for the rest. This replaces the
approximate values in the terrain table with measured ones.

**Then recalibrate `physics.py`,** or retire it. Its coefficients are assumptions;
the rainfall-window denominators in `hydrological_loading` are the first thing to
fit per region against a real inventory, since triggering thresholds in the Western
Ghats are not the thresholds in Sikkim. Once real labels exist, `physics.py` keeps
its value as the fallback and as the fourth explanation strategy, but it stops
being the source of truth.

`docs/SCALABILITY.md` covers the engineering side of all of this — where the seams
are and what running it for a whole state actually costs.

## Reading further

| Document | What it covers |
| --- | --- |
| [`../README.md`](../README.md) | Install, run, and what the system is |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How a request becomes a risk score |
| [`DATABASE.md`](DATABASE.md) | All ten tables, column by column |
| [`API.md`](API.md) | All 35 endpoints with parameters and examples |
| [`DEMO.md`](DEMO.md) | The three-minute demonstration script |
| [`SCALABILITY.md`](SCALABILITY.md) | Replacing demo sources with real ones |

Source files, in the order it is worth reading them: `ml/features.py` (the
contract), `ml/physics.py` (the hazard model), `ml/hydrology.py` (the weather
process), `ml/data/generate_dataset.py` (the dataset), `ml/preprocess.py` (feature
assembly), `ml/train_model.py` (training and metrics), `ml/predict.py` (serving),
`ml/explain.py` (attribution), `ml/fallback_gbm.py` (the NumPy GBM).
