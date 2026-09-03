/**
 * The command centre.
 *
 * This is `/`, the first screen, and the one a demonstration opens on, so it has
 * a single job: say what the monitored country looks like right now in the time
 * it takes to glance at it, then offer a way in to everything else.
 *
 * Every figure here is read from `/api/overview`, `/api/risk-map` and
 * `/api/alerts`. Not one of them is a constant chosen to look impressive, which
 * is why they all move when a scenario is loaded, and why the country reads VERY
 * LOW on a calm day instead of sitting permanently amber to look busy.
 *
 * Three requests rather than one. The national roll-up, the map layer and the
 * alert queue are three endpoints with three different costs, and keeping them
 * apart means a failure in one leaves the other two on screen - each panel wraps
 * its own `ResourceBody`, which owns that panel's skeleton, error and stale note.
 */
import { Activity, AlertTriangle, BellRing, Gauge, Radio, ShieldAlert, Users } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';

import { PageHeader } from '../components/AppShell';
import { AlertStatusChip, ModeChip, RiskChip, SeverityChip } from '../components/Chips';
import { Panel, ResourceBody } from '../components/Panel';
import { BandBar, StatTile } from '../components/Readouts';
import { DemoConsole } from '../components/ScenarioControls';
import { EmptyState } from '../components/States';
import { DataTable, NumCell, TwoLine, type Column } from '../components/Table';
import {
  count as fmtCount,
  people,
  place,
  relativeTime,
  score as fmtScore,
} from '../lib/format';
import { palette, paletteForScore, rank, severityPalette } from '../lib/risk';
import { RiskMap } from '../maps/RiskMap';
import { api } from '../services/api';
import { usePlatform } from '../state/PlatformContext';
import { useResource } from '../state/useResource';
import type {
  Alert,
  AlertListResponse,
  OverviewResponse,
  RiskMapResponse,
  TopRegion,
} from '../types/api';

/**
 * The strip of national figures.
 *
 * Split out so the loading state is one skeleton for the whole strip rather than
 * six tiles arriving at six different moments, which reads as a page that cannot
 * make up its mind.
 *
 * `country_risk` is the mean of the worst decile, not the national mean, and the
 * tile says so on hover. A national average over dozens of quiet districts would
 * read LOW on the morning one district is being evacuated - the exact morning
 * this screen has to be right.
 */
function NationalStrip({ summary }: { summary: OverviewResponse }) {
  const tone = paletteForScore(summary.country_risk);
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
      <StatTile
        label="Country risk"
        value={fmtScore(summary.country_risk)}
        unit="/ 100"
        tone={tone.text}
        icon={<Gauge className="h-3.5 w-3.5" aria-hidden />}
        hint="Mean score of the worst-scoring tenth of monitored regions, not the national average - an average over many calm districts would hide the one that matters."
        footer={
          <span className="tnum">
            peak {fmtScore(summary.max_score)} · mean {fmtScore(summary.avg_score)}
          </span>
        }
      />
      <StatTile
        label="High risk"
        value={fmtCount(summary.high_risk)}
        unit={`of ${fmtCount(summary.regions_scored)}`}
        tone={summary.high_risk > 0 ? palette('HIGH').text : undefined}
        icon={<AlertTriangle className="h-3.5 w-3.5" aria-hidden />}
        hint="Regions scoring at or above the HIGH alert threshold in the current scenario."
        footer="Score 61 and above"
      />
      <StatTile
        label="Critical"
        value={fmtCount(summary.critical)}
        tone={summary.critical > 0 ? palette('CRITICAL').text : undefined}
        icon={<ShieldAlert className="h-3.5 w-3.5" aria-hidden />}
        hint="Regions in the CRITICAL band. Each one raises an alert with a recommended response."
        footer="Score 81 and above"
      />
      <StatTile
        label="Open alerts"
        value={fmtCount(summary.unresolved_alerts)}
        unit={`of ${fmtCount(summary.active_alerts)}`}
        tone={summary.unresolved_alerts > 0 ? palette('HIGH').text : undefined}
        icon={<BellRing className="h-3.5 w-3.5" aria-hidden />}
        hint="Alerts not yet resolved, out of every alert raised in this scenario."
        footer={
          <Link to="/alerts" className="text-accent hover:underline">
            Open the queue
          </Link>
        }
      />
      <StatTile
        label="People exposed"
        value={people(summary.population_exposed)}
        icon={<Users className="h-3.5 w-3.5" aria-hidden />}
        hint="Census-style population of the regions currently in the HIGH or CRITICAL bands. Demo figures held per region in the database."
        footer={`${fmtCount(summary.states_monitored)} states monitored`}
      />
      <StatTile
        label="Instruments"
        value={fmtCount(summary.sensors_alerting)}
        unit={`of ${fmtCount(summary.sensors_total)}`}
        tone={summary.sensors_alerting > 0 ? palette('MODERATE').text : undefined}
        icon={<Radio className="h-3.5 w-3.5" aria-hidden />}
        hint="Simulated instruments reading ELEVATED or ALARM. This platform has no hardware - the virtual network stands in for one."
        footer={
          <Link to="/sensors" className="text-accent hover:underline">
            Simulated network
          </Link>
        }
      />
    </div>
  );
}

