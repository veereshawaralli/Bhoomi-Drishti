/**
 * Shared Recharts furniture: the palette, the axis and grid defaults, the
 * tooltip shell, and the risk-band shading every score chart sits on.
 *
 * Recharts draws SVG and wants literal colours, so it cannot be themed with
 * Tailwind classes. The tokens from `tailwind.config.js` are therefore repeated
 * here as hex - once, in this file, rather than sprinkled through four chart
 * components where they would drift apart.
 *
 * Axes are exported as prop objects to spread, not as wrapper components, and
 * that is not a style preference. Recharts discovers its axes, reference lines
 * and series by inspecting the *type* of its direct children: `<XAxis {...AXIS} />`
 * works, while a `<StyledXAxis />` of my own is silently ignored and the chart
 * renders with no axis at all. For the same reason the band and threshold
 * helpers return arrays of elements rather than fragments - React flattens an
 * array child, so Recharts still sees each `ReferenceArea` individually.
 */
import type { ReactElement, ReactNode } from 'react';
import { ReferenceArea, ReferenceLine, ResponsiveContainer } from 'recharts';

import { RISK_HEX, RISK_LEVELS, cx } from '../lib/risk';
import type { RiskLevel } from '../types/api';

/** The chrome, as hex. Mirrors the `colors` block of the Tailwind config. */
export const CHART = {
  ground: '#08121C',
  panel: '#0D1B29',
  raised: '#112436',
  grid: '#1C3346',
  axis: '#2A4A63',
  faint: '#5C7691',
  dim: '#8AA2B8',
  ink: '#DCE7F0',
  accent: '#48C9E6',
  accentdim: '#1E7A94',
  /** Rain, water and population: deliberately off the severity ramp so a blue
   *  bar is never mistaken for a risk reading. */
  water: '#7FB2E5',
  /** Second neutral, for a paired series such as modelled vs documented. */
  slate: '#6C8AA6',
} as const;

/** The mono stack, for SVG text that Tailwind cannot reach. */
export const MONO = '"IBM Plex Mono", ui-monospace, Consolas, monospace';

export const TICK = { fill: CHART.faint, fontSize: 10, fontFamily: MONO } as const;

/** Spread into every `XAxis` and `YAxis`: hairline rule, mono ticks, no combs. */
export const AXIS = {
  tick: TICK,
  tickLine: false,
  axisLine: { stroke: CHART.axis },
  stroke: CHART.axis,
} as const;

/** Horizontal rules only. Vertical grid lines fight the bars. */
export const GRID = {
  stroke: CHART.grid,
  strokeDasharray: '2 4',
  vertical: false,
} as const;

export const CURSOR_BAR = { fill: 'rgba(72,201,230,0.07)' } as const;
export const CURSOR_LINE = {
  stroke: CHART.accentdim,
  strokeWidth: 1,
  strokeDasharray: '3 3',
} as const;

// -------------------------------------------------------------- band shading

/** The five band edges, as the specification fixes them. */
const BAND_EDGES: Record<RiskLevel, [number, number]> = {
  'VERY LOW': [0, 20],
  LOW: [20, 40],
  MODERATE: [40, 60],
  HIGH: [60, 80],
  CRITICAL: [80, 100],
};

/**
 * Five faint horizontal stripes behind a score series, so a reader can see
 * which band a curve is *in* without tracing it back to the axis.
 *
 * Returned as an array because Recharts only inspects direct children; a
 * fragment would hide these from it in some versions.
 */
export function riskBandAreas(yAxisId: string | number = 0, opacity = 0.07): ReactElement[] {
  return RISK_LEVELS.map((level) => {
    const [low, high] = BAND_EDGES[level];
    return (
      <ReferenceArea
        key={level}
        yAxisId={yAxisId}
        y1={low}
        y2={high}
        fill={RISK_HEX[level]}
        fillOpacity={opacity}
        stroke="none"
        ifOverflow="hidden"
      />
    );
  });
}

/**
 * The two lines that matter operationally: where this platform starts raising
 * alerts, and where it escalates. Labelled on the chart itself, because a
 * curve crossing 60 is the whole point of the forecast.
 */
export function thresholdLines(
  high: number,
  critical: number,
  yAxisId: string | number = 0,
): ReactElement[] {
  return [
    { value: high, hex: RISK_HEX.HIGH, text: `HIGH ${high}` },
    { value: critical, hex: RISK_HEX.CRITICAL, text: `CRITICAL ${critical}` },
  ].map((line) => (
    <ReferenceLine
      key={line.text}
      yAxisId={yAxisId}
      y={line.value}
      stroke={line.hex}
      strokeDasharray="4 3"
      strokeOpacity={0.75}
      ifOverflow="hidden"
      label={{
        value: line.text,
        position: 'insideTopLeft',
        fill: line.hex,
        fontSize: 9,
        fontFamily: MONO,
        offset: 4,
      }}
    />
  ));
}

