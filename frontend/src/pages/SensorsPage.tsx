/**
 * The virtual sensor network.
 *
 * Nothing on this screen touches hardware. There is no Arduino, no Raspberry Pi
 * and no gauge on a hillside: every reading is produced by a software model of
 * how an instrument would respond to the slope state the risk engine is already
 * using, and it is stamped SIMULATED where it is shown rather than in a caption
 * underneath. The stamp is on the panel, on the chart, in the chart's tooltip
 * and on every row of the table, because a number that looks live and is not is
 * the one dishonest thing this platform must never do.
 *
 * What the screen is for, then, is the half of instrument work a real network
 * cannot demonstrate on request: an operator can drive one slope into heavy-rain
 * or pre-failure conditions and watch the risk engine respond, scored through
 * the same model as the map so the two numbers are comparable.
 *
 * No threshold is written here. Every reading arrives with its own `elevated_at`
 * and `alarm_at`, and the instrument specs come from the API, so the control
 * panel and the simulator cannot drift apart about what exists.
 */
import { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CloudRain,
  Compass,
  Cpu,
  Droplets,
  Gauge,
  Radio,
  Zap,
} from 'lucide-react';

import { SensorHistoryChart, SensorStatusStrip } from '../charts/SensorChart';
import { PageHeader } from '../components/AppShell';
import { ModeChip, SensorStatusChip } from '../components/Chips';
import { Panel, ResourceBody } from '../components/Panel';
import { KeyValue, Meter, StatTile } from '../components/Readouts';
import { RegionSelect } from '../components/RegionPicker';
import { DemoConsole } from '../components/ScenarioControls';
import { EmptyState, InlineError } from '../components/States';
import { DataTable, NumCell, TwoLine, type Column } from '../components/Table';
import {
  count as fmtCount,
  decimal,
  formatDateTime,
  reading as fmtReading,
  relativeTime,
  score as fmtScore,
  truncate,
} from '../lib/format';
import { SENSOR_STATUS_HEX, cx, palette } from '../lib/risk';
import { api, asApiError, type ApiError } from '../services/api';
import { usePlatform } from '../state/PlatformContext';
import { useResource } from '../state/useResource';
import type {
  SensorConditionKey,
  SensorConditionsResponse,
  SensorHistoryResponse,
  SensorNetworkResponse,
  SensorReading,
  SensorSimulateResponse,
  SensorStatus,
  SensorType,
  SensorTypeSpec,
} from '../types/api';

type TypeFilter = 'ALL' | SensorType;

/**
 * Which instrument the trace panel is showing.
 *
 * Held as an identity rather than as the reading itself, so a poll that brings a
 * new value for the same instrument updates the open panel instead of replacing
 * a stale copy of it.
 */
interface Picked {
  regionId: number;
  sensorType: SensorType;
}

function samePick(reading: SensorReading, picked: Picked | null): boolean {
  return (
    picked !== null &&
    reading.region_id === picked.regionId &&
    reading.sensor_type === picked.sensorType
  );
}

/** Loudest first when sorting: an instrument in alarm is the reason to be here. */
const STATUS_RANK: Record<SensorStatus, number> = {
  ALARM: 3,
  ELEVATED: 2,
  NORMAL: 1,
  OFFLINE: 0,
};

/** One glyph per instrument, so a filtered table is still scannable by kind. */
const TYPE_ICON: Record<SensorType, typeof Activity> = {
  RAIN_GAUGE: CloudRain,
  SOIL_MOISTURE: Droplets,
  PORE_PRESSURE: Gauge,
  TILT: Compass,
  VIBRATION: Activity,
};

/** Trace lengths offered. The API accepts 2-500; these are the useful windows. */
const POINT_CHOICES = [24, 48, 96, 240];

/** Windows for a forced condition. `SimulateSensorIn` bounds these at 10-720. */
const MINUTE_CHOICES = [60, 180, 360, 720];

