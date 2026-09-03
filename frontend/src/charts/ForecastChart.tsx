/**
 * The 72-hour risk forecast: one curve for score, bars for the rainfall driving
 * it, the alert thresholds it has to cross, and a marked peak.
 *
 * Two vertical scales share one plot because the question an operator asks is
 * never "what is the score" or "how hard will it rain" on its own - it is
 * whether the two move together. Risk is on the left in points, rainfall on the
 * right in mm/h, and the axis units are written on the axes so the pairing
 * cannot be misread as one quantity.
 *
 * The curve is stroked in the platform's accent colour, not in the severity
 * ramp, because a single line cannot honestly be one colour while crossing four
 * bands. Severity is carried instead by the band stripes behind it and by the
 * dots, which take the colour of the band each point actually falls in.
 *
 * Every value here is model output for a future hour. Nothing on this chart is
 * an observation, and the forecast page says so beside it.
 */
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { formatDateTime, formatTime, mmPerHour, percent, score as fmtScore } from '../lib/format';
import {
  DEFAULT_THRESHOLDS,
  RISK_HEX,
  type Thresholds,
  cx,
  hexForScore,
  palette,
} from '../lib/risk';
import type { ForecastPoint, RiskLevel } from '../types/api';
import type { LegendItem, TipProps } from './theme';
import {
  AXIS,
  CHART,
  ChartEmpty,
  ChartFrame,
  ChartLegend,
  CURSOR_LINE,
  GRID,
  MONO,
  TICK,
  TipRow,
  TooltipCard,
  riskBandAreas,
  thresholdLines,
  tipItem,
  tipNumber,
} from './theme';

/** One plotted hour, flattened so Recharts can read it by key. */
interface Row {
  label: string;
  hours: number;
  valid_at: string;
  score: number;
  level: RiskLevel;
  rain: number;
  moisture: number | null;
  confidence: number;
  hex: string;
}

function toRows(points: ForecastPoint[]): Row[] {
  return points.map((point) => ({
    label: point.label,
    hours: point.hours,
    valid_at: point.valid_at,
    score: Math.max(0, Math.min(100, point.risk_score)),
    level: point.risk_level,
    rain: point.rainfall_mm,
    moisture: point.soil_moisture_pct,
    confidence: point.confidence,
    hex: RISK_HEX[point.risk_level] ?? hexForScore(point.risk_score),
  }));
}

/**
 * The worst hour in the horizon.
 *
 * The backend supplies its own `peak`, and that is what the pages display. This
 * exists for the What-If simulator, which re-scores a curve client-side and has
 * no server peak to quote.
 */
export function forecastPeak(points: ForecastPoint[]): ForecastPoint | null {
  if (!points.length) return null;
  return points.reduce((worst, point) => (point.risk_score > worst.risk_score ? point : worst));
}

// ------------------------------------------------------------------- tooltip

/**
 * Recharts calls the dot renderer once per point, so the band colour can change
 * along the line. `index` arrives from the library and gives each circle a
 * stable key.
 */
interface DotProps {
  cx?: number;
  cy?: number;
  index?: number;
  payload?: Row;
}

function BandDot({ cx: x, cy: y, index, payload }: DotProps) {
  if (x === undefined || y === undefined || !payload) return <g key={`dot-${index ?? 0}`} />;
  const big = payload.level === 'HIGH' || payload.level === 'CRITICAL';
  return (
    <circle
      key={`dot-${index ?? 0}`}
      cx={x}
      cy={y}
      r={big ? 3.6 : 2.8}
      fill={payload.hex}
      stroke={CHART.ground}
      strokeWidth={1.2}
    />
  );
}

