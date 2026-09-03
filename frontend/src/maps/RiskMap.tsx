/**
 * The GIS map. The centre of this platform, and the screen a judge looks at
 * first.
 *
 * Three structural decisions are worth reading before changing anything here.
 *
 * The controls are siblings of the Leaflet container, not Leaflet controls. A
 * layer panel implemented as a Leaflet control lives inside the map's own event
 * handling, which means a scroll over the panel zooms the country and a click
 * on a switch can also drop a click on the map. Rendering them as absolutely
 * positioned siblings above the map removes both problems at the source, at the
 * cost of doing the positioning by hand.
 *
 * The Leaflet map instance is captured through a child component that calls
 * `useMap`, rather than through a ref on `MapContainer`. The child hook is
 * guaranteed to run after the map exists, so the zoom buttons and the search box
 * can never fire against a null map.
 *
 * The risk layer takes `points` as a prop instead of fetching them. The
 * dashboard shows a small map beside its panels and the map page shows a large
 * one, both from the same `/api/risk-map` payload the page already holds, and
 * neither should pay for a second country-wide read. The seven overlays are the
 * opposite case: each fetches its own data and only while its switch is on.
 *
 * Nothing on this map is a satellite feed. Discs sit at region centroids, alert
 * radii are indicative warning footprints rather than modelled runout, and the
 * footer says both.
 */
import { Crosshair, Loader2, Maximize2, Minus, Plus, Search, X } from 'lucide-react';
import * as L from 'leaflet';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { MapContainer, Marker, Popup, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';

import { coords, formatDateTime, mm, people, percent, place, score as formatScore } from '../lib/format';
import { DEFAULT_THRESHOLDS, cx, palette } from '../lib/risk';
import type { BandCounts, RiskPoint } from '../types/api';
import { ModeChip, RiskChip } from '../components/Chips';
import type { Basemap } from './basemaps';
import { INDIA_CENTER, INDIA_ZOOM, basemapFor } from './basemaps';
import type { LayerKey, LayerState } from './layers';
import { PANE_Z, defaultLayers, paneName } from './layers';
import { MapLegend } from './MapLegend';
import {
  AlertsLayer,
  EventsLayer,
  ExposureLayer,
  HaloLayer,
  LabelsLayer,
  ReportsLayer,
  SensorsLayer,
  indexRegions,
  overlayFootnote,
} from './OverlayLayers';
import { haloIcon, riskIcon } from './markers';

/** Where a search hit or a selection asks the map to go. */
interface FlyTarget {
  lat: number;
  lon: number;
  zoom?: number;
}

/**
 * Creates the eight overlay panes, once, for the life of the map.
 *
 * Deliberately during render rather than in an effect. Leaflet throws when a
 * layer names a pane that does not exist, and a layer's own effect runs before
 * its parent's - so a pane created in an effect here would not be there yet when
 * an overlay switched on. Creating them while this component renders, before any
 * sibling below it mounts, removes the ordering problem entirely. The loop is
 * idempotent, which is what makes a render-time side effect safe here.
 */
function Panes() {
  const map = useMap();
  for (const key of Object.keys(PANE_Z) as LayerKey[]) {
    const name = paneName(key);
    const pane = map.getPane(name) ?? map.createPane(name);
    pane.style.zIndex = String(PANE_Z[key]);
  }
  return null;
}

/**
 * Captures the Leaflet map instance for the controls, and mirrors the current
 * zoom into React state, because marker size is a function of zoom and the icons
 * have to be rebuilt when it changes.
 */
function MapBridge({
  onMap,
  onZoom,
}: {
  onMap: (map: L.Map) => void;
  onZoom: (zoom: number) => void;
}) {
  const map = useMapEvents({
    zoomend: () => onZoom(map.getZoom()),
  });
  useEffect(() => {
    onMap(map);
    onZoom(map.getZoom());
  }, [map, onMap, onZoom]);
  return null;
}

/**
 * Leaflet caches its container size, so a map inside a grid that reflows - a
 * sidebar collapsing, a panel opening beside it - paints grey where the tiles
 * used to be until something forces a recount. This does the recount.
 */
function AutoResize() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => map.invalidateSize({ animate: false }));
    observer.observe(container);
    return () => observer.disconnect();
  }, [map]);
  return null;
}

/**
 * Frames the monitored regions on the first payload only.
 *
 * Once, deliberately: an operator who has zoomed into a district must not be
 * yanked back to the whole country every time a 30-second poll returns.
 */
function FitOnce({ points }: { points: RiskPoint[] }) {
  const map = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || points.length === 0) return;
    done.current = true;
    const bounds = L.latLngBounds(
      points.map((point) => [point.region.latitude, point.region.longitude] as [number, number]),
    );
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30], animate: false });
  }, [map, points]);
  return null;
}

