/**
 * The historical landslide record.
 *
 * This is the only screen that looks backwards, and it is the one that earns the
 * others their credit: a forecast is easier to weigh when the same interface will
 * show you what has already happened in the same valley.
 *
 * Three things about how it is built.
 *
 * The dropdowns are filled from `filter_options`, which the API derives from the
 * inventory table rather than from a list written in code. Replace the demo
 * inventory with the GSI national inventory and the filters change with it, with
 * no edit here.
 *
 * The five charts are computed server-side from the *filtered* rows, so narrowing
 * to one state redraws all of them instead of leaving a national chart sitting
 * above a local table. That is why they are read straight out of `data.charts`
 * and never recomputed in the browser - two versions of the same statistic is one
 * too many.
 *
 * The record is of mixed provenance and says so per row. Some events are compiled
 * from public reports of real Indian landslides, with approximate figures; the
 * rest are modelled minor events that give the inventory realistic density. The
 * split is served next to the charts and shown as a chip on every row, because
 * nothing on this page is a complete national statistic and it should never be
 * read as one.
 */
import { Archive, Crosshair, Filter, MapPin, RotateCcw } from 'lucide-react';
import * as L from 'leaflet';
import { useEffect, useMemo, useState } from 'react';
import { MapContainer, Marker, TileLayer, Tooltip, useMap } from 'react-leaflet';

import {
  EventsPerYearChart,
  RainfallVsEventsChart,
  SeasonalChart,
  SeveritySplitChart,
  TopRegionsChart,
} from '../charts/HistoryCharts';
import { PageHeader } from '../components/AppShell';
import { Chip, EventSeverityChip, ModeChip } from '../components/Chips';
import { Panel, ResourceBody } from '../components/Panel';
import { KeyValue, StatTile } from '../components/Readouts';
import { EmptyState } from '../components/States';
import { DataTable, NumCell, TwoLine, type Column } from '../components/Table';
import {
  EMPTY,
  coords,
  count as formatCount,
  degrees,
  formatDate,
  km,
  metres,
  mm,
  place,
  truncate,
} from '../lib/format';
import { EVENT_SEVERITY, EVENT_SEVERITY_HEX } from '../lib/risk';
import { api } from '../services/api';
import { usePlatform } from '../state/PlatformContext';
import { useResource } from '../state/useResource';
import type {
  EventSeverity,
  HighRiskRegion,
  HistoryNearResponse,
  HistoryResponse,
  LandslideEvent,
} from '../types/api';
import { BASEMAPS, INDIA_CENTER, INDIA_ZOOM } from '../maps/basemaps';
import { glyphIcon } from '../maps/markers';

/** Where a click on a chart or a detail panel asks the map to go. */
interface FlyTarget {
  lat: number;
  lon: number;
  zoom: number;
}

/** Ascending severity, for the table sort. Matches the backend's own order. */
const SEVERITY_RANK: Record<EventSeverity, number> = {
  MINOR: 1,
  MODERATE: 2,
  MAJOR: 3,
  SEVERE: 4,
};

/** Marker size by severity, so the worst events read first on a national view. */
const GLYPH_SIZE: Record<EventSeverity, number> = {
  MINOR: 9,
  MODERATE: 11,
  MAJOR: 13,
  SEVERE: 15,
};

/**
 * How many markers the map will draw.
 *
 * The API will return up to 5000 rows and the table is happy with all of them,
 * but five thousand DivIcons is five thousand DOM nodes and the map would stop
 * being usable. The cap is stated on the map when it bites rather than silently
 * dropping events - a map that quietly shows a subset of the table is worse than
 * one that admits it.
 */
const MAP_MARKER_CAP = 600;

const LIMIT_CHOICES = [200, 500, 1000, 5000];

/**
 * Whether a row is on the public record.
 *
 * Mirrors the test in `history_service.charts`, which decides the documented /
 * modelled split from the same `source` string. The totals on this page come from
 * the API; this only chooses which chip a row gets, and it reads the same field so
 * the two cannot disagree.
 */
