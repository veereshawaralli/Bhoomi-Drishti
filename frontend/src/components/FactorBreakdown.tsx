/**
 * Why the model produced this score - the part a judge, an officer or a
 * villager has to be able to read without knowing what a gradient is.
 *
 * The percentage is a share of everything that moved this decision, in both
 * directions, so the bars are comparable between a factor pushing risk up and
 * one holding it down. It is emphatically not a probability, and the header
 * says so: "41% of what moved this score" is a claim about the explanation,
 * while "41% chance" would be a claim about the hillside.
 *
 * Every row carries the actual measured value beside its label, because "heavy
 * rainfall" means nothing next to "rainfall over 24 hours: 214 mm". The
 * `evidence` sentence the backend attaches - the threshold or comparison that
 * makes the value notable - is the row's hover text.
 */
import type { ReactNode } from 'react';

import { percentPoints, signed } from '../lib/format';
import { cx } from '../lib/risk';
import type { Factor } from '../types/api';

interface Tone {
  text: string;
  solid: string;
  word: string;
}

function toneFor(direction: Factor['direction']): Tone {
  if (direction === 'lowering') {
    return { text: 'text-risk-verylow', solid: 'bg-risk-verylow', word: 'holds risk down' };
  }
  if (direction === 'raising') {
    return { text: 'text-risk-high', solid: 'bg-risk-high', word: 'pushes risk up' };
  }
  return { text: 'text-dim', solid: 'bg-hairbright', word: 'little effect' };
}

export function FactorRow({
  factor,
  scale,
  showContribution,
}: {
  factor: Factor;
  /** Largest share in the set, so the biggest bar fills the track. */
  scale: number;
  showContribution?: boolean;
}) {
  const tone = toneFor(factor.direction);
  const width = Math.max(2, Math.min(100, (factor.share_percent / (scale || 1)) * 100));
  return (
    <li className="space-y-1 py-1.5" title={factor.evidence ?? undefined}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-xs text-ink">{factor.label}</span>
        <span className="tnum shrink-0 font-mono text-2xs text-dim">{factor.value_text}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-raised">
          <div
            className={cx('h-full rounded-full transition-[width] duration-500', tone.solid)}
            style={{ width: `${width}%` }}
          />
        </div>
        <span className={cx('tnum w-9 shrink-0 text-right font-mono text-2xs', tone.text)}>
          {percentPoints(factor.share_percent)}
        </span>
      </div>
      <p className="flex items-baseline gap-1.5 text-2xs text-faint">
        <span className={tone.text}>{tone.word}</span>
        {showContribution && (
          <span className="tnum font-mono" title="Signed log-odds contribution">
            ({signed(factor.contribution, 2)})
          </span>
        )}
      </p>
    </li>
  );
}

export function FactorBreakdown({
  factors,
  summary,
  disclaimer,
  methodLabel,
  limit,
  showContribution,
  className,
  children,
}: {
  factors: Factor[];
  /** The backend's plain-language paragraph. Shown above the bars. */
  summary?: string | null;
  disclaimer?: string | null;
  /** e.g. "SHAP (TreeExplainer)" - named so the method is auditable. */
  methodLabel?: string | null;
  limit?: number;
  showContribution?: boolean;
  className?: string;
  /** Extra content under the bars, before the disclaimer. */
  children?: ReactNode;
}) {
  const rows = limit ? factors.slice(0, limit) : factors;
  const scale = rows.reduce((max, factor) => Math.max(max, factor.share_percent), 0) || 100;

  if (rows.length === 0) {
    return (
      <p className={cx('text-xs leading-relaxed text-faint', className)}>
        No factor breakdown was returned for this prediction.
      </p>
    );
  }

  return (
    <div className={cx('space-y-3', className)}>
      {summary && <p className="text-xs leading-relaxed text-dim">{summary}</p>}
      <p className="text-2xs leading-relaxed text-faint">
        Each bar is that factor&apos;s share of everything that moved this score - not a
        probability.
        {methodLabel ? ` Attributed with ${methodLabel}.` : ''}
      </p>
      <ul className="divide-y divide-hairline/60">
        {rows.map((factor) => (
          <FactorRow
            key={factor.feature}
            factor={factor}
            scale={scale}
            showContribution={showContribution}
          />
        ))}
      </ul>
      {children}
      {disclaimer && (
        <p className="border-t border-hairline pt-2 text-2xs leading-relaxed text-faint">
          {disclaimer}
        </p>
      )}
    </div>
  );
}
