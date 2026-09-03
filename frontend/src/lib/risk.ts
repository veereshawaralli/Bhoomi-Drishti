/**
 * Severity, colour and provenance, resolved in one place.
 *
 * Two rules hold everywhere in this file.
 *
 * The band boundaries below mirror `ml/features.py:risk_level` exactly - half
 * open intervals at 20 / 40 / 60 / 80, so a score of 60.0 is HIGH and not
 * MODERATE. `/api/info` also serves a `risk_bands` table, but that one carries
 * the *prose* (what each band means, what to do about it) and states its ranges
 * as inclusive integers for a human reader. The UI takes its wording from the
 * API and its arithmetic from here, and `levelFromScore` is only ever used for
 * client-side previews - a score that came from the backend arrives with its
 * level already attached, and that value is trusted over any recomputation.
 *
 * The hex values match `tailwind.config.js`. They are repeated as literals
 * because Leaflet and Recharts take colours as strings and cannot read a
 * Tailwind class; the class names and the hex map are kept adjacent so a change
 * to one is an obvious prompt to change the other.
 */
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

/** Ascending severity. Used for sorting, legends and band tables. */
export const RISK_LEVELS: readonly RiskLevel[] = [
  'VERY LOW',
  'LOW',
  'MODERATE',
  'HIGH',
  'CRITICAL',
] as const;

/** Position in the ramp, for comparisons like `rank(a) > rank(b)`. */
export function rank(level: RiskLevel): number {
  const index = RISK_LEVELS.indexOf(level);
  return index < 0 ? 0 : index;
}

/** The severity ramp, matching the `risk.*` colours in the Tailwind config. */
export const RISK_HEX: Record<RiskLevel, string> = {
  'VERY LOW': '#3FB8A0',
  LOW: '#A8C256',
  MODERATE: '#E8B23A',
  HIGH: '#E2683C',
  CRITICAL: '#C81E4E',
};
/**
 * Band a score locally. Mirrors `ml/features.py:risk_level`.
 *
 * Only for values the client produced itself - a What-If slider being dragged,
 * an interpolated point between two forecast steps. Anything scored by the
 * backend already carries its level.
 */
export function levelFromScore(score: number): RiskLevel {
  const s = Math.max(0, Math.min(100, Number(score) || 0));
  if (s < 20) return 'VERY LOW';
  if (s < 40) return 'LOW';
  if (s < 60) return 'MODERATE';
  if (s < 80) return 'HIGH';
  return 'CRITICAL';
}

/** Colour for a score, without needing its level. */
export function hexForScore(score: number): string {
  return RISK_HEX[levelFromScore(score)];
}

/**
 * The class set for a severity, as Tailwind utilities.
 *
 * Written out per level rather than interpolated (`text-risk-${slug}`) because
 * Tailwind scans source text for complete class names at build time and would
 * purge anything assembled at run time.
 */
export interface Palette {
  /** Foreground for numerals and labels. */
  text: string;
  /** Translucent fill for cards and chips. */
  bg: string;
  border: string;
  /** Solid fill, for meter bars and legend swatches. */
  solid: string;
  /** Everything a chip needs, in one string. */
  chip: string;
  hex: string;
}

