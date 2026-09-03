/**
 * The four charts the historical archive is read through, plus a severity donut.
 *
 * Each one answers a question an officer actually asks of a landslide record:
 * is this getting worse year on year, how much rain does it take here, which
 * places keep failing, and when in the year does it happen. They are exported
 * separately rather than as one dashboard component so the history page can lay
 * them out and the national overview can borrow two of them.
 *
 * The severity ramp is reused deliberately: a MAJOR event in the archive is
 * drawn in the same laterite as a HIGH forecast, so the eye learns one scale
 * across the whole platform. What the archive does not get is the accent colour,
 * which is reserved for model output - nothing on these charts is a prediction.
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { count as fmtCount, mm, percent, place, truncate } from '../lib/format';
import { EVENT_SEVERITY, EVENT_SEVERITY_HEX } from '../lib/risk';
import type {
  EventSeverity,
  EventsPerYear,
  HighRiskRegion,
  RainBand,
  SeasonalPoint,
  SeveritySplit,
} from '../types/api';
import type { LegendItem, TipProps } from './theme';
import {
  AXIS,
  CHART,
  ChartEmpty,
  ChartFrame,
  ChartLegend,
  CURSOR_BAR,
  GRID,
  TICK,
  TipRow,
  TooltipCard,
} from './theme';

/** Ascending, so a stack reads minor at the bottom and severe on top. */
const SEVERITIES: EventSeverity[] = ['MINOR', 'MODERATE', 'MAJOR', 'SEVERE'];

const SEVERITY_LEGEND: LegendItem[] = SEVERITIES.map((severity) => ({
  label: EVENT_SEVERITY[severity].label,
  hex: EVENT_SEVERITY_HEX[severity],
}));

// ------------------------------------------------------- events per year

function YearTip({ active, label, payload }: TipProps) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as EventsPerYear | undefined;
  if (!row) return null;
  return (
    <TooltipCard title={String(label ?? row.year)} meta={`${fmtCount(row.total)} recorded`}>
      {SEVERITIES.filter((severity) => row[severity] > 0)
        .reverse()
        .map((severity) => (
          <TipRow
            key={severity}
            label={EVENT_SEVERITY[severity].label}
            value={fmtCount(row[severity])}
            hex={EVENT_SEVERITY_HEX[severity]}
          />
        ))}
    </TooltipCard>
  );
}

/**
 * Recorded landslides per year, stacked by how bad each one was.
 *
 * Stacked rather than grouped because the first question is the total and the
 * second is the mix; grouped bars answer the second well and the first badly.
 */
export function EventsPerYearChart({
  data,
  height = 210,
  legend = true,
}: {
  data: EventsPerYear[];
  height?: number;
  legend?: boolean;
}) {
  if (!data.length) return <ChartEmpty height={height} message="No events in this selection" />;

  return (
    <div className="min-w-0">
      <ChartFrame height={height}>
        <BarChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
          <CartesianGrid {...GRID} />
          <XAxis dataKey="year" {...AXIS} interval="preserveStartEnd" height={18} />
          <YAxis {...AXIS} width={28} allowDecimals={false} />
          <Tooltip content={<YearTip />} cursor={CURSOR_BAR} />
          {SEVERITIES.map((severity) => (
            <Bar
              key={severity}
              dataKey={severity}
              stackId="events"
              fill={EVENT_SEVERITY_HEX[severity]}
              fillOpacity={0.85}
              isAnimationActive={false}
              maxBarSize={26}
            />
          ))}
        </BarChart>
      </ChartFrame>
      {legend && <ChartLegend className="mt-2 px-1" items={SEVERITY_LEGEND} />}
    </div>
  );
}

// -------------------------------------------------- rainfall vs landslides

/**
 * Extra props on a tooltip are safe: Recharts clones the element it is given and
 * injects `active`, `label` and `payload` alongside whatever was already there.
 * That is how the share-of-archive line gets a denominator without rebuilding
 * the component on every render.
 */
function RainTip({ active, label, payload, total = 0 }: TipProps & { total?: number }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as RainBand | undefined;
  if (!row) return null;
  return (
    <TooltipCard title={`${String(label ?? row.band)} of rain`} meta="24 h before the event">
      <TipRow label="Recorded events" value={fmtCount(row.events)} hex={CHART.water} />
      <TipRow label="Share of archive" value={total > 0 ? percent(row.events / total) : '—'} />
    </TooltipCard>
  );
}

/**
 * How much rain it took, bucketed.
 *
 * The bars stay one colour and gain saturation with intensity. Painting them on
 * the severity ramp would suggest that 150 mm is itself a HIGH risk reading,
 * which is exactly the conflation this platform exists to avoid: rain is a
 * driver, and the model weighs it against slope, soil and antecedent wetness.
 */
