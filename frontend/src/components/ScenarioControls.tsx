/**
 * The demo console: the four scenarios, the large extreme-rainfall control, and
 * the receipt that says what actually happened.
 *
 * Loading a scenario is not a display setting. The backend re-runs the trained
 * model over every monitored region under altered weather, stores the new
 * predictions, reconciles the alert table against them, and reports what moved.
 * That is why these controls live in one component and drive the whole platform
 * through `usePlatform()` rather than holding any state of their own: after a
 * press, every open screen is stale, and the `version` bump is what pulls the
 * map, the charts and the alert list forward together.
 *
 * The receipt exists because a large red button that visibly "does something" is
 * exactly the kind of thing a judge should be suspicious of. So the banner
 * prints the numbers the API returned - regions re-scored, predictions stored,
 * bands crossed, alerts raised - and names the worst region with its before and
 * after score. Every line is a value from the response; none of it is decoration.
 */
import {
  Activity,
  BellRing,
  Check,
  CloudLightning,
  CloudRain,
  Crosshair,
  Database,
  LineChart,
  Loader2,
  MapPin,
  RotateCcw,
  Siren,
  Sun,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { count as fmtCount, people, score as fmtScore, signed } from '../lib/format';
import { cx, palette } from '../lib/risk';
import { usePlatform } from '../state/PlatformContext';
import type {
  RiskLevel,
  Scenario,
  ScenarioKey,
  SimulationResetResponse,
  SimulationResponse,
} from '../types/api';
import { ModeChip, RiskChip } from './Chips';
import { InlineError } from './States';

/** Calm to worst. Also the order the bar renders and the demo runs in. */
const SCENARIO_ORDER: ScenarioKey[] = [
  'NORMAL',
  'HEAVY_RAINFALL',
  'EXTREME_RAINFALL',
  'CRITICAL_RISK',
];

const SCENARIO_ICON: Record<ScenarioKey, LucideIcon> = {
  NORMAL: Sun,
  HEAVY_RAINFALL: CloudRain,
  EXTREME_RAINFALL: CloudLightning,
  CRITICAL_RISK: Siren,
};

/**
 * Each scenario borrows a band colour instead of getting one of its own, so the
 * demo bar is read on the same scale as every score on the platform. It is a
 * rough correspondence - a scenario is an input, not a risk level - which is why
 * the button also prints the modifiers it applies.
 */
const SCENARIO_BAND: Record<ScenarioKey, RiskLevel> = {
  NORMAL: 'VERY LOW',
  HEAVY_RAINFALL: 'MODERATE',
  EXTREME_RAINFALL: 'HIGH',
  CRITICAL_RISK: 'CRITICAL',
};

/** The API's labels are sentences. Four of them in one row need shorter ones. */
const SHORT_LABEL: Record<ScenarioKey, string> = {
  NORMAL: 'Normal',
  HEAVY_RAINFALL: 'Heavy rain',
  EXTREME_RAINFALL: 'Extreme rain',
  CRITICAL_RISK: 'Critical risk',
};

/** "rainfall x2.5 · soil moisture +8 pp" - the modifiers, already formatted. */
function changeList(changes: Record<string, string>): string {
  return Object.entries(changes)
    .map(([key, value]) => `${key.replace(/_/g, ' ')} ${value}`)
    .join(' · ');
}

function byDemoOrder(a: Scenario, b: Scenario): number {
  return SCENARIO_ORDER.indexOf(a.key) - SCENARIO_ORDER.indexOf(b.key);
}

// ------------------------------------------------------------ scenario bar

function ScenarioButton({
  item,
  active,
  busy,
  disabled,
  onPick,
}: {
  item: Scenario;
  active: boolean;
  busy: boolean;
  disabled: boolean;
  onPick: (key: ScenarioKey) => void;
}) {
  const Icon = SCENARIO_ICON[item.key] ?? Activity;
  const tone = palette(SCENARIO_BAND[item.key] ?? 'MODERATE');
  const mods = changeList(item.changes);

  return (
    <button
      type="button"
      className={cx(
        'group flex min-w-0 flex-1 items-center gap-2 rounded-panel border px-2.5 py-2 text-left transition-colors',
        active ? cx(tone.border, tone.bg) : 'border-hairline bg-raised/60 hover:border-accent/50',
        disabled && !busy && 'cursor-not-allowed opacity-40',
      )}
      onClick={() => onPick(item.key)}
      disabled={disabled}
      aria-pressed={active}
      title={`${item.label} — ${item.description}${mods ? `\nApplies: ${mods}` : ''}`}
    >
      {busy ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" aria-hidden />
      ) : (
        <Icon
          className={cx(
            'h-4 w-4 shrink-0',
            active ? tone.text : 'text-faint group-hover:text-accent',
          )}
          aria-hidden
        />
      )}
      <span className="min-w-0">
        <span
          className={cx(
            'block truncate font-display text-2xs font-semibold uppercase tracking-wider',
            active ? tone.text : 'text-ink',
          )}
        >
          {SHORT_LABEL[item.key] ?? item.label}
        </span>
        <span className="block truncate font-mono text-[10px] text-faint">
          {mods || 'baseline weather'}
        </span>
      </span>
      {active && !busy && (
        <Check className={cx('ml-auto h-3.5 w-3.5 shrink-0', tone.text)} aria-hidden />
      )}
    </button>
  );
}