export default function SensorsPage() {
  const { version, refreshSeconds, capabilities, session, scenarioLabel, refresh } = usePlatform();
  const [regionFilter, setRegionFilter] = useState<number | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [lastForced, setLastForced] = useState<SensorSimulateResponse | null>(null);

  // Writing sensor rows is an officer action for the same reason acting on an
  // alert is: it changes what everybody else's screen says.
  const canSimulate = capabilities.can_manage_alerts;

  // `limit_regions` is the size of the network, not a page size. The API places
  // instruments on the regions with the most recorded landslides, so asking for
  // twelve asks for the twelve slopes a real deployment would wire up first.
  const query = useMemo(
    () =>
      regionFilter === null
        ? { limit_regions: 12 }
        : { region_id: regionFilter, limit_regions: 1 },
    [regionFilter],
  );
  const queryKey = useMemo(() => JSON.stringify(query), [query]);

  const network = useResource<SensorNetworkResponse>(
    (signal) => api.sensors(query, signal),
    [version, queryKey],
    { pollSeconds: refreshSeconds },
  );

  // The instrument-kind filter is applied here, not in the request. The API has
  // no sensor_type parameter for the network view and should not: the counts
  // strip describes the whole network, and filtering server-side would quietly
  // change what those totals mean.
  const rows = useMemo(() => {
    const all = network.data?.sensors ?? [];
    return typeFilter === 'ALL' ? all : all.filter((row) => row.sensor_type === typeFilter);
  }, [network.data, typeFilter]);

  const counts = network.data?.counts ?? null;
  const specs = network.data?.types ?? [];
  const alarming = useMemo(() => rows.filter((row) => row.status === 'ALARM'), [rows]);

  // Until an instrument is chosen the trace follows the loudest one, so the panel
  // opens on something worth reading rather than on whatever sorted first.
  const loudest = useMemo(() => {
    let best: SensorReading | null = null;
    for (const row of rows) {
      if (!best || STATUS_RANK[row.status] > STATUS_RANK[best.status]) best = row;
    }
    return best;
  }, [rows]);

  const active = useMemo(
    () => rows.find((row) => samePick(row, picked)) ?? loudest,
    [rows, picked, loudest],
  );

  function onForced(result: SensorSimulateResponse) {
    setLastForced(result);
    // Follow the condition into the trace panel: the rain gauge is the
    // instrument the forced condition moves first and most visibly.
    setPicked({ regionId: result.region_id, sensorType: 'RAIN_GAUGE' });
    setRegionFilter(null);
    // The simulation wrote rows and re-scored the slope, so the map, the
    // dashboard and the alert queue are all now behind.
    refresh();
  }

  const columns: Column<SensorReading>[] = [
    {
      key: 'instrument',
      header: 'Instrument',
      width: 'w-[14rem]',
      hint: 'Software model of the named field instrument. No hardware exists.',
      cell: (row) => {
        const Icon = TYPE_ICON[row.sensor_type] ?? Radio;
        return (
          <span className="flex min-w-0 items-center gap-2">
            <Icon className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
            <TwoLine primary={row.label} secondary={row.sensor_code} />
          </span>
        );
      },
      sort: (row) => row.label,
    },
    {
      key: 'region',
      header: 'Region',
      hideBelow: 'sm',
      cell: (row) => <TwoLine primary={row.region_name} secondary={row.region_code} />,
      sort: (row) => row.region_name,
    },
    {
      key: 'reading',
      header: 'Reading',
      align: 'right',
      width: 'w-[9.5rem]',
      hint: 'Simulated value. The bar ticks the instrument’s own elevated and alarm thresholds.',
      cell: (row) => (
        <span className="block min-w-0">
          <span
            className="tnum block font-mono"
            style={{ color: SENSOR_STATUS_HEX[row.status] }}
          >
            {fmtReading(row.reading, row.unit)}
          </span>
          <Meter
            value={row.reading}
            max={Math.max(row.alarm_at * 1.2, row.reading, 1)}
            hex={SENSOR_STATUS_HEX[row.status]}
            marks={[row.elevated_at, row.alarm_at]}
            height="h-0.5"
            className="mt-1"
            label={`${row.label} at ${row.region_name}`}
          />
        </span>
      ),
      sort: (row) => row.reading,
    },
    {
      key: 'status',
      header: 'State',
      cell: (row) => <SensorStatusChip status={row.status} />,
      sort: (row) => STATUS_RANK[row.status] ?? 0,
    },
    {
      key: 'thresholds',
      header: 'Elev / alarm',
      align: 'right',
      hideBelow: 'xl',
      hint: 'Sent with the reading by the API, never held in the UI.',
      cell: (row) => (
        <NumCell className="text-2xs text-dim">
          {decimal(row.elevated_at)} / {decimal(row.alarm_at)}
        </NumCell>
      ),
      sort: (row) => row.alarm_at,
    },
    {
      key: 'real_world',
      header: 'Stands in for',
      hideBelow: 'lg',
      cell: (row) => (
        <span className="block truncate text-2xs text-dim" title={row.real_world}>
          {truncate(row.real_world, 46)}
        </span>
      ),
      sort: (row) => row.real_world,
    },
    {
      key: 'recorded',
      header: 'Generated',
      align: 'right',
      hideBelow: 'md',
      cell: (row) => (
        <span className="text-2xs text-faint" title={formatDateTime(row.recorded_at)}>
          {relativeTime(row.recorded_at)}
        </span>
      ),
      sort: (row) => row.recorded_at,
    },
  ];

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title="Virtual sensor network"
        lead="Software-modelled instruments on the slopes a real deployment would wire up first. Every reading is generated by a model of the instrument, not measured by one, and is labelled SIMULATED wherever it appears."
        right={
          <>
            <ModeChip mode="SIMULATED" />
            <span className="font-mono text-2xs uppercase tracking-wider text-faint">
              {scenarioLabel}
            </span>
          </>
        }
      />

      <div className="panel flex items-start gap-3 border-accentdim/40 bg-accent/5 px-4 py-3">
        <Cpu className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 space-y-1">
          <p className="font-display text-2xs font-semibold uppercase tracking-[0.14em] text-accent">
            Simulated sensor data &middot; no hardware
          </p>
          <p className="text-xs leading-relaxed text-dim">
            There is no Arduino, no Raspberry Pi and no gauge on a hillside anywhere in this
            platform. Each reading is computed from the same slope state the risk engine sees,
            through a physical model of how that instrument would respond. The point is not to
            imitate hardware: it is to show what the platform does with instrument data when a
            deployment has it, and to let an operator force a condition a real slope cannot be
            asked to produce on demand.
          </p>
        </div>
      </div>

      {counts && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <StatTile
            label="Instruments"
            value={fmtCount(counts.total)}
            icon={<Radio className="h-3.5 w-3.5" aria-hidden />}
            hint="Simulated instruments currently modelled."
            footer="software models"
          />
          <StatTile
            label="Regions"
            value={fmtCount(counts.regions)}
            hint="Slopes carrying instruments in this view."
            footer="five instruments each"
          />
          <StatTile
            label="In alarm"
            value={fmtCount(counts.ALARM)}
            tone="text-risk-critical"
            hint="Readings past the instrument's own alarm threshold."
            footer="past alarm threshold"
          />
          <StatTile
            label="Elevated"
            value={fmtCount(counts.ELEVATED)}
            tone="text-risk-moderate"
            hint="Above the elevated threshold, below alarm."
            footer="worth watching"
          />
          <StatTile
            label="Normal"
            value={fmtCount(counts.NORMAL)}
            tone="text-risk-verylow"
            hint="Reporting, and within the quiet band."
            footer="within band"
          />
          <StatTile
            label="Not reporting"
            value={fmtCount(counts.OFFLINE)}
            tone="text-faint"
            hint="Modelled as offline, so a gap in the network is visible rather than silent."
            footer="modelled outage"
          />
        </div>
      )}

      {alarming.length > 0 && (
        <div className="panel flex items-start gap-3 border-risk-critical/45 bg-risk-critical/10 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-risk-critical" aria-hidden />
          <div className="min-w-0 space-y-1">
            <p className="font-display text-2xs font-semibold uppercase tracking-[0.14em] text-risk-critical">
              {alarming.length} simulated {alarming.length === 1 ? 'instrument' : 'instruments'} in
              alarm
            </p>
            <p className="text-xs leading-relaxed text-dim">
              {alarming
                .slice(0, 4)
                .map((row) => `${row.label} at ${row.region_name} (${fmtReading(row.reading, row.unit)})`)
                .join(' · ')}
              {alarming.length > 4 && ` · and ${alarming.length - 4} more`}
            </p>
          </div>
        </div>
      )}

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="min-w-0 space-y-4">
          {counts && (
            <Panel
              title="Network state"
              note="simulated"
              busy={network.refreshing}
              right={<ModeChip mode="SIMULATED" compact />}
            >
              <SensorStatusStrip counts={counts} />
            </Panel>
          )}

          <Panel
            title="Instrument readings"
            note={`${rows.length} of ${counts?.total ?? 0}`}
            busy={network.refreshing}
            flush
            right={
              <select
                className="field w-auto py-1 text-xs"
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.target.value as TypeFilter)}
                aria-label="Filter by instrument"
              >
                <option value="ALL">All instruments</option>
                {specs.map((spec) => (
                  <option key={spec.key} value={spec.key}>
                    {spec.label}
                  </option>
                ))}
              </select>
            }
          >
            <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-3 py-2">
              <span className="label mb-0 shrink-0">Region</span>
              <div className="min-w-0 flex-1 sm:max-w-sm">
                <RegionSelect
                  value={regionFilter}
                  onChange={setRegionFilter}
                  blankLabel="Whole network (12 slopes)"
                  className="py-1 text-xs"
                />
              </div>
              <span className="ml-auto hidden text-2xs text-faint sm:block">
                Select a row to plot that instrument’s trace
              </span>
            </div>

            <div className="min-w-0 p-3">
              <ResourceBody
                resource={network}
                loadingRows={8}
                loadingLabel="Generating simulated readings"
                isEmpty={() => rows.length === 0}
                empty={
                  <EmptyState
                    title="No instruments in this view"
                    hint="Clear the instrument filter, or widen the region selection back to the whole network."
                    icon={<Radio className="h-4 w-4" aria-hidden />}
                  />
                }
              >
                {() => (
                  <DataTable
                    rows={rows}
                    columns={columns}
                    rowKey={(row) => row.sensor_code}
                    onRowClick={(row) =>
                      setPicked({ regionId: row.region_id, sensorType: row.sensor_type })
                    }
                    isActive={(row) => samePick(row, picked)}
                    rowClassName={(row) =>
                      row.status === 'ALARM' ? 'bg-risk-critical/10' : undefined
                    }
                    initialSort={{ key: 'status', direction: 'desc' }}
                    maxHeight="max-h-[34rem]"
                    dense
                    caption="Simulated instrument readings. No hardware is involved."
                  />
                )}
              </ResourceBody>
            </div>
          </Panel>

          <SpecPanel specs={specs} />
        </div>

        <div className="min-w-0 space-y-4">
          {active ? (
            <InstrumentTrace key={active.sensor_code} instrument={active} />
          ) : (
            <Panel title="Instrument trace" note="simulated">
              <EmptyState
                title="No instrument selected"
                hint="Readings are still being generated. Once the table fills, the loudest instrument is plotted here automatically."
                icon={<Activity className="h-4 w-4" aria-hidden />}
              />
            </Panel>
          )}

          {canSimulate ? (
            <Panel
              title="Force a condition"
              note="officer"
              right={<Zap className="h-3.5 w-3.5 text-risk-moderate" aria-hidden />}
            >
              <ForceConditionForm
                defaultRegionId={active?.region_id ?? null}
                lastResult={lastForced}
                onForced={onForced}
              />
            </Panel>
          ) : (
            <Panel title="Forcing a condition" note="officer only">
              <div className="space-y-2 text-xs leading-relaxed text-dim">
                <p>
                  Driving a slope into heavy-rain or pre-failure conditions writes readings the
                  whole platform then reads, so it needs the officer role.
                </p>
                <p>
                  {session.authenticated
                    ? `You are signed in as ${session.username}, which can read the network but not write to it.`
                    : 'Sign in as an officer to use it. Reading the network needs no account.'}
                </p>
              </div>
            </Panel>
          )}

          <Panel title="Demonstration" note="platform-wide">
            <DemoConsole />
          </Panel>
        </div>
      </div>

      <Panel title="How to read this screen" note="scope and limits">
        <div className="grid gap-4 text-xs leading-relaxed text-dim sm:grid-cols-3">
          <div className="space-y-1.5">
            <p className="font-display text-2xs font-semibold uppercase tracking-wider text-ink">
              What it is
            </p>
            <p>
              A software model of five instrument types on twelve slopes. Each reading is derived
              from the weather and terrain the risk engine is already using, so an instrument and
              the map agree about the same hillside.
            </p>
          </div>
          <div className="space-y-1.5">
            <p className="font-display text-2xs font-semibold uppercase tracking-wider text-ink">
              What it is not
            </p>
            <p>
              Not a measurement. No instrument in this platform exists physically, nothing is
              wired to it, and no reading here has ever been observed on a real slope. Treat every
              number as the model’s output.
            </p>
          </div>
          <div className="space-y-1.5">
            <p className="font-display text-2xs font-semibold uppercase tracking-wider text-ink">
              Why it is here
            </p>
            <p>
              A deployment with real telemetry replaces this service and nothing else changes: the
              risk engine already consumes instrument state through the same interface. Forcing a
              condition is how the response can be rehearsed without waiting for a storm.
            </p>
          </div>
        </div>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------- the trace