const DOCUMENTED_MARK = 'Compiled from public reports';

function isDocumented(event: LandslideEvent): boolean {
  return (event.source ?? '').includes(DOCUMENTED_MARK);
}

function ProvenanceChip({ event }: { event: LandslideEvent }) {
  const documented = isDocumented(event);
  return (
    <Chip
      className={
        documented
          ? 'border-risk-low/40 bg-risk-low/10 text-risk-low'
          : 'border-hairbright bg-raised text-faint'
      }
      title={
        documented
          ? 'Compiled from public reports of a real landslide. Figures are approximate.'
          : 'A modelled event, generated to give the inventory realistic density. Not a record of anything that happened.'
      }
    >
      {documented ? 'Record' : 'Modelled'}
    </Chip>
  );
}
// ------------------------------------------------------------------- map

/**
 * Keeps the Leaflet viewport in step with the filters.
 *
 * The refit is keyed on `signature` rather than on the array, because the array is
 * a new object on every render and refitting on every render would fight the
 * user's own panning. A single result gets a fixed zoom: the bounds of one point
 * have no extent and Leaflet would take that as licence to zoom to street level
 * over an empty hillside.
 */
function MapSync({
  events,
  signature,
  flyTo,
}: {
  events: LandslideEvent[];
  signature: string;
  flyTo: FlyTarget | null;
}) {
  const map = useMap();

  // Leaflet caches its container size, so a map in a grid that reflows paints
  // grey until something forces a recount. This does the recount.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => map.invalidateSize({ animate: false }));
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map]);

  useEffect(() => {
    if (!events.length) {
      map.setView(INDIA_CENTER, INDIA_ZOOM);
      return;
    }
    if (events.length === 1) {
      map.setView([events[0].latitude, events[0].longitude], 9);
      return;
    }
    const bounds = L.latLngBounds(
      events.map((event) => [event.latitude, event.longitude] as [number, number]),
    );
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 9 });
    // `events` is deliberately absent: `signature` is its identity.
  }, [map, signature]);

  useEffect(() => {
    if (flyTo) map.flyTo([flyTo.lat, flyTo.lon], flyTo.zoom, { duration: 0.8 });
  }, [map, flyTo]);

  return null;
}

/**
 * The filtered events, plotted.
 *
 * A purpose-built map rather than a reuse of `RiskMap`: that component's events
 * overlay fetches the whole inventory on its own, which would put every event on
 * the map above a table showing four. The map and the table on this screen are
 * always looking at the same rows.
 */