/**
 * The worst-scoring regions, in the order the model ranked them.
 *
 * Module-level rather than built per render: nothing in these columns closes over
 * page state, and a fresh array on every poll would make the table's `useMemo`
 * pointless.
 */
const TOP_COLUMNS: Column<TopRegion>[] = [
  {
    key: 'region',
    header: 'Region',
    cell: (row) => <TwoLine primary={row.name} secondary={place(row.district, row.state)} />,
    sort: (row) => row.name,
  },
  {
    key: 'score',
    header: 'Risk',
    align: 'right',
    width: 'w-14',
    sort: (row) => row.risk_score,
    hint: 'Model output for the current scenario, 0-100',
    cell: (row) => (
      <NumCell className={paletteForScore(row.risk_score).text}>
        {fmtScore(row.risk_score)}
      </NumCell>
    ),
  },
  {
    key: 'level',
    header: 'Band',
    width: 'w-28',
    sort: (row) => rank(row.risk_level),
    cell: (row) => <RiskChip level={row.risk_level} />,
  },
  {
    key: 'exposed',
    header: 'Exposed',
    align: 'right',
    hideBelow: 'sm',
    sort: (row) => row.population_exposed,
    hint: 'Population held for this region in the demo region table',
    cell: (row) => <NumCell className="text-dim">{people(row.population_exposed)}</NumCell>,
  },
  {
    key: 'past',
    header: 'Past events',
    align: 'right',
    hideBelow: 'md',
    sort: (row) => row.historical_landslide_count,
    hint: 'Recorded landslides in the archive for this region',
    cell: (row) => (
      <NumCell className="text-dim">{fmtCount(row.historical_landslide_count)}</NumCell>
    ),
  },
];

/**
 * The most recent alerts, newest first.
 *
 * Deliberately read-only here. Acknowledging and assigning belong on the officer
 * desk, where the person doing it is signed in and the audit trail makes sense;
 * a stray click on an overview screen should not change the state of a warning.
 */
