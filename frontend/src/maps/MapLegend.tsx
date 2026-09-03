/**
 * The map's control panel: what the colours mean, which overlays are on, and
 * which basemap is underneath.
 *
 * The band legend is not optional decoration. A coloured dot on a map is
 * meaningless until the reader knows that amber is 41-60 and that 60 is the
 * line where this platform starts raising alerts, so the legend carries the
 * numeric range and the live count of regions in each band.
 *
 * Each overlay switch says where that layer's data comes from - "simulated",
 * "citizen-submitted", "historical archive" - beside the switch itself. That is
 * the whole point: a reader should never have to hunt for a footnote to find out
 * whether the dots they are looking at are measurements or models.
 *
 * Rendered as a sibling of the Leaflet container rather than as a Leaflet
 * control, so a scroll over this panel scrolls the list instead of zooming the
 * country, and a click on a switch cannot reach the map underneath.
 */
import { ChevronDown, Layers, Map as MapIcon } from 'lucide-react';
import { useState } from 'react';

import { RISK_HEX, RISK_LEVELS, cx } from '../lib/risk';
import type { BandCounts, RiskLevel } from '../types/api';
import type { Basemap } from './basemaps';
import { BASEMAPS } from './basemaps';
import type { LayerKey, LayerState } from './layers';
import { LAYERS, LAYER_MODE_LABEL } from './layers';

/** The bands as the specification fixes them, shown so a colour has a number. */
const BAND_RANGE: Record<RiskLevel, string> = {
  'VERY LOW': '0-20',
  LOW: '21-40',
  MODERATE: '41-60',
  HIGH: '61-80',
  CRITICAL: '81-100',
};

export function BandLegend({
  counts,
  thresholds,
  className,
}: {
  counts?: BandCounts | null;
  thresholds?: { high: number; critical: number };
  className?: string;
}) {
  return (
    <div className={cx('space-y-1', className)}>
      {RISK_LEVELS.map((level) => (
        <div key={level} className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: RISK_HEX[level] }}
            aria-hidden
          />
          <span className="w-[68px] shrink-0 text-2xs uppercase tracking-wider text-dim">
            {level}
          </span>
          <span className="tnum shrink-0 font-mono text-2xs text-faint">{BAND_RANGE[level]}</span>
          {counts && (
            <span className="tnum ml-auto font-mono text-2xs text-ink">{counts[level] ?? 0}</span>
          )}
        </div>
      ))}
      {thresholds && (
        <p className="pt-1 text-2xs leading-relaxed text-faint">
          Alerts are raised from{' '}
          <span className="tnum font-mono text-risk-high">{thresholds.high}</span> and escalate to
          critical from <span className="tnum font-mono text-risk-critical">{thresholds.critical}</span>.
        </p>
      )}
    </div>
  );
}

export function MapLegend({
  layers,
  onToggle,
  basemap,
  onBasemap,
  counts,
  thresholds,
  className,
}: {
  layers: LayerState;
  onToggle: (key: LayerKey) => void;
  basemap: Basemap;
  onBasemap: (key: Basemap['key']) => void;
  counts?: BandCounts | null;
  thresholds?: { high: number; critical: number };
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const active = LAYERS.filter((layer) => layers[layer.key]).length;

  return (
    <div className={cx('w-[228px] max-w-[62vw]', className)}>
      <div className="panel overflow-hidden shadow-bezel">
        <button
          type="button"
          className="flex w-full items-center gap-2 border-b border-hairline px-3 py-2 text-left hover:bg-raised/60"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <Layers className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
          <span className="font-display text-2xs font-semibold uppercase tracking-[0.12em] text-ink">
            Layers
          </span>
          <span className="tnum font-mono text-2xs text-faint">{active}/{LAYERS.length}</span>
          <ChevronDown
            className={cx(
              'ml-auto h-3.5 w-3.5 shrink-0 text-faint transition-transform',
              open && 'rotate-180',
            )}
            aria-hidden
          />
        </button>

        {open ? (
          <div className="max-h-[52vh] overflow-y-auto">
            <ul className="divide-y divide-hairline/60">
              {LAYERS.map((layer) => {
                const on = layers[layer.key];
                const Icon = layer.icon;
                return (
                  <li key={layer.key}>
                    <button
                      type="button"
                      className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-raised/50"
                      onClick={() => onToggle(layer.key)}
                      aria-pressed={on}
                    >
                      <span
                        className={cx(
                          'mt-px flex h-3.5 w-6 shrink-0 items-center rounded-full border px-px transition-colors',
                          on ? 'border-accent/60 bg-accent/25' : 'border-hairbright bg-raised',
                        )}
                        aria-hidden
                      >
                        <span
                          className={cx(
                            'h-2.5 w-2.5 rounded-full transition-transform',
                            on ? 'translate-x-2.5 bg-accent' : 'bg-faint',
                          )}
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <Icon
                            className={cx('h-3 w-3 shrink-0', on ? 'text-ink' : 'text-faint')}
                            aria-hidden
                          />
                          <span className={cx('text-2xs', on ? 'text-ink' : 'text-dim')}>
                            {layer.label}
                          </span>
                          {layer.mode && (
                            <span className="ml-auto shrink-0 font-mono text-[9px] uppercase tracking-wider text-faint">
                              {LAYER_MODE_LABEL[layer.mode]}
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block text-[10px] leading-snug text-faint">
                          {layer.hint}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="border-t border-hairline px-3 py-2">
              <p className="mb-1.5 flex items-center gap-1.5 font-display text-2xs font-semibold uppercase tracking-[0.12em] text-faint">
                <MapIcon className="h-3 w-3" aria-hidden />
                Basemap
              </p>
              <div className="flex gap-1">
                {BASEMAPS.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    className={cx(
                      'flex-1 rounded-panel border px-2 py-1 font-mono text-2xs uppercase tracking-wider transition-colors',
                      option.key === basemap.key
                        ? 'border-accent/60 bg-accent/15 text-ink'
                        : 'border-hairline bg-raised text-dim hover:text-ink',
                    )}
                    onClick={() => onBasemap(option.key)}
                    title={option.describes}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[10px] leading-snug text-faint">{basemap.describes}</p>
            </div>
          </div>
        ) : null}

        <div className="border-t border-hairline px-3 py-2">
          <BandLegend counts={counts} thresholds={thresholds} />
        </div>
      </div>
    </div>
  );
}