/**
 * One instrument's stored readings.
 *
 * Remounted per instrument through a `key` on the caller, so the window length a
 * reader chose for the rain gauge does not silently carry onto a tiltmeter whose
 * useful window is different.
 */
function InstrumentTrace({ instrument }: { instrument: SensorReading }) {
  const { version, refreshSeconds } = usePlatform();
  const [points, setPoints] = useState(48);

  const history = useResource<SensorHistoryResponse>(
    (signal) =>
      api.sensorHistory(
        { region_id: instrument.region_id, sensor_type: instrument.sensor_type, points },
        signal,
      ),
    [version, instrument.region_id, instrument.sensor_type, points],
    { pollSeconds: refreshSeconds },
  );

  return (
    <Panel
      title="Instrument trace"
      note={instrument.sensor_code}
      busy={history.refreshing}
      right={
        <select
          className="field w-auto py-1 text-xs"
          value={points}
          onChange={(event) => setPoints(Number(event.target.value))}
          aria-label="Readings to plot"
        >
          {POINT_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              last {choice}
            </option>
          ))}
        </select>
      }
    >
      <ResourceBody
        resource={history}
        loadingRows={5}
        loadingLabel="Loading stored readings"
        isEmpty={(data) => data.readings.length === 0}
        empty={
          <EmptyState
            title="No stored readings yet"
            hint="Readings accumulate as the platform scores this slope, and a forced condition writes an hourly trace immediately."
            icon={<Activity className="h-4 w-4" aria-hidden />}
          />
        }
      >
        {(data) => (
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-display text-sm font-semibold text-ink">
                  {data.label}
                </p>
                <p className="truncate text-2xs text-faint">{data.region_name}</p>
              </div>
              <SensorStatusChip status={instrument.status} />
            </div>

            <SensorHistoryChart history={data} height={186} />

            <div className="rule" />

            <div>
              <KeyValue label="Current" value={fmtReading(instrument.reading, data.unit)} />
              <KeyValue
                label="Elevated at"
                value={`${decimal(data.elevated_at)} ${data.unit}`}
                title="Threshold sent by the API with the reading."
              />
              <KeyValue label="Alarm at" value={`${decimal(data.alarm_at)} ${data.unit}`} />
              <KeyValue label="Stored readings" value={fmtCount(data.count)} />
              <KeyValue label="Provenance" value={<ModeChip mode="SIMULATED" compact />} mono={false} />
            </div>

            <div className="space-y-1.5 rounded-panel border border-hairline bg-ground/40 px-3 py-2">
              <p className="text-xs leading-relaxed text-dim">{data.purpose}</p>
              <p className="text-2xs leading-relaxed text-faint">
                Stands in for: {data.real_world}. {data.note}
              </p>
            </div>
          </div>
        )}
      </ResourceBody>
    </Panel>
  );
}

