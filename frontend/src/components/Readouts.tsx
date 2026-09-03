/**
 * The instrument readouts: the score, the meters, the tiles and the band bar.
 *
 * Two conventions run through all of them.
 *
 * A level is always taken as given, never derived from the score here. The
 * backend bands the score and a disagreement between the numeral and the word
 * beside it would be the single most damaging bug this interface could have.
 *
 * Bars carry the alert thresholds as tick marks, read from `/api/info`, so a
 * score of 58 visibly sits just under the line that would raise an alert
 * instead of being an unmoored number.
 */
import type { ReactNode } from 'react';

import { percent, score as formatScore, signed } from '../lib/format';
import {
  RISK_HEX,
  RISK_LEVELS,
  confidenceWord,
  cx,
  deltaStyle,
  palette,
} from '../lib/risk';
import type { BandCounts, RiskLevel } from '../types/api';
import { RiskChip } from './Chips';

export function Meter({
  value,
  max = 100,
  hex,
  marks,
  className,
  height = 'h-1.5',
  label,
}: {
  value: number;
  max?: number;
  /** Fill colour. Leaflet-style hex because it is set through `style`. */
  hex: string;
  /** Values on the same scale to tick, e.g. the HIGH and CRITICAL thresholds. */
  marks?: number[];
  className?: string;
  height?: string;
  label?: string;
}) {
  const span = max || 100;
  const fill = Math.max(0, Math.min(100, ((Number(value) || 0) / span) * 100));
  return (
    <div
      className={cx('relative w-full overflow-hidden rounded-full bg-raised', height, className)}
      role="meter"
      aria-valuenow={Number(value) || 0}
      aria-valuemin={0}
      aria-valuemax={span}
      aria-label={label ?? 'Risk score'}
    >
      <div
        className="h-full rounded-full transition-[width] duration-500 ease-out"
        style={{ width: `${fill}%`, backgroundColor: hex }}
      />
      {marks?.map((mark) => (
        <span
          key={mark}
          className="absolute top-0 h-full w-px bg-ground/80"
          style={{ left: `${Math.max(0, Math.min(100, (mark / span) * 100))}%` }}
          aria-hidden
        />
      ))}
    </div>
  );
}

/**
 * The headline score for a region, a forecast step or a what-if result.
 *
 * `confidence` describes how closely the model's members agreed. It is shown as
 * a word with the caution on hover, because a bare "0.86" invites reading as a
 * probability of a landslide, which it is not.
 */
export function RiskReadout({
  score,
  level,
  confidence,
  delta,
  caption,
  marks,
  className,
}: {
  score: number;
  level: RiskLevel;
  confidence?: number | null;
  /** Change against a baseline, for a what-if or a scenario comparison. */
  delta?: number | null;
  caption?: ReactNode;
  marks?: number[];
  className?: string;
}) {
  const tone = palette(level);
  const words =
    confidence === undefined || confidence === null ? null : confidenceWord(confidence);
  const move = delta === undefined || delta === null ? null : deltaStyle(delta);
  return (
    <div className={cx('space-y-3', className)}>
      <div className="flex items-end gap-3">
        <span
          className={cx('tnum font-display text-readout font-semibold leading-none', tone.text)}
        >
          {formatScore(score)}
        </span>
        <div className="space-y-1.5 pb-1">
          <p className="font-mono text-2xs text-faint">/ 100</p>
          <RiskChip level={level} />
        </div>
        {move && delta !== undefined && delta !== null && (
          <span
            className={cx('tnum ml-auto pb-1.5 font-mono text-sm', move.text)}
            title="Change against the baseline score"
          >
            {move.arrow} {signed(delta)}
          </span>
        )}
      </div>
      <Meter value={score} hex={tone.hex} marks={marks} />
      {words && (
        <p className="text-2xs text-faint" title={words.caution}>
          Model confidence <span className="text-dim">{words.word}</span>
          <span className="tnum"> · {percent(confidence ?? 0)}</span> · members agreed
        </p>
      )}
      {caption && <div className="text-xs leading-relaxed text-dim">{caption}</div>}
    </div>
  );
}

/** A single figure with its label, for the strip along the top of a screen. */
export function StatTile({
  label,
  value,
  unit,
  hint,
  tone,
  icon,
  footer,
  className,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  /** Hover text - where the figure comes from, or what it excludes. */
  hint?: string;
  /** Tailwind text colour for the value, e.g. `palette(level).text`. */
  tone?: string;
  icon?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('panel px-3 py-2.5', className)} title={hint}>
      <div className="mb-1 flex items-center gap-1.5">
        {icon && <span className="text-faint">{icon}</span>}
        <p className="font-display text-2xs font-semibold uppercase tracking-[0.12em] text-faint">
          {label}
        </p>
      </div>
      <p className="flex items-baseline gap-1">
        <span className={cx('tnum font-display text-xl font-semibold leading-none', tone ?? 'text-ink')}>
          {value}
        </span>
        {unit && <span className="font-mono text-2xs text-faint">{unit}</span>}
      </p>
      {footer && <div className="mt-1.5 text-2xs leading-tight text-faint">{footer}</div>}
    </div>
  );
}

/** A label/value row, for the detail lists inside a panel. */
export function KeyValue({
  label,
  value,
  mono = true,
  title,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <div
      className={cx('flex items-baseline justify-between gap-3 py-1', className)}
      title={title}
    >
      <span className="shrink-0 text-2xs uppercase tracking-wider text-faint">{label}</span>
      <span
        className={cx(
          'min-w-0 truncate text-right text-xs text-ink',
          mono && 'tnum font-mono',
        )}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * How the monitored regions are distributed across the five bands.
 *
 * Always drawn over the full set, so the calm end of the country stays visible.
 * A bar that only showed HIGH and CRITICAL would make every day look like an
 * emergency and the one real emergency indistinguishable from it.
 */
export function BandBar({
  counts,
  className,
  showLegend = true,
}: {
  counts: BandCounts;
  className?: string;
  showLegend?: boolean;
}) {
  const total = RISK_LEVELS.reduce((sum, level) => sum + (counts[level] ?? 0), 0);
  return (
    <div className={cx('space-y-2', className)}>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-raised">
        {total === 0 ? null : (
          RISK_LEVELS.map((level) => {
            const value = counts[level] ?? 0;
            if (value <= 0) return null;
            return (
              <span
                key={level}
                className="h-full first:rounded-l-full last:rounded-r-full"
                style={{
                  width: `${(value / total) * 100}%`,
                  backgroundColor: RISK_HEX[level],
                }}
                title={`${level}: ${value} of ${total} regions`}
              />
            );
          })
        )}
      </div>
      {showLegend && (
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {RISK_LEVELS.map((level) => (
            <li key={level} className="flex items-center gap-1.5">
              <span
                className="h-2 w-2 shrink-0 rounded-sm"
                style={{ backgroundColor: RISK_HEX[level] }}
                aria-hidden
              />
              <span className="text-2xs uppercase tracking-wider text-faint">{level}</span>
              <span className="tnum font-mono text-2xs text-dim">{counts[level] ?? 0}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