function ForecastTip({ active, label, payload }: TipProps) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as Row | undefined;
  const scoreValue = tipNumber(tipItem(payload, 'score')) ?? row?.score ?? null;
  if (!row || scoreValue === null) return null;
  const tone = palette(row.level);

  return (
    <TooltipCard title={String(label ?? row.label)} meta={formatDateTime(row.valid_at)}>
      <TipRow
        label="Risk score"
        value={
          <span className={tone.text}>
            {fmtScore(scoreValue)} <span className="text-faint">/ {row.level}</span>
          </span>
        }
        hex={row.hex}
        shape="line"
      />
      <TipRow label="Rainfall" value={mmPerHour(row.rain)} hex={CHART.water} />
      {row.moisture !== null && (
        <TipRow label="Soil moisture" value={`${Math.round(row.moisture)}%`} />
      )}
      <TipRow label="Confidence" value={percent(row.confidence)} />
    </TooltipCard>
  );
}

// --------------------------------------------------------------------- chart

export interface ForecastChartProps {
  points: ForecastPoint[];
  /** The server's own peak. Falls back to the worst plotted hour. */
  peak?: ForecastPoint | null;
  thresholds?: Thresholds;
  height?: number;
  /** Hidden on narrow panels, where two axes are more clutter than help. */
  showRainfall?: boolean;
  legend?: boolean;
  className?: string;
}

