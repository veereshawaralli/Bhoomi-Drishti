/**
 * The virtual instruments, plotted.
 *
 * Everything in this file draws numbers produced by a software model. There is
 * no hardware anywhere in this platform, and the chart says so on its face
 * rather than in a caption a reader can scroll past: the plot carries a
 * SIMULATED stamp inside the frame, and the tooltip repeats it on every hover.
 *
 * The two horizontal rules are not decoration either. They are the instrument's
 * own `elevated_at` and `alarm_at`, sent with every reading by the API, so the
 * chart never invents a threshold of its own - if the backend retunes an
 * instrument, these lines move with it.
 */
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { formatDateTime, formatTime, reading as fmtReading } from '../lib/format';
import { SENSOR_STATUS, SENSOR_STATUS_HEX, cx } from '../lib/risk';
import type {
  SensorCounts,
  SensorHistoryResponse,
  SensorStatus,
  StoredSensorReading,
} from '../types/api';
import type { TipProps } from './theme';
import {
  AXIS,
  CHART,
  ChartEmpty,
  ChartFrame,
  ChartLegend,
  CURSOR_LINE,
  GRID,
  MONO,
  TipRow,
  TooltipCard,
} from './theme';

interface Row {
  time: string;
  stamp: string;
  value: number;
  status: SensorStatus;
  hex: string;
}

function toRows(readings: StoredSensorReading[]): Row[] {
  return readings.map((row) => ({
    time: formatTime(row.recorded_at),
    stamp: row.recorded_at,
    value: row.reading,
    status: row.status,
    hex: SENSOR_STATUS_HEX[row.status] ?? CHART.slate,
  }));
}

function SensorDot({
  cx: x,
  cy: y,
  index,
  payload,
}: {
  cx?: number;
  cy?: number;
  index?: number;
  payload?: Row;
}) {
  if (x === undefined || y === undefined || !payload) return <g key={`dot-${index ?? 0}`} />;
  // Only the interesting readings get a dot. A dot on all 96 samples is a smear.
  const notable = payload.status === 'ELEVATED' || payload.status === 'ALARM';
  if (!notable) return <g key={`dot-${index ?? 0}`} />;
  return (
    <circle
      key={`dot-${index ?? 0}`}
      cx={x}
      cy={y}
      r={payload.status === 'ALARM' ? 3.4 : 2.6}
      fill={payload.hex}
      stroke={CHART.ground}
      strokeWidth={1.1}
    />
  );
}

function SensorTip({ active, payload, unit = '' }: TipProps & { unit?: string }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as Row | undefined;
  if (!row) return null;
  const chip = SENSOR_STATUS[row.status];
  return (
    <TooltipCard title={fmtReading(row.value, unit)} meta={formatDateTime(row.stamp)}>
      <TipRow label="State" value={chip?.label ?? row.status} hex={row.hex} />
      <p className="pt-0.5 font-mono text-[9px] uppercase tracking-wider text-faint">
        Simulated reading
      </p>
    </TooltipCard>
  );
}

/**
 * One instrument's recent readings.
 *
 * The y-axis floor is pinned to zero when the data allows it, so the shape of
 * the trace is honest about magnitude; if a reading ever goes negative the axis
 * extends rather than clipping it.
 */