// ------------------------------------------------------- forcing a condition

/**
 * Drive one slope's instruments into an abnormal state.
 *
 * The conditions are fetched rather than listed here, so what the buttons offer
 * is exactly what the simulator implements. The window is offered in hours
 * because the backend writes one row per hour across it, which is what makes the
 * trace show a condition developing instead of stepping.
 */
function ForceConditionForm({
  defaultRegionId,
  lastResult,
  onForced,
}: {
  defaultRegionId: number | null;
  lastResult: SensorSimulateResponse | null;
  onForced: (result: SensorSimulateResponse) => void;
}) {
  const { version } = usePlatform();
  const [regionId, setRegionId] = useState<number | null>(null);
  const [condition, setCondition] = useState<SensorConditionKey>('HEAVY_RAIN');
  const [minutes, setMinutes] = useState(180);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const conditions = useResource<SensorConditionsResponse>(
    (signal) => api.sensorConditions(signal),
    [version],
  );
  const choices = conditions.data?.conditions ?? [];

  // Falls back to whichever instrument is open on the left, so the common case -
  // "make this one alarm" - needs no second selection.
  const target = regionId ?? defaultRegionId;

  async function submit() {
    if (target === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.simulateSensors({ region_id: target, condition, minutes });
      onForced(result);
    } catch (cause) {
      setError(asApiError(cause, '/sensors/simulate'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="label" htmlFor="force-region">
          Slope
        </label>
        <RegionSelect
          id="force-region"
          value={regionId}
          onChange={setRegionId}
          blankLabel={
            defaultRegionId === null ? 'Choose a slope' : 'The instrument selected on the left'
          }
        />
      </div>

      <div>
        <span className="label">Condition</span>
        <div className="space-y-1.5">
          {choices.map((choice) => {
            const on = choice.key === condition;
            return (
              <button
                key={choice.key}
                type="button"
                onClick={() => setCondition(choice.key)}
                aria-pressed={on}
                className={cx(
                  'block w-full rounded-panel border px-3 py-2 text-left transition-colors',
                  on
                    ? 'border-accent/60 bg-accent/10'
                    : 'border-hairline bg-raised hover:border-hairbright',
                )}
              >
                <span
                  className={cx(
                    'block font-display text-xs font-semibold uppercase tracking-wider',
                    on ? 'text-accent' : 'text-ink',
                  )}
                >
                  {choice.label}
                </span>
                <span className="tnum mt-0.5 block font-mono text-2xs text-faint">
                  rainfall &times;{decimal(choice.rainfall_multiplier)} &middot; soil moisture
                  {choice.soil_moisture_added_pct >= 0 ? ' +' : ' '}
                  {decimal(choice.soil_moisture_added_pct)} pp
                </span>
              </button>
            );
          })}
          {conditions.loading && choices.length === 0 && (
            <p className="text-2xs text-faint">Loading the conditions the simulator offers…</p>
          )}
          <InlineError error={conditions.error} />
        </div>
      </div>

      <div>
        <span className="label">Window</span>
        <div className="flex flex-wrap gap-1.5">
          {MINUTE_CHOICES.map((choice) => (
            <button
              key={choice}
              type="button"
              onClick={() => setMinutes(choice)}
              aria-pressed={choice === minutes}
              className={cx(
                'btn px-2.5 py-1',
                choice === minutes && 'border-accent/60 bg-accent/10 text-accent',
              )}
            >
              {choice / 60} h
            </button>
          ))}
        </div>
        <p className="mt-1 text-2xs leading-relaxed text-faint">
          One reading is written per hour across the window, so the trace shows the condition
          developing rather than jumping to it.
        </p>
      </div>

      <button
        type="button"
        className="btn btn-accent w-full"
        onClick={() => void submit()}
        disabled={busy || target === null}
      >
        <Zap className="h-3.5 w-3.5" aria-hidden />
        {busy ? 'Writing readings…' : 'Force condition and re-score'}
      </button>

      <InlineError error={error} />

      <p className="text-2xs leading-relaxed text-faint">
        This writes rows to the database, all stamped SIMULATED, then scores the slope in the state
        the instruments describe using the same model as the map. It is decision support for a
        rehearsal, not an observation of a real hillside.
      </p>

      {lastResult && (
        <div className="space-y-2 rounded-panel border border-hairline bg-ground/40 px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <p className="min-w-0 truncate font-display text-xs font-semibold text-ink">
              {lastResult.region_name}
            </p>
            <ModeChip mode={lastResult.data_mode} compact />
          </div>
          <div className="flex items-baseline gap-2">
            <span
              className={cx(
                'tnum font-display text-2xl font-semibold leading-none',
                palette(lastResult.risk.risk_level).text,
              )}
            >
              {fmtScore(lastResult.risk.risk_score)}
            </span>
            <span
              className={cx(
                'font-display text-2xs font-semibold uppercase tracking-wider',
                palette(lastResult.risk.risk_level).text,
              )}
            >
              {lastResult.risk.risk_level}
            </span>
          </div>
          <div>
            <KeyValue label="Applied" value={lastResult.applied_condition} mono={false} />
            <KeyValue label="Rows written" value={fmtCount(lastResult.inserted_rows)} />
            <KeyValue
              label="In alarm"
              value={
                lastResult.alarming.length > 0
                  ? lastResult.alarming.join(', ')
                  : 'none'
              }
              mono={false}
            />
          </div>
          <p className="text-2xs leading-relaxed text-faint">{lastResult.note}</p>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------- what each one models

/**
 * The five instrument types, with what they measure and what they stand in for.
 *
 * Served by the API rather than described here, so a retuned threshold or a new
 * instrument appears on this screen without a frontend change - and so this
 * panel can never claim a specification the simulator does not implement.
 */
function SpecPanel({ specs }: { specs: SensorTypeSpec[] }) {
  if (specs.length === 0) return null;

  return (
    <Panel title="What each instrument models" note="from the API">
      <ul className="grid gap-3 sm:grid-cols-2">
        {specs.map((spec) => {
          const Icon = TYPE_ICON[spec.key] ?? Radio;
          return (
            <li
              key={spec.key}
              className="min-w-0 rounded-panel border border-hairline bg-ground/40 px-3 py-2.5"
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="flex min-w-0 items-center gap-2">
                  <Icon className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
                  <span className="truncate font-display text-xs font-semibold text-ink">
                    {spec.label}
                  </span>
                </p>
                <span className="tnum shrink-0 font-mono text-2xs text-faint">{spec.unit}</span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-dim">{spec.purpose}</p>
              <p className="tnum mt-1.5 font-mono text-2xs text-faint">
                elevated {decimal(spec.elevated_at)} &middot; alarm {decimal(spec.alarm_at)}
              </p>
              <p className="mt-0.5 text-2xs leading-relaxed text-faint">
                Stands in for {spec.real_world}.
              </p>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