export function ForecastChart({
  points,
  peak,
  thresholds = DEFAULT_THRESHOLDS,
  height = 250,
  showRainfall = true,
  legend = true,
  className,
}: ForecastChartProps) {
  const rows = toRows(points);
  if (!rows.length) {
    return <ChartEmpty height={height} message="No forecast for this region yet" />;
  }

  const worst = peak ?? forecastPeak(points);
  const peakRow = worst ? rows.find((row) => row.hours === worst.hours) ?? null : null;

  const legendItems: LegendItem[] = [
    {
      label: 'Risk score (0-100)',
      hex: CHART.accent,
      shape: 'line',
      hint: 'Model output for each future hour, left-hand axis',
    },
  ];
  if (showRainfall) {
    legendItems.push({
      label: 'Forecast rainfall (mm/h)',
      hex: CHART.water,
      hint: 'Right-hand axis. An intensity, not a period total.',
    });
  }
  legendItems.push(
    { label: `Alert from ${thresholds.high}`, hex: RISK_HEX.HIGH, shape: 'line' },
    { label: `Critical from ${thresholds.critical}`, hex: RISK_HEX.CRITICAL, shape: 'line' },
  );

  return (
    <div className={cx('min-w-0', className)}>
      <ChartFrame height={height}>
        <ComposedChart data={rows} margin={{ top: 16, right: 4, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="forecastFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART.accent} stopOpacity={0.3} />
              <stop offset="100%" stopColor={CHART.accent} stopOpacity={0.02} />
            </linearGradient>
          </defs>

          {riskBandAreas('risk')}
          <CartesianGrid {...GRID} />

          <XAxis dataKey="label" {...AXIS} interval={0} height={18} />
          <YAxis
            yAxisId="risk"
            {...AXIS}
            domain={[0, 100]}
            ticks={[0, 20, 40, 60, 80, 100]}
            width={30}
          />
          {showRainfall && (
            <YAxis
              yAxisId="rain"
              orientation="right"
              {...AXIS}
              domain={[0, 'auto']}
              width={30}
              tick={{ ...TICK, fill: CHART.water }}
            />
          )}

          {showRainfall && (
            <Bar
              yAxisId="rain"
              dataKey="rain"
              name="Rainfall"
              fill={CHART.water}
              fillOpacity={0.45}
              barSize={13}
              radius={[1, 1, 0, 0]}
              isAnimationActive={false}
            />
          )}

          <Area
            yAxisId="risk"
            type="monotone"
            dataKey="score"
            stroke="none"
            fill="url(#forecastFill)"
            tooltipType="none"
            isAnimationActive={false}
          />
          <Line
            yAxisId="risk"
            type="monotone"
            dataKey="score"
            name="Risk score"
            stroke={CHART.accent}
            strokeWidth={2}
            dot={BandDot}
            activeDot={{ r: 4.5, fill: CHART.ink, stroke: CHART.ground, strokeWidth: 1.5 }}
            isAnimationActive={false}
          />

          {thresholdLines(thresholds.high, thresholds.critical, 'risk')}
          {peakRow && (
            <ReferenceLine
              yAxisId="risk"
              x={peakRow.label}
              stroke={peakRow.hex}
              strokeDasharray="3 2"
              label={{
                value: `PEAK ${fmtScore(peakRow.score)}`,
                position: 'top',
                fill: peakRow.hex,
                fontSize: 9,
                fontFamily: MONO,
              }}
            />
          )}

          <Tooltip content={<ForecastTip />} cursor={CURSOR_LINE} />
        </ComposedChart>
      </ChartFrame>

      {legend && <ChartLegend className="mt-2 px-1" items={legendItems} />}
    </div>
  );
}

// --------------------------------------------------------------- horizon tiles

/**
 * The six horizons as tiles, above or below the curve.
 *
 * The chart shows the shape; these show the numbers. An officer deciding whether
 * to move people tonight needs to read "+24 h: 78 HIGH" without interpolating
 * from an axis, and the peak tile is flagged so the worst hour is found by
 * looking rather than by comparing.
 *
 * Rendered as buttons only when `onPick` is supplied. A tile that looks pressable
 * and does nothing is worse than a tile that does not look pressable.
 */
export function ForecastStrip({
  points,
  peak,
  activeHours,
  onPick,
  className,
}: {
  points: ForecastPoint[];
  peak?: ForecastPoint | null;
  /** Highlights one tile, when a page keeps a selected horizon. */
  activeHours?: number | null;
  onPick?: (point: ForecastPoint) => void;
  className?: string;
}) {
  if (!points.length) return null;
  const worst = peak ?? forecastPeak(points);

  return (
    <div className={cx('grid grid-cols-3 gap-1.5 sm:grid-cols-6', className)}>
      {points.map((point) => {
        const tone = palette(point.risk_level);
        const isPeak = worst ? point.hours === worst.hours : false;
        const isActive = activeHours !== null && activeHours !== undefined && activeHours === point.hours;
        const body = (
          <>
            <div className="flex items-baseline justify-between gap-1">
              <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
                {point.label}
              </span>
              {isPeak && (
                <span className="font-mono text-[9px] uppercase tracking-wider text-ink">peak</span>
              )}
            </div>
            <p className={cx('tnum font-display text-xl font-semibold leading-none', tone.text)}>
              {fmtScore(point.risk_score)}
            </p>
            <p className="mt-0.5 truncate text-[10px] uppercase tracking-wider text-dim">
              {point.risk_level}
            </p>
            <p className="font-mono text-[10px] text-faint">{formatTime(point.valid_at)}</p>
            <span
              className="mt-1 block h-0.5 w-full rounded-full"
              style={{ backgroundColor: RISK_HEX[point.risk_level] }}
              aria-hidden
            />
          </>
        );

        const shell = cx(
          'rounded-panel border px-2 py-1.5 text-left transition-colors',
          isActive ? 'border-accent/60 bg-accent/10' : cx(tone.border, tone.bg),
        );

        return onPick ? (
          <button
            key={point.hours}
            type="button"
            className={cx(shell, 'hover:border-accent/60')}
            onClick={() => onPick(point)}
            aria-pressed={isActive}
            title={`${point.label} · ${formatDateTime(point.valid_at)}`}
          >
            {body}
          </button>
        ) : (
          <div key={point.hours} className={shell} title={formatDateTime(point.valid_at)}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

/** "Peak 83 CRITICAL at +48 h, 12 Sep 14:00" - for a panel note or a caption. */
export function peakSentence(peak: ForecastPoint | null | undefined): string {
  if (!peak) return 'No peak in the current horizon.';
  return `Peak ${fmtScore(peak.risk_score)} ${peak.risk_level} at ${peak.label}, ${formatDateTime(
    peak.valid_at,
  )}`;
}