export function SensorHistoryChart({
  history,
  height = 200,
  legend = true,
  className,
}: {
  history: SensorHistoryResponse;
  height?: number;
  legend?: boolean;
  className?: string;
}) {
  const rows = toRows(history.readings);
  if (!rows.length) {
    return <ChartEmpty height={height} message="No stored readings for this instrument yet" />;
  }

  const ceiling = Math.max(history.alarm_at, ...rows.map((row) => row.value)) * 1.08;
  const last = rows[rows.length - 1];

  return (
    <div className={cx('min-w-0', className)}>
      <div className="relative">
        <ChartFrame height={height}>
          <ComposedChart data={rows} margin={{ top: 14, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="sensorFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART.water} stopOpacity={0.26} />
                <stop offset="100%" stopColor={CHART.water} stopOpacity={0.02} />
              </linearGradient>
            </defs>

            <ReferenceArea
              y1={history.elevated_at}
              y2={history.alarm_at}
              fill={SENSOR_STATUS_HEX.ELEVATED}
              fillOpacity={0.06}
              stroke="none"
              ifOverflow="hidden"
            />
            <ReferenceArea
              y1={history.alarm_at}
              y2={ceiling}
              fill={SENSOR_STATUS_HEX.ALARM}
              fillOpacity={0.08}
              stroke="none"
              ifOverflow="hidden"
            />
            <CartesianGrid {...GRID} />
            <XAxis dataKey="time" {...AXIS} height={18} minTickGap={28} />
            <YAxis
              {...AXIS}
              width={34}
              domain={[(dataMin: number) => Math.min(0, dataMin), 'auto']}
            />
            <Tooltip content={<SensorTip unit={history.unit} />} cursor={CURSOR_LINE} />

            <Area
              type="monotone"
              dataKey="value"
              stroke="none"
              fill="url(#sensorFill)"
              tooltipType="none"
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke={CHART.water}
              strokeWidth={1.75}
              dot={SensorDot}
              activeDot={{ r: 4, fill: CHART.ink, stroke: CHART.ground, strokeWidth: 1.5 }}
              isAnimationActive={false}
            />

            <ReferenceLine
              y={history.elevated_at}
              stroke={SENSOR_STATUS_HEX.ELEVATED}
              strokeDasharray="4 3"
              ifOverflow="hidden"
              label={{
                value: `ELEVATED ${history.elevated_at}`,
                position: 'insideTopLeft',
                fill: SENSOR_STATUS_HEX.ELEVATED,
                fontSize: 9,
                fontFamily: MONO,
              }}
            />
            <ReferenceLine
              y={history.alarm_at}
              stroke={SENSOR_STATUS_HEX.ALARM}
              strokeDasharray="4 3"
              ifOverflow="hidden"
              label={{
                value: `ALARM ${history.alarm_at}`,
                position: 'insideTopLeft',
                fill: SENSOR_STATUS_HEX.ALARM,
                fontSize: 9,
                fontFamily: MONO,
              }}
            />
          </ComposedChart>
        </ChartFrame>

        <span className="pointer-events-none absolute right-2 top-1 font-mono text-[9px] uppercase tracking-[0.14em] text-faint">
          simulated
        </span>
      </div>

      {legend && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1">
          <ChartLegend
            items={[
              { label: history.label, hex: CHART.water, shape: 'line' },
              { label: 'Elevated', hex: SENSOR_STATUS_HEX.ELEVATED },
              { label: 'Alarm', hex: SENSOR_STATUS_HEX.ALARM },
            ]}
          />
          <span className="tnum font-mono text-2xs text-dim">
            latest {fmtReading(last.value, history.unit)}
          </span>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- sparkline

// ------------------------------------------------------------- status strip

const STATUS_ORDER: SensorStatus[] = ['NORMAL', 'ELEVATED', 'ALARM', 'OFFLINE'];

/**
 * The whole simulated network as one bar: how many instruments are calm, raised,
 * in alarm, or not reporting.
 *
 * Built from divs rather than Recharts. At this size a chart library would add a
 * measurement pass, an SVG and an animation for what is four rectangles.
 */
export function SensorStatusStrip({
  counts,
  className,
}: {
  counts: SensorCounts;
  className?: string;
}) {
  const total = STATUS_ORDER.reduce((sum, status) => sum + (counts[status] ?? 0), 0);

  return (
    <div className={cx('space-y-1.5', className)}>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-raised">
        {total > 0 &&
          STATUS_ORDER.map((status) => {
            const value = counts[status] ?? 0;
            if (value <= 0) return null;
            return (
              <span
                key={status}
                className="h-full"
                style={{
                  width: `${(value / total) * 100}%`,
                  backgroundColor: SENSOR_STATUS_HEX[status],
                  opacity: status === 'OFFLINE' ? 0.5 : 0.9,
                }}
                title={`${SENSOR_STATUS[status]?.label ?? status}: ${value}`}
              />
            );
          })}
      </div>
      <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {STATUS_ORDER.map((status) => (
          <li key={status} className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 shrink-0 rounded-sm"
              style={{ backgroundColor: SENSOR_STATUS_HEX[status] }}
              aria-hidden
            />
            <span className="text-2xs text-dim">{SENSOR_STATUS[status]?.label ?? status}</span>
            <span className="tnum font-mono text-2xs text-ink">{counts[status] ?? 0}</span>
          </li>
        ))}
      </ul>
      <p className="font-mono text-[10px] uppercase tracking-wider text-faint">
        {counts.total} simulated instruments across {counts.regions} regions &middot; software model,
        no hardware
      </p>
    </div>
  );
}