function EventMap({
  events,
  activeId,
  onPick,
  flyTo,
}: {
  events: LandslideEvent[];
  activeId: number | null;
  onPick: (event: LandslideEvent) => void;
  flyTo: FlyTarget | null;
}) {
  const basemap = BASEMAPS[0];
  const shown = events.length > MAP_MARKER_CAP ? events.slice(0, MAP_MARKER_CAP) : events;
  const signature = `${shown.length}:${shown[0]?.id ?? 0}:${shown[shown.length - 1]?.id ?? 0}`;

  return (
    <div className="relative h-[23rem] w-full overflow-hidden sm:h-[27rem]">
      <MapContainer center={INDIA_CENTER} zoom={INDIA_ZOOM} className="h-full w-full">
        <TileLayer
          url={basemap.url}
          attribution={basemap.attribution}
          maxZoom={basemap.maxZoom}
        />
        <MapSync events={shown} signature={signature} flyTo={flyTo} />
        {shown.map((event) => (
          <Marker
            key={event.id}
            position={[event.latitude, event.longitude]}
            icon={glyphIcon(
              'diamond',
              EVENT_SEVERITY_HEX[event.severity],
              GLYPH_SIZE[event.severity] + (event.id === activeId ? 6 : 0),
            )}
            zIndexOffset={event.id === activeId ? 500 : 0}
            eventHandlers={{ click: () => onPick(event) }}
          >
            <Tooltip direction="top" offset={[0, -8]}>
              {formatDate(event.event_date)} &middot; {event.location}
              <br />
              {EVENT_SEVERITY[event.severity]?.label ?? event.severity}
              {event.rainfall_mm === null ? '' : ` · ${mm(event.rainfall_mm)} in 24 h`}
            </Tooltip>
          </Marker>
        ))}
      </MapContainer>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[700] flex flex-wrap items-end justify-between gap-2 bg-gradient-to-t from-ground/95 to-transparent px-2.5 pb-1.5 pt-8">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {(Object.keys(SEVERITY_RANK) as EventSeverity[]).map((severity) => (
            <span key={severity} className="flex items-center gap-1 text-[10px] text-dim">
              <span
                className="h-2 w-2 rotate-45 rounded-[1px]"
                style={{ backgroundColor: EVENT_SEVERITY_HEX[severity] }}
                aria-hidden
              />
              {EVENT_SEVERITY[severity]?.label ?? severity}
            </span>
          ))}
        </div>
        <p className="text-[10px] leading-snug text-faint">
          {events.length > MAP_MARKER_CAP
            ? `First ${formatCount(MAP_MARKER_CAP)} of ${formatCount(events.length)} plotted · narrow the filters to map the rest`
            : `${formatCount(events.length)} plotted · click a marker to open it`}
        </p>
      </div>
    </div>
  );
}
// ---------------------------------------------------------------- controls