const PALETTES: Record<RiskLevel, Palette> = {
  'VERY LOW': {
    text: 'text-risk-verylow',
    bg: 'bg-risk-verylow/10',
    border: 'border-risk-verylow/40',
    solid: 'bg-risk-verylow',
    chip: 'border-risk-verylow/40 bg-risk-verylow/10 text-risk-verylow',
    hex: RISK_HEX['VERY LOW'],
  },
  LOW: {
    text: 'text-risk-low',
    bg: 'bg-risk-low/10',
    border: 'border-risk-low/40',
    solid: 'bg-risk-low',
    chip: 'border-risk-low/40 bg-risk-low/10 text-risk-low',
    hex: RISK_HEX.LOW,
  },
  MODERATE: {
    text: 'text-risk-moderate',
    bg: 'bg-risk-moderate/10',
    border: 'border-risk-moderate/40',
    solid: 'bg-risk-moderate',
    chip: 'border-risk-moderate/40 bg-risk-moderate/10 text-risk-moderate',
    hex: RISK_HEX.MODERATE,
  },
  HIGH: {
    text: 'text-risk-high',
    bg: 'bg-risk-high/10',
    border: 'border-risk-high/45',
    solid: 'bg-risk-high',
    chip: 'border-risk-high/45 bg-risk-high/12 text-risk-high',
    hex: RISK_HEX.HIGH,
  },
  CRITICAL: {
    text: 'text-risk-critical',
    bg: 'bg-risk-critical/12',
    border: 'border-risk-critical/50',
    solid: 'bg-risk-critical',
    chip: 'border-risk-critical/50 bg-risk-critical/15 text-risk-critical',
    hex: RISK_HEX.CRITICAL,
  },
};

export function palette(level: RiskLevel): Palette {
  return PALETTES[level] ?? PALETTES['VERY LOW'];
}

export function paletteForScore(score: number): Palette {
  return palette(levelFromScore(score));
}

/** Alert severity is a two-value slice of the same ramp. */
export function severityPalette(severity: AlertSeverity): Palette {
  return palette(severity === 'CRITICAL' ? 'CRITICAL' : 'HIGH');
}
// ------------------------------------------------------------- provenance

/**
 * How a data mode is shown. Every number on every screen is reachable from one
 * of these badges, and the wording is deliberately blunt: a DEMO figure says
 * DEMO DATA on the same panel as the figure, not in a footnote. Nothing in this
 * platform is allowed to look live when it is not.
 */
export interface ModeBadge {
  label: string;
  chip: string;
  hex: string;
  meaning: string;
}

export const DATA_MODES: Record<DataMode, ModeBadge> = {
  LIVE: {
    label: 'LIVE DATA',
    chip: 'border-risk-verylow/45 bg-risk-verylow/10 text-risk-verylow',
    hex: RISK_HEX['VERY LOW'],
    meaning: 'Fetched from an external provider just now.',
  },
  DEMO: {
    label: 'DEMO DATA',
    chip: 'border-risk-moderate/45 bg-risk-moderate/10 text-risk-moderate',
    hex: RISK_HEX.MODERATE,
    meaning:
      'Modelled stand-in for a real feed, generated deterministically. Not a real observation.',
  },
  SIMULATED: {
    label: 'SIMULATED DATA',
    chip: 'border-accentdim/60 bg-accent/10 text-accent',
    hex: '#48C9E6',
    meaning:
      'Produced by a software model of an instrument. No physical hardware exists in this platform.',
  },
  MIXED: {
    label: 'MIXED DATA',
    chip: 'border-risk-low/45 bg-risk-low/10 text-risk-low',
    hex: RISK_HEX.LOW,
    meaning: 'Part documented record, part modelled - labelled per row.',
  },
};

/** Tolerant of an unknown string so an unexpected mode is never shown as live. */
export function modeBadge(mode: DataMode | string | null | undefined): ModeBadge {
  const key = String(mode ?? '').toUpperCase();
  return DATA_MODES[key as DataMode] ?? DATA_MODES.DEMO;
}
// --------------------------------------------------------------- workflow

export interface Chip {
  label: string;
  chip: string;
}

/**
 * Alert workflow states. NEW is the loudest thing on the screen and RESOLVED
 * the quietest, so an officer scanning a list sees what is unattended first.
 */
export const ALERT_STATUS: Record<AlertStatus, Chip> = {
  NEW: {
    label: 'New',
    chip: 'border-risk-critical/50 bg-risk-critical/15 text-risk-critical',
  },
  ACKNOWLEDGED: {
    label: 'Acknowledged',
    chip: 'border-risk-moderate/45 bg-risk-moderate/10 text-risk-moderate',
  },
  'IN PROGRESS': {
    label: 'In progress',
    chip: 'border-accentdim/60 bg-accent/10 text-accent',
  },
  RESOLVED: {
    label: 'Resolved',
    chip: 'border-hairbright bg-raised text-dim',
  },
};

