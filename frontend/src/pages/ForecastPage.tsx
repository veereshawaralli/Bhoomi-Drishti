/**
 * The forecast screen, and the simulator that asks how much worse it could get.
 *
 * Two questions on one page, because they are the same question at different
 * levels of confidence. The chart answers "where does this region go if the
 * weather does what the forecast says". The simulator answers "and if it does
 * something else" - which is the officer's real question, since a plan has to
 * survive the storm nobody called.
 *
 * Both halves go through the same model. The curve comes from
 * `/api/forecast/{region}` with `store: false`, so browsing regions does not
 * litter the forecast table with rows nobody asked for. The simulator posts to
 * `/api/what-if`, which scores the region twice - as it stands, and as
 * described - and returns both, so the difference on screen is attributable to
 * the controls and to nothing else.
 *
 * Nothing on this page is an observation. Every number is model output for
 * conditions that have not happened, and the page says so in three places
 * rather than one: a projection screenshotted out of context is exactly how a
 * demonstration turns into a false claim.
 */
import { AlertTriangle, MapPin, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { ForecastChart, ForecastStrip, peakSentence } from '../charts/ForecastChart';
import { PageHeader } from '../components/AppShell';
import { ModeChip, RiskChip } from '../components/Chips';
import { FactorBreakdown } from '../components/FactorBreakdown';
import { Panel, ResourceBody } from '../components/Panel';
import { KeyValue, RiskReadout } from '../components/Readouts';
import { RegionPicker, useSelectedRegion } from '../components/RegionPicker';
import { DemoConsole } from '../components/ScenarioControls';
import { EmptyState, StaleNote } from '../components/States';
import {
  decimal,
  featureLabel,
  formatDateTime,
  horizonLabel,
  mmPerHour,
  percent,
  percentPoints,
  place,
  relativeTime,
  score as fmtScore,
  signed,
} from '../lib/format';
import { cx, palette } from '../lib/risk';
import { api } from '../services/api';
import { usePlatform } from '../state/PlatformContext';
import { useResource } from '../state/useResource';
import type {
  Features,
  ForecastPoint,
  ForecastResponse,
  RegionRiskResponse,
  WhatIfBody,
  WhatIfResponse,
} from '../types/api';

// -------------------------------------------------------------------- controls

/**
 * The eight controls, keyed on the request field each one sets.
 *
 * Keyed on the wire name deliberately. The body posted to `/api/what-if` is
 * assembled from these keys, so a control that exists on screen and a field the
 * backend understands cannot drift apart without the compiler noticing.
 */
type KnobKey =
  | 'rainfall_multiplier'
  | 'rainfall_add_mm_h'
  | 'soil_moisture_pct'
  | 'slope_deg'
  | 'vegetation_index'
  | 'distance_to_river_km'
  | 'historical_landslide_count'
  | 'future_hours';

/**
 * `null` means untouched, and untouched controls are never sent.
 *
 * This is the whole reason the state is nullable instead of being seeded with
 * the region's current values. A slider resting at a default is not a statement
 * about the world, and posting it as an override would have the model score a
 * question nobody asked: "soil moisture 20%" pinned on ground currently reading
 * 38% is a different scenario, not a neutral one.
 */
type KnobState = Record<KnobKey, number | null>;

const IDLE: KnobState = {
  rainfall_multiplier: null,
  rainfall_add_mm_h: null,
  soil_moisture_pct: null,
  slope_deg: null,
  vegetation_index: null,
  distance_to_river_km: null,
  historical_landslide_count: null,
  future_hours: null,
};
interface Knob {
  key: KnobKey;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Where the thumb rests before it is touched, read from the live features. */
  base: (features: Features | null) => number;
  format: (value: number) => string;
  hint: string;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * The controls, in the order a hazard officer reaches for them: the weather
 * first, because that is what changes today, then the ground, which changes over
 * years, then the lead time.
 *
 * Every range sits inside the bounds `WhatIfIn` validates, and narrower wherever
 * the schema's limit is physically silly - the backend accepts rainfall x6, but
 * a six-fold multiplier on a monsoon reading is not a scenario anyone plans for,
 * and a slider that can produce nonsense invites a screenshot of nonsense.
 */
const KNOBS: Knob[] = [
  {
    key: 'rainfall_multiplier',
    label: 'Rainfall intensity',
    min: 0.5,
    max: 4,
    step: 0.1,
    base: () => 1,
    format: (value) => `${value.toFixed(1)}×`,
    hint:
      'Scales all five rainfall windows, with less reach on the longer ones - a burst in the next hour cannot change what fell last week.',
  },
  {
    key: 'rainfall_add_mm_h',
    label: 'Extra rain',
    min: 0,
    max: 60,
    step: 1,
    base: () => 0,
    format: (value) => `${Math.round(value)} mm/h`,
    hint: 'An absolute addition on top of the multiplier, accumulated across each window.',
  },
  {
    key: 'soil_moisture_pct',
    label: 'Soil moisture',
    min: 5,
    max: 62,
    step: 0.5,
    base: (features) => features?.soil_moisture ?? 20,
    format: (value) => `${value.toFixed(1)}%`,
    hint:
      'Pins the wetness of the ground. Left alone, moisture follows the rain you add, saturating towards 62% the way the water balance does.',
  },
  {
    key: 'slope_deg',
    label: 'Slope',
    min: 2,
    max: 60,
    step: 0.5,
    base: (features) => features?.slope ?? 20,
    format: (value) => `${value.toFixed(1)}°`,
    hint:
      'Terrain, not weather. Useful for asking what the same storm would do on steeper ground - two districts an hour apart differ mostly by this.',
  },
  {
    key: 'vegetation_index',
    label: 'Vegetation cover',
    min: 0,
    max: 0.95,
    step: 0.05,
    base: (features) => features?.vegetation_index ?? 0.5,
    format: (value) => value.toFixed(2),
    hint: 'NDVI-style index, 0 to 1. Roots hold soil, so clearing a slope raises its risk.',
  },
  {
    key: 'distance_to_river_km',
    label: 'To nearest river',
    min: 0,
    max: 12,
    step: 0.1,
    base: (features) => features?.distance_to_river ?? 2,
    format: (value) => `${value.toFixed(1)} km`,
    hint: 'Channels undercut the toe of a slope, so ground close to one fails at lower rainfall.',
  },
  {
    key: 'historical_landslide_count',
    label: 'Recorded landslides',
    min: 0,
    max: 40,
    step: 1,
    base: (features) => features?.historical_landslide_count ?? 0,
    format: (value) => `${Math.round(value)}`,
    hint: 'How often this ground has failed before. Slopes that have moved tend to move again.',
  },
  {
    key: 'future_hours',
    label: 'Lead time',
    min: 0,
    max: 72,
    step: 6,
    base: () => 0,
    format: (value) => horizonLabel(value),
    hint:
      'Scores the region against the forecast weather this far ahead, and applies your other changes on top of that hour.',
  },
];

/**
 * The request, built only from what the user actually moved.
 *
 * Eight explicit assignments rather than a loop over `KNOBS`, because
 * `WhatIfBody` is a typed object and a computed-key loop would need a cast to
 * satisfy it - a cast that would then swallow a typo in a key name silently.
 *
 * `future_hours` is the exception that is always sent. The schema defaults it to
 * 6, so omitting it would have the backend score the modified case six hours
 * into the future while the baseline stayed at now, and report the difference as
 * though the user had asked for it.
 */
function toBody(regionId: number, knobs: KnobState): WhatIfBody {
  const body: WhatIfBody = { region_id: regionId, future_hours: knobs.future_hours ?? 0 };
  if (knobs.rainfall_multiplier !== null) body.rainfall_multiplier = knobs.rainfall_multiplier;
  if (knobs.rainfall_add_mm_h !== null) body.rainfall_add_mm_h = knobs.rainfall_add_mm_h;
  if (knobs.soil_moisture_pct !== null) body.soil_moisture_pct = knobs.soil_moisture_pct;
  if (knobs.slope_deg !== null) body.slope_deg = knobs.slope_deg;
  if (knobs.vegetation_index !== null) body.vegetation_index = knobs.vegetation_index;
  if (knobs.distance_to_river_km !== null) body.distance_to_river_km = knobs.distance_to_river_km;
  if (knobs.historical_landslide_count !== null) {
    body.historical_landslide_count = Math.round(knobs.historical_landslide_count);
  }
  return body;
}
/**
 * Trails `value` by `ms`.
 *
 * Dragging a slider costs one request instead of forty. Deliberately a debounce
 * and not a throttle: the interesting value is where the thumb came to rest, not
 * the pixels it passed through on the way.
 */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** One labelled slider, its current reading, and a way back to untouched. */
function KnobRow({
  knob,
  value,
  base,
  onChange,
  onReset,
}: {
  knob: Knob;
  value: number | null;
  base: number;
  onChange: (value: number) => void;
  onReset: () => void;
}) {
  const touched = value !== null;
  // The label shows the region's true reading even when it falls outside the
  // slider's range; only the thumb is clamped. Reporting a clamped 60° on ground
  // that is actually 67° would be the interface lying about the terrain.
  const shown = value ?? base;

  return (
    <div className="space-y-1" title={knob.hint}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate font-display text-2xs font-semibold uppercase tracking-[0.12em] text-faint">
          {knob.label}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span className={cx('tnum font-mono text-xs', touched ? 'text-accent' : 'text-dim')}>
            {knob.format(shown)}
          </span>
          <button
            type="button"
            className="text-faint transition-colors hover:text-accent disabled:invisible"
            onClick={onReset}
            disabled={!touched}
            title={`Return ${knob.label.toLowerCase()} to this region's own value`}
            aria-label={`Reset ${knob.label}`}
          >
            <RotateCcw className="h-3 w-3" aria-hidden />
          </button>
        </span>
      </div>
      <input
        className="slider"
        type="range"
        min={knob.min}
        max={knob.max}
        step={knob.step}
        value={clamp(shown, knob.min, knob.max)}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={knob.label}
      />
    </div>
  );
}

// --------------------------------------------------------------------- result

/**
 * What the model made of the described conditions.
 *
 * Read top to bottom: the new score against the old one, whether that crosses a
 * band, a sentence saying what it means, what the user changed, what the model
 * actually saw change, and finally which factors carry the new score.
 */
function SimulatorResult({
  result,
  thresholds,
}: {
  result: WhatIfResponse;
  thresholds: { high: number; critical: number };
}) {
  const { changes, modified, interpretation } = result;
  const before = palette(changes.risk_level_before);
  const after = palette(changes.risk_level_after);
  // Lead time is reported on its own line below, so it would be duplication in
  // the "what you changed" list - and "Lead time 0 h" is not a change at all.
  const inputs = changes.inputs_changed.filter((input) => input.field !== 'future_hours');
  const factors = modified.explanation?.top_factors ?? modified.top_factors;

  return (
    <div className="space-y-3">
      <RiskReadout
        score={changes.risk_score_after}
        level={changes.risk_level_after}
        confidence={changes.confidence_after}
        delta={changes.risk_score_delta}
        marks={[thresholds.high, thresholds.critical]}
        caption={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-faint">Baseline</span>
            <span className={cx('tnum font-mono', before.text)}>
              {fmtScore(changes.risk_score_before)}
            </span>
            <RiskChip level={changes.risk_level_before} />
            <span className="text-faint">under your conditions</span>
            <span className={cx('tnum font-mono', after.text)}>
              {fmtScore(changes.risk_score_after)}
            </span>
            <RiskChip level={changes.risk_level_after} />
          </span>
        }
      />

      {changes.band_changed && (
        <p
          className={cx(
            'flex items-start gap-2 rounded-panel border px-2.5 py-2 text-2xs leading-relaxed',
            after.border,
            after.bg,
            after.text,
          )}
        >
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Band change - this takes {result.region.name} out of {changes.risk_level_before} and
            into {changes.risk_level_after}.
          </span>
        </p>
      )}

      <p className="text-xs leading-relaxed text-dim">{interpretation}</p>

      {changes.lead_time_hours !== undefined && changes.lead_time_hours > 0 && (
        <KeyValue
          label="Lead time"
          value={horizonLabel(changes.lead_time_hours)}
          title="The baseline is scored now; the modified score starts from the forecast weather this far ahead, with your changes applied on top of it."
        />
      )}
      {inputs.length > 0 && (
        <div className="space-y-1.5">
          <p className="label mb-0">What you changed</p>
          <ul className="flex flex-wrap gap-1.5">
            {inputs.map((input) => (
              <li key={input.field} className="chip border-accent/40 bg-accent/10 text-accent">
                {input.label} {input.value_text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {changes.features_changed.length > 0 && (
        <div className="space-y-1.5">
          <p className="label mb-0">What the model saw</p>
          <ul className="space-y-1">
            {changes.features_changed.slice(0, 7).map((change) => (
              <li key={change.feature} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-2xs text-faint">
                  {featureLabel(change.feature)}
                </span>
                <span className="tnum shrink-0 font-mono text-2xs text-dim">
                  {decimal(change.before, 2)} → <span className="text-ink">
                    {decimal(change.after, 2)}
                  </span>{' '}
                  <span className="text-faint">{signed(change.delta, 2)}</span>
                </span>
              </li>
            ))}
          </ul>
          {/* Deliberately uncoloured. Up is not always worse - more vegetation
              lowers risk, more rain raises it - and a green-for-down convention
              borrowed from the score would invert the meaning of half of these
              rows. */}
          <p className="text-2xs leading-relaxed text-faint">
            One change in a control moves several features, because rainfall,
            moisture and terrain are not independent in the model’s view.
          </p>
        </div>
      )}

      <div className="rule" />

      <div>
        <p className="label mb-1.5">Why the new score</p>
        <FactorBreakdown
          factors={factors}
          summary={modified.explanation?.summary}
          disclaimer={modified.explanation?.disclaimer}
          methodLabel={modified.explanation?.method_label}
          limit={5}
        />
      </div>
      <div className="flex items-start gap-2">
        <ModeChip mode={result.data_mode} compact />
        <p className="min-w-0 text-2xs leading-relaxed text-faint">{result.note}</p>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------- page

export default function ForecastPage() {
  const { version, refreshSeconds, thresholds, dataMode, selectedRegionId } = usePlatform();
  const { region, select } = useSelectedRegion();

  const [knobs, setKnobs] = useState<KnobState>(IDLE);
  const [step, setStep] = useState<ForecastPoint | null>(null);

  const chosen = selectedRegionId;

  // A new region starts from its own conditions. Carrying the previous region's
  // overrides across would silently score a scenario the user never described.
  useEffect(() => {
    setKnobs(IDLE);
    setStep(null);
  }, [chosen]);

  // `?? 0` is unreachable: `enabled: false` means the fetcher is never called.
  const detail = useResource<RegionRiskResponse>(
    (signal) => api.regionRisk(chosen ?? 0, {}, signal),
    [version, chosen],
    { enabled: chosen !== null, pollSeconds: refreshSeconds },
  );

  const forecast = useResource<ForecastResponse>(
    (signal) => api.forecast(chosen ?? 0, { store: false }, signal),
    [version, chosen],
    { enabled: chosen !== null, pollSeconds: refreshSeconds },
  );

  const settled = useDebounced(knobs, 400);
  const dirty = useMemo(() => Object.values(settled).some((value) => value !== null), [settled]);
  const settledKey = useMemo(() => JSON.stringify(settled), [settled]);
  const liveKey = useMemo(() => JSON.stringify(knobs), [knobs]);

  // Not polled. A hypothetical has no fresher version of itself, and a poll
  // landing mid-drag would fight the debounce for the same panel.
  const sim = useResource<WhatIfResponse>(
    (signal) => api.whatIf(toBody(chosen ?? 0, settled), signal),
    [version, chosen, settledKey],
    { enabled: chosen !== null && dirty },
  );
  const features = detail.data?.risk.features ?? null;
  const touched = Object.values(knobs).filter((value) => value !== null).length;
  const pending = liveKey !== settledKey;

  const setKnob = (key: KnobKey, value: number) =>
    setKnobs((current) => ({ ...current, [key]: value }));
  const resetKnob = (key: KnobKey) => setKnobs((current) => ({ ...current, [key]: null }));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Forecast and simulation"
        lead="The next 72 hours for one region as the model projects them, and a simulator for the storm the forecast did not call. Both are model output, not observation."
        right={
          <>
            <RegionPicker
              selected={region}
              onPick={(picked) => select(picked.id)}
              className="w-56"
              align="right"
            />
            <ModeChip mode={dataMode} />
          </>
        }
      />

      {chosen === null ? (
        <Panel title="72-hour risk forecast">
          <EmptyState
            title="No region selected"
            hint="Pick a region above, or select a marker on the risk map, and its forecast curve and simulator load here."
            icon={<MapPin className="h-5 w-5" />}
          />
        </Panel>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
          <div className="space-y-4">
            <Panel
              title="72-hour risk forecast"
              note={
                forecast.data
                  ? peakSentence(forecast.data.peak)
                  : place(region?.district, region?.state)
              }
              right={
                forecast.data ? (
                  <span className="font-mono text-2xs text-faint">
                    issued {relativeTime(forecast.data.issued_at)}
                  </span>
                ) : undefined
              }
              busy={forecast.refreshing}
            >
              <ResourceBody
                resource={forecast}
                loadingRows={5}
                loadingLabel="Projecting the next 72 hours"
              >
                {(data) => (
                  <div className="space-y-3">
                    {forecast.error && (
                      <StaleNote error={forecast.error} onRetry={forecast.reload} />
                    )}
                    <ForecastChart
                      points={data.points}
                      peak={data.peak}
                      thresholds={thresholds}
                      height={264}
                    />
                    <ForecastStrip
                      points={data.points}
                      peak={data.peak}
                      activeHours={step?.hours ?? null}
                      onPick={(point) =>
                        setStep((current) => (current?.hours === point.hours ? null : point))
                      }
                    />
                    <p className="text-xs leading-relaxed text-dim">{data.summary}</p>
                    <p className="text-2xs leading-relaxed text-faint">
                      Six horizons, each scored by {data.model_backend} against the forecast
                      weather for that hour. A projection, not an observation - and it moves when
                      the weather it was built from moves.
                      {data.note ? ` ${data.note}` : ''}
                    </p>
                  </div>
                )}
              </ResourceBody>
            </Panel>

            <Panel
              title="What-if simulator"
              note="Every control re-scores this region through the same model that scored the map."
              busy={sim.refreshing || pending}
              right={
                touched > 0 ? (
                  <button type="button" className="btn btn-ghost" onClick={() => setKnobs(IDLE)}>
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                    Reset {touched}
                  </button>
                ) : undefined
              }
            >
              <div className="space-y-3">
                <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
                  {KNOBS.map((knob) => (
                    <KnobRow
                      key={knob.key}
                      knob={knob}
                      value={knobs[knob.key]}
                      base={knob.base(features)}
                      onChange={(value) => setKnob(knob.key, value)}
                      onReset={() => resetKnob(knob.key)}
                    />
                  ))}
                </div>

                <div className="rule" />

                {!dirty &&
                  (detail.data ? (
                    <RiskReadout
                      score={detail.data.risk.risk_score}
                      level={detail.data.risk.risk_level}
                      confidence={detail.data.risk.confidence}
                      marks={[thresholds.high, thresholds.critical]}
                      caption="The region as it stands, and the baseline every simulation is measured against. Move a control and the model re-scores it under your conditions."
                    />
                  ) : (
                    <p className="text-xs leading-relaxed text-faint">
                      Move a control and the model re-scores this region under your conditions.
                    </p>
                  ))}

                {dirty && (
                  <>
                    {sim.error && sim.data && (
                      <StaleNote error={sim.error} onRetry={sim.reload} />
                    )}
                    <ResourceBody
                      resource={sim}
                      loadingRows={4}
                      loadingLabel="Re-scoring through the model"
                    >
                      {(result) => <SimulatorResult result={result} thresholds={thresholds} />}
                    </ResourceBody>
                  </>
                )}
              </div>
            </Panel>
          </div>
          <div className="space-y-3">
            <Panel
              title="Demonstration"
              note="These controls re-score every monitored region, not only this one."
            >
              <DemoConsole onFocusRegion={select} />
            </Panel>

            <Panel
              title={step ? `Horizon ${step.label}` : 'Selected horizon'}
              note={step ? formatDateTime(step.valid_at) : undefined}
            >
              {step ? (
                <div className="space-y-1">
                  <RiskReadout
                    score={step.risk_score}
                    level={step.risk_level}
                    confidence={step.confidence}
                    marks={[thresholds.high, thresholds.critical]}
                  />
                  <div className="rule my-1.5" />
                  <KeyValue
                    label="Rainfall"
                    value={mmPerHour(step.rainfall_mm)}
                    title="Rate forecast for that hour, not a total for the period"
                  />
                  {step.soil_moisture_pct !== null && (
                    <KeyValue label="Soil moisture" value={percentPoints(step.soil_moisture_pct)} />
                  )}
                  <KeyValue label="Confidence" value={percent(step.confidence)} />
                  <KeyValue label="Horizon" value={horizonLabel(step.hours)} />
                  <KeyValue label="Valid at" value={formatDateTime(step.valid_at)} />
                </div>
              ) : (
                <EmptyState
                  title="No horizon picked"
                  hint="Select one of the six tiles under the chart to read that hour on its own."
                />
              )}
            </Panel>
            <Panel title="How to read this screen">
              <ul className="space-y-2 text-2xs leading-relaxed text-faint">
                <li>
                  The curve is the model run forward over forecast weather. It is a projection, and
                  it changes when the forecast underneath it changes.
                </li>
                <li>
                  The simulator scores this region twice through one model - as it stands, and as
                  you describe it. The difference is your conditions and nothing else.
                </li>
                <li>
                  A what-if is never stored as a prediction and never raises an alert. Nothing you
                  do on this panel reaches the alert queue or the officer desk.
                </li>
              </ul>
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}