export function RainfallVsEventsChart({
  data,
  height = 210,
}: {
  data: RainBand[];
  height?: number;
}) {
  if (!data.length) return <ChartEmpty height={height} message="No rainfall bands to show" />;
  const total = data.reduce((sum, row) => sum + row.events, 0);

  return (
    <div className="min-w-0">
      <ChartFrame height={height}>
        <BarChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
          <CartesianGrid {...GRID} />
          <XAxis dataKey="band" {...AXIS} interval={0} height={18} />
          <YAxis {...AXIS} width={28} allowDecimals={false} />
          <Tooltip content={<RainTip total={total} />} cursor={CURSOR_BAR} />
          <Bar dataKey="events" isAnimationActive={false} maxBarSize={38} radius={[1, 1, 0, 0]}>
            {data.map((row, index) => (
              <Cell
                key={row.band}
                fill={CHART.water}
                fillOpacity={0.34 + (index / Math.max(1, data.length - 1)) * 0.56}
              />
            ))}
          </Bar>
        </BarChart>
      </ChartFrame>
      <p className="mt-2 px-1 text-2xs leading-relaxed text-faint">
        Rainfall in the 24 hours before each recorded event. A driver of failure, not a risk score.
      </p>
    </div>
  );
}

// ------------------------------------------------------- most affected places

interface RegionRow extends HighRiskRegion {
  /** Shortened for the category axis, which has a fixed width. */
  label: string;
  /** `count` minus `severe`, so the two can be stacked without double-counting. */
  other: number;
}

function RegionTip({ active, payload }: TipProps) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as RegionRow | undefined;
  if (!row) return null;
  return (
    <TooltipCard title={row.location} meta={place(row.district, row.state)}>
      <TipRow label="Recorded events" value={fmtCount(row.count)} />
      <TipRow
        label="Severe"
        value={fmtCount(row.severe)}
        hex={EVENT_SEVERITY_HEX.SEVERE}
      />
      <TipRow label="Heaviest 24 h rain" value={mm(row.max_rainfall_mm)} hex={CHART.water} />
    </TooltipCard>
  );
}

/**
 * The places that keep failing, worst first.
 *
 * Horizontal because place names are long and a rotated axis label is a tax on
 * the reader. The bar is split into severe and everything else, so a town with
 * three catastrophic slides is not read as safer than one with eight minor ones.
 *
 * A click flies the map to the place, which is why the row carries its
 * coordinates all the way through.
 */