/**
 * The transitions the API will accept, mirroring
 * `alert_service._ALLOWED_TRANSITIONS`. The officer dashboard offers only these
 * as buttons, so a legal-looking control never comes back as a 409. The backend
 * still enforces it - this copy shapes the UI, it does not guard anything.
 */
export const ALERT_TRANSITIONS: Record<AlertStatus, AlertStatus[]> = {
  NEW: ['ACKNOWLEDGED', 'IN PROGRESS', 'RESOLVED'],
  ACKNOWLEDGED: ['IN PROGRESS', 'RESOLVED'],
  'IN PROGRESS': ['ACKNOWLEDGED', 'RESOLVED'],
  RESOLVED: ['IN PROGRESS'],
};

export function nextStatuses(status: AlertStatus): AlertStatus[] {
  return ALERT_TRANSITIONS[status] ?? [];
}

/**
 * The workflow in order, from unattended to closed.
 *
 * Declared once so the filter dropdown, the legend and the table's status sort
 * all agree on what "further along" means.
 */
export const ALERT_STATUSES: readonly AlertStatus[] = [
  'NEW',
  'ACKNOWLEDGED',
  'IN PROGRESS',
  'RESOLVED',
];

/** An alert still needing someone's attention. */
export function isOpen(status: AlertStatus): boolean {
  return status !== 'RESOLVED';
}
export const REPORT_STATUS: Record<ReportStatus, Chip> = {
  NEW: { label: 'New', chip: 'border-accentdim/60 bg-accent/10 text-accent' },
  'UNDER REVIEW': {
    label: 'Under review',
    chip: 'border-risk-moderate/45 bg-risk-moderate/10 text-risk-moderate',
  },
  VERIFIED: {
    label: 'Verified',
    chip: 'border-risk-verylow/45 bg-risk-verylow/10 text-risk-verylow',
  },
  DISMISSED: { label: 'Dismissed', chip: 'border-hairbright bg-raised text-faint' },
};

/** Historical event severity - a record of what happened, not a forecast. */
export const EVENT_SEVERITY: Record<EventSeverity, Chip> = {
  MINOR: { label: 'Minor', chip: 'border-risk-low/40 bg-risk-low/10 text-risk-low' },
  MODERATE: {
    label: 'Moderate',
    chip: 'border-risk-moderate/45 bg-risk-moderate/10 text-risk-moderate',
  },
  MAJOR: { label: 'Major', chip: 'border-risk-high/45 bg-risk-high/12 text-risk-high' },
  SEVERE: {
    label: 'Severe',
    chip: 'border-risk-critical/50 bg-risk-critical/15 text-risk-critical',
  },
};

export const EVENT_SEVERITY_HEX: Record<EventSeverity, string> = {
  MINOR: RISK_HEX.LOW,
  MODERATE: RISK_HEX.MODERATE,
  MAJOR: RISK_HEX.HIGH,
  SEVERE: RISK_HEX.CRITICAL,
};
/**
 * Virtual instrument states. Thresholds come from the API with every reading
 * (`elevated_at`, `alarm_at`), so this only carries appearance, never a number.
 */
export const SENSOR_STATUS: Record<SensorStatus, Chip> = {
  NORMAL: {
    label: 'Normal',
    chip: 'border-risk-verylow/40 bg-risk-verylow/10 text-risk-verylow',
  },
  ELEVATED: {
    label: 'Elevated',
    chip: 'border-risk-moderate/45 bg-risk-moderate/10 text-risk-moderate',
  },
  ALARM: {
    label: 'Alarm',
    chip: 'border-risk-critical/50 bg-risk-critical/15 text-risk-critical',
  },
  OFFLINE: { label: 'Offline', chip: 'border-hairbright bg-raised text-faint' },
};

