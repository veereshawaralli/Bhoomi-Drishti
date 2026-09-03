/**
 * The alert queue: what the platform is warning about, and what has been done
 * about it.
 *
 * Three decisions shape this screen.
 *
 * Reading is open, acting is not. Anyone can see the queue - a warning nobody
 * can read is not a warning - but acknowledging, assigning and resolving are
 * operational acts with a name attached, so those controls render only when the
 * session actually holds the officer capability. The backend enforces it either
 * way; this only avoids offering a button that would fail the moment it was
 * pressed.
 *
 * The transition buttons are drawn from `ALERT_TRANSITIONS`, which mirrors the
 * state machine in `alert_service`. An officer is never shown a move the API
 * would reject with a 409.
 *
 * Every row on this page came out of the model crossing a threshold, or out of
 * an officer's own observation. Nothing here is invented by the interface: the
 * score, the cause and the recommended action are all stored with the alert, and
 * the data-mode chip on each one says which world it was raised in.
 */
import { AlertTriangle, BellRing, CheckCircle2, Send, ShieldCheck } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';

import { PageHeader } from '../components/AppShell';
import { AlertStatusChip, ModeChip, SeverityChip } from '../components/Chips';
import { Panel, ResourceBody } from '../components/Panel';
import { KeyValue, Meter, StatTile } from '../components/Readouts';
import { RegionSelect } from '../components/RegionPicker';
import { DemoConsole } from '../components/ScenarioControls';
import { EmptyState, InlineError } from '../components/States';
import { DataTable, NumCell, RowActions, TwoLine, type Column } from '../components/Table';
import {
  EMPTY,
  count,
  formatDateTime,
  parseInstant,
  relativeTime,
  score as fmtScore,
  truncate,
} from '../lib/format';
import {
  ALERT_STATUSES,
  cx,
  hexForScore,
  isOpen,
  nextStatuses,
  paletteForScore,
  severityPalette,
  type Thresholds,
} from '../lib/risk';
import { api, asApiError, type ApiError } from '../services/api';
import { usePlatform } from '../state/PlatformContext';
import { useResource } from '../state/useResource';
import type { Alert, AlertListResponse, AlertSeverity, AlertStatus } from '../types/api';

/** `OPEN` is not a backend status - see `rows` below for why it is here. */
type StatusFilter = 'ALL' | 'OPEN' | AlertStatus;
type SeverityFilter = 'ALL' | AlertSeverity;

/**
 * The verb for moving an alert *into* a status.
 *
 * Keyed on the destination rather than the origin, so one table serves both the
 * single button in a table row and the full set in the detail panel.
 */
const ACTION_WORD: Record<AlertStatus, string> = {
  NEW: 'Reopen',
  ACKNOWLEDGED: 'Acknowledge',
  'IN PROGRESS': 'Start response',
  RESOLVED: 'Resolve',
};

/**
 * The one move an officer scanning the list almost always wants.
 *
 * Offered in the row so the common case is one click; every other legal move is
 * still available in the detail panel.
 */
function primaryNext(status: AlertStatus): AlertStatus | null {
  if (status === 'NEW') return 'ACKNOWLEDGED';
  if (status === 'ACKNOWLEDGED') return 'IN PROGRESS';
  if (status === 'IN PROGRESS') return 'RESOLVED';
  return null;
}

