/**
 * The officer desk: one screen for a shift.
 *
 * An officer's job on this platform is to turn two queues into decisions - the
 * alerts the risk engine raised, and the reports citizens filed - and the two are
 * read together or not at all. A verified crack in a road matters more when the
 * region above it is already at 78; an alert at 62 in a region nobody has reported
 * anything about is a different call. So both queues live here, side by side, and
 * the full alert board stays at `/alerts` for the cases that need every filter.
 *
 * Everything on this page writes through the same endpoints the API documents:
 * `PUT /api/citizen-report/{id}` for triage and `PUT /api/alerts/{id}` for a
 * status move. Both are OFFICER-gated on the server, which is the check that
 * counts - the route guard in front of this screen only hides it.
 *
 * Triage notes are appended with the officer's name and a timestamp rather than
 * replacing anything: the citizen's original words are evidence and stay exactly
 * as filed. That is a backend decision (`report_service.set_status`), and this
 * screen says so where the note is typed, because an officer who thinks they are
 * editing a record behaves differently from one who knows they are adding to it.
 *
 * The photograph screening shown beside a report is the one the server ran when
 * the report arrived. It is a deterministic image-feature heuristic, not a trained
 * network, and it is decision support that does not replace assessment by a
 * qualified engineer or a site visit. An officer verifying a report is making
 * their own judgement; the screening is one input to it.
 */