export function TopRegionsChart({
  data,
  limit = 8,
  height,
  onPick,
}: {
  data: HighRiskRegion[];
  limit?: number;
  height?: number;
  onPick?: (region: HighRiskRegion) => void;
}) {
  const rows: RegionRow[] = data.slice(0, limit).map((region) => ({
    ...region,
    label: truncate(region.location, 18),
    other: Math.max(0, region.count - region.severe),
  }));

  const box = height ?? Math.max(150, rows.length * 26 + 26);
  if (!rows.length) return <ChartEmpty height={box} message="No regions in this selection" />;

  function pick(entry: unknown) {
    if (!onPick) return;
    const row = entry as { payload?: HighRiskRegion } | undefined;
    const region = row?.payload ?? (entry as HighRiskRegion | undefined);
    if (region && typeof region.latitude === 'number') onPick(region);
  }

  return (
    <div className="min-w-0">
      <ChartFrame height={box}>
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 2, right: 10, bottom: 2, left: 0 }}
          barCategoryGap="22%"
        >
          <CartesianGrid {...GRID} horizontal={false} vertical />
          <XAxis type="number" {...AXIS} allowDecimals={false} height={18} />
          <YAxis
            type="category"
            dataKey="label"
            {...AXIS}
            width={104}
            tick={{ ...TICK, fill: CHART.dim }}
          />
          <Tooltip content={<RegionTip />} cursor={CURSOR_BAR} />
          <Bar
            dataKey="other"
            stackId="events"
            fill={EVENT_SEVERITY_HEX.MODERATE}
            fillOpacity={0.7}
            isAnimationActive={false}
            onClick={pick}
            cursor={onPick ? 'pointer' : undefined}
          />
          <Bar
            dataKey="severe"
            stackId="events"
            fill={EVENT_SEVERITY_HEX.SEVERE}
            isAnimationActive={false}
            onClick={pick}
            cursor={onPick ? 'pointer' : undefined}
            radius={[0, 1, 1, 0]}
          />
        </BarChart>
      </ChartFrame>
      <ChartLegend
        className="mt-2 px-1"
        items={[
          { label: 'Minor to major', hex: EVENT_SEVERITY_HEX.MODERATE },
          { label: 'Severe', hex: EVENT_SEVERITY_HEX.SEVERE },
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------- seasonal pattern

/** June to September: the south-west monsoon, when most of this happens. */
function isMonsoon(monthNumber: number): boolean {
  return monthNumber >= 6 && monthNumber <= 9;
}

function SeasonTip({ active, payload, total = 0 }: TipProps & { total?: number }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as SeasonalPoint | undefined;
  if (!row) return null;
  return (
    <TooltipCard
      title={row.month}
      meta={isMonsoon(row.month_number) ? 'South-west monsoon' : 'Outside the monsoon'}
    >
      <TipRow
        label="Recorded events"
        value={fmtCount(row.events)}
        hex={isMonsoon(row.month_number) ? CHART.water : CHART.slate}
      />
      <TipRow label="Share of year" value={total > 0 ? percent(row.events / total) : '—'} />
    </TooltipCard>
  );
}

/**
 * Events by month of the year.
 *
 * The monsoon months are picked out in water blue and the rest left slate,
 * because the seasonal story is the single most useful thing in the archive for
 * planning: it says when to staff the control room.
 */
export function SeasonalChart({
  data,
  height = 200,
}: {
  data: SeasonalPoint[];
  height?: number;
}) {
  if (!data.length) return <ChartEmpty height={height} message="No seasonal data" />;
  const total = data.reduce((sum, row) => sum + row.events, 0);

  return (
    <div className="min-w-0">
      <ChartFrame height={height}>
        <BarChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
          <CartesianGrid {...GRID} />
          <XAxis dataKey="month" {...AXIS} height={18} />
          <YAxis {...AXIS} width={28} allowDecimals={false} />
          <Tooltip content={<SeasonTip total={total} />} cursor={CURSOR_BAR} />
          <Bar dataKey="events" isAnimationActive={false} maxBarSize={30} radius={[1, 1, 0, 0]}>
            {data.map((row) => (
              <Cell
                key={row.month}
                fill={isMonsoon(row.month_number) ? CHART.water : CHART.slate}
                fillOpacity={isMonsoon(row.month_number) ? 0.85 : 0.45}
              />
            ))}
          </Bar>
        </BarChart>
      </ChartFrame>
      <ChartLegend
        className="mt-2 px-1"
        items={[
          { label: 'Monsoon (Jun-Sep)', hex: CHART.water },
          { label: 'Rest of the year', hex: CHART.slate },
        ]}
      />
    </div>
  );
}

// ------------------------------------------------------------ severity split

interface SplitRow extends SeveritySplit {
  label: string;
  hex: string;
}

function SplitTip({ active, payload, total = 0 }: TipProps & { total?: number }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as SplitRow | undefined;
  if (!row) return null;
  return (
    <TooltipCard title={`${row.label} events`}>
      <TipRow label="Recorded" value={fmtCount(row.count)} hex={row.hex} />
      <TipRow label="Share" value={total > 0 ? percent(row.count / total) : '—'} />
    </TooltipCard>
  );
}

/**
 * How the archive breaks down by severity, as a ring with the total in the hole.
 *
 * A ring is used here and nowhere else on the platform. It suits a
 * parts-of-a-whole question with four categories, and it keeps the total - the
 * number a reader wants first - in the most legible position on the chart.
 */
export function SeveritySplitChart({
  data,
  height = 176,
}: {
  data: SeveritySplit[];
  height?: number;
}) {
  const rows: SplitRow[] = data
    .filter((row) => row.count > 0)
    .map((row) => ({
      ...row,
      label: EVENT_SEVERITY[row.severity]?.label ?? row.severity,
      hex: EVENT_SEVERITY_HEX[row.severity] ?? CHART.slate,
    }));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (!rows.length) return <ChartEmpty height={height} message="No events to break down" />;

  return (
    <div className="min-w-0">
      <div className="relative">
        <ChartFrame height={height}>
          <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
            <Tooltip content={<SplitTip total={total} />} />
            <Pie
              data={rows}
              dataKey="count"
              nameKey="label"
              innerRadius="60%"
              outerRadius="86%"
              startAngle={90}
              endAngle={-270}
              paddingAngle={1.5}
              stroke={CHART.ground}
              strokeWidth={1}
              isAnimationActive={false}
            >
              {rows.map((row) => (
                <Cell key={row.severity} fill={row.hex} fillOpacity={0.88} />
              ))}
            </Pie>
          </PieChart>
        </ChartFrame>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="tnum font-display text-xl font-semibold leading-none text-ink">
            {fmtCount(total)}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-faint">recorded</span>
        </div>
      </div>
      <ChartLegend
        className="mt-1 justify-center px-1"
        items={rows.map((row) => ({
          label: `${row.label} ${fmtCount(row.count)}`,
          hex: row.hex,
          shape: 'dot' as const,
        }))}
      />
    </div>
  );
}