const ALERT_COLUMNS: Column<Alert>[] = [
  {
    key: 'alert',
    header: 'Alert',
    cell: (row) => (
      <TwoLine
        primary={row.region_name}
        secondary={<span className="font-mono">{row.alert_code}</span>}
      />
    ),
    sort: (row) => row.region_name,
  },
  {
    key: 'severity',
    header: 'Severity',
    width: 'w-24',
    sort: (row) => (row.severity === 'CRITICAL' ? 1 : 0),
    cell: (row) => <SeverityChip severity={row.severity} />,
  },
  {
    key: 'score',
    header: 'Score',
    align: 'right',
    width: 'w-14',
    sort: (row) => row.risk_score,
    cell: (row) => (
      <NumCell className={severityPalette(row.severity).text}>{fmtScore(row.risk_score)}</NumCell>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    width: 'w-28',
    hideBelow: 'sm',
    sort: (row) => row.status,
    cell: (row) => <AlertStatusChip status={row.status} />,
  },
  {
    key: 'raised',
    header: 'Raised',
    align: 'right',
    hideBelow: 'md',
    sort: (row) => row.created_at,
    cell: (row) => <span className="text-2xs text-faint">{relativeTime(row.created_at)}</span>,
  },
];

/** A faint red wash behind a CRITICAL row, so the eye finds it before reading. */
function criticalTint(critical: boolean): string | undefined {
  return critical ? 'bg-risk-critical/[0.07]' : undefined;
}

export default function Dashboard() {
  const {
    version,
    refreshSeconds,
    thresholds,
    dataMode,
    selectedRegionId,
    selectRegion,
    lastSimulation,
  } = usePlatform();

  // All three keyed on `version`, which the platform bumps after a scenario run
  // or a reset. One bump pulls the whole screen forward together, so the map and
  // the figures above it can never describe two different scenarios.
  const overview = useResource<OverviewResponse>(
    (signal) => api.overview({ top_n: 8 }, signal),
    [version],
    { pollSeconds: refreshSeconds },
  );
  const riskMap = useResource<RiskMapResponse>((signal) => api.riskMap({}, signal), [version], {
    pollSeconds: refreshSeconds,
  });
  const alerts = useResource<AlertListResponse>(
    (signal) => api.alerts({ limit: 6 }, signal),
    [version],
    { pollSeconds: refreshSeconds },
  );

  // Regions that changed band in the last simulation. The map rings them with a
  // dashed halo, which is what makes "watch these six regions escalate" visible
  // rather than something the presenter has to assert.
  const highlighted = useMemo(() => lastSimulation?.highlighted ?? [], [lastSimulation]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Command centre"
        lead="Model-scored landslide risk for every monitored region, the alerts that score raised, and the controls that drive a demonstration."
        right={
          <>
            <ModeChip mode={dataMode} />
            {riskMap.updatedAt && (
              <span className="font-mono text-2xs text-faint">
                scored {relativeTime(riskMap.updatedAt)}
              </span>
            )}
          </>
        }
      />

      <ResourceBody resource={overview} loadingRows={3} loadingLabel="Scoring the network">
        {(summary) => <NationalStrip summary={summary} />}
      </ResourceBody>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Panel
          title="National risk map"
          note={
            riskMap.data
              ? `${fmtCount(riskMap.data.count)} regions scored · ${riskMap.data.scenario_label}`
              : undefined
          }
          busy={riskMap.refreshing}
          flush
        >
          {/* The map needs a definite height or Leaflet renders a zero-height
              container and the tiles never appear. */}
          <ResourceBody resource={riskMap} loadingRows={5} loadingLabel="Building the risk layer">
            {(data) => (
              <RiskMap
                points={data.points}
                counts={data.band_counts}
                thresholds={thresholds}
                highlighted={highlighted}
                selectedRegionId={selectedRegionId}
                onSelectRegion={selectRegion}
                version={version}
                dataMode={data.data_mode}
                busy={riskMap.refreshing}
                className="h-[26rem] xl:h-[34rem]"
              />
            )}
          </ResourceBody>
        </Panel>

        <div className="space-y-4">
          <Panel
            title="Demonstration"
            note="Each control re-scores every region through the trained model and stores the result."
          >
            <DemoConsole onFocusRegion={selectRegion} />
          </Panel>

          <Panel title="Band distribution" busy={riskMap.refreshing}>
            <ResourceBody resource={riskMap} loadingRows={2}>
              {(data) => (
                <div className="space-y-3">
                  <BandBar counts={data.band_counts} />
                  <p className="text-2xs leading-relaxed text-faint">{data.note}</p>
                </div>
              )}
            </ResourceBody>
          </Panel>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title="Highest scoring regions"
          note="Worst first. Select a row to fly the map to it."
          right={
            <Link to="/overview" className="btn btn-ghost">
              National overview
            </Link>
          }
          busy={overview.refreshing}
          flush
        >
          <ResourceBody
            resource={overview}
            isEmpty={(data) => data.top_regions.length === 0}
            empty={
              <EmptyState
                title="Nothing scored yet"
                hint="Run database/seed.py and ml/train_model.py, then reload."
              />
            }
          >
            {(data) => (
              <DataTable
                rows={data.top_regions}
                columns={TOP_COLUMNS}
                rowKey={(row) => row.region_id}
                onRowClick={(row) => selectRegion(row.region_id)}
                isActive={(row) => row.region_id === selectedRegionId}
                rowClassName={(row) => criticalTint(row.risk_level === 'CRITICAL')}
                caption="Monitored regions ranked by model risk score"
                dense
              />
            )}
          </ResourceBody>
        </Panel>

        <Panel
          title="Latest alerts"
          note={
            alerts.data
              ? `${fmtCount(alerts.data.stats.total)} raised · ${fmtCount(
                  alerts.data.stats.new,
                )} unacknowledged`
              : undefined
          }
          right={
            <Link to="/alerts" className="btn btn-ghost">
              All alerts
            </Link>
          }
          busy={alerts.refreshing}
          flush
        >
          <ResourceBody
            resource={alerts}
            isEmpty={(data) => data.alerts.length === 0}
            empty={
              <EmptyState
                title="No alert standing"
                hint={`Nothing has reached the HIGH threshold of ${thresholds.high}. Load a heavier scenario to raise some.`}
                icon={<Activity className="h-5 w-5" />}
              />
            }
          >
            {(data) => (
              <DataTable
                rows={data.alerts}
                columns={ALERT_COLUMNS}
                rowKey={(row) => row.id}
                onRowClick={(row) => selectRegion(row.region_id)}
                isActive={(row) => row.region_id === selectedRegionId}
                rowClassName={(row) => criticalTint(row.severity === 'CRITICAL')}
                initialSort={{ key: 'raised', direction: 'desc' }}
                caption="Most recent alerts raised by the early-warning engine"
                dense
              />
            )}
          </ResourceBody>
        </Panel>
      </div>
    </div>
  );
}

