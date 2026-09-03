/**
 * Display formatting, in one place.
 *
 * Two decisions here are load-bearing rather than cosmetic.
 *
 * The first is timezone handling. The backend stores and returns every
 * timestamp in UTC (see `backend/app/clock.py`), but SQLite has no
 * timezone-aware column type, so a value that was written as aware comes back
 * naive and is serialised without an offset - `2026-09-02T10:15:00`. JavaScript
 * reads a date-time string with no offset as *local* time, which in IST would
 * put an alert raised four minutes ago five and a half hours in the future.
 * `parseInstant` therefore assumes UTC whenever an offset is absent, which is
 * exactly what the backend promises.
 *
 * The second is that nothing here invents a value. A missing number formats as
 * an em dash, never as 0: on a warning platform, "no reading" and "zero" are
 * different facts and must not look the same.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** Nothing-to-show marker. Used everywhere a value is absent. */
export const EMPTY = '—';

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

export type Instant = string | number | Date | null | undefined;

/**
 * Parse an API timestamp into a `Date`, treating an offset-less string as UTC.
 * Returns `null` for anything unparseable so callers can render EMPTY rather
 * than the string "Invalid Date".
 */
export function parseInstant(value: Instant): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return new Date(value);
  const text = value.trim();
  // A date with no time is a calendar date, not an instant: keep it out of the
  // timezone machinery entirely so it cannot slide a day either way.
  if (DATE_ONLY.test(text)) {
    const [y, m, d] = text.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0);
  }
  const stamped = HAS_OFFSET.test(text) ? text : `${text}Z`;
  const parsed = new Date(stamped);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
/** `16 Jun 2013` - month names beat numeric order ambiguity. */
export function formatDate(value: Instant): string {
  const at = parseInstant(value);
  if (!at) return EMPTY;
  return `${at.getDate()} ${MONTHS[at.getMonth()]} ${at.getFullYear()}`;
}

/** `14:05` in the viewer's own timezone, 24-hour because this is an ops tool. */
export function formatTime(value: Instant): string {
  const at = parseInstant(value);
  if (!at) return EMPTY;
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** `16 Jun 2013, 14:05` */
export function formatDateTime(value: Instant): string {
  const at = parseInstant(value);
  if (!at) return EMPTY;
  return `${formatDate(at)}, ${formatTime(at)}`;
}

/** `14:05:22` - for the header clock, which ticks every second. */
export function formatClock(value: Instant = new Date()): string {
  const at = parseInstant(value);
  if (!at) return EMPTY;
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/** The viewer's timezone abbreviation, so a displayed time is unambiguous. */
export function timezoneLabel(): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? 'local';
  } catch {
    return 'local';
  }
}

/**
 * `just now`, `4 min ago`, `in 6 h`, `3 days ago`.
 *
 * Alert freshness is read at a glance far more often than an absolute time is,
 * so this is the default in lists; the absolute stamp goes in the tooltip.
 */
export function relativeTime(value: Instant, now: Date = new Date()): string {
  const at = parseInstant(value);
  if (!at) return EMPTY;
  const seconds = (now.getTime() - at.getTime()) / 1000;
  const ahead = seconds < 0;
  const abs = Math.abs(seconds);
  const said = spanWords(abs);
  if (said === null) return 'just now';
  return ahead ? `in ${said}` : `${said} ago`;
}
function spanWords(seconds: number): string | null {
  if (seconds < 45) return null;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)} h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)} ${Math.round(days) === 1 ? 'day' : 'days'}`;
  const months = days / 30.44;
  if (months < 12) return `${Math.round(months)} mo`;
  const years = days / 365.25;
  return `${years.toFixed(years < 10 ? 1 : 0)} yr`;
}

/** How stale a reading is, phrased for a status line. */
export function ageLabel(value: Instant, now: Date = new Date()): string {
  const at = parseInstant(value);
  if (!at) return 'no timestamp';
  return relativeTime(at, now);
}

/** Minutes elapsed, or `null` when the timestamp is missing or unparseable. */
export function ageMinutes(value: Instant, now: Date = new Date()): number | null {
  const at = parseInstant(value);
  if (!at) return null;
  return (now.getTime() - at.getTime()) / 60000;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

// ------------------------------------------------------------------ numbers

function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Grouped integer in Indian digit grouping: `12,34,567`. */
export function count(value: unknown): string {
  const n = finite(value);
  if (n === null) return EMPTY;
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n);
}

/** Fixed decimals, grouped, absent-safe. */
export function decimal(value: unknown, digits = 1): string {
  const n = finite(value);
  if (n === null) return EMPTY;
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}
/**
 * A risk score for a large readout: whole number, 0-100, clamped.
 *
 * Clamped rather than trusted because a score outside the band table would
 * render with no colour at all, and a blank severity is worse than a rounded
 * one.
 */
export function score(value: unknown): string {
  const n = finite(value);
  if (n === null) return EMPTY;
  return String(Math.max(0, Math.min(100, Math.round(n))));
}

/** A 0-1 fraction as a percentage: `0.62` -> `62%`. */
export function percent(fraction: unknown, digits = 0): string {
  const n = finite(fraction);
  if (n === null) return EMPTY;
  return `${decimal(n * 100, digits)}%`;
}

/** A value already expressed in percentage points: `61.4` -> `61%`. */
export function percentPoints(value: unknown, digits = 0): string {
  const n = finite(value);
  if (n === null) return EMPTY;
  return `${decimal(n, digits)}%`;
}

/** Always carries its sign, so a downward contribution is unmistakable. */
export function signed(value: unknown, digits = 1): string {
  const n = finite(value);
  if (n === null) return EMPTY;
  const body = decimal(Math.abs(n), digits);
  if (Math.abs(n) < Number.EPSILON) return body;
  return `${n > 0 ? '+' : '−'}${body}`;
}

/**
 * Population in Indian units: `84,200` below a lakh, then `1.4 L`, `2.3 Cr`.
 *
 * Lakh and crore rather than K/M because the exposure figures on this platform
 * describe Indian districts and are read by Indian officers.
 */
export function people(value: unknown): string {
  const n = finite(value);
  if (n === null) return EMPTY;
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${decimal(n / 1e7, abs >= 1e8 ? 0 : 1)} Cr`;
  if (abs >= 1e5) return `${decimal(n / 1e5, abs >= 1e6 ? 0 : 1)} L`;
  return count(Math.round(n));
}
// -------------------------------------------------------------------- units