function FilterSelect({
  id,
  label,
  value,
  onChange,
  allLabel,
  options,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  allLabel: string;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <div className="min-w-0">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="field"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{allLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
// ------------------------------------------------------------------ detail

/**
 * Distance in kilometres, flat-earth.
 *
 * Mirrors the approximation in `history_service.near`, which is what ordered the
 * list in the first place. At these distances its error is far smaller than the
 * positional accuracy of the inventory itself.
 */
function distanceKm(from: LandslideEvent, to: LandslideEvent): number {
  const dy = (to.latitude - from.latitude) * 111.0;
  const dx =
    (to.longitude - from.longitude) * 111.0 * Math.cos((from.latitude * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

const NEAR_RADIUS_KM = 30;

/**
 * One event in full, and what else the record holds nearby.
 *
 * The nearby lookup is the question a warning invites - "has this happened here
 * before?" - and it is a separate request against `/history/near` rather than a
 * filter over the rows already loaded, because the rows already loaded are the
 * ones that passed the filters and the answer must not depend on those.
 */
function EventDetail({
  event,
  onCentre,
}: {
  event: LandslideEvent;
  onCentre: (target: FlyTarget) => void;
}) {
  const near = useResource<HistoryNearResponse>(
    (signal) =>
      api.historyNear(
        { lat: event.latitude, lon: event.longitude, radius_km: NEAR_RADIUS_KM, limit: 8 },
        signal,
      ),
    [event.id],
  );
  const others = (near.data?.events ?? []).filter((row) => row.id !== event.id);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <EventSeverityChip severity={event.severity} />
        <ProvenanceChip event={event} />
        <ModeChip mode={event.data_mode} compact />
      </div>

      <div>
        <p className="font-display text-sm font-semibold text-ink">{event.location}</p>
        <p className="text-xs text-dim">
          {place(event.district, event.state) || EMPTY} &middot; {formatDate(event.event_date)}
        </p>
      </div>

      {event.description && (
        <p className="text-xs leading-relaxed text-dim">{event.description}</p>
      )}

      <div className="space-y-1">
        <KeyValue label="24 h rainfall" value={event.rainfall_mm === null ? EMPTY : mm(event.rainfall_mm)} />
        <KeyValue label="Slope" value={event.slope_deg === null ? EMPTY : degrees(event.slope_deg)} />
        <KeyValue
          label="Elevation"
          value={event.elevation_m === null ? EMPTY : metres(event.elevation_m)}
        />
        <KeyValue label="Trigger" value={event.trigger ?? EMPTY} mono={false} />
        <KeyValue
          label="Lives lost"
          value={event.fatalities === null ? 'Not recorded' : formatCount(event.fatalities)}
        />
        <KeyValue label="Coordinates" value={coords(event.latitude, event.longitude)} />
        <KeyValue label="Event ID" value={event.event_id} />
      </div>

      <p className="text-2xs leading-relaxed text-faint">Source: {event.source}</p>

      <button
        type="button"
        className="btn btn-ghost w-full"
        onClick={() => onCentre({ lat: event.latitude, lon: event.longitude, zoom: 11 })}
      >
        <Crosshair className="h-3.5 w-3.5" aria-hidden />
        Centre the map here
      </button>

      <div className="rule" />

      <div>
        <p className="font-display text-2xs font-semibold uppercase tracking-wider text-dim">
          Within {km(NEAR_RADIUS_KM, 0)}
        </p>
        <ResourceBody
          resource={near}
          isEmpty={() => others.length === 0}
          loadingRows={2}
          loadingLabel="Searching the inventory"
          empty={
            <p className="mt-1.5 text-xs leading-relaxed text-faint">
              Nothing else in the record within {km(NEAR_RADIUS_KM, 0)} of this point. That is a
              statement about the inventory, not about the slope.
            </p>
          }
        >
          {() => (
            <ul className="mt-1.5 space-y-1.5">
              {others.map((row) => (
                <li key={row.id} className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate text-dim">
                    <span
                      className="mr-1.5 inline-block h-1.5 w-1.5 rotate-45 rounded-[1px] align-middle"
                      style={{ backgroundColor: EVENT_SEVERITY_HEX[row.severity] }}
                      aria-hidden
                    />
                    {row.location}
                  </span>
                  <span className="shrink-0 font-mono text-2xs text-faint">
                    {km(distanceKm(event, row))} &middot; {formatDate(row.event_date)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </ResourceBody>
      </div>
    </div>
  );
}
// -------------------------------------------------------------------- page

export default function HistoryPage() {
  const { version } = usePlatform();

  const [stateFilter, setStateFilter] = useState('');
  const [districtFilter, setDistrictFilter] = useState('');
  const [yearFilter, setYearFilter] = useState('');
  const [severityFilter, setSeverityFilter] = useState('');
  const [limit, setLimit] = useState(1000);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [flyTo, setFlyTo] = useState<FlyTarget | null>(null);

  const query = useMemo(() => {
    const next: {
      state?: string;
      district?: string;
      year?: number;
      severity?: string;
      limit: number;
    } = { limit };
    if (stateFilter) next.state = stateFilter;
    if (districtFilter) next.district = districtFilter;
    if (yearFilter) next.year = Number(yearFilter);
    if (severityFilter) next.severity = severityFilter;
    return next;
  }, [stateFilter, districtFilter, yearFilter, severityFilter, limit]);

  const queryKey = JSON.stringify(query);

  /**
   * No polling. The inventory is a record, not a feed: it changes when someone
   * loads a new one, which bumps `version`, and not on a timer.
   */
  const history = useResource<HistoryResponse>(
    (signal) => api.history(query, signal),
    [version, queryKey],
  );

  const data = history.data;
  const events = data?.events ?? [];
  const options = data?.filter_options;
  const charts = data?.charts;

  const active = useMemo(
    () => events.find((event) => event.id === activeId) ?? null,
    [events, activeId],
  );

  /**
   * The served district list covers the whole inventory, because the API derives
   * its options from the table and not from the current filter. Once a state is
   * chosen the list is narrowed to the districts that actually appear in its
   * rows - otherwise the dropdown would offer a district in Sikkim while the
   * table is filtered to Kerala, and choosing it would return nothing.
   */
  const districtOptions = useMemo(() => {
    const served = options?.districts ?? [];
    if (!stateFilter) return served;
    const inState = new Set(
      events
        .filter((event) => event.state === stateFilter)
        .map((event) => event.district)
        .filter((district): district is string => Boolean(district)),
    );
    return served.filter((district) => inState.has(district));
  }, [options, stateFilter, events]);

  const filtered = Boolean(stateFilter || districtFilter || yearFilter || severityFilter);

  function chooseState(next: string) {
    setStateFilter(next);
    // A district in the old state cannot survive the change.
    setDistrictFilter('');
  }

  function clearFilters() {
    setStateFilter('');
    setDistrictFilter('');
    setYearFilter('');
    setSeverityFilter('');
  }

  function centreOn(target: FlyTarget) {
    // A fresh object each time, so pressing the same button twice re-flies.
    setFlyTo({ ...target });
  }

  function focusRegion(region: HighRiskRegion) {
    centreOn({ lat: region.latitude, lon: region.longitude, zoom: 9 });
  }

  const peakMonth = useMemo(() => {
    const months = charts?.seasonal_pattern ?? [];
    if (!months.length) return null;
    return months.reduce((best, row) => (row.events > best.events ? row : best), months[0]);
  }, [charts]);

  const severeCount = useMemo(
    () =>
      (charts?.severity_split ?? [])
        .filter((row) => row.severity === 'MAJOR' || row.severity === 'SEVERE')
        .reduce((sum, row) => sum + row.count, 0),
    [charts],
  );
  const columns: Column<LandslideEvent>[] = [
    {
      key: 'date',
      header: 'Date',
      width: 'w-24',
      // ISO dates sort lexicographically, which is also chronologically.
      sort: (row) => row.event_date,
      cell: (row) => <span className="font-mono text-2xs text-dim">{formatDate(row.event_date)}</span>,
    },
    {
      key: 'location',
      header: 'Location',
      sort: (row) => row.location,
      cell: (row) => (
        <TwoLine primary={row.location} secondary={place(row.district, row.state) || row.event_id} />
      ),
    },
    {
      key: 'severity',
      header: 'Severity',
      width: 'w-24',
      sort: (row) => SEVERITY_RANK[row.severity] ?? 0,
      cell: (row) => <EventSeverityChip severity={row.severity} />,
    },
    {
      key: 'rainfall',
      header: 'Rain 24 h',
      align: 'right',
      width: 'w-24',
      hint: 'Rainfall recorded around the event where a figure is available. Blank means the record does not carry one, not that it was dry.',
      sort: (row) => row.rainfall_mm,
      cell: (row) => (
        <NumCell className={row.rainfall_mm === null ? 'text-faint' : undefined}>
          {row.rainfall_mm === null ? EMPTY : mm(row.rainfall_mm)}
        </NumCell>
      ),
    },
    {
      key: 'slope',
      header: 'Slope',
      align: 'right',
      width: 'w-20',
      hideBelow: 'lg',
      sort: (row) => row.slope_deg,
      cell: (row) => (
        <NumCell className={row.slope_deg === null ? 'text-faint' : undefined}>
          {row.slope_deg === null ? EMPTY : degrees(row.slope_deg)}
        </NumCell>
      ),
    },
    {
      key: 'trigger',
      header: 'Trigger',
      hideBelow: 'xl',
      sort: (row) => row.trigger,
      cell: (row) => (
        <span className="block truncate text-2xs text-dim">
          {row.trigger ? truncate(row.trigger, 42) : EMPTY}
        </span>
      ),
    },
    {
      key: 'fatalities',
      header: 'Lives lost',
      align: 'right',
      width: 'w-24',
      hideBelow: 'xl',
      hint: 'From the public report, where one gives a figure. Approximate.',
      sort: (row) => row.fatalities,
      cell: (row) => (
        <NumCell className={row.fatalities ? 'text-risk-high' : 'text-faint'}>
          {row.fatalities === null ? EMPTY : formatCount(row.fatalities)}
        </NumCell>
      ),
    },
    {
      key: 'provenance',
      header: 'Record',
      width: 'w-24',
      hideBelow: 'md',
      hint: 'Whether the row is compiled from a public report of a real landslide or modelled for inventory density.',
      sort: (row) => (isDocumented(row) ? 1 : 0),
      cell: (row) => <ProvenanceChip event={row} />,
    },
  ];
  return (
    <div className="min-w-0 space-y-3">
      <PageHeader
        title="Historical landslide record"
        lead="What has already happened, filtered and charted. The record is of mixed provenance: some rows are compiled from public reports of real Indian landslides, with approximate figures, and the rest are modelled minor events that give the inventory realistic density. Every row says which it is."
        right={
          <>
            <Chip
              className="border-hairbright bg-raised text-dim"
              title="Events in the inventory table, before any filter is applied."
            >
              {formatCount(data?.total ?? 0)} events on file
            </Chip>
            <ModeChip mode={data?.data_mode ?? 'DEMO'} />
          </>
        }
      />

      <Panel
        title={
          <span className="flex items-center gap-1.5">
            <Filter className="h-3.5 w-3.5 text-accent" aria-hidden />
            Filters
          </span>
        }
        note={
          data
            ? `${formatCount(data.filtered)} of ${formatCount(data.total)} events`
            : 'loading the inventory'
        }
        busy={history.refreshing}
        right={
          filtered ? (
            <button type="button" className="btn btn-ghost" onClick={clearFilters}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              Clear
            </button>
          ) : null
        }
      >
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
          <FilterSelect
            id="history-state"
            label="State"
            value={stateFilter}
            onChange={chooseState}
            allLabel="All states"
            disabled={!options}
            options={(options?.states ?? []).map((value) => ({ value, label: value }))}
          />
          <FilterSelect
            id="history-district"
            label="District"
            value={districtFilter}
            onChange={setDistrictFilter}
            allLabel={stateFilter ? `All of ${stateFilter}` : 'All districts'}
            disabled={!options}
            options={districtOptions.map((value) => ({ value, label: value }))}
          />
          <FilterSelect
            id="history-year"
            label="Year"
            value={yearFilter}
            onChange={setYearFilter}
            allLabel="All years"
            disabled={!options}
            options={(options?.years ?? []).map((year) => ({
              value: String(year),
              label: String(year),
            }))}
          />
          <FilterSelect
            id="history-severity"
            label="Severity"
            value={severityFilter}
            onChange={setSeverityFilter}
            allLabel="All severities"
            disabled={!options}
            options={(options?.severities ?? []).map((value) => ({
              value,
              label: EVENT_SEVERITY[value]?.label ?? value,
            }))}
          />
          <div className="min-w-0">
            <label className="label" htmlFor="history-limit">
              Row limit
            </label>
            <select
              id="history-limit"
              className="field"
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
            >
              {LIMIT_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {formatCount(choice)} rows
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="mt-2.5 text-2xs leading-relaxed text-faint">
          These lists are read from the inventory table, not written into the interface, so a
          different inventory changes them without a code change. The charts below are rebuilt
          server-side from the filtered rows — narrowing to one state redraws all five rather than
          leaving a national chart above a local table.
        </p>
      </Panel>

      {data && charts && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          <StatTile
            label="Events shown"
            value={formatCount(data.filtered)}
            hint="Rows matching the filters, up to the row limit."
          />
          <StatTile
            label="On file"
            value={formatCount(data.total)}
            hint="Every event in the inventory, before filters."
          />
          <StatTile
            label="From reports"
            value={formatCount(charts.provenance.documented)}
            tone="text-risk-low"
            hint="Compiled from public reports of real landslides. Figures approximate."
          />
          <StatTile
            label="Modelled"
            value={formatCount(charts.provenance.modelled)}
            tone="text-dim"
            hint="Generated minor events, present for density. Not records of real landslides."
          />
          <StatTile
            label="Major or severe"
            value={formatCount(severeCount)}
            tone="text-risk-high"
            hint="Rows in the two heaviest severity classes, within the current filters."
          />
          <StatTile
            label="Peak month"
            value={peakMonth ? peakMonth.month : EMPTY}
            tone="text-accent"
            footer={peakMonth ? `${formatCount(peakMonth.events)} events` : undefined}
            hint="The month carrying the most events in this selection — the monsoon, in most selections."
          />
        </div>
      )}
      <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="min-w-0 space-y-3">
          <Panel
            title="Where the record has events"
            note={filtered ? 'filtered' : 'whole inventory'}
            busy={history.refreshing}
            flush
            bodyClassName="p-2.5"
          >
            <ResourceBody
              resource={history}
              loadingRows={4}
              loadingLabel="Loading the inventory"
              isEmpty={(payload) => payload.events.length === 0}
              empty={
                <EmptyState
                  title="No events to plot"
                  hint="Nothing in the record matches these filters."
                  icon={<MapPin className="h-5 w-5" />}
                />
              }
            >
              {() => (
                <div className="overflow-hidden rounded-md border border-hairline">
                  <EventMap
                    events={events}
                    activeId={activeId}
                    onPick={(event) => setActiveId(event.id)}
                    flyTo={flyTo}
                  />
                </div>
              )}
            </ResourceBody>
          </Panel>

          <Panel
            title="Events"
            note={data ? `${formatCount(events.length)} rows · newest first` : undefined}
            busy={history.refreshing}
            flush
          >
            <div className="min-w-0 p-3">
              <ResourceBody
                resource={history}
                loadingRows={6}
                loadingLabel="Loading events"
                isEmpty={(payload) => payload.events.length === 0}
                empty={
                  <EmptyState
                    title="No events match these filters"
                    hint="Widen the year or the severity, or clear the filters to see the whole inventory."
                  />
                }
              >
                {() => (
                  <DataTable
                    rows={events}
                    columns={columns}
                    rowKey={(row) => row.id}
                    onRowClick={(row) => setActiveId(row.id)}
                    isActive={(row) => row.id === activeId}
                    rowClassName={(row) =>
                      row.severity === 'SEVERE' ? 'bg-risk-critical/[0.06]' : undefined
                    }
                    initialSort={{ key: 'date', direction: 'desc' }}
                    maxHeight="max-h-[32rem]"
                    dense
                    caption="Past landslide events in the inventory"
                  />
                )}
              </ResourceBody>
            </div>
          </Panel>
        </div>

        <div className="min-w-0 space-y-3">
          <Panel title="Event detail" note={active ? active.event_id : undefined}>
            {active ? (
              <EventDetail key={active.id} event={active} onCentre={centreOn} />
            ) : (
              <EmptyState
                title="No event open"
                hint="Pick a row in the table or a marker on the map. The panel also answers whether anything else in the record sits within 30 km of it."
                icon={<MapPin className="h-5 w-5" />}
              />
            )}
          </Panel>

          <Panel
            title={
              <span className="flex items-center gap-1.5">
                <Archive className="h-3.5 w-3.5 text-accent" aria-hidden />
                Provenance
              </span>
            }
          >
            {charts ? (
              <div className="space-y-2.5">
                <div className="space-y-1">
                  <KeyValue
                    label="From public reports"
                    value={formatCount(charts.provenance.documented)}
                  />
                  <KeyValue label="Modelled for density" value={formatCount(charts.provenance.modelled)} />
                </div>
                <p className="text-2xs leading-relaxed text-faint">{charts.provenance.note}</p>
                <p className="text-2xs leading-relaxed text-faint">
                  The counts describe the rows currently shown, so they move with the filters.
                </p>
              </div>
            ) : (
              <p className="text-xs text-faint">Waiting for the inventory.</p>
            )}
          </Panel>
        </div>
      </div>
      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        <Panel title="Events per year" note="stacked by severity" busy={history.refreshing}>
          {charts ? (
            <EventsPerYearChart data={charts.events_per_year} height={220} />
          ) : (
            <ChartWaiting height={220} />
          )}
          <p className="mt-2 text-2xs leading-relaxed text-faint">
            A tall year is a wet year, and also a year somebody wrote more of it down. Reporting
            effort is part of what this chart measures — it describes the inventory as much as the
            hillsides.
          </p>
        </Panel>

        <Panel title="Rainfall against landslides" note="24 h totals, mm" busy={history.refreshing}>
          {charts ? (
            <RainfallVsEventsChart data={charts.rainfall_vs_events} height={220} />
          ) : (
            <ChartWaiting height={220} />
          )}
          <p className="mt-2 text-2xs leading-relaxed text-faint">
            The shape the model learns from: events cluster in the heavy bands. It is not a
            threshold — slope, soil and how wet the ground already was decide whether a given band
            matters, which is why the model reads sixteen features and not one.
          </p>
        </Panel>
      </div>

      <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Panel title="Seasonal pattern" note="events by month" busy={history.refreshing}>
          {charts ? (
            <SeasonalChart data={charts.seasonal_pattern} height={200} />
          ) : (
            <ChartWaiting height={200} />
          )}
          <p className="mt-2 text-2xs leading-relaxed text-faint">
            The monsoon, drawn from the record rather than asserted. June to September carries most
            of the inventory, which is the window in which a warning system has to be trusted.
          </p>
        </Panel>

        <Panel title="Severity split" note="of the rows shown" busy={history.refreshing}>
          {charts ? (
            <SeveritySplitChart data={charts.severity_split} height={190} />
          ) : (
            <ChartWaiting height={190} />
          )}
          <p className="mt-2 text-2xs leading-relaxed text-faint">
            Minor events dominate any inventory. The modelled rows are all minor, so this split moves
            with the provenance mix.
          </p>
        </Panel>
      </div>

      <Panel
        title="Places the record returns to"
        note="click a bar to centre the map"
        busy={history.refreshing}
      >
        {charts ? (
          <TopRegionsChart data={charts.high_risk_regions} limit={10} onPick={focusRegion} />
        ) : (
          <ChartWaiting height={260} />
        )}
        <p className="mt-2 text-2xs leading-relaxed text-faint">
          Grouped by district where the row carries one. A district near the top has a history, and
          that history is what the model reads through{' '}
          <span className="font-mono">historical_landslide_count</span> — one of the sixteen
          features, not a warning of its own.
        </p>
      </Panel>

      <Panel title="How to read this record">
        <div className="grid gap-4 text-xs leading-relaxed text-dim sm:grid-cols-3">
          <div>
            <p className="mb-1 font-display text-2xs font-semibold uppercase tracking-wider text-ink">
              What it is
            </p>
            <p>
              An inventory of past landslides with date, place, severity, rainfall and slope,
              filtered and charted out of the database. Every figure on this screen is computed from
              those rows.
            </p>
          </div>
          <div>
            <p className="mb-1 font-display text-2xs font-semibold uppercase tracking-wider text-risk-high">
              What it is not
            </p>
            <p>
              Not a complete national inventory, and not a hazard map. Documented rows come from
              public reports and their figures are approximate; modelled rows never happened. Silence
              here means the record is silent, not that a slope is safe.
            </p>
          </div>
          <div>
            <p className="mb-1 font-display text-2xs font-semibold uppercase tracking-wider text-accent">
              Replacing it
            </p>
            <p>
              The filters, the charts and the counts are all derived from the table, so loading a
              real inventory — the GSI national one, or a state inventory — changes this screen
              without a line of code here. Only the loader has to be written.
            </p>
          </div>
        </div>
      </Panel>
    </div>
  );
}

/**
 * A chart panel body while the first request is in flight.
 *
 * The map and the table above already report loading and any failure. Six more
 * copies of the same message would only make a bad moment noisier, so these
 * panels reserve their height and stay quiet.
 */
function ChartWaiting({ height = 210 }: { height?: number }) {
  return (
    <div className="flex items-center justify-center text-2xs text-faint" style={{ height }}>
      Waiting for the inventory…
    </div>
  );
}