export default function AlertsPage() {
  const { version, refreshSeconds, thresholds, capabilities, session, refresh } = usePlatform();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('ALL');
  const [regionFilter, setRegionFilter] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const canManage = capabilities.can_manage_alerts;

  const query = useMemo(() => {
    const next: { status?: string; severity?: string; region_id?: number; limit?: number } = {
      limit: 200,
    };
    // OPEN is deliberately not sent: the API filters on one exact status, and
    // "anything not yet resolved" spans three of them.
    if (statusFilter !== 'ALL' && statusFilter !== 'OPEN') next.status = statusFilter;
    if (severityFilter !== 'ALL') next.severity = severityFilter;
    if (regionFilter !== null) next.region_id = regionFilter;
    return next;
  }, [statusFilter, severityFilter, regionFilter]);
  const queryKey = useMemo(() => JSON.stringify(query), [query]);

  const alerts = useResource<AlertListResponse>(
    (signal) => api.alerts(query, signal),
    [version, queryKey],
    { pollSeconds: refreshSeconds },
  );

  const rows = useMemo(() => {
    const all = alerts.data?.alerts ?? [];
    return statusFilter === 'OPEN' ? all.filter((alert) => isOpen(alert.status)) : all;
  }, [alerts.data, statusFilter]);

  // Resolved from the current rows rather than held as its own copy, so a
  // transition or a poll updates the open detail panel without a second fetch.
  const selected = rows.find((alert) => alert.id === selectedId) ?? null;

  const [busyId, setBusyId] = useState<number | null>(null);
  const [moveError, setMoveError] = useState<ApiError | null>(null);

  async function move(
    alert: Alert,
    next: AlertStatus,
    extra: { assigned_to?: string | null; note?: string | null } = {},
  ) {
    setBusyId(alert.id);
    setMoveError(null);
    try {
      await api.updateAlert(alert.id, { status: next, ...extra });
      setSelectedId(alert.id);
      // A platform-wide bump: this alert's status is also a dashboard badge and
      // an officer-desk count, and all of them are now wrong.
      refresh();
    } catch (cause) {
      setMoveError(asApiError(cause, `/alerts/${alert.id}`));
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Built plainly rather than memoised. Each cell closes over `move` and
   * `busyId`, and a memo keyed on those would either be re-made every render
   * anyway or hand a row a stale handler; re-sorting two hundred rows is free.
   */
  const columns: Column<Alert>[] = [
    {
      key: 'code',
      header: 'Alert ID',
      width: 'w-28',
      hint: 'Identifier assigned when the alert was raised',
      sort: (alert) => alert.alert_code,
      cell: (alert) => <NumCell className="text-2xs">{alert.alert_code}</NumCell>,
    },
    {
      key: 'region',
      header: 'Location',
      sort: (alert) => alert.region_name ?? alert.region_code ?? null,
      cell: (alert) => (
        <TwoLine
          primary={alert.region_name ?? alert.region_code ?? EMPTY}
          secondary={alert.region_code}
        />
      ),
    },
    {
      key: 'score',
      header: 'Risk',
      align: 'right',
      width: 'w-20',
      hint: 'Model risk score, 0-100, at the moment the alert was raised',
      sort: (alert) => alert.risk_score,
      cell: (alert) => (
        <span className="block">
          <NumCell className={paletteForScore(alert.risk_score).text}>
            {fmtScore(alert.risk_score)}
          </NumCell>
          <Meter
            className="mt-1"
            height="h-0.5"
            value={alert.risk_score}
            hex={hexForScore(alert.risk_score)}
            label={`Risk score ${fmtScore(alert.risk_score)}`}
          />
        </span>
      ),
    },
    {
      key: 'severity',
      header: 'Severity',
      width: 'w-24',
      hideBelow: 'sm',
      sort: (alert) => (alert.severity === 'CRITICAL' ? 1 : 0),
      cell: (alert) => <SeverityChip severity={alert.severity} />,
    },
    {
      key: 'created',
      header: 'Raised',
      width: 'w-24',
      hideBelow: 'sm',
      hint: 'When the alert was raised, in your timezone',
      sort: (alert) => parseInstant(alert.created_at)?.getTime() ?? null,
      cell: (alert) => (
        <span className="whitespace-nowrap text-2xs text-dim" title={formatDateTime(alert.created_at)}>
          {relativeTime(alert.created_at)}
        </span>
      ),
    },
    {
      key: 'cause',
      header: 'Cause',
      hideBelow: 'lg',
      hint: 'The drivers that put this region over the threshold',
      cell: (alert) => (
        <span className="block max-w-[22rem] text-2xs leading-snug text-dim" title={alert.cause}>
          {truncate(alert.cause, 96)}
        </span>
      ),
    },
    {
      key: 'action',
      header: 'Recommended action',
      hideBelow: 'xl',
      hint: 'Stored with the alert. Decision support, not an instruction.',
      cell: (alert) => (
        <span
          className="block max-w-[18rem] text-2xs leading-snug text-dim"
          title={alert.recommended_action}
        >
          {truncate(alert.recommended_action, 78)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'w-28',
      sort: (alert) => ALERT_STATUSES.indexOf(alert.status),
      cell: (alert) => <AlertStatusChip status={alert.status} />,
    },
  ];

  if (canManage) {
    columns.push({
      key: 'actions',
      header: '',
      align: 'right',
      width: 'w-28',
      cell: (alert) => {
        const next = primaryNext(alert.status);
        // A resolved alert has no obvious next move, and a disabled button that
        // says "Resolve" on a resolved alert would only be confusing.
        if (!next) return null;
        return (
          <RowActions>
            <button
              type="button"
              className="btn btn-ghost px-2 py-1 text-2xs"
              disabled={busyId === alert.id}
              onClick={() => void move(alert, next)}
              title={`${ACTION_WORD[next]} ${alert.alert_code}`}
            >
              {busyId === alert.id ? 'Saving…' : ACTION_WORD[next]}
            </button>
          </RowActions>
        );
      },
    });
  }

  const stats = alerts.data?.stats ?? null;
  const openCount = stats ? stats.new + stats.acknowledged + stats.in_progress : null;

  return (
    <div className="min-w-0">
      <PageHeader
        title="Alerts and response"
        lead={
          <>
            Alerts are raised when a region’s model score crosses {thresholds.high} (HIGH) or{' '}
            {thresholds.critical} (CRITICAL). Each one carries the drivers that caused it and a
            recommended action, and moves through acknowledgement to resolution with the officer’s
            name recorded at every step.
          </>
        }
        right={
          <>
            <ModeChip mode={alerts.data?.alerts[0]?.data_mode} compact />
            <span className="font-mono text-2xs text-faint">
              {alerts.updatedAt ? `updated ${relativeTime(alerts.updatedAt)}` : 'loading'}
            </span>
          </>
        }
      />
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label="Open"
          value={count(openCount ?? 0)}
          hint="New, acknowledged and in-progress alerts - everything still needing someone"
          icon={<BellRing className="h-3 w-3" aria-hidden />}
          tone={openCount ? 'text-ink' : 'text-dim'}
          footer={stats ? `of ${count(stats.total)} in the queue` : 'loading'}
        />
        <StatTile
          label="Unattended"
          value={count(stats?.new ?? 0)}
          hint="Raised and not yet acknowledged by anyone"
          tone={stats?.new ? severityPalette('CRITICAL').text : 'text-dim'}
          footer="status NEW"
        />
        <StatTile
          label="In progress"
          value={count(stats?.in_progress ?? 0)}
          hint="A response is under way"
          footer="teams engaged"
        />
        <StatTile
          label="Resolved"
          value={count(stats?.resolved ?? 0)}
          hint="Closed out. Kept in the queue as the record of what happened."
          icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}
          footer="closed"
        />
        <StatTile
          label="Critical"
          value={count(stats?.critical ?? 0)}
          hint={`Score above ${thresholds.critical} when raised`}
          tone={severityPalette('CRITICAL').text}
          footer={`≥ ${thresholds.critical} / 100`}
        />
        <StatTile
          label="High"
          value={count(stats?.high ?? 0)}
          hint={`Score between ${thresholds.high} and ${thresholds.critical} when raised`}
          tone={severityPalette('HIGH').text}
          footer={`≥ ${thresholds.high} / 100`}
        />
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-4">
          <Panel
            title="Alert queue"
            note={`${rows.length} shown, newest first`}
            busy={alerts.refreshing}
            flush
            right={
              <>
                <select
                  className="field w-auto py-1 text-2xs"
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                  aria-label="Filter by status"
                >
                  <option value="ALL">All statuses</option>
                  <option value="OPEN">Open only</option>
                  {ALERT_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
                <select
                  className="field w-auto py-1 text-2xs"
                  value={severityFilter}
                  onChange={(event) => setSeverityFilter(event.target.value as SeverityFilter)}
                  aria-label="Filter by severity"
                >
                  <option value="ALL">All severities</option>
                  <option value="CRITICAL">Critical</option>
                  <option value="HIGH">High</option>
                </select>
              </>
            }
          >
            <div className="border-b border-hairline px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-2xs uppercase tracking-wider text-faint">Region</span>
                <div className="w-56">
                  <RegionSelect
                    value={regionFilter}
                    onChange={setRegionFilter}
                    blankLabel="All monitored regions"
                    className="py-1 text-2xs"
                  />
                </div>
                {(statusFilter !== 'ALL' || severityFilter !== 'ALL' || regionFilter !== null) && (
                  <button
                    type="button"
                    className="btn btn-ghost px-2 py-1 text-2xs"
                    onClick={() => {
                      setStatusFilter('ALL');
                      setSeverityFilter('ALL');
                      setRegionFilter(null);
                    }}
                  >
                    Clear filters
                  </button>
                )}
              </div>
            </div>
            {/* Padded here rather than on the panel, so the filter strip above
                can span the full width while the table, the skeleton and the
                error state all sit on the same inset. */}
            <div className="min-w-0 p-3">
              <ResourceBody
                resource={alerts}
                loadingRows={6}
                loadingLabel="Loading alerts"
                isEmpty={() => rows.length === 0}
                empty={
                  <EmptyState
                    title={
                      statusFilter === 'ALL' && severityFilter === 'ALL' && regionFilter === null
                        ? 'No alerts anywhere'
                        : 'No alerts match these filters'
                    }
                    hint={
                      statusFilter === 'ALL' && severityFilter === 'ALL' && regionFilter === null
                        ? 'Every monitored region is below the alert threshold. This is the best state this platform can be in.'
                        : 'Clear the filters to see the whole queue.'
                    }
                    icon={<CheckCircle2 className="h-5 w-5" aria-hidden />}
                  />
                }
              >
                {() => (
                  <DataTable
                    rows={rows}
                    columns={columns}
                    rowKey={(alert) => alert.id}
                    onRowClick={(alert) => setSelectedId(alert.id === selectedId ? null : alert.id)}
                    isActive={(alert) => alert.id === selectedId}
                    rowClassName={(alert) =>
                      alert.status === 'NEW' ? severityPalette(alert.severity).bg : undefined
                    }
                    caption="Alerts raised by the risk engine, newest first"
                    maxHeight="max-h-[34rem]"
                  />
                )}
              </ResourceBody>
            </div>
          </Panel>
          <Panel title="How the queue works">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <p className="label">Why an alert exists</p>
                <p className="text-2xs leading-relaxed text-faint">
                  A region is scored by the model, not by a rule of thumb. Below {thresholds.high}{' '}
                  nothing is raised. From {thresholds.high} the platform raises a HIGH alert and asks
                  for response teams on standby; from {thresholds.critical} it raises CRITICAL and
                  recommends evacuating households below unstable slopes.
                </p>
              </div>
              <div>
                <p className="label">How it closes</p>
                <p className="text-2xs leading-relaxed text-faint">
                  NEW → ACKNOWLEDGED → IN PROGRESS → RESOLVED, with the officer’s name and the time
                  stamped on every move. A resolved alert stays in the queue: it is the record of
                  what the platform said and what was done about it.
                </p>
              </div>
              <div>
                <p className="label">What it is not</p>
                <p className="text-2xs leading-relaxed text-faint">
                  The recommended action is decision support drawn from the severity band. It does
                  not replace a professional site assessment, and the data-mode chip on each alert
                  says whether the conditions behind it were live, demo or simulated.
                </p>
              </div>
            </div>
          </Panel>
        </div>

        <div className="min-w-0 space-y-4">
          <Panel
            title="Alert detail"
            note={selected ? selected.alert_code : 'select a row'}
            busy={busyId !== null}
          >
            {selected ? (
              <AlertDetail
                // Remounted per alert, so the assign and note fields never carry
                // one alert's half-typed text onto another's record.
                key={selected.id}
                alert={selected}
                thresholds={thresholds}
                canManage={canManage}
                busy={busyId === selected.id}
                error={moveError}
                onMove={move}
              />
            ) : (
              <EmptyState
                title="No alert selected"
                hint="Choose a row to see its drivers, its recommended action and its response history."
                icon={<BellRing className="h-5 w-5" aria-hidden />}
              />
            )}
          </Panel>

          {canManage && (
            <Panel
              title="Raise an alert"
              note="from a field observation"
            >
              <RaiseAlertForm
                onRaised={(alert) => {
                  setSelectedId(alert.id);
                  refresh();
                }}
              />
            </Panel>
          )}

          <Panel title="Demonstration" note="drives the whole platform">
            <DemoConsole />
          </Panel>

          {!canManage && (
            <Panel title="Acting on an alert">
              <p className="flex items-start gap-2 text-2xs leading-relaxed text-faint">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
                <span>
                  {session.authenticated ? (
                    <>
                      You are signed in as {session.fullName ?? session.username} with the{' '}
                      {session.role} role, which reads the queue but does not change it.
                    </>
                  ) : (
                    <>
                      You are not signed in. Reading the queue needs no account - a warning nobody
                      can see is not a warning.
                    </>
                  )}{' '}
                  Acknowledging, assigning and resolving are recorded against a named officer, so
                  they need the officer role.
                </span>
              </p>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
/**
 * Everything stored with one alert, and the controls to move it on.
 *
 * The fields are read straight off the record rather than recomputed: the score
 * is what the model said when the alert was raised, not what the region is
 * scoring now, and presenting it as current would be a quiet lie about when the
 * warning was issued.
 */
function AlertDetail({
  alert,
  thresholds,
  canManage,
  busy,
  error,
  onMove,
}: {
  alert: Alert;
  thresholds: Thresholds;
  canManage: boolean;
  busy: boolean;
  error: ApiError | null;
  onMove: (
    alert: Alert,
    next: AlertStatus,
    extra?: { assigned_to?: string | null; note?: string | null },
  ) => void | Promise<void>;
}) {
  const [assignee, setAssignee] = useState(alert.assigned_to ?? '');
  const [note, setNote] = useState('');
  const tone = paletteForScore(alert.risk_score);

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-3">
        <span className={cx('tnum font-display text-3xl font-semibold leading-none', tone.text)}>
          {fmtScore(alert.risk_score)}
        </span>
        <div className="space-y-1.5 pb-0.5">
          <p className="font-mono text-2xs text-faint">/ 100 when raised</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <SeverityChip severity={alert.severity} />
            <AlertStatusChip status={alert.status} />
          </div>
        </div>
      </div>
      <Meter
        value={alert.risk_score}
        hex={tone.hex}
        marks={[thresholds.high, thresholds.critical]}
        label={`Risk score ${fmtScore(alert.risk_score)} of 100`}
      />

      {alert.status === 'NEW' && (
        <p className="flex items-start gap-2 rounded-panel border border-risk-critical/40 bg-risk-critical/10 px-2.5 py-2 text-2xs leading-relaxed text-risk-critical">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>Nobody has acknowledged this yet.</span>
        </p>
      )}

      <div className="divide-y divide-hairline/60">
        <KeyValue label="Alert ID" value={alert.alert_code} />
        <KeyValue
          label="Region"
          value={alert.region_name ?? alert.region_code ?? EMPTY}
          mono={false}
        />
        <KeyValue
          label="Raised"
          value={formatDateTime(alert.created_at)}
          title={relativeTime(alert.created_at)}
        />
        <KeyValue label="Last change" value={formatDateTime(alert.updated_at)} />
        <KeyValue
          label="Acknowledged"
          value={alert.acknowledged_at ? formatDateTime(alert.acknowledged_at) : EMPTY}
          title="Blank means no officer has picked this up"
        />
        <KeyValue
          label="Resolved"
          value={alert.resolved_at ? formatDateTime(alert.resolved_at) : EMPTY}
        />
        <KeyValue label="Assigned to" value={alert.assigned_to ?? EMPTY} mono={false} />
        <KeyValue
          label="Scenario"
          value={alert.scenario}
          title="The world this alert was raised in"
        />
        <KeyValue label="Provenance" value={<ModeChip mode={alert.data_mode} compact />} />
      </div>

      <div>
        <p className="label">Cause</p>
        <p className="text-xs leading-relaxed text-dim">{alert.cause}</p>
      </div>

      <div className="rounded-panel border border-accentdim/50 bg-accent/[0.07] px-2.5 py-2">
        <p className="label mb-0.5 text-accent">Recommended action</p>
        <p className="text-xs leading-relaxed text-ink">{alert.recommended_action}</p>
        <p className="mt-1.5 text-2xs leading-relaxed text-faint">
          Decision support from the severity band. It does not replace a professional site
          assessment.
        </p>
      </div>

      {alert.note && (
        <div>
          <p className="label">Response log</p>
          <p className="whitespace-pre-line break-words font-mono text-2xs leading-relaxed text-faint">
            {alert.note}
          </p>
        </div>
      )}

      {canManage ? (
        <div className="space-y-2 border-t border-hairline pt-3">
          <div>
            <label className="label" htmlFor="alert-assignee">
              Assign to
            </label>
            <input
              id="alert-assignee"
              className="field py-1 text-xs"
              value={assignee}
              onChange={(event) => setAssignee(event.target.value)}
              placeholder="Team or officer name"
              maxLength={128}
              disabled={busy}
            />
          </div>
          <div>
            <label className="label" htmlFor="alert-note">
              Note for the log
            </label>
            <textarea
              id="alert-note"
              className="field py-1 text-xs"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="What was done, or what is being done"
              maxLength={2000}
              disabled={busy}
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {nextStatuses(alert.status).map((status) => (
              <button
                key={status}
                type="button"
                className={cx(
                  'btn px-2 py-1 text-2xs',
                  status === 'RESOLVED' ? 'btn-accent' : 'btn-ghost',
                )}
                disabled={busy}
                onClick={() =>
                  void onMove(alert, status, {
                    // Sent as typed, including empty: the API treats an empty
                    // string as "unassign" and null as "leave as it was".
                    assigned_to: assignee.trim(),
                    note: note.trim() || null,
                  })
                }
              >
                {ACTION_WORD[status]}
              </button>
            ))}
          </div>
          <p className="text-2xs leading-relaxed text-faint">
            Only legal moves are offered. Every change is stamped with your name and appended to the
            response log above.
          </p>
          <InlineError error={error} />
        </div>
      ) : (
        <p className="flex items-start gap-2 border-t border-hairline pt-3 text-2xs leading-relaxed text-faint">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
          <span>Acknowledging, assigning and resolving need the officer role.</span>
        </p>
      )}
    </div>
  );
}
/**
 * An officer raising a warning from something seen in the field.
 *
 * Recorded as a human observation under the MANUAL scenario, so it never reads
 * as model output. The minimum lengths mirror `ManualAlertIn` in the schema: an
 * alert whose cause is "landslide" tells a responder nothing, and the API
 * refuses it, so the form refuses it first and says why.
 */
function RaiseAlertForm({ onRaised }: { onRaised: (alert: Alert) => void }) {
  const [regionId, setRegionId] = useState<number | null>(null);
  const [severity, setSeverity] = useState<AlertSeverity>('HIGH');
  const [scoreText, setScoreText] = useState('75');
  const [cause, setCause] = useState('');
  const [action, setAction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [raised, setRaised] = useState<string | null>(null);

  const scoreValue = Number(scoreText);
  const scoreOk = Number.isFinite(scoreValue) && scoreValue >= 0 && scoreValue <= 100;
  const ready =
    regionId !== null && scoreOk && cause.trim().length >= 8 && action.trim().length >= 8;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || regionId === null) return;
    setBusy(true);
    setError(null);
    setRaised(null);
    try {
      const alert = await api.createAlert({
        region_id: regionId,
        severity,
        risk_score: scoreValue,
        cause: cause.trim(),
        recommended_action: action.trim(),
        scenario: 'MANUAL',
      });
      setRaised(alert.alert_code);
      setCause('');
      setAction('');
      onRaised(alert);
    } catch (failure) {
      setError(asApiError(failure, '/alerts'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-2" onSubmit={submit}>
      <div>
        <label className="label" htmlFor="raise-region">
          Region
        </label>
        <RegionSelect
          id="raise-region"
          value={regionId}
          onChange={setRegionId}
          blankLabel="Choose a region"
          className="py-1 text-xs"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label" htmlFor="raise-severity">
            Severity
          </label>
          <select
            id="raise-severity"
            className="field py-1 text-xs"
            value={severity}
            onChange={(event) => setSeverity(event.target.value as AlertSeverity)}
            disabled={busy}
          >
            <option value="HIGH">HIGH</option>
            <option value="CRITICAL">CRITICAL</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="raise-score">
            Assessed risk
          </label>
          <input
            id="raise-score"
            className="field tnum py-1 text-xs"
            type="number"
            min={0}
            max={100}
            step={1}
            value={scoreText}
            onChange={(event) => setScoreText(event.target.value)}
            disabled={busy}
          />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="raise-cause">
          What was observed
        </label>
        <textarea
          id="raise-cause"
          className="field py-1 text-xs"
          rows={2}
          value={cause}
          onChange={(event) => setCause(event.target.value)}
          placeholder="Fresh tension cracks above the highway, 40 m across"
          maxLength={1000}
          disabled={busy}
        />
      </div>
      <div>
        <label className="label" htmlFor="raise-action">
          Recommended action
        </label>
        <textarea
          id="raise-action"
          className="field py-1 text-xs"
          rows={2}
          value={action}
          onChange={(event) => setAction(event.target.value)}
          placeholder="Close the highway between km 12 and km 14 and post a watch"
          maxLength={1000}
          disabled={busy}
        />
      </div>
      <button type="submit" className="btn btn-accent w-full py-1.5 text-xs" disabled={!ready || busy}>
        <Send className="h-3.5 w-3.5" aria-hidden />
        {busy ? 'Raising…' : 'Raise alert'}
      </button>
      {!ready && (
        <p className="text-2xs leading-relaxed text-faint">
          A region, a score between 0 and 100, and at least eight characters each of observation and
          recommended action. This is a human record, not a model prediction, and it is stored as
          LIVE DATA under the MANUAL scenario.
        </p>
      )}
      {raised && (
        <p className="text-2xs leading-relaxed text-risk-verylow">
          Raised as {raised}. It is now at the top of the queue, unacknowledged.
        </p>
      )}
      <InlineError error={error} />
    </form>
  );
}