/** Rainfall accumulation. Totals get no decimals past 100 mm - false precision. */
export function mm(value: unknown): string {
  const n = finite(value);
  if (n === null) return EMPTY;
  return `${decimal(n, Math.abs(n) >= 100 ? 0 : 1)} mm`;
}

/** Rainfall intensity, which is a different quantity from a total. */
export function mmPerHour(value: unknown): string {
  const n = finite(value);
  if (n === null) return EMPTY;
  return `${decimal(n, 1)} mm/h`;
}

export function celsius(value: unknown): string {
  const n = finite(value);
  if (n === null) return EMPTY;
  return `${decimal(n, 1)} °C`;
}

/** Slope angle, elevation-independent. */
export function degrees(value: unknown, digits = 1): string {
  const n = finite(value);
  if (n === null) return EMPTY;
  return `${decimal(n, digits)}°`;
}

export function metres(value: unknown): string {
  const n = finite(value);
  if (n === null) return EMPTY;
  return `${count(Math.round(n))} m`;
}

export function km(value: unknown, digits = 1): string {
  const n = finite(value);
  if (n === null) return EMPTY;
  return `${decimal(n, digits)} km`;
}

/**
 * A sensor reading with whatever unit the API said it has.
 *
 * The unit is never guessed from the sensor type here: `sensor_simulator.SPECS`
 * owns the unit, ships it with every reading, and this only prints it. One
 * source of truth for what a number means.
 */
export function reading(value: unknown, unit: string, digits = 2): string {
  const n = finite(value);
  if (n === null) return EMPTY;
  return `${decimal(n, digits)} ${unit}`.trim();
}
/** `30.7268° N, 79.0669° E` - six decimals is roughly 0.1 m, enough for a slope. */
export function coords(lat: unknown, lon: unknown): string {
  const la = finite(lat);
  const lo = finite(lon);
  if (la === null || lo === null) return EMPTY;
  const ns = la >= 0 ? 'N' : 'S';
  const ew = lo >= 0 ? 'E' : 'W';
  return `${Math.abs(la).toFixed(4)}° ${ns}, ${Math.abs(lo).toFixed(4)}° ${ew}`;
}

// --------------------------------------------------------------------- text

/** `IN PROGRESS` -> `In progress`. The API speaks in constants; screens do not. */
export function sentenceCase(value: string | null | undefined): string {
  if (!value) return EMPTY;
  const lower = value.trim().toLowerCase().replace(/_/g, ' ');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** `GROUND CRACK` -> `Ground Crack`, for chips and legends. */
export function titleCase(value: string | null | undefined): string {
  if (!value) return EMPTY;
  return value
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** `soil_moisture` -> `Soil moisture`, for feature names from the model. */
export function featureLabel(value: string): string {
  return sentenceCase(value.replace(/_/g, ' '));
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${Math.abs(n) === 1 ? one : many}`;
}

export function truncate(text: string | null | undefined, max = 120): string {
  if (!text) return '';
  const clean = text.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** `NOW`, `+6 h`, `+72 h` - the forecast axis. */
export function horizonLabel(hours: unknown): string {
  const n = finite(hours);
  if (n === null) return EMPTY;
  return n <= 0 ? 'NOW' : `+${Math.round(n)} h`;
}
/** `Kavya Nair` -> `KN`, for the avatar chip in the header. */
export function initials(name: string | null | undefined, fallback = '??'): string {
  if (!name) return fallback;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** `Rudraprayag, Uttarakhand` from a region, skipping whichever part is absent. */
export function place(district?: string | null, state?: string | null): string {
  return [district, state].filter(Boolean).join(', ') || EMPTY;
}

/** Bytes for the upload control on the report form. */
export function fileSize(bytes: unknown): string {
  const n = finite(bytes);
  if (n === null) return EMPTY;
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${decimal(n / 1024, 0)} KB`;
  return `${decimal(n / (1024 * 1024), 1)} MB`;
}