// ------------------------------------------------------------------ tooltips

/**
 * The shape Recharts hands a custom tooltip.
 *
 * Declared locally, with every field optional, rather than imported from
 * Recharts' own generics. Two reasons: the library's `TooltipProps` is
 * parameterised over value and name types that change between minor versions,
 * and every field really is absent at some point in the hover lifecycle.
 * Tooltips are passed as elements (`content={<Tip />}`) so Recharts clones them
 * with these props injected.
 */
export interface TipItem {
  name?: string | number;
  value?: number | string | (number | string)[];
  dataKey?: string | number;
  color?: string;
  unit?: string;
  payload?: Record<string, unknown>;
}

export interface TipProps {
  active?: boolean;
  label?: string | number;
  payload?: TipItem[];
}

/** The floating card itself: same bezel and hairline as a panel, tighter type. */
export function TooltipCard({
  title,
  meta,
  children,
  className,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        'min-w-[132px] rounded-panel border border-hairbright bg-ground/95 px-2.5 py-1.5 shadow-bezel backdrop-blur-sm',
        className,
      )}
    >
      {title && (
        <p className="font-display text-2xs font-semibold uppercase tracking-wider text-ink">
          {title}
        </p>
      )}
      {meta && <p className="font-mono text-[10px] text-faint">{meta}</p>}
      {children && <div className="mt-1 space-y-0.5">{children}</div>}
    </div>
  );
}

/** One labelled number inside a tooltip, with the series' own colour. */
export function TipRow({
  label,
  value,
  hex,
  shape = 'square',
}: {
  label: ReactNode;
  value: ReactNode;
  hex?: string;
  shape?: 'square' | 'line';
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="flex items-center gap-1.5 text-2xs text-dim">
        {hex && (
          <span
            className={shape === 'line' ? 'h-0.5 w-2.5 shrink-0' : 'h-2 w-2 shrink-0 rounded-sm'}
            style={{ backgroundColor: hex }}
            aria-hidden
          />
        )}
        {label}
      </span>
      <span className="tnum shrink-0 font-mono text-2xs text-ink">{value}</span>
    </div>
  );
}

/** A tooltip value, coerced to a number, or null when the series has a gap. */
export function tipNumber(item: TipItem | undefined): number | null {
  if (!item) return null;
  const raw = Array.isArray(item.value) ? item.value[item.value.length - 1] : item.value;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Find a series in the hovered payload by its `dataKey`. */
export function tipItem(payload: TipItem[] | undefined, key: string): TipItem | undefined {
  return payload?.find((entry) => entry.dataKey === key);
}

// -------------------------------------------------------------------- framing

/**
 * The sized box a chart lives in.
 *
 * `ResponsiveContainer` measures its parent, so the parent needs a height that
 * does not depend on its content - otherwise the first paint measures zero and
 * the chart never appears. The height is applied inline because it arrives as a
 * number and Tailwind cannot build a class from a runtime value.
 */
export function ChartFrame({
  height = 220,
  children,
  className,
}: {
  height?: number;
  children: ReactElement;
  className?: string;
}) {
  return (
    <div className={cx('w-full min-w-0', className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

/**
 * A chart with nothing to draw, held at the same height as the chart it
 * replaces so a filter that matches no events does not make the page jump.
 */
export function ChartEmpty({
  message = 'No data for this selection',
  height = 220,
}: {
  message?: string;
  height?: number;
}) {
  return (
    <div
      className="flex w-full items-center justify-center rounded-panel border border-dashed border-hairline"
      style={{ height }}
    >
      <p className="px-4 text-center text-2xs text-faint">{message}</p>
    </div>
  );
}

export interface LegendItem {
  label: string;
  hex: string;
  shape?: 'square' | 'line' | 'dot';
  hint?: string;
}

/**
 * A hand-built legend instead of Recharts' `<Legend>`.
 *
 * The built-in one reserves layout height inside the plot area and restyles
 * badly at this type size; this row sits under the chart, wraps, and can carry
 * a `title` explaining what a series actually is.
 */
export function ChartLegend({ items, className }: { items: LegendItem[]; className?: string }) {
  return (
    <ul className={cx('flex flex-wrap items-center gap-x-3 gap-y-1', className)}>
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5" title={item.hint}>
          <span
            className={cx(
              'shrink-0',
              item.shape === 'line' && 'h-0.5 w-3',
              item.shape === 'dot' && 'h-2 w-2 rounded-full',
              (!item.shape || item.shape === 'square') && 'h-2 w-2 rounded-sm',
            )}
            style={{ backgroundColor: item.hex }}
            aria-hidden
          />
          <span className="text-2xs text-dim">{item.label}</span>
        </li>
      ))}
    </ul>
  );
}