/**
 * The four scenarios, plus a stand-down.
 *
 * The list is the API's, not a copy: labels, descriptions and modifiers all come
 * from `/api/scenarios`, so retuning a scenario in the backend retunes this bar.
 * Nothing renders before that list arrives - four buttons with invented captions
 * would be the one place in this interface where the UI made something up.
 *
 * Every button is disabled while any scenario is applying. Two overlapping
 * re-scores of the same regions would race in the database, and the second
 * response would overwrite the first banner with a mix of both worlds.
 */
export function ScenarioBar({
  className,
  compareWith = 'NORMAL',
}: {
  className?: string;
  /** Baseline the deltas are measured against. NORMAL for a demo. */
  compareWith?: ScenarioKey;
}) {
  const {
    scenarios,
    scenario,
    scenarioBusy,
    scenarioError,
    loadScenario,
    resetScenario,
  } = usePlatform();

  const list = [...scenarios].sort(byDemoOrder);
  const busy = scenarioBusy !== null;
  const resetting = scenarioBusy === 'RESET';

  return (
    <div className={cx('space-y-2', className)}>
      {list.length > 0 && (
        <div className="flex flex-wrap items-stretch gap-1.5">
          {list.map((item) => (
            <ScenarioButton
              key={item.key}
              item={item}
              active={item.key === scenario}
              busy={scenarioBusy === item.key}
              disabled={busy}
              onPick={(key) => {
                void loadScenario(key, key === compareWith ? undefined : compareWith);
              }}
            />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-2xs text-faint">
          Scenarios re-score every monitored region through the trained model.
        </p>
        <button
          type="button"
          className="btn btn-ghost shrink-0 px-2 py-1"
          onClick={() => void resetScenario()}
          disabled={busy}
          title="Re-score every region under baseline weather and resolve the alerts this demo raised."
        >
          {resetting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          )}
          Stand down
        </button>
      </div>

      {scenarioError && <InlineError error={scenarioError} />}
    </div>
  );
}

// ------------------------------------------------------------- large control

/**
 * The control the live demonstration turns on.
 *
 * One press raises rainfall across the network, re-scores every monitored region
 * through the model, stores those predictions, reconciles the alert table, and
 * returns the regions that crossed a band boundary. The map highlights them, the
 * charts refetch on the version bump, and the banner below prints the response.
 *
 * `compareWith` defaults to NORMAL so the deltas the banner shows are against
 * calm weather, which is the comparison a room full of people wants to see.
 */
export function ExtremeRainfallButton({
  className,
  label = 'Simulate extreme rainfall',
  onDone,
}: {
  className?: string;
  label?: string;
  /** Fires only on success - a page can fly the map to the worst region. */
  onDone?: (result: SimulationResponse) => void;
}) {
  const { loadScenario, scenarioBusy, scenario } = usePlatform();
  const busy = scenarioBusy === 'EXTREME_RAINFALL';
  const active = scenario === 'EXTREME_RAINFALL';

  async function run() {
    const result = await loadScenario('EXTREME_RAINFALL', 'NORMAL');
    if (result) onDone?.(result);
  }

  return (
    <button
      type="button"
      className={cx(
        'group relative flex w-full items-center justify-center gap-3 overflow-hidden rounded-panel border px-4 py-3',
        'font-display text-sm font-bold uppercase tracking-[0.14em] transition-colors',
        'border-risk-high/60 bg-risk-high/15 text-risk-high hover:bg-risk-high/25',
        'disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      onClick={() => void run()}
      disabled={scenarioBusy !== null}
      title="Raise rainfall network-wide, re-score every region through the model, and reconcile alerts."
    >
      {/* A slow sheen while idle: this is the control a demonstration starts on.
          Suppressed once the scenario is loaded, so it does not keep begging to
          be pressed after it has been. */}
      {!busy && !active && (
        <span
          className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 animate-sweep bg-gradient-to-r from-transparent via-risk-high/25 to-transparent"
          aria-hidden
        />
      )}
      {busy ? (
        <Loader2 className="h-5 w-5 shrink-0 animate-spin" aria-hidden />
      ) : (
        <CloudLightning className="h-5 w-5 shrink-0" aria-hidden />
      )}
      <span className="truncate">{busy ? 'Re-scoring the network' : label}</span>
    </button>
  );
}

// ------------------------------------------------------------------ receipt

/** One confirmed action, with the number the API reported for it. */
function ActionRow({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <li className="flex items-baseline gap-2">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
      <span className="min-w-0 text-xs leading-relaxed text-dim">{children}</span>
    </li>
  );
}

/**
 * What the last simulation did, in the API's own numbers.
 *
 * The six rows are the six things the press actually performed, each carrying
 * the count the backend returned for it, and the seventh - the recommended
 * response - is the playbook the engine selected for the resulting band. If a
 * count is zero it still shows: "0 alerts raised" is a real and useful outcome
 * and hiding it would make the banner a highlight reel.
 */
function SimulationReceipt({
  sim,
  version,
  onDismiss,
  onFocusRegion,
}: {
  sim: SimulationResponse;
  version: number;
  onDismiss: () => void;
  onFocusRegion?: (regionId: number) => void;
}) {
  const tone = palette(sim.headline_level);
  const worst = sim.worst_region;
  const mods = changeList(sim.changes);

  return (
    <div
      className={cx('animate-rise rounded-panel border bg-panel/85 shadow-bezel', tone.border)}
      role="status"
      aria-live="polite"
    >
      <header className="flex items-start justify-between gap-3 border-b border-hairline px-3 py-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={cx(
                'font-display text-xs font-semibold uppercase tracking-[0.12em]',
                tone.text,
              )}
            >
              {sim.badge}
            </span>
            <ModeChip mode={sim.data_mode} compact />
            <RiskChip level={sim.headline_level} score={sim.max_score} />
          </div>
          <p className="text-2xs leading-relaxed text-faint">{sim.scenario_description}</p>
        </div>
        <button
          type="button"
          className="btn btn-ghost shrink-0 px-1.5 py-1"
          onClick={onDismiss}
          title="Dismiss this summary. The scenario stays loaded."
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">Dismiss</span>
        </button>
      </header>

      <div className="grid gap-x-5 gap-y-3 p-3 lg:grid-cols-2">
        <ul className="space-y-1.5">
          <ActionRow icon={CloudRain}>
            Rainfall raised against{' '}
            <span className="font-mono text-ink">{sim.compared_with.replace(/_/g, ' ')}</span>
            {mods && <span className="text-faint"> · {mods}</span>}
          </ActionRow>
          <ActionRow icon={Activity}>
            <span className="tnum font-mono text-ink">{fmtCount(sim.regions_scored)}</span> regions
            re-scored through the model · country risk{' '}
            <span className="tnum font-mono text-ink">{fmtScore(sim.country_risk)}</span>
          </ActionRow>
          <ActionRow icon={Database}>
            <span className="tnum font-mono text-ink">{fmtCount(sim.predictions_stored)}</span>{' '}
            predictions written to the database
          </ActionRow>
          <ActionRow icon={MapPin}>
            <span className="tnum font-mono text-ink">{fmtCount(sim.regions_escalated)}</span>{' '}
            regions crossed a band boundary ·{' '}
            <span className="tnum font-mono text-ink">{fmtCount(sim.highlighted.length)}</span>{' '}
            highlighted on the map
          </ActionRow>
          <ActionRow icon={BellRing}>
            <span className="tnum font-mono text-ink">{fmtCount(sim.alerts_raised)}</span> alerts
            raised ·{' '}
            <span className="tnum font-mono text-ink">{fmtCount(sim.alerts.length)}</span> open in
            the alert table
          </ActionRow>
          <ActionRow icon={LineChart}>
            Charts, readouts and the alert list refreshed at platform version{' '}
            <span className="tnum font-mono text-ink">{version}</span>
          </ActionRow>
        </ul>

        <div className="space-y-3">
          {worst && (
            <div className={cx('rounded-panel border px-2.5 py-2', tone.border, tone.bg)}>
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="font-display text-2xs font-semibold uppercase tracking-[0.12em] text-faint">
                  Worst region
                </p>
                {onFocusRegion && (
                  <button
                    type="button"
                    className="btn btn-ghost px-1.5 py-0.5 text-[10px]"
                    onClick={() => onFocusRegion(worst.region_id)}
                    title="Centre the map on this region"
                  >
                    <Crosshair className="h-3 w-3" aria-hidden />
                    Locate
                  </button>
                )}
              </div>

              <p className="truncate text-xs font-semibold text-ink" title={worst.region_name}>
                {worst.region_name}
              </p>
              <p className="truncate text-2xs text-faint">
                {[worst.district, worst.state].filter(Boolean).join(', ')}
              </p>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="tnum font-mono text-2xs text-faint">
                  {fmtScore(worst.before_score)}
                </span>
                <span className="text-faint" aria-hidden>
                  &rarr;
                </span>
                <span className={cx('tnum font-display text-lg font-semibold leading-none', tone.text)}>
                  {fmtScore(worst.risk_score)}
                </span>
                <span className={cx('tnum font-mono text-2xs', tone.text)}>
                  {signed(worst.delta, 0)}
                </span>
                <RiskChip level={worst.risk_level} className="ml-auto" />
              </div>
              {worst.population_exposed !== null && (
                <p className="mt-1 text-2xs text-faint">
                  {people(worst.population_exposed)} people in the exposed area
                </p>
              )}
            </div>
          )}

          {sim.recommended_response.length > 0 && (
            <div>
              <p className="mb-1 font-display text-2xs font-semibold uppercase tracking-[0.12em] text-faint">
                Recommended response
              </p>
              <ol className="space-y-1">
                {sim.recommended_response.map((step, index) => (
                  <li key={step} className="flex gap-2 text-xs leading-relaxed text-dim">
                    <span className="tnum shrink-0 font-mono text-2xs text-faint">
                      {index + 1}.
                    </span>
                    <span className="min-w-0">{step}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>

      <p className="border-t border-hairline px-3 py-1.5 font-mono text-[10px] leading-snug text-faint">
        {sim.note}
      </p>
    </div>
  );
}

/** A stand-down, reported the same way: what it re-scored, and at what baseline. */
function ResetReceipt({
  reset,
  onDismiss,
}: {
  reset: SimulationResetResponse;
  onDismiss: () => void;
}) {
  const tone = palette('VERY LOW');
  return (
    <div
      className={cx(
        'animate-rise flex items-start gap-2.5 rounded-panel border bg-panel/85 px-3 py-2',
        tone.border,
      )}
      role="status"
      aria-live="polite"
    >
      <RotateCcw className={cx('mt-0.5 h-4 w-4 shrink-0', tone.text)} aria-hidden />
      <div className="min-w-0 space-y-0.5">
        <p className="text-xs leading-relaxed text-dim">
          Stood down to{' '}
          <span className={cx('font-semibold', tone.text)}>{reset.scenario_label}</span>.{' '}
          <span className="tnum font-mono text-ink">{fmtCount(reset.regions_scored)}</span> regions
          re-scored,{' '}
          <span className="tnum font-mono text-ink">{fmtCount(reset.predictions_stored)}</span>{' '}
          predictions stored.
        </p>
        <p className="font-mono text-[10px] leading-snug text-faint">{reset.note}</p>
      </div>
      <button
        type="button"
        className="btn btn-ghost ml-auto shrink-0 px-1.5 py-1"
        onClick={onDismiss}
        title="Dismiss"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
        <span className="sr-only">Dismiss</span>
      </button>
    </div>
  );
}

/**
 * Whichever of the two receipts applies, or nothing.
 *
 * A failure is shown alongside the previous receipt rather than instead of it:
 * "the last run did this, and the attempt after it failed" is the accurate
 * account, and blanking the summary would hide half of it.
 */
export function SimulationBanner({
  className,
  onFocusRegion,
}: {
  className?: string;
  onFocusRegion?: (regionId: number) => void;
}) {

  const { lastSimulation, lastReset, scenarioError, clearSimulation, version } = usePlatform();
  if (!lastSimulation && !lastReset && !scenarioError) return null;

  return (
    <div className={cx('space-y-2', className)}>
      {scenarioError && (
        <div className="rounded-panel border border-risk-high/40 bg-risk-high/10 px-3 py-2">
          <InlineError error={scenarioError} />
        </div>
      )}
      {lastSimulation && (
        <SimulationReceipt
          sim={lastSimulation}
          version={version}
          onDismiss={clearSimulation}
          onFocusRegion={onFocusRegion}
        />
      )}
      {lastReset && <ResetReceipt reset={lastReset} onDismiss={clearSimulation} />}
    </div>
  );
}

// ------------------------------------------------------------------ console

/**
 * The whole demo control in one block: the scenario bar, the large button and
 * the receipt.
 *
 * Composed here rather than assembled on each page so the demonstration behaves
 * identically wherever it is driven from, and so the dashboard and the map page
 * cannot drift into offering different halves of it.
 */
export function DemoConsole({
  className,
  onFocusRegion,
  onDone,
}: {
  className?: string;
  onFocusRegion?: (regionId: number) => void;
  onDone?: (result: SimulationResponse) => void;
}) {
  const { scenarioLabel, dataMode } = usePlatform();
  return (
    <div className={cx('space-y-2.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-2xs text-faint">
          Active scenario <span className="text-dim">{scenarioLabel}</span>
        </p>
        <ModeChip mode={dataMode} compact />
      </div>
      <ScenarioBar />
      <ExtremeRainfallButton onDone={onDone} />
      <SimulationBanner onFocusRegion={onFocusRegion} />
    </div>
  );
}