/** Flies to a target when one is set. A new object means a new request. */
function FlyTo({ target }: { target: FlyTarget | null }) {
  const map = useMap();
  useEffect(() => {
    if (!target) return;
    map.flyTo([target.lat, target.lon], target.zoom ?? Math.max(map.getZoom(), 8), {
      duration: 0.7,
    });
  }, [map, target]);
  return null;
}
/**
 * Find a region by name, district, state or code.
 *
 * Matches are ordered by risk rather than alphabetically. Someone typing
 * "Wayanad" during an event wants the hillside that is about to go, and if two
 * regions share a name prefix the dangerous one should be the first row and the
 * one Enter selects.
 */
function SearchBox({
  points,
  onPick,
}: {
  points: RiskPoint[];
  onPick: (point: RiskPoint) => void;
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    return points
      .filter((point) => {
        const region = point.region;
        return (
          region.name.toLowerCase().includes(needle) ||
          region.district.toLowerCase().includes(needle) ||
          region.state.toLowerCase().includes(needle) ||
          region.code.toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => b.risk_score - a.risk_score)
      .slice(0, 7);
  }, [points, query]);

  const pick = (point: RiskPoint | undefined) => {
    if (!point) return;
    onPick(point);
    setQuery('');
    setCursor(0);
  };

  return (
    <div className="w-[248px] max-w-[64vw]">
      <div className="panel flex items-center gap-2 px-2.5 py-1.5 shadow-bezel">
        <Search className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
        <input
          type="search"
          className="min-w-0 flex-1 bg-transparent text-xs text-ink placeholder:text-faint focus:outline-none"
          placeholder="Find a region, district or state"
          value={query}
          aria-label="Find a region"
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setCursor((index) => Math.min(index + 1, matches.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setCursor((index) => Math.max(index - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              pick(matches[cursor]);
            } else if (event.key === 'Escape') {
              setQuery('');
            }
          }}
        />
        {query && (
          <button
            type="button"
            className="shrink-0 text-faint hover:text-ink"
            onClick={() => setQuery('')}
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>
      {matches.length > 0 && (
        <ul className="panel mt-1 max-h-[42vh] divide-y divide-hairline/60 overflow-y-auto shadow-bezel">
          {matches.map((point, index) => (
            <li key={point.region.id}>
              <button
                type="button"
                className={cx(
                  'flex w-full items-center gap-2 px-2.5 py-1.5 text-left',
                  index === cursor ? 'bg-raised/70' : 'hover:bg-raised/50',
                )}
                onClick={() => pick(point)}
                onMouseEnter={() => setCursor(index)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-2xs text-ink">{point.region.name}</span>
                  <span className="block truncate text-[10px] text-faint">
                    {place(point.region.district, point.region.state)}
                  </span>
                </span>
                <RiskChip level={point.risk_level} score={point.risk_score} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {query.trim().length >= 2 && matches.length === 0 && (
        <p className="panel mt-1 px-2.5 py-1.5 text-2xs text-faint shadow-bezel">
          No monitored region matches that.
        </p>
      )}
    </div>
  );
}
/**
 * The popup behind a region disc.
 *
 * Written to be the answer to "why is this dot orange": the score with its
 * band, how closely the model's members agreed, the three drivers the map
 * payload carries, when it was scored and on what kind of data. The button at
 * the bottom does a real thing - it makes this the selected region, which is
 * what the forecast, what-if and detail panels read.
 */
function RiskPopup({
  point,
  onSelect,
}: {
  point: RiskPoint;
  onSelect?: (id: number) => void;
}) {
  const region = point.region;
  return (
    <div className="min-w-[212px] space-y-1.5">
      <div>
        <p className="font-display text-xs font-semibold leading-tight text-ink">{region.name}</p>
        <p className="text-[10px] text-faint">
          {place(region.district, region.state)} &middot; {region.code}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <span
          className={cx('tnum font-display text-lg font-semibold leading-none', palette(point.risk_level).text)}
        >
          {formatScore(point.risk_score)}
        </span>
        <RiskChip level={point.risk_level} />
        <ModeChip mode={point.data_mode} compact className="ml-auto" />
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        <Fact label="Rain 24 h" value={mm(point.rainfall_24h)} />
        <Fact label="Soil moisture" value={`${Math.round(point.soil_moisture)}%`} />
        <Fact label="Slope" value={`${Math.round(point.slope_deg)}°`} />
        <Fact label="Confidence" value={percent(point.confidence)} />
        <Fact label="People" value={people(region.population_exposed)} />
        <Fact label="Past events" value={String(region.historical_landslide_count ?? 0)} />
      </dl>
      <p className="font-mono text-[10px] leading-snug text-faint">
        {coords(region.latitude, region.longitude)} &middot; scored{' '}
        {formatDateTime(point.predicted_at)}
      </p>
      {onSelect && (
        <button
          type="button"
          className="btn btn-ghost w-full justify-center px-2 py-1"
          onClick={() => onSelect(region.id)}
        >
          <Crosshair className="h-3 w-3" aria-hidden />
          Use as selected region
        </button>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-1.5">
      <dt className="text-[10px] uppercase tracking-wider text-faint">{label}</dt>
      <dd className="tnum font-mono text-[10px] text-dim">{value}</dd>
    </div>
  );
}
/**
 * The risk discs, plus the rings that mark what is selected and what a scenario
 * just moved.
 *
 * The rings are separate markers rather than a different disc colour, because
 * the disc's colour is the region's band and overloading it would trade
 * information for decoration. A solid ring is the selection; a dashed ring is a
 * region that changed band in the last simulation run.
 */
function RiskLayer({
  points,
  zoom,
  selectedRegionId,
  highlighted,
  onSelectRegion,
}: {
  points: RiskPoint[];
  zoom: number;
  selectedRegionId?: number | null;
  highlighted: Set<number>;
  onSelectRegion?: (id: number) => void;
}) {
  return (
    <>
      {points.map((point) => {
        const id = point.region.id;
        const isSelected = selectedRegionId === id;
        const moved = highlighted.has(id);
        return (
          <Fragment key={id}>
            {(isSelected || moved) && (
              <Marker
                position={[point.region.latitude, point.region.longitude]}
                icon={haloIcon(point.risk_score, point.risk_level, zoom, moved && !isSelected)}
                pane={paneName('risk')}
                interactive={false}
                keyboard={false}
                zIndexOffset={-100}
              />
            )}
            <Marker
              position={[point.region.latitude, point.region.longitude]}
              icon={riskIcon(point.risk_score, point.risk_level, zoom)}
              pane={paneName('risk')}
              zIndexOffset={Math.round(point.risk_score)}
              eventHandlers={onSelectRegion ? { click: () => onSelectRegion(id) } : undefined}
            >
              <Tooltip direction="top" offset={[0, -6]} opacity={1}>
                <span className="font-mono text-2xs">
                  {point.region.name} &middot; {formatScore(point.risk_score)} {point.risk_level}
                </span>
              </Tooltip>
              <Popup>
                <RiskPopup point={point} onSelect={onSelectRegion} />
              </Popup>
            </Marker>
          </Fragment>
        );
      })}
    </>
  );
}
export interface RiskMapProps {
  points: RiskPoint[];
  /** Band counts for the legend. Usually straight from `/api/risk-map`. */
  counts?: BandCounts | null;
  thresholds?: { high: number; critical: number };
  /** Region ids that changed band in the last simulation - ringed with dashes. */
  highlighted?: number[];
  selectedRegionId?: number | null;
  onSelectRegion?: (id: number) => void;
  /** Which overlays start on, over the defaults in `layers.ts`. */
  initialLayers?: Partial<LayerState>;
  /** Search box, layer panel and zoom buttons. Off for a small inset map. */
  controls?: boolean;
  /** Bumped by the platform after a scenario run so overlays refetch. */
  version?: number;
  /** Provenance of the risk layer, named in the footer. */
  dataMode?: string;
  /** A refresh is in flight; shown as a quiet dot, never as a blocking spinner. */
  busy?: boolean;
  /** Must resolve to a definite height - a Leaflet map with none does not exist. */
  className?: string;
  footnote?: boolean;
}

export function RiskMap({
  points,
  counts,
  thresholds = DEFAULT_THRESHOLDS,
  highlighted,
  selectedRegionId,
  onSelectRegion,
  initialLayers,
  controls = true,
  version = 0,
  dataMode = 'DEMO',
  busy,
  className,
  footnote = true,
}: RiskMapProps) {
  const [map, setMap] = useState<L.Map | null>(null);
  const [zoom, setZoom] = useState(INDIA_ZOOM);
  const [layers, setLayers] = useState<LayerState>(() => defaultLayers(initialLayers));
  const [basemapKey, setBasemapKey] = useState<Basemap['key']>('dark');
  const [target, setTarget] = useState<FlyTarget | null>(null);

  const basemap = basemapFor(basemapKey);
  const regions = useMemo(() => indexRegions(points), [points]);
  const moved = useMemo(() => new Set(highlighted ?? []), [highlighted]);

  const toggle = useCallback((key: LayerKey) => {
    setLayers((current) => ({ ...current, [key]: !current[key] }));
  }, []);
  // A selection made elsewhere - a table row, an alert card - should bring the
  // region into view here too, otherwise the two halves of the screen disagree
  // about what is being discussed.
  //
  // Keyed on the id alone. The region index is rebuilt on every poll, so making
  // it a dependency would re-fly the map every thirty seconds and fight an
  // operator who has panned somewhere on purpose.
  const regionsRef = useRef(regions);
  regionsRef.current = regions;
  useEffect(() => {
    if (!selectedRegionId) return;
    const region = regionsRef.current.get(selectedRegionId);
    if (region) setTarget({ lat: region.latitude, lon: region.longitude, zoom: 8 });
  }, [selectedRegionId]);

  const fitAll = useCallback(() => {
    if (!map || points.length === 0) return;
    const bounds = L.latLngBounds(
      points.map((point) => [point.region.latitude, point.region.longitude] as [number, number]),
    );
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30] });
  }, [map, points]);

  return (
    <div className={cx('relative isolate overflow-hidden rounded-panel bg-ground', className)}>
      <MapContainer
        center={INDIA_CENTER}
        zoom={INDIA_ZOOM}
        minZoom={4}
        maxZoom={18}
        zoomControl={false}
        attributionControl
        scrollWheelZoom
        worldCopyJump={false}
        className="absolute inset-0 h-full w-full bg-ground"
      >
        <TileLayer
          key={basemap.key}
          url={basemap.url}
          attribution={basemap.attribution}
          maxZoom={18}
          maxNativeZoom={basemap.maxZoom}
          opacity={basemap.light ? 0.75 : 1}
        />
        <Panes />
        <MapBridge onMap={setMap} onZoom={setZoom} />
        <AutoResize />
        <FitOnce points={points} />
        <FlyTo target={target} />

        <ExposureLayer enabled={layers.exposure} points={points} />
        <HaloLayer enabled={layers.halo} points={points} thresholds={thresholds} />
        <EventsLayer enabled={layers.events} version={version} />
        <ReportsLayer enabled={layers.reports} version={version} />
        <SensorsLayer
          enabled={layers.sensors}
          regions={regions}
          version={version}
          onSelectRegion={onSelectRegion}
        />
        {layers.risk && (
          <RiskLayer
            points={points}
            zoom={zoom}
            selectedRegionId={selectedRegionId}
            highlighted={moved}
            onSelectRegion={onSelectRegion}
          />
        )}
        <AlertsLayer
          enabled={layers.alerts}
          regions={regions}
          version={version}
          onSelectRegion={onSelectRegion}
        />
        <LabelsLayer enabled={layers.labels} points={points} zoom={zoom} />
      </MapContainer>

      {controls && (
        <div className="pointer-events-none absolute inset-0 z-[700] p-2.5">
          <div className="pointer-events-auto absolute left-2.5 top-2.5">
            <SearchBox
              points={points}
              onPick={(point) => {
                setTarget({ lat: point.region.latitude, lon: point.region.longitude, zoom: 9 });
                onSelectRegion?.(point.region.id);
              }}
            />
          </div>

          <div className="pointer-events-auto absolute right-2.5 top-2.5">
            <MapLegend
              layers={layers}
              onToggle={toggle}
              basemap={basemap}
              onBasemap={setBasemapKey}
              counts={counts}
              thresholds={thresholds}
            />
          </div>
          <div className="pointer-events-auto absolute bottom-8 left-2.5 flex flex-col gap-1">
            <MapButton label="Zoom in" onClick={() => map?.zoomIn()}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
            </MapButton>
            <MapButton label="Zoom out" onClick={() => map?.zoomOut()}>
              <Minus className="h-3.5 w-3.5" aria-hidden />
            </MapButton>
            <MapButton label="Fit all monitored regions" onClick={fitAll}>
              <Maximize2 className="h-3.5 w-3.5" aria-hidden />
            </MapButton>
          </div>

          {busy && (
            <div className="pointer-events-none absolute left-1/2 top-2.5 -translate-x-1/2">
              <span className="flex items-center gap-1.5 rounded-panel border border-hairline bg-ground/85 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-accent">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                Re-scoring
              </span>
            </div>
          )}
        </div>
      )}

      {footnote && (
        <p className="pointer-events-none absolute inset-x-0 bottom-0 z-[700] bg-gradient-to-t from-ground/95 to-transparent pb-4 pl-2.5 pr-28 pt-6 text-[10px] leading-snug text-faint">
          {overlayFootnote(dataMode)}
        </p>
      )}
    </div>
  );
}

/** A square map button, sized for a thumb and legible over any basemap. */
function MapButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="panel flex h-7 w-7 items-center justify-center text-dim shadow-bezel hover:text-ink"
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}







