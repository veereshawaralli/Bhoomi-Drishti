/**
 * The national picture.
 *
 * Every figure on this screen is computed by `overview_service.build` from the
 * platform's own rows at the moment of the request: the model scores each
 * monitored region, the alert, event and report counts are database queries, and
 * the instrument counts come from the virtual network reporting its live state.
 * Nothing here is a constant chosen to look impressive, which is why loading a
 * scenario moves this whole page and not only the map.
 *
 * The headline is deliberately *not* the national mean. It is the mean of the
 * worst decile of scored regions, because an average over sixty-odd districts is
 * dominated by the quiet ones and would read LOW on the day one valley is being
 * evacuated. The panel says so on screen, and names the size of the decile,
 * rather than leaving a number labelled "national risk" to be read as something
 * it is not.
 *
 * The band a score falls in is looked up in the table served by `/api/info`
 * instead of being recomputed from constants here, so the word beside the
 * numeral cannot contradict the engine that assigned it.
 *
 * The two tables are wired into the rest of the platform: choosing a state
 * filters the ranking beside it, and a ranked region can be opened on the map or
 * in the 72-hour forecast, both of which read the same shared selection.
 */
import {
  Activity,
  BellRing,
  FileWarning,
  Layers,
  LineChart,
  MapPin,
  Radio,
  Users,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { PageHeader } from '../components/AppShell';
import { Chip, ModeChip, RiskChip } from '../components/Chips';
import { Panel, ResourceBody } from '../components/Panel';
import { BandBar, KeyValue, Meter, RiskReadout, StatTile } from '../components/Readouts';
import { EmptyState } from '../components/States';
import { DataTable, NumCell, RowActions, TwoLine, type Column } from '../components/Table';
import {
  count,
  decimal,
  formatTime,
  people,
  percent,
  percentPoints,
  place,
  plural,
  score as formatScore,
} from '../lib/format';
import {
  RISK_HEX,
  RISK_LEVELS,
  cx,
  levelFromScore,
  palette,
  type Thresholds,
} from '../lib/risk';
import { api } from '../services/api';
import { usePlatform } from '../state/PlatformContext';
import { useResource } from '../state/useResource';
import type {
  BandCounts,
  OverviewBand,
  OverviewResponse,
  RiskBand,
  RiskLevel,
  StateRollup,
  TopRegion,
} from '../types/api';

/** The endpoint caps `top_n` at 50, so the control offers nothing it would reject. */
const TOP_CHOICES = [10, 20, 50];

const NO_BANDS: BandCounts = {
  'VERY LOW': 0,
  LOW: 0,
  MODERATE: 0,
  HIGH: 0,
  CRITICAL: 0,
};

/**
 * The served band array folded into the record `BandBar` reads.
 *
 * Seeded from every known level rather than from the response alone, so a band
 * the API happened to omit renders as a zero instead of a hole in the bar.
 */
function foldBands(bands: OverviewBand[]): BandCounts {
  const counts: BandCounts = { ...NO_BANDS };
  for (const band of bands) counts[band.level] = band.count;
  return counts;
}

/**
 * Which band a bare score belongs to, using the boundaries `/api/info` served.
 *
 * `country_risk` arrives as a number with no level attached - it is an aggregate
 * over regions, not a prediction about one - and something has to band it before
 * it can be coloured. The lookup uses the platform's own table so this screen
 * cannot invent a boundary; the local constants are only a fallback for the
 * moment before `/api/info` has answered.
 *
 * The comparison is half-open on purpose. The engine's `risk_level` treats a
 * score as HIGH from 60.0 up to but not including 80.0, so testing `<= max` here
 * would colour exactly 60.0 as MODERATE while every region page called it HIGH.
 * The top band takes the closing 100.
 */
function bandFor(value: number, bands: RiskBand[]): RiskLevel {
  const clamped = Math.max(0, Math.min(100, Number(value) || 0));
  const hit = bands.find((band) => clamped >= band.min && clamped < band.max);
  const last = bands.length > 0 ? bands[bands.length - 1] : undefined;
  return hit?.level ?? (last && clamped >= last.min ? last.level : levelFromScore(clamped));
}

/** Mirrors `risk_engine.summarise`: the worst tenth, and never fewer than one. */
function decileSize(scored: number): number {
  return Math.max(1, Math.floor(scored / 10));
}

/**
 * The headline, and the three other numbers that stop it being read wrongly.
 *
 * A lone national figure invites two opposite mistakes: that a low number means
 * the country is safe, and that a high one means every district is in danger.
 * Putting the worst-decile mean beside the plain average and the single worst
 * region makes the shape of the distribution visible, which is the honest
 * version of "national risk".
 */
function NationalFigure({
  data,
  bands,
  thresholds,
}: {
  data: OverviewResponse;
  bands: RiskBand[];
  thresholds: Thresholds;
}) {
  const level = bandFor(data.country_risk, bands);
  const worstLevel = bandFor(data.max_score, bands);
  const decile = decileSize(data.regions_scored);

  return (
    <div className="space-y-3">
      <RiskReadout
        score={data.country_risk}
        level={level}
        marks={[thresholds.high, thresholds.critical]}
        caption={
          <>
            The mean of the worst {plural(decile, 'region')} of{' '}
            {count(data.regions_scored)} scored — a tenth of the network, rounded down. The ticks
            on the bar are the alert thresholds at {formatScore(thresholds.high)} and{' '}
            {formatScore(thresholds.critical)}.
          </>
        }
      />
      <div className="rule" />
      <div>
        <KeyValue
          label="Mean, all regions"
          value={decimal(data.avg_score, 1)}
          title="The plain national average, shown for contrast: it is the figure that would hide a local emergency."
        />
        <KeyValue
          label="Worst single region"
          value={<span className={palette(worstLevel).text}>{decimal(data.max_score, 1)}</span>}
          title="The highest score any monitored region currently holds."
        />
        <KeyValue
          label="At HIGH or above"
          value={`${count(data.high_risk)} of ${count(data.regions_scored)}`}
          title="Regions the alert engine would act on at this moment."
        />
        <KeyValue
          label="Of those, CRITICAL"
          value={
            <span className={data.critical > 0 ? palette('CRITICAL').text : undefined}>
              {count(data.critical)}
            </span>
          }
        />
      </div>
      <p className="text-2xs leading-relaxed text-faint">
        Scored under the {data.scenario_label.toLowerCase()} scenario · computed{' '}
        {formatTime(data.generated_at)}, when this screen last asked.
      </p>
    </div>
  );
}

/**
 * How the network is spread across the five bands.
 *
 * The counts and percentages are the ones the API served. The sentence beside
 * each band is the platform's own description of what that band means, read from
 * `/api/info` - so changing the band table changes this list without anyone
 * editing this file, and the legend can never describe a scheme the engine has
 * stopped using.
 */
function BandSpread({ data, bands }: { data: OverviewResponse; bands: RiskBand[] }) {
  const counts = useMemo(() => foldBands(data.bands), [data.bands]);

  const meaning = useMemo(() => {
    const table: Partial<Record<RiskLevel, string>> = {};
    for (const band of bands) table[band.level] = band.meaning;
    return table;
  }, [bands]);

  const served = useMemo(() => {
    const table: Partial<Record<RiskLevel, OverviewBand>> = {};
    for (const band of data.bands) table[band.level] = band;
    return table;
  }, [data.bands]);

  const unscored = Math.max(0, data.regions_total - data.regions_scored);

  return (
    <div className="space-y-3">
      <BandBar counts={counts} showLegend={false} />
      <ul className="space-y-1.5">
        {RISK_LEVELS.map((level) => {
          const row = served[level];
          return (
            <li key={level} className="flex items-center gap-2">
              <span
                className="h-2 w-2 shrink-0 rounded-sm"
                style={{ backgroundColor: RISK_HEX[level] }}
                aria-hidden
              />
              <span className="w-20 shrink-0 text-2xs uppercase tracking-wider text-dim">
                {level}
              </span>
              <span className="tnum w-8 shrink-0 text-right font-mono text-xs text-ink">
                {count(row?.count ?? 0)}
              </span>
              <span className="tnum w-12 shrink-0 text-right font-mono text-2xs text-faint">
                {percentPoints(row?.percent ?? 0)}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-2xs text-faint"
                title={meaning[level]}
              >
                {meaning[level] ?? ''}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="text-2xs leading-relaxed text-faint">
        Shares are of the {count(data.regions_scored)} regions scored on this request, not of the
        country’s area or its population.
        {unscored > 0 && ` Regions the model could not score (${count(unscored)}) are absent from the bar.`}
      </p>
    </div>
  );
}

/**
 * The response system in six figures.
 *
 * These are counts of things that exist - alerts raised, reports waiting,
 * instruments in alarm, events on file - rather than model output, which is why
 * they sit apart from the score above. Exposure leads, because it is the figure
 * that decides how many people a district actually has to reach.
 */
function SystemStrip({ data }: { data: OverviewResponse }) {
  const alerts = data.alert_counts;
  const exposedTone = data.population_exposed > 0 ? palette('HIGH').text : undefined;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
      <StatTile
        label="People exposed"
        value={people(data.population_exposed)}
        icon={<Users className="h-3.5 w-3.5" />}
        tone={exposedTone}
        hint="Population of the regions currently scored HIGH or CRITICAL. Everything below that band is excluded, so this figure falls again as the scores fall."
        footer={`across ${plural(data.high_risk, 'region')} at HIGH or above`}
      />
      <StatTile
        label="Open alerts"
        value={count(data.unresolved_alerts)}
        icon={<BellRing className="h-3.5 w-3.5" />}
        tone={data.unresolved_alerts > 0 ? palette('CRITICAL').text : undefined}
        hint="Alerts whose status is NEW, ACKNOWLEDGED or IN PROGRESS. Resolved ones are excluded."
        footer={`${count(alerts.new)} new · ${count(alerts.critical)} critical · ${count(alerts.resolved)} resolved`}
      />
      <StatTile
        label="Reports waiting"
        value={count(data.reports_pending)}
        icon={<FileWarning className="h-3.5 w-3.5" />}
        hint="Citizen reports still marked NEW or UNDER REVIEW, so still somebody's job."
        footer="submitted from the public portal"
      />
      <StatTile
        label="Instruments in alarm"
        value={`${count(data.sensors_alerting)} / ${count(data.sensors_total)}`}
        icon={<Radio className="h-3.5 w-3.5" />}
        tone={data.sensors_alerting > 0 ? palette('HIGH').text : undefined}
        hint="Virtual instruments reporting an alarm. The whole network is software: no hardware exists anywhere in this project."
        footer="SIMULATED SENSOR DATA"
      />
      <StatTile
        label="Events on file"
        value={count(data.events_total)}
        icon={<Activity className="h-3.5 w-3.5" />}
        hint="Rows in the landslide inventory. Mixed provenance - the history screen labels each row."
        footer={`${count(data.events_this_year)} dated this year`}
      />
      <StatTile
        label="States monitored"
        value={count(data.states_monitored)}
        icon={<Layers className="h-3.5 w-3.5" />}
        hint="States holding at least one monitored region. Not a claim of national coverage."
        footer={`${count(data.regions_total)} regions in all`}
      />
    </div>
  );
}

/**
 * The scope of this screen, stated on the screen.
 *
 * The served `note` is echoed rather than paraphrased. The backend is the thing
 * that knows which scenario produced these figures and how that scenario is
 * labelled, and a hand-written copy here would drift away from it the first time
 * either changed.
 */
function ReadingNote({ data }: { data: OverviewResponse }) {
  return (
    <Panel title="How to read this page">
      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <p className="mb-1 font-display text-2xs font-semibold uppercase tracking-wider text-dim">
            What it is
          </p>
          <p className="text-2xs leading-relaxed text-faint">
            The platform describing its own state. Every score is the trained model run against a
            monitored region on this request, and every count is a query over the same tables the
            officer screens write to. Nothing on this page is a figure typed into the interface.
          </p>
        </div>
        <div>
          <p className="mb-1 font-display text-2xs font-semibold uppercase tracking-wider text-risk-moderate">
            What it is not
          </p>
          <p className="text-2xs leading-relaxed text-faint">{data.note}</p>
          <p className="mt-1.5 text-2xs leading-relaxed text-faint">
            A calm national figure says nothing about any particular slope, and a state missing
            from the table above is a state with no monitored region — not a safe one.
          </p>
        </div>
        <div>
          <p className="mb-1 font-display text-2xs font-semibold uppercase tracking-wider text-dim">
            Replacing the inputs
          </p>
          <p className="text-2xs leading-relaxed text-faint">
            Give the weather service real credentials and point the terrain loader at a real DEM,
            and the only visible change here is the mode chip reading LIVE DATA. This screen holds
            no figures of its own: it renders what the API serves, so improving the inputs improves
            the page without touching it.
          </p>
        </div>
      </div>
    </Panel>
  );
}

/** The national overview screen. */
export default function OverviewPage() {
  const {
    version,
    refreshSeconds,
    scenario,
    thresholds,
    bands: infoBands,
    dataMode,
    selectedRegionId,
    selectRegion,
  } = usePlatform();
  const navigate = useNavigate();

  const [topN, setTopN] = useState(10);
  const [stateFilter, setStateFilter] = useState('');

  /**
   * Polled on the interval the backend recommends, and refetched on every
   * `version` bump: loading a scenario re-scores the whole network, and a
   * national page describing the previous scenario is worse than a blank one.
   *
   * `scenario` is sent explicitly rather than left to the server's stored value
   * so the response cannot describe a different world from the header chip.
   */
  const overview = useResource<OverviewResponse>(
    (signal) => api.overview({ scenario, top_n: topN }, signal),
    [version, scenario, topN],
    { pollSeconds: refreshSeconds },
  );

  const data = overview.data;
  const states = data?.states ?? [];

  // The ranking is national - the state filter narrows what is already served
  // rather than asking for a state's own top ten, which the endpoint does not
  // offer. The panel says so, because otherwise an empty result looks like a bug.
  const ranked = useMemo(() => {
    const rows = data?.top_regions ?? [];
    return stateFilter ? rows.filter((row) => row.state === stateFilter) : rows;
  }, [data, stateFilter]);

  /** Selecting the region and then navigating: both screens read the selection. */
  const openRegion = (region: TopRegion, where: '/map' | '/forecast') => {
    selectRegion(region.region_id);
    navigate(where);
  };

  const stateColumns: Column<StateRollup>[] = [
    {
      key: 'state',
      header: 'State',
      cell: (row) => <TwoLine primary={row.state} secondary={plural(row.regions, 'region')} />,
      sort: (row) => row.state,
    },
    {
      key: 'peak',
      header: 'Worst',
      align: 'right',
      width: 'w-24',
      hint: 'The highest score any monitored region in that state currently holds. The tick is the HIGH threshold.',
      sort: (row) => row.max_score,
      cell: (row) => {
        const level = bandFor(row.max_score, infoBands);
        return (
          <span className="ml-auto flex w-20 flex-col items-end gap-1">
            <NumCell className={palette(level).text}>{decimal(row.max_score, 1)}</NumCell>
            <Meter
              value={row.max_score}
              hex={RISK_HEX[level]}
              height="h-1"
              marks={[thresholds.high]}
              label={`Worst score in ${row.state}`}
            />
          </span>
        );
      },
    },
    {
      key: 'high',
      header: 'High+',
      align: 'right',
      width: 'w-16',
      hint: 'Regions in that state scored HIGH or CRITICAL right now.',
      sort: (row) => row.high,
      cell: (row) => (
        <NumCell className={row.high > 0 ? palette('HIGH').text : 'text-faint'}>
          {count(row.high)}
        </NumCell>
      ),
    },
  ];

  const regionColumns: Column<TopRegion>[] = [
    {
      key: 'region',
      header: 'Region',
      cell: (row) => (
        <TwoLine primary={row.name} secondary={place(row.district, row.state)} />
      ),
      sort: (row) => row.name,
    },
    {
      key: 'score',
      header: 'Risk',
      align: 'right',
      width: 'w-32',
      hint: 'Model score out of 100 under the active scenario, with the band the engine assigned it.',
      sort: (row) => row.risk_score,
      cell: (row) => (
        <span className="flex items-center justify-end gap-2">
          <NumCell className={palette(row.risk_level).text}>
            {decimal(row.risk_score, 1)}
          </NumCell>
          <RiskChip level={row.risk_level} />
        </span>
      ),
    },
    {
      key: 'confidence',
      header: 'Agreement',
      align: 'right',
      width: 'w-24',
      hideBelow: 'lg',
      hint: 'How closely the model’s members agreed on this score. It is not the probability of a landslide.',
      sort: (row) => row.confidence,
      cell: (row) => <NumCell className="text-dim">{percent(row.confidence)}</NumCell>,
    },
    {
      key: 'exposed',
      header: 'People',
      align: 'right',
      width: 'w-20',
      hideBelow: 'md',
      hint: 'Population recorded for the region, whatever band it is in today.',
      sort: (row) => row.population_exposed ?? 0,
      cell: (row) => <NumCell className="text-dim">{people(row.population_exposed)}</NumCell>,
    },
    {
      key: 'history',
      header: 'Past',
      align: 'right',
      width: 'w-16',
      hideBelow: 'xl',
      hint: 'Landslides on file for this region. A feature the model reads, and a blank means the record is silent.',
      sort: (row) => row.historical_landslide_count ?? 0,
      cell: (row) => (
        <NumCell className="text-dim">{count(row.historical_landslide_count)}</NumCell>
      ),
    },
    {
      key: 'open',
      header: '',
      align: 'right',
      width: 'w-20',
      cell: (row) => (
        <RowActions>
          <button
            type="button"
            className="btn btn-ghost px-1.5 py-1"
            title={`Show ${row.name} on the risk map`}
            onClick={() => openRegion(row, '/map')}
          >
            <MapPin className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">Show {row.name} on the map</span>
          </button>
          <button
            type="button"
            className="btn btn-ghost px-1.5 py-1"
            title={`72-hour forecast for ${row.name}`}
            onClick={() => openRegion(row, '/forecast')}
          >
            <LineChart className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">Open the 72-hour forecast for {row.name}</span>
          </button>
        </RowActions>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="National risk overview"
        lead="What the platform currently believes about the whole monitored network: how the regions are banded, which of them are worst, how many people are under a high score, and what the response system is carrying. Change the scenario in the header and every figure here moves, because none of them is written into this screen."
        right={
          <div className="flex flex-wrap items-center gap-1.5">
            {data && (
              <Chip className="border-hairbright bg-raised text-dim">
                {count(data.regions_scored)} of {count(data.regions_total)} regions scored
              </Chip>
            )}
            {data && (
              <Chip className="border-hairbright bg-raised text-dim">{data.scenario_label}</Chip>
            )}
            <ModeChip mode={data?.data_mode ?? dataMode} />
          </div>
        }
      />

      <Panel
        title="The national picture"
        note={data ? `computed ${formatTime(data.generated_at)}` : undefined}
        busy={overview.refreshing}
      >
        <ResourceBody
          resource={overview}
          loadingRows={5}
          loadingLabel="Scoring every monitored region"
        >
          {(payload) => (
            <div className="grid gap-5 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
              <NationalFigure data={payload} bands={infoBands} thresholds={thresholds} />
              <div className="space-y-2">
                <p className="font-display text-2xs font-semibold uppercase tracking-[0.12em] text-faint">
                  Where the regions sit
                </p>
                <BandSpread data={payload} bands={infoBands} />
              </div>
            </div>
          )}
        </ResourceBody>
      </Panel>

      {data && (
        <>
          <SystemStrip data={data} />

          <div className="grid gap-4 xl:grid-cols-[minmax(0,21rem)_minmax(0,1fr)]">
            <Panel
              title="By state"
              note={plural(states.length, 'state')}
              busy={overview.refreshing}
              flush
            >
              <div className="min-w-0 p-3">
                <DataTable
                  rows={states}
                  columns={stateColumns}
                  rowKey={(row) => row.state}
                  onRowClick={(row) =>
                    setStateFilter((current) => (current === row.state ? '' : row.state))
                  }
                  isActive={(row) => row.state === stateFilter}
                  initialSort={{ key: 'peak', direction: 'desc' }}
                  maxHeight="max-h-[24rem]"
                  caption="Monitored regions rolled up by state, worst first"
                  emptyTitle="No state has a scored region"
                  emptyHint="Nothing has been scored yet, so there is nothing to roll up."
                  dense
                />
                <p className="mt-2 text-2xs leading-relaxed text-faint">
                  A state is shown by its worst region rather than its average — a state is only as
                  calm as its loudest slope. Click a row to narrow the ranking beside it, and click
                  it again to clear.
                </p>
              </div>
            </Panel>

            <Panel
              title="Regions the model is most worried about"
              note={stateFilter ? `filtered to ${stateFilter}` : `top ${count(topN)} nationally`}
              busy={overview.refreshing}
              right={
                <div className="flex items-center gap-1">
                  <span className="mr-0.5 font-mono text-2xs uppercase tracking-wider text-faint">
                    Rank
                  </span>
                  {TOP_CHOICES.map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      className={cx(
                        'btn px-2 py-0.5 text-2xs',
                        topN === choice ? 'btn-accent' : 'btn-ghost',
                      )}
                      onClick={() => setTopN(choice)}
                      aria-pressed={topN === choice}
                      title={`Ask the API for the worst ${choice} regions`}
                    >
                      {choice}
                    </button>
                  ))}
                  {stateFilter && (
                    <button
                      type="button"
                      className="btn btn-ghost ml-1 px-2 py-0.5 text-2xs"
                      onClick={() => setStateFilter('')}
                    >
                      Clear {stateFilter}
                    </button>
                  )}
                </div>
              }
              flush
            >
              <div className="min-w-0 p-3">
                <DataTable
                  rows={ranked}
                  columns={regionColumns}
                  rowKey={(row) => row.region_id}
                  onRowClick={(row) => selectRegion(row.region_id)}
                  isActive={(row) => row.region_id === selectedRegionId}
                  rowClassName={(row) =>
                    row.risk_level === 'CRITICAL' ? 'bg-risk-critical/[0.06]' : undefined
                  }
                  initialSort={{ key: 'score', direction: 'desc' }}
                  maxHeight="max-h-[24rem]"
                  caption="Monitored regions ranked by model risk score"
                  empty={
                    <EmptyState
                      title={
                        stateFilter
                          ? `No ${stateFilter} region in the worst ${count(topN)}`
                          : 'Nothing has been scored'
                      }
                      hint={
                        stateFilter
                          ? 'The ranking is national. Ask for more regions, or clear the filter.'
                          : 'Load a scenario from the header to score the network.'
                      }
                    />
                  }
                  dense
                />
                <p className="mt-2 text-2xs leading-relaxed text-faint">
                  Clicking a row selects the region; the two buttons open it on the risk map or in
                  its 72-hour forecast, both of which read the same selection. Scores are model
                  output for the active scenario, not observations.
                </p>
              </div>
            </Panel>
          </div>

          <ReadingNote data={data} />
        </>
      )}
    </div>
  );
}
