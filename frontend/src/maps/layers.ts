/**
 * The eight things that can be drawn over the basemap.
 *
 * Kept in one list, in draw order, because three separate places need to agree
 * about them: the map builds a pane per layer, the legend builds a switch per
 * layer, and the overlay components each fetch only when their own switch is
 * on. A ninth overlay added here appears in all three.
 *
 * `defaultOn` is conservative. A map that opens with everything on is a map
 * nobody can read, so the risk layer and the alerts carry the first view and
 * the rest are there when a question needs them.
 *
 * `mode` is the honest label for where the layer's numbers come from, and it is
 * shown in the legend next to the switch rather than in a footnote: the sensor
 * layer is software-modelled, the historical layer is a documented archive, the
 * risk layer is whatever the platform is currently running on.
 */
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  AlertTriangle,
  Circle,
  MessageSquare,
  Mountain,
  Tag,
  Target,
  Users,
} from 'lucide-react';

export type LayerKey =
  | 'risk'
  | 'halo'
  | 'alerts'
  | 'events'
  | 'reports'
  | 'sensors'
  | 'exposure'
  | 'labels';

export type LayerState = Record<LayerKey, boolean>;

export interface LayerSpec {
  key: LayerKey;
  label: string;
  /** One line under the switch: what the layer shows and how to read it. */
  hint: string;
  icon: LucideIcon;
  defaultOn: boolean;
  /** Provenance for this layer specifically. Null where it follows the platform. */
  mode: 'MODEL' | 'ARCHIVE' | 'SIMULATED' | 'CITIZEN' | 'CENSUS' | null;
}

export const LAYERS: LayerSpec[] = [
  {
    key: 'risk',
    label: 'Risk score',
    hint: 'One disc per monitored region, coloured by band and sized by score.',
    icon: Circle,
    defaultOn: true,
    mode: 'MODEL',
  },
  {
    key: 'halo',
    label: 'Alert radius',
    hint: 'Ground circle around regions at or above the HIGH threshold.',
    icon: Target,
    defaultOn: false,
    mode: 'MODEL',
  },
  {
    key: 'alerts',
    label: 'Open alerts',
    hint: 'Warnings the engine has raised and nobody has resolved yet.',
    icon: AlertTriangle,
    defaultOn: true,
    mode: 'MODEL',
  },
  {
    key: 'events',
    label: 'Past landslides',
    hint: 'Recorded events. Where it happened before is where it can happen again.',
    icon: Mountain,
    defaultOn: false,
    mode: 'ARCHIVE',
  },
  {
    key: 'reports',
    label: 'Citizen reports',
    hint: 'Cracks, rockfall and soil movement reported from the ground.',
    icon: MessageSquare,
    defaultOn: false,
    mode: 'CITIZEN',
  },
  {
    key: 'sensors',
    label: 'Virtual sensors',
    hint: 'Software-modelled instruments. No hardware exists in this system.',
    icon: Activity,
    defaultOn: false,
    mode: 'SIMULATED',
  },
  {
    key: 'exposure',
    label: 'People exposed',
    hint: 'Circle area is the population living in the region, not the risk.',
    icon: Users,
    defaultOn: false,
    mode: 'CENSUS',
  },
  {
    key: 'labels',
    label: 'Region names',
    hint: 'Place names beside each disc. Crowded below zoom 6.',
    icon: Tag,
    defaultOn: false,
    mode: null,
  },
];

export function defaultLayers(overrides?: Partial<LayerState>): LayerState {
  const state = {} as LayerState;
  for (const layer of LAYERS) state[layer.key] = layer.defaultOn;
  return { ...state, ...overrides };
}

/** Draw order, low to high. Panes are created from this so overlays never
 *  disappear under the risk discs depending on which loaded first. */
export const PANE_Z: Record<LayerKey, number> = {
  exposure: 405,
  halo: 410,
  events: 420,
  reports: 430,
  sensors: 440,
  risk: 450,
  alerts: 460,
  labels: 470,
};

/**
 * The Leaflet pane a layer draws into.
 *
 * Panes are created once for the life of the map and referenced by name, rather
 * than mounted and unmounted with the layers themselves. Leaflet throws if a
 * layer is added to a pane that does not exist, and creating a pane per toggle
 * makes that a live possibility every time an operator flips a switch.
 */
export function paneName(key: LayerKey): string {
  return `risk-${key}`;
}

export const LAYER_MODE_LABEL: Record<NonNullable<LayerSpec['mode']>, string> = {
  MODEL: 'model output',
  ARCHIVE: 'historical archive',
  SIMULATED: 'simulated',
  CITIZEN: 'citizen-submitted',
  CENSUS: 'population estimate',
};
