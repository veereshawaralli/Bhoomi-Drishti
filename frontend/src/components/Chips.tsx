/**
 * The small tags that carry state and provenance.
 *
 * Every number on every screen sits next to one of these. `ModeChip` in
 * particular is not decoration: a DEMO figure has to say DEMO DATA on the same
 * panel as the figure, never in a footnote, and its `title` carries the full
 * sentence explaining what the mode means so a judge or an officer can check
 * what they are looking at without leaving the screen.
 */
import type { ReactNode } from 'react';

import {
  ALERT_STATUS,
  EVENT_SEVERITY,
  REPORT_STATUS,
  ROLE_LABEL,
  SENSOR_STATUS,
  cx,
  modeBadge,
  palette,
  severityPalette,
} from '../lib/risk';
import { score as formatScore } from '../lib/format';
import type {
  AlertSeverity,
  AlertStatus,
  DataMode,
  EventSeverity,
  ReportStatus,
  RiskLevel,
  Role,
  SensorStatus,
} from '../types/api';

export function Chip({
  className,
  title,
  children,
}: {
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={cx('chip', className)} title={title}>
      {children}
    </span>
  );
}

/**
 * A risk band, optionally with its score.
 *
 * `level` is taken as given rather than recomputed from `score`: the backend
 * assigns the band and the two must never disagree on screen.
 */
export function RiskChip({
  level,
  score,
  className,
}: {
  level: RiskLevel;
  score?: number | null;
  className?: string;
}) {
  const tone = palette(level);
  return (
    <Chip className={cx(tone.chip, className)}>
      {level}
      {score !== undefined && score !== null && (
        <span className="tnum opacity-80">{formatScore(score)}</span>
      )}
    </Chip>
  );
}

/** LIVE / DEMO / SIMULATED / MIXED, with the meaning on hover. */
export function ModeChip({
  mode,
  className,
  compact,
}: {
  mode: DataMode | string | null | undefined;
  className?: string;
  compact?: boolean;
}) {
  const badge = modeBadge(mode);
  return (
    <Chip className={cx(badge.chip, className)} title={badge.meaning}>
      {compact ? badge.label.replace(' DATA', '') : badge.label}
    </Chip>
  );
}

export function AlertStatusChip({ status, className }: { status: AlertStatus; className?: string }) {
  const spec = ALERT_STATUS[status] ?? ALERT_STATUS.NEW;
  return <Chip className={cx(spec.chip, className)}>{spec.label}</Chip>;
}

export function SeverityChip({
  severity,
  className,
}: {
  severity: AlertSeverity;
  className?: string;
}) {
  return <Chip className={cx(severityPalette(severity).chip, className)}>{severity}</Chip>;
}

export function ReportStatusChip({
  status,
  className,
}: {
  status: ReportStatus;
  className?: string;
}) {
  const spec = REPORT_STATUS[status] ?? REPORT_STATUS.NEW;
  return <Chip className={cx(spec.chip, className)}>{spec.label}</Chip>;
}

export function EventSeverityChip({
  severity,
  className,
}: {
  severity: EventSeverity;
  className?: string;
}) {
  const spec = EVENT_SEVERITY[severity] ?? EVENT_SEVERITY.MODERATE;
  return <Chip className={cx(spec.chip, className)}>{spec.label}</Chip>;
}

export function SensorStatusChip({
  status,
  className,
}: {
  status: SensorStatus;
  className?: string;
}) {
  const spec = SENSOR_STATUS[status] ?? SENSOR_STATUS.OFFLINE;
  return <Chip className={cx(spec.chip, className)}>{spec.label}</Chip>;
}

export function RoleChip({ role, className }: { role: Role; className?: string }) {
  return (
    <Chip className={cx('border-hairbright bg-raised text-dim', className)}>
      {ROLE_LABEL[role] ?? role}
    </Chip>
  );
}