export const SENSOR_STATUS_HEX: Record<SensorStatus, string> = {
  NORMAL: RISK_HEX['VERY LOW'],
  ELEVATED: RISK_HEX.MODERATE,
  ALARM: RISK_HEX.CRITICAL,
  OFFLINE: '#5C7691',
};

export const ROLE_LABEL: Record<Role, string> = {
  CITIZEN: 'Citizen',
  OFFICER: 'District officer',
  ADMIN: 'Administrator',
};

// -------------------------------------------------------------- thresholds

export interface Thresholds {
  high: number;
  critical: number;
}

/** Fallback only, replaced by `/api/info` on load. Matches the backend default. */
export const DEFAULT_THRESHOLDS: Thresholds = { high: 60, critical: 80 };

/** Whether a score is high enough that the alert engine would act on it. */
export function raisesAlert(score: number, thresholds: Thresholds): boolean {
  return Number(score) >= thresholds.high;
}
// ------------------------------------------------------------------- map

/**
 * Marker radius in pixels, 6 to 15 by score.
 *
 * Area, not radius, is what the eye reads as magnitude, so the radius grows
 * with the square root of the score. A quiet region stays a small dot instead
 * of disappearing, because "monitored and calm" is information too.
 */
export function markerRadius(score: number, zoom = 6): number {
  const s = Math.max(0, Math.min(100, Number(score) || 0));
  const base = 6 + Math.sqrt(s / 100) * 9;
  const zoomBoost = Math.max(0, Math.min(1.35, 0.75 + (zoom - 5) * 0.12));
  return Math.round(base * zoomBoost * 10) / 10;
}

/** Only HIGH and CRITICAL pulse. If everything animates, nothing is urgent. */
export function shouldPulse(level: RiskLevel): boolean {
  return level === 'HIGH' || level === 'CRITICAL';
}

// ------------------------------------------------------------- confidence

/**
 * Confidence in words.
 *
 * This describes how closely the ensemble members agreed, which is a statement
 * about the model and not about the hillside. `caution` is shown next to it so
 * a high number is never read as a promise.
 */
export function confidenceWord(confidence: number): { word: string; caution: string } {
  const c = Number(confidence) || 0;
  if (c >= 0.75) {
    return {
      word: 'High',
      caution: 'The model’s members agreed closely. Agreement is not accuracy.',
    };
  }
  if (c >= 0.55) {
    return {
      word: 'Moderate',
      caution: 'Some disagreement between model members - treat the score as indicative.',
    };
  }
  return {
    word: 'Low',
    caution: 'The model members disagreed. Corroborate before acting on this score.',
  };
}
// ----------------------------------------------------------------- deltas

export type Direction = 'up' | 'down' | 'flat';

/**
 * How a change in risk should read. Rising risk is coloured with the severity
 * ramp and falling risk with the calm end of it - on this platform "up" is bad,
 * which is the opposite of a financial dashboard and worth being explicit about.
 */
export function deltaStyle(delta: number, deadband = 0.5): {
  direction: Direction;
  text: string;
  arrow: string;
} {
  const d = Number(delta) || 0;
  if (Math.abs(d) < deadband) {
    return { direction: 'flat', text: 'text-dim', arrow: '→' };
  }
  return d > 0
    ? { direction: 'up', text: 'text-risk-critical', arrow: '↑' }
    : { direction: 'down', text: 'text-risk-verylow', arrow: '↓' };
}

/** A factor that pushes risk up is red; one that holds it down is teal. */
export function factorStyle(contribution: number): { text: string; solid: string } {
  return contribution >= 0
    ? { text: 'text-risk-high', solid: 'bg-risk-high' }
    : { text: 'text-risk-verylow', solid: 'bg-risk-verylow' };
}

/** Join class names, dropping anything falsy. Saves a dependency on clsx. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

