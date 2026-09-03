/**
 * The icons on the map.
 *
 * Leaflet's default marker is deliberately never used. Its icon URLs break
 * under a bundler, and more importantly a row of identical blue pins would
 * throw away the one thing this map has to communicate at a glance: which
 * points are dangerous and which kind of thing each point is.
 *
 * So every marker here is a `divIcon` built from a small piece of HTML. Two
 * rules make that safe:
 *
 * Colour comes through inline `style`, because the palette is hex (shared with
 * the Recharts series) and Tailwind cannot generate a class from a runtime
 * string. Everything else is a literal Tailwind class written out in this file
 * so the build's class scanner can see it.
 *
 * Shape carries the layer, not colour. Risk is a disc, an alert is a triangle,
 * a past landslide is a diamond, a citizen report is a teardrop and a virtual
 * sensor is a square. Someone with colour-vision deficiency can still separate
 * five overlays, and a printed screenshot survives.
 */
import * as L from 'leaflet';

import { RISK_HEX, markerRadius, shouldPulse } from '../lib/risk';
import type { RiskLevel } from '../types/api';

/** `.risk-marker` in index.css strips Leaflet's white box and shadow. */
const BARE = 'risk-marker';

function icon(html: string, size: number, className = BARE): L.DivIcon {
  return L.divIcon({
    html,
    className,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

/**
 * A risk disc, with an expanding ring on HIGH and CRITICAL only.
 *
 * The ring is the single animated thing on the map. If every band pulsed the
 * animation would carry no information and the two bands that need an operator
 * to look would be lost in it.
 *
 * The box is sized for the fully expanded ring (`pulsering` scales to 2.4) so
 * the animation is never clipped, and the ring itself is `pointer-events-none`
 * so the growing circle cannot steal the click from a neighbouring region.
 */
export function riskIcon(score: number, level: RiskLevel, zoom = 6): L.DivIcon {
  const hex = RISK_HEX[level];
  const radius = markerRadius(score, zoom);
  const diameter = radius * 2;
  const box = Math.round(diameter * 2.6);
  const pulse = shouldPulse(level)
    ? `<span class="pointer-events-none absolute inset-0 m-auto animate-pulsering rounded-full" style="width:${diameter}px;height:${diameter}px;background-color:${hex};opacity:0.55"></span>`
    : '';
  return icon(
    `<span class="relative flex items-center justify-center" style="width:${box}px;height:${box}px">
       ${pulse}
       <span class="relative block rounded-full" style="width:${diameter}px;height:${diameter}px;background-color:${hex};border:1.5px solid rgba(8,11,16,0.85);box-shadow:0 0 0 1px ${hex}55, 0 1px 3px rgba(0,0,0,0.6)"></span>
     </span>`,
    box,
  );
}

/**
 * The selected region, and the regions a scenario just moved.
 *
 * Drawn as a static ring around the disc rather than as a colour change, so
 * the risk band stays readable while something is selected. `SIMULATE EXTREME
 * RAINFALL` highlights every region that crossed a band this way.
 */
export function haloIcon(score: number, level: RiskLevel, zoom = 6, dashed = false): L.DivIcon {
  const hex = RISK_HEX[level];
  const radius = markerRadius(score, zoom);
  const size = Math.round(radius * 2 + 14);
  return icon(
    `<span class="block rounded-full" style="width:${size}px;height:${size}px;border:1.5px ${
      dashed ? 'dashed' : 'solid'
    } ${hex};opacity:0.9"></span>`,
    size,
  );
}

export type Glyph = 'triangle' | 'diamond' | 'teardrop' | 'square';

/**
 * An overlay marker: alert, past event, citizen report or virtual sensor.
 *
 * Sized smaller than the risk discs on purpose. The risk layer is the subject
 * of this map and the overlays are context; if they competed for attention the
 * screen would read as noise.
 */
export function glyphIcon(glyph: Glyph, hex: string, size = 12): L.DivIcon {
  const box = size + 6;
  const stroke = 'border:1.25px solid rgba(8,11,16,0.9)';
  let shape: string;
  if (glyph === 'triangle') {
    // A border trick, because a CSS triangle cannot take a border of its own.
    shape = `<span style="width:0;height:0;border-left:${size / 2}px solid transparent;border-right:${
      size / 2
    }px solid transparent;border-bottom:${size}px solid ${hex};filter:drop-shadow(0 1px 1px rgba(0,0,0,0.7))"></span>`;
  } else if (glyph === 'diamond') {
    shape = `<span style="width:${size * 0.78}px;height:${
      size * 0.78
    }px;background-color:${hex};transform:rotate(45deg);${stroke}"></span>`;
  } else if (glyph === 'teardrop') {
    shape = `<span style="width:${size * 0.85}px;height:${
      size * 0.85
    }px;background-color:${hex};border-radius:50% 50% 50% 0;transform:rotate(-45deg);${stroke}"></span>`;
  } else {
    shape = `<span style="width:${size * 0.8}px;height:${
      size * 0.8
    }px;background-color:${hex};border-radius:1px;${stroke}"></span>`;
  }
  return icon(
    `<span class="flex items-center justify-center" style="width:${box}px;height:${box}px">${shape}</span>`,
    box,
  );
}

/**
 * A region name, for the labels layer.
 *
 * Anchored below the disc rather than centred on it, and never interactive, so
 * a label can never swallow the click meant for the marker it names.
 */
export function labelIcon(text: string, radius: number): L.DivIcon {
  const safe = escapeHtml(text);
  return L.divIcon({
    html: `<span class="pointer-events-none block whitespace-nowrap rounded-sm bg-ground/75 px-1 py-px font-mono text-[9px] leading-none text-ink/90">${safe}</span>`,
    className: BARE,
    iconSize: [0, 0],
    iconAnchor: [0, -Math.round(radius) - 4],
  });
}

/**
 * Region names arrive from the database, so they are escaped before going into
 * icon HTML. A tooltip built by string concatenation is a real injection route
 * even when the strings are only ever place names today.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