import {
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  Eye,
  Inbox,
  MapPin,
  ScanLine,
  ShieldAlert,
  Siren,
  XCircle,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { PageHeader } from '../components/AppShell';
import { AlertStatusChip, Chip, ReportStatusChip, SeverityChip } from '../components/Chips';
import { Panel, ResourceBody } from '../components/Panel';
import { KeyValue, Meter, StatTile } from '../components/Readouts';
import { RegionSelect } from '../components/RegionPicker';
import { EmptyState, InlineError, Spinner } from '../components/States';
import { DataTable, NumCell, RowActions, TwoLine, type Column } from '../components/Table';
import {
  coords,
  count as formatCount,
  formatDate,
  formatDateTime,
  percentPoints,
  relativeTime,
  score as formatScore,
  truncate,
} from '../lib/format';
import { REPORT_STATUS, cx, isOpen, paletteForScore } from '../lib/risk';
import { api, asApiError, uploadUrl, type ApiError } from '../services/api';
import { usePlatform } from '../state/PlatformContext';
import { useResource } from '../state/useResource';
import type {
  Alert,
  AlertListResponse,
  AlertStatus,
  CitizenReport,
  RegionRiskResponse,
  ReportListResponse,
  ReportStatus,
} from '../types/api';

type StatusFilter = 'ALL' | 'OPEN' | ReportStatus;

/** Report statuses that still need an officer to look at them. */
const OPEN_REPORT: readonly ReportStatus[] = ['NEW', 'UNDER REVIEW'];

const REPORT_FILTERS: readonly { value: StatusFilter; label: string; hint: string }[] = [
  { value: 'OPEN', label: 'Needs a look', hint: 'NEW and UNDER REVIEW together' },
  { value: 'NEW', label: 'New', hint: 'Filed and not yet opened by anyone' },
  { value: 'UNDER REVIEW', label: 'Under review', hint: 'Someone is checking it' },
  { value: 'VERIFIED', label: 'Verified', hint: 'An officer confirmed the observation' },
  { value: 'DISMISSED', label: 'Dismissed', hint: 'Checked and found not to be a hazard' },
  { value: 'ALL', label: 'Everything', hint: 'Every report in the queue' },
];

const SEVERITY_TONE: Record<string, string> = {
  LOW: 'text-risk-low',
  MEDIUM: 'text-risk-moderate',
  HIGH: 'text-risk-high',
};

/**
 * The triage moves offered for a report, keyed on where it is now.
 *
 * A DISMISSED report can be reopened, because dismissing one is a judgement and
 * judgements get revisited when a second report arrives from the same road.
 */
const TRIAGE: Record<ReportStatus, ReportStatus[]> = {
  NEW: ['UNDER REVIEW', 'VERIFIED', 'DISMISSED'],
  'UNDER REVIEW': ['VERIFIED', 'DISMISSED'],
  VERIFIED: ['UNDER REVIEW'],
  DISMISSED: ['NEW', 'UNDER REVIEW'],
};

const TRIAGE_WORD: Record<ReportStatus, string> = {
  NEW: 'Reopen',
  'UNDER REVIEW': 'Take for review',
  VERIFIED: 'Verify',
  DISMISSED: 'Dismiss',
};

const TRIAGE_ICON: Record<ReportStatus, typeof Eye> = {
  NEW: Inbox,
  'UNDER REVIEW': Eye,
  VERIFIED: CheckCircle2,
  DISMISSED: XCircle,
};

/** The move an officer scanning the queue almost always wants next. */
function primaryTriage(status: ReportStatus): ReportStatus | null {
  if (status === 'NEW') return 'UNDER REVIEW';
  if (status === 'UNDER REVIEW') return 'VERIFIED';
  return null;
}

/**
 * What the server made of the photograph when the report arrived.
 *
 * Shown with its confidence and its disclaimer, and never as a verdict: the
 * officer is deciding, and this is one input. `confidence` is percentage points
 * capped at 80 by construction, which is why it is formatted with
 * `percentPoints` and captioned rather than left to speak for itself.
 */
function StoredScreening({ report }: { report: CitizenReport }) {
  const analysis = report.image_analysis;
  if (!analysis?.category_label) {
    return (
      <p className="text-2xs leading-relaxed text-faint">
        {report.has_image
          ? 'A photograph was stored but the screening did not complete. Open the image and judge it yourself.'
          : 'No photograph was filed, so this report stands on its description alone.'}
      </p>
    );
  }
  return (
    <div className="space-y-1.5 rounded-panel border border-hairline bg-raised/40 p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="flex items-center gap-1.5 font-display text-xs font-semibold text-ink">
          <ScanLine className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
          {analysis.category_label}
        </p>
        <span className="tnum shrink-0 font-mono text-2xs text-dim">
          {percentPoints(analysis.confidence ?? 0)}
        </span>
      </div>
      <Meter value={analysis.confidence ?? 0} hex="#48C9E6" />
      <p className="text-2xs leading-relaxed text-dim">{analysis.recommendation}</p>
      <p className="text-2xs leading-relaxed text-risk-moderate">
        {analysis.disclaimer ??
          'Decision support only. This does not replace professional geotechnical assessment.'}
      </p>
    </div>
  );
}

/**
 * The single move offered beside an open alert on this desk.
 *
 * The rule matches the alert board's deliberately: acknowledging from here and
 * acknowledging from `/alerts` must mean the same thing. Every other legal move
 * lives on the board, which is one click away, so this screen stays a worklist
 * rather than becoming a second, slightly different alert console.
 */
function nextAlertMove(status: AlertStatus): AlertStatus | null {
  if (status === 'NEW') return 'ACKNOWLEDGED';
  if (status === 'ACKNOWLEDGED') return 'IN PROGRESS';
  if (status === 'IN PROGRESS') return 'RESOLVED';
  return null;
}

/** The verb for moving an alert *into* a status. */
const ALERT_WORD: Record<AlertStatus, string> = {
  NEW: 'Reopen',
  ACKNOWLEDGED: 'Acknowledge',
  'IN PROGRESS': 'Start response',
  RESOLVED: 'Resolve',
};

/**
 * One report, opened.
 *
 * The citizen's own words are quoted rather than summarised, because an officer
 * deciding whether to send someone out needs the description as filed and not a
 * paraphrase of it. Beside them sits the region's current model score, fetched
 * live: a report of a new crack reads differently at 34 than it does at 79, and
 * making the officer hold two screens in their head to see that is how a real
 * observation gets filed under "probably nothing".
 */
function ReportDetail({
  report,
  canReview,
  busy,
  error,
  onTriage,
  onOpen,
}: {
  report: CitizenReport;
  canReview: boolean;
  busy: boolean;
  error: ApiError | null;
  onTriage: (next: ReportStatus, note: string) => Promise<boolean>;
  onOpen: (to: string) => void;
}) {
  const { scenario, version } = usePlatform();
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<ReportStatus | null>(null);

  /** Clears the note only once the write has actually landed. */
  async function apply(next: ReportStatus) {
    setPending(next);
    const saved = await onTriage(next, note);
    setPending(null);
    if (saved) setNote('');
  }

  const regionId = report.region_id;
  // `?? 0` is never reached: the resource is disabled when there is no region,
  // which is the case for a report that fell outside the routing radius.
  const risk = useResource<RegionRiskResponse>(
    (signal) => api.regionRisk(regionId ?? 0, { scenario }, signal),
    [regionId, scenario, version],
    { enabled: regionId !== null },
  );

  const photo = uploadUrl(report.image_url);
  const moves = TRIAGE[report.status];
  const primary = primaryTriage(report.status);
  const current = risk.data?.risk ?? null;
  const tone = paletteForScore(current?.risk_score ?? 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="font-mono text-xs text-ink">{report.report_code}</span>
          <ReportStatusChip status={report.status} />
          <Chip className={cx('border-hairbright bg-raised', SEVERITY_TONE[report.severity])}>
            {report.severity}
          </Chip>
        </div>
        <span className="shrink-0 font-mono text-2xs text-faint">
          {relativeTime(report.created_at)}
        </span>
      </div>

      {photo ? (
        <div className="space-y-1">
          <img
            src={photo}
            alt={`Photograph filed with report ${report.report_code}`}
            className="max-h-56 w-full rounded-panel border border-hairline object-cover"
          />
          <a
            href={photo}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-2xs text-dim hover:text-accent"
          >
            Open the photograph full size
            <ArrowRight className="h-3 w-3" aria-hidden />
          </a>
        </div>
      ) : null}

      <div className="rounded-panel border border-hairline bg-raised/40 p-2.5">
        <p className="text-2xs uppercase tracking-wider text-faint">What the reporter wrote</p>
        <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink">
          {report.description}
        </p>
      </div>

      {report.officer_note ? (
        <div className="rounded-panel border border-hairline bg-raised/40 p-2.5">
          <p className="text-2xs uppercase tracking-wider text-faint">
            Officer notes on this report
          </p>
          {/* A separate panel because it is a separate kind of statement: the block
              above is what a citizen saw, this is what the office made of it. The
              server keeps them in separate columns for the same reason. */}
          <ul className="mt-1 space-y-1">
            {report.officer_note
              .split(' | ')
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0)
              .map((entry, index) => (
                <li key={`${index}-${entry.slice(0, 24)}`} className="text-xs leading-relaxed text-dim">
                  {entry}
                </li>
              ))}
          </ul>
        </div>
      ) : null}

      <div>
        <KeyValue label="Observation" value={report.observation_type} />
        <KeyValue
          label="Seen on"
          value={formatDate(report.observed_on)}
          title="The date the reporter says they saw it, which is not the date they filed"
        />
        <KeyValue label="Filed" value={formatDateTime(report.created_at)} />
        <KeyValue label="Position" value={coords(report.latitude, report.longitude)} />
        <KeyValue
          label="Region"
          value={report.region_name ?? 'not routed'}
          mono={false}
          title={
            report.region_name
              ? 'The monitored region this report was filed against'
              : 'No monitored region was close enough, so this one waits for manual routing'
          }
        />
        <KeyValue label="Reporter" value={report.reporter_name ?? 'anonymous'} mono={false} />
      </div>

      <StoredScreening report={report} />

      {regionId !== null && (
        <div className="space-y-1.5 rounded-panel border border-hairline bg-raised/40 p-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <p className="min-w-0 truncate text-2xs uppercase tracking-wider text-faint">
              {report.region_name ?? 'This region'} scores
            </p>
            {current ? (
              <span className={cx('tnum shrink-0 font-display text-sm font-semibold', tone.text)}>
                {formatScore(current.risk_score)}
              </span>
            ) : (
              <Spinner className="h-3 w-3" />
            )}
          </div>
          {current && (
            <>
              <Meter value={current.risk_score} hex={tone.hex} />
              <p className="text-2xs leading-relaxed text-dim">
                {current.risk_level} band, scored {relativeTime(current.predicted_at)} from{' '}
                {current.data_mode} DATA. Read the report against this, not on its own.
              </p>
            </>
          )}
          <InlineError error={risk.error} />
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            <button
              type="button"
              className="btn btn-ghost px-2 py-1 text-2xs"
              onClick={() => onOpen('/map')}
            >
              <MapPin className="h-3.5 w-3.5" aria-hidden />
              Show on the map
            </button>
            <button
              type="button"
              className="btn btn-ghost px-2 py-1 text-2xs"
              onClick={() => onOpen('/forecast')}
            >
              Open the 72-hour forecast
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </div>
      )}

      {canReview ? (
        <div className="space-y-2">
          <div className="min-w-0">
            <label className="label" htmlFor={`triage-note-${report.id}`}>
              Officer note (optional)
            </label>
            <textarea
              id={`triage-note-${report.id}`}
              className="field min-h-[4rem] py-1.5 text-xs leading-relaxed"
              maxLength={1000}
              placeholder="What you checked, who you sent, what you found."
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={busy}
            />
            <p className="mt-1 text-2xs leading-relaxed text-faint">
              Saved with your name and the time, into the report’s own note trail rather than over
              the top of it. The reporter’s description is evidence and is stored in a separate
              column that nothing in this application writes to after filing.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {moves.map((next) => {
              const Icon = TRIAGE_ICON[next];
              return (
                <button
                  key={next}
                  type="button"
                  className={cx(
                    'btn px-2 py-1 text-2xs',
                    // Dismissing is the one move that discards a citizen's report, so it
                    // reads as destructive rather than as just another option.
                    next === 'DISMISSED'
                      ? 'btn-danger'
                      : next === primary
                        ? 'btn-accent'
                        : 'btn-ghost',
                  )}
                  disabled={busy}
                  onClick={() => void apply(next)}
                  title={`${TRIAGE_WORD[next]} — moves ${report.report_code} to ${next}`}
                >
                  {pending === next ? (
                    <Spinner className="h-3.5 w-3.5" />
                  ) : (
                    <Icon className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {TRIAGE_WORD[next]}
                </button>
              );
            })}
          </div>
          <InlineError error={error} />
        </div>
      ) : (
        <p className="flex items-start gap-2 text-2xs leading-relaxed text-risk-moderate">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Triage needs an officer account. The record is readable, but the status buttons are not
            drawn because the server would refuse the write.
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * The alerts still needing someone, as a worklist.
 *
 * Deliberately not a second alert console: one score, one cause, one move. An
 * officer who needs to filter by state, reassign, or read the whole history goes
 * to `/alerts`, and the link to it sits in this panel's head. What this list is
 * for is the question "while I am triaging reports, what else is live?".
 */
function AlertWorklist({
  alerts,
  canManage,
  busyId,
  onMove,
}: {
  alerts: Alert[];
  canManage: boolean;
  busyId: number | null;
  onMove: (alert: Alert, next: AlertStatus) => void;
}) {
  if (alerts.length === 0) {
    return (
      <EmptyState
        title="No open alerts"
        hint="Nothing is above the alerting threshold. Alerts appear here as soon as the engine raises them, without a reload."
        icon={<Siren className="h-5 w-5" aria-hidden />}
      />
    );
  }
  return (
    <ul className="space-y-1.5">
      {alerts.map((alert) => {
        const next = nextAlertMove(alert.status);
        const tone = paletteForScore(alert.risk_score);
        return (
          <li key={alert.id} className={cx('rounded-panel border bg-raised/30 p-2.5', tone.border)}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-2xs text-ink">{alert.alert_code}</span>
                  <SeverityChip severity={alert.severity} />
                  <AlertStatusChip status={alert.status} />
                </div>
                <p className="mt-1 truncate text-xs font-semibold text-ink">
                  {alert.region_name ?? 'Unnamed region'}
                </p>
                <p className="mt-0.5 text-2xs leading-relaxed text-dim">
                  {truncate(alert.cause, 120)}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <NumCell className={cx('font-display text-base font-semibold', tone.text)}>
                  {formatScore(alert.risk_score)}
                </NumCell>
                <p className="mt-0.5 font-mono text-2xs text-faint">
                  {relativeTime(alert.created_at)}
                </p>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 truncate text-2xs text-faint">
                {alert.assigned_to ? `With ${alert.assigned_to}` : 'Nobody has taken it yet'}
              </p>
              {canManage && next && (
                <button
                  type="button"
                  className="btn btn-ghost shrink-0 px-2 py-1 text-2xs"
                  disabled={busyId === alert.id}
                  onClick={() => onMove(alert, next)}
                  title={`${ALERT_WORD[next]} ${alert.alert_code}`}
                >
                  {busyId === alert.id ? 'Saving…' : ALERT_WORD[next]}
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default function OfficerPage() {
  const { version, refreshSeconds, capabilities, session, refresh, selectRegion } = usePlatform();
  const navigate = useNavigate();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('OPEN');
  const [regionFilter, setRegionFilter] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const canReview = capabilities.can_review_reports;
  const canManage = capabilities.can_manage_alerts;

  /**
   * `OPEN` has no server-side equivalent - the API filters on one status at a
   * time - so it is fetched unfiltered and narrowed here. That has a second
   * benefit: verifying a report takes it out of the queue while leaving it
   * readable in the detail panel, rather than making the record vanish under
   * the officer who just acted on it.
   */
  const reportQuery = useMemo(() => {
    const next: { status?: string; region_id?: number; limit?: number } = { limit: 200 };
    if (statusFilter !== 'ALL' && statusFilter !== 'OPEN') next.status = statusFilter;
    if (regionFilter !== null) next.region_id = regionFilter;
    return next;
  }, [statusFilter, regionFilter]);

  const reports = useResource<ReportListResponse>(
    (signal) => api.reports(reportQuery, signal),
    [reportQuery, version],
    { pollSeconds: refreshSeconds, enabled: canReview },
  );

  const alerts = useResource<AlertListResponse>(
    (signal) => api.alerts({ limit: 80 }, signal),
    [version],
    { pollSeconds: refreshSeconds, enabled: canManage },
  );

  const rows = useMemo(() => {
    const all = reports.data?.reports ?? [];
    return statusFilter === 'OPEN'
      ? all.filter((report) => OPEN_REPORT.includes(report.status))
      : all;
  }, [reports.data, statusFilter]);

  // Resolved from the whole fetched set rather than from `rows`, for the reason
  // in the comment above.
  const selected = (reports.data?.reports ?? []).find((report) => report.id === selectedId) ?? null;

  const openAlerts = useMemo(
    () => (alerts.data?.alerts ?? []).filter((alert) => isOpen(alert.status)),
    [alerts.data],
  );

  const [busyId, setBusyId] = useState<number | null>(null);
  const [triageError, setTriageError] = useState<ApiError | null>(null);

  /** Resolves true when the write landed, so the note field knows to clear. */
  async function triage(
    report: CitizenReport,
    next: ReportStatus,
    note: string,
  ): Promise<boolean> {
    setBusyId(report.id);
    setTriageError(null);
    try {
      await api.triageReport(report.id, { status: next, note: note.trim() || null });
      setSelectedId(report.id);
      // Platform-wide: this report's status is also a dashboard count and a
      // badge in the sidebar, and both of them are now wrong.
      refresh();
      return true;
    } catch (cause) {
      setTriageError(asApiError(cause, `/citizen-report/${report.id}`));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  const [alertBusyId, setAlertBusyId] = useState<number | null>(null);
  const [alertError, setAlertError] = useState<ApiError | null>(null);

  /**
   * Moving an alert from this desk also puts a name on it when nobody has
   * claimed it yet, because "acknowledged by nobody in particular" is how a
   * response ends up with no owner. An existing assignee is never overwritten.
   */
  async function moveAlert(alert: Alert, next: AlertStatus) {
    setAlertBusyId(alert.id);
    setAlertError(null);
    try {
      const owner = alert.assigned_to ?? session.fullName ?? session.username;
      await api.updateAlert(alert.id, { status: next, assigned_to: owner });
      refresh();
    } catch (cause) {
      setAlertError(asApiError(cause, `/alerts/${alert.id}`));
    } finally {
      setAlertBusyId(null);
    }
  }

  /** Hands a region to the map or the forecast, which both read the selection. */
  function openRegion(regionId: number | null, to: string) {
    if (regionId === null) return;
    selectRegion(regionId);
    navigate(to);
  }

  const reportStats = reports.data?.stats ?? null;
  const alertStats = alerts.data?.stats ?? null;
  const needsLook = reportStats ? reportStats.new + reportStats.under_review : null;
  const openAlertCount = alertStats
    ? alertStats.new + alertStats.acknowledged + alertStats.in_progress
    : null;

  /**
   * Built plainly rather than memoised: each cell closes over `triage` and
   * `busyId`, and a memo keyed on those would be rebuilt every render anyway.
   */
  const columns: Column<CitizenReport>[] = [
    {
      key: 'code',
      header: 'Report',
      width: 'w-28',
      hint: 'The code the reporter was given when they filed',
      sort: (report) => report.report_code,
      cell: (report) => <span className="font-mono text-2xs text-ink">{report.report_code}</span>,
    },
    {
      key: 'place',
      header: 'Where',
      sort: (report) => report.location_text,
      cell: (report) => (
        <TwoLine
          primary={truncate(report.location_text, 44)}
          secondary={report.region_name ?? 'not routed to a region'}
        />
      ),
    },
    {
      key: 'what',
      header: 'Observation',
      hideBelow: 'md',
      sort: (report) => report.observation_type,
      cell: (report) => (
        <TwoLine
          primary={report.observation_type}
          secondary={
            <span className={SEVERITY_TONE[report.severity]}>{report.severity} severity</span>
          }
        />
      ),
    },
    {
      key: 'filed',
      header: 'Filed',
      width: 'w-24',
      hideBelow: 'sm',
      hint: 'When the report reached the platform, not when the hazard was seen',
      sort: (report) => report.created_at,
      cell: (report) => (
        <span className="font-mono text-2xs text-faint">{relativeTime(report.created_at)}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'w-28',
      sort: (report) => report.status,
      cell: (report) => <ReportStatusChip status={report.status} />,
    },
  ];

  if (canReview) {
    columns.push({
      key: 'actions',
      header: '',
      align: 'right',
      width: 'w-28',
      cell: (report) => {
        const next = primaryTriage(report.status);
        // A verified or dismissed report has no obvious next move from a row.
        // Reopening one is a deliberate act and lives in the detail panel.
        if (!next) return null;
        return (
          <RowActions>
            <button
              type="button"
              className="btn btn-ghost px-2 py-1 text-2xs"
              disabled={busyId === report.id}
              onClick={() => void triage(report, next, '')}
              title={`${TRIAGE_WORD[next]} ${report.report_code} without a note`}
            >
              {busyId === report.id ? 'Saving…' : TRIAGE_WORD[next]}
            </button>
          </RowActions>
        );
      },
    });
  }

  return (
    <div className="min-w-0">
      <PageHeader
        title="Officer desk"
        lead="Two queues, read together: the alerts the engine raised and the reports people filed. Both write through the API, which re-checks the officer role on every request — the guard in front of this screen only hides it."
        right={
          <>
            <Chip
              className="border-accentdim/60 bg-accent/10 text-accent"
              title="The account this desk is signed in as"
            >
              {session.fullName ?? session.username} · {session.role}
            </Chip>
            <button type="button" className="btn btn-ghost" onClick={() => navigate('/alerts')}>
              Full alert board
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          </>
        }
      />

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Needs a look"
          value={needsLook === null ? '—' : formatCount(needsLook)}
          icon={<Inbox className="h-3.5 w-3.5" aria-hidden />}
          tone={needsLook ? 'text-risk-moderate' : undefined}
          hint="NEW and UNDER REVIEW reports counted together"
          footer={
            reportStats
              ? `${formatCount(reportStats.new)} new, ${formatCount(reportStats.under_review)} being checked`
              : 'waiting for the queue'
          }
        />
        <StatTile
          label="Verified"
          value={reportStats ? formatCount(reportStats.verified) : '—'}
          icon={<ClipboardCheck className="h-3.5 w-3.5" aria-hidden />}
          tone="text-risk-verylow"
          hint="Observations an officer confirmed"
          footer={
            reportStats
              ? `${formatCount(reportStats.dismissed)} dismissed after checking`
              : 'waiting for the queue'
          }
        />
        <StatTile
          label="Open alerts"
          value={openAlertCount === null ? '—' : formatCount(openAlertCount)}
          icon={<Siren className="h-3.5 w-3.5" aria-hidden />}
          tone={openAlertCount ? 'text-risk-high' : undefined}
          hint="Raised and not yet resolved, at any stage"
          footer={
            alertStats ? `${formatCount(alertStats.total)} raised in total` : 'waiting for the board'
          }
        />
        <StatTile
          label="Critical now"
          value={alertStats ? formatCount(alertStats.critical) : '—'}
          icon={<ShieldAlert className="h-3.5 w-3.5" aria-hidden />}
          tone={alertStats?.critical ? 'text-risk-critical' : undefined}
          hint="Alerts above the critical threshold"
          footer="An evacuation call belongs to the district authority, not to this platform"
        />
      </div>

      <div className="mt-3 grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,23rem)]">
        <Panel
          title="Citizen reports"
          note={`${formatCount(rows.length)} shown`}
          busy={reports.refreshing}
          flush
          right={
            <div className="flex flex-wrap items-center gap-1">
              {REPORT_FILTERS.map((filter) => {
                const active = statusFilter === filter.value;
                const tint =
                  filter.value !== 'ALL' && filter.value !== 'OPEN'
                    ? REPORT_STATUS[filter.value].chip
                    : 'border-accentdim/60 bg-accent/10 text-accent';
                return (
                  <button
                    key={filter.value}
                    type="button"
                    className={cx(
                      'chip transition-colors',
                      active
                        ? tint
                        : 'border-hairline bg-raised/40 text-faint hover:border-hairbright hover:text-ink',
                    )}
                    aria-pressed={active}
                    title={filter.hint}
                    onClick={() => setStatusFilter(filter.value)}
                  >
                    {filter.label}
                  </button>
                );
              })}
            </div>
          }
        >
          <div className="flex flex-wrap items-end gap-2 border-b border-hairline px-3 py-2">
            <div className="min-w-0 flex-1 sm:max-w-xs">
              <label className="label" htmlFor="officer-region">
                Region
              </label>
              <RegionSelect
                id="officer-region"
                value={regionFilter}
                onChange={setRegionFilter}
                blankLabel="Every region"
                className="py-1 text-xs"
              />
            </div>
            <p className="min-w-0 flex-1 text-2xs leading-relaxed text-faint">
              Filtering by region is done by the API, not in this browser, so a queue of two
              thousand reports narrows the same way a queue of twenty does.
            </p>
          </div>
          {canReview ? (
            <ResourceBody resource={reports} loadingLabel="Reading the report queue" loadingRows={6}>
              {(served) => (
                <DataTable<CitizenReport>
                  rows={rows}
                  columns={columns}
                  rowKey={(report) => report.id}
                  onRowClick={(report) => setSelectedId(report.id)}
                  isActive={(report) => report.id === selectedId}
                  initialSort={{ key: 'filed', direction: 'desc' }}
                  maxHeight="max-h-[34rem]"
                  dense
                  emptyTitle={
                    statusFilter === 'OPEN' ? 'The queue is clear' : 'Nothing matches those filters'
                  }
                  emptyHint={
                    statusFilter === 'OPEN'
                      ? 'No report is waiting on an officer. New ones appear here without a reload.'
                      : 'No stored report has that status in the chosen region.'
                  }
                  caption={`${formatCount(served.count)} citizen reports in the queue, ${formatCount(rows.length)} shown`}
                />
              )}
            </ResourceBody>
          ) : (
            <div className="px-3 py-4">
              <EmptyState
                title="Reading the queue needs an officer account"
                hint="Filing a report needs no account, but reading other people’s does: the descriptions and photographs are somebody else’s, and the API refuses this list to anyone below the officer role."
                icon={<ShieldAlert className="h-5 w-5" aria-hidden />}
              />
            </div>
          )}
        </Panel>

        <div className="min-w-0 space-y-3">
          <Panel title="Report detail" note={selected ? selected.report_code : 'nothing selected'}>
            {selected ? (
              <ReportDetail
                key={selected.id}
                report={selected}
                canReview={canReview}
                busy={busyId === selected.id}
                error={triageError}
                onTriage={(next, note) => triage(selected, next, note)}
                onOpen={(to) => openRegion(selected.region_id, to)}
              />
            ) : (
              <EmptyState
                title="Pick a report"
                hint="Opening one shows the photograph, the description exactly as filed, the screening the server ran on the image, and the region’s current model score beside it."
                icon={<Eye className="h-5 w-5" aria-hidden />}
              />
            )}
          </Panel>

          <Panel
            title="Open alerts"
            note={`${formatCount(openAlerts.length)} live`}
            busy={alerts.refreshing}
            right={
              <button
                type="button"
                className="btn btn-ghost px-2 py-1 text-2xs"
                onClick={() => navigate('/alerts')}
                title="Every alert, with filters and the full history"
              >
                Board
                <ArrowRight className="h-3 w-3" aria-hidden />
              </button>
            }
          >
            {canManage ? (
              <ResourceBody
                resource={alerts}
                loadingLabel="Reading the alert board"
                loadingRows={4}
              >
                {(served) => (
                  <>
                    <AlertWorklist
                      alerts={openAlerts}
                      canManage={canManage}
                      busyId={alertBusyId}
                      onMove={(alert, next) => void moveAlert(alert, next)}
                    />
                    <p className="mt-2.5 text-2xs leading-relaxed text-faint">
                      Thresholds in force: HIGH at {formatScore(served.thresholds.high)}, CRITICAL
                      at {formatScore(served.thresholds.critical)}. Both are read from the backend,
                      so this desk cannot disagree with the engine that raised them.
                    </p>
                  </>
                )}
              </ResourceBody>
            ) : (
              <EmptyState
                title="Moving an alert needs an officer account"
                hint="The board itself is readable without one at /alerts. Changing a status is not."
                icon={<ShieldAlert className="h-5 w-5" aria-hidden />}
              />
            )}
            <InlineError error={alertError} className="mt-2" />
          </Panel>
        </div>
      </div>

      <p className="mt-3 flex items-start gap-2 text-2xs leading-relaxed text-faint">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          Model scores and image screenings on this screen are decision support. They do not replace
          assessment by a qualified engineer or a site visit, and nothing here authorises an
          evacuation — that call belongs to the district authority.
        </span>
      </p>
    </div>
  );
}
