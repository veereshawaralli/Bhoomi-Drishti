/**
 * The seven overlays that sit over the risk discs.
 *
 * Each one fetches its own data, and only while its switch is on. That is the
 * reason they are separate components rather than props passed down from a
 * page: turning the historical layer off has to stop the request as well as
 * hide the markers, and a page that opens with three overlays off should not
 * have paid for them.
 *
 * Two joins happen here, both forced by the API shape and both deliberate. An
 * alert carries `region_id` but no coordinates, and so does a sensor reading -
 * the backend does not repeat a region's geometry on every row. So the risk
 * points, which do carry the full region, are turned into a lookup and the
 * overlay draws only what it can place. A row whose region is missing from the
 * current map is skipped rather than dropped at (0, 0) in the Gulf of Guinea.
 */
import { Circle, Marker, Popup, Tooltip } from 'react-leaflet';

import {
  count as formatCount,
  formatDate,
  formatDateTime,
  mm,
  people,
  reading as formatReading,
  relativeTime,
  score as formatScore,
  truncate,
} from '../lib/format';
import {
  EVENT_SEVERITY,
  EVENT_SEVERITY_HEX,
  RISK_HEX,
  SENSOR_STATUS,
  SENSOR_STATUS_HEX,
  isOpen,
  markerRadius,
  severityPalette,
} from '../lib/risk';
import { api } from '../services/api';
import { useResource } from '../state/useResource';
import type { Alert, CitizenReport, Region, RiskPoint, SensorReading } from '../types/api';
import { paneName } from './layers';
import { glyphIcon, labelIcon } from './markers';

/** region_id -> region, built from the points already on the map. */
export type RegionIndex = Map<number, Region>;

export function indexRegions(points: RiskPoint[]): RegionIndex {
  const index: RegionIndex = new Map();
  for (const point of points) index.set(point.region.id, point.region);
  return index;
}

const POPUP_CLASS = 'min-w-[190px] space-y-1';
const POPUP_TITLE = 'font-display text-xs font-semibold text-ink';
const POPUP_LINE = 'text-2xs leading-relaxed text-dim';
const POPUP_META = 'font-mono text-[10px] text-faint';

// ------------------------------------------------------------------ alerts

/**
 * Open alerts only.
 *
 * A resolved alert is history, and leaving it on the map would make a handled
 * situation look like a live one. Status is filtered here with the same
 * `isOpen` helper the alerts table uses, so the two can never disagree.
 */
export function AlertsLayer({
  enabled,
  regions,
  version,
  onSelectRegion,
}: {
  enabled: boolean;
  regions: RegionIndex;
  version: number;
  onSelectRegion?: (id: number) => void;
}) {
  const alerts = useResource(
    (signal) => api.alerts({ limit: 200 }, signal),
    [version],
    { enabled },
  );
  if (!enabled || !alerts.data) return null;
  const open = alerts.data.alerts.filter((alert) => isOpen(alert.status));

  return (
    <>
      {open.map((alert: Alert) => {
        const region = regions.get(alert.region_id);
        if (!region) return null;
        const hex = severityPalette(alert.severity).hex;
        return (
          <Marker
            key={alert.id}
            position={[region.latitude, region.longitude]}
            icon={glyphIcon('triangle', hex, 13)}
            pane={paneName('alerts')}
            zIndexOffset={600}
            eventHandlers={onSelectRegion ? { click: () => onSelectRegion(alert.region_id) } : undefined}
          >
            <Tooltip direction="top" offset={[0, -8]}>
              {alert.severity} alert &middot; {alert.region_name ?? region.name}
            </Tooltip>
            <Popup>
              <div className={POPUP_CLASS}>
                <p className={POPUP_TITLE}>
                  {alert.severity} alert &middot; {formatScore(alert.risk_score)}
                </p>
                <p className={POPUP_LINE}>{alert.cause}</p>
                <p className={POPUP_LINE}>
                  <span className="text-faint">Action: </span>
                  {alert.recommended_action}
                </p>
                <p className={POPUP_META}>
                  {alert.alert_code} &middot; {alert.status} &middot; raised{' '}
                  {relativeTime(alert.created_at)}
                </p>
              </div>
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}

// ------------------------------------------------------- past landslides

export function EventsLayer({ enabled, version }: { enabled: boolean; version: number }) {
  const history = useResource(
    (signal) => api.history({ limit: 400 }, signal),
    [version],
    { enabled },
  );
  if (!enabled || !history.data) return null;

  return (
    <>
      {history.data.events.map((event) => (
        <Marker
          key={event.id}
          position={[event.latitude, event.longitude]}
          icon={glyphIcon('diamond', EVENT_SEVERITY_HEX[event.severity], 11)}
          pane={paneName('events')}
          zIndexOffset={300}
        >
          <Tooltip direction="top" offset={[0, -7]}>
            {formatDate(event.event_date)} &middot; {event.location}
          </Tooltip>
          <Popup>
            <div className={POPUP_CLASS}>
              <p className={POPUP_TITLE}>{event.location}</p>
              <p className={POPUP_LINE}>
                {EVENT_SEVERITY[event.severity]?.label ?? event.severity} landslide on{' '}
                {formatDate(event.event_date)}
                {event.trigger ? ` · ${event.trigger}` : ''}
              </p>
              {event.description && (
                <p className={POPUP_LINE}>{truncate(event.description, 160)}</p>
              )}
              <p className={POPUP_META}>
                rain {mm(event.rainfall_mm)} &middot; slope{' '}
                {event.slope_deg === null ? '—' : `${event.slope_deg}°`}
                {event.fatalities ? ` · ${formatCount(event.fatalities)} lives lost` : ''}
              </p>
              <p className={POPUP_META}>
                {event.event_id} &middot; source: {event.source}
              </p>
            </div>
          </Popup>
        </Marker>
      ))}
    </>
  );
}

// ----------------------------------------------------------- citizen reports

export function ReportsLayer({
  enabled,
  version,
}: {
  enabled: boolean;
  version: number;
}) {
  const reports = useResource(
    (signal) => api.reports({ limit: 200 }, signal),
    [version],
    { enabled },
  );
  if (!enabled || !reports.data) return null;

  return (
    <>
      {reports.data.reports.map((report: CitizenReport) => (
        <Marker
          key={report.id}
          position={[report.latitude, report.longitude]}
          icon={glyphIcon('teardrop', '#7FB2E5', 12)}
          pane={paneName('reports')}
          zIndexOffset={400}
        >
          <Tooltip direction="top" offset={[0, -8]}>
            Citizen report &middot; {report.location_text}
          </Tooltip>
          <Popup>
            <div className={POPUP_CLASS}>
              <p className={POPUP_TITLE}>{report.location_text}</p>
              <p className={POPUP_LINE}>
                {report.observation_type} &middot; reported severity {report.severity}
              </p>
              <p className={POPUP_LINE}>{truncate(report.description, 160)}</p>
              {report.image_analysis?.category_label && (
                <p className={POPUP_LINE}>
                  <span className="text-faint">Image screening: </span>
                  {report.image_analysis.category_label}
                  {' — decision support only, not a professional assessment.'}
                </p>
              )}
              <p className={POPUP_META}>
                {report.report_code} &middot; {report.status} &middot; observed{' '}
                {formatDate(report.observed_on)}
              </p>
            </div>
          </Popup>
        </Marker>
      ))}
    </>
  );
}

// ---------------------------------------------------------- virtual sensors

/**
 * One square per region, carrying the worst status among that region's
 * instruments, because five overlapping squares on one town is unreadable.
 *
 * Every popup here repeats that the readings are software-modelled. This layer
 * is the one most likely to be mistaken for a hardware sensor network, and the
 * label has to travel with the number.
 */
export function SensorsLayer({
  enabled,
  regions,
  version,
  onSelectRegion,
}: {
  enabled: boolean;
  regions: RegionIndex;
  version: number;
  onSelectRegion?: (id: number) => void;
}) {
  const network = useResource(
    (signal) => api.sensors({ limit_regions: 60 }, signal),
    [version],
    { enabled },
  );
  if (!enabled || !network.data) return null;

  const worst = new Map<number, SensorReading[]>();
  for (const sensor of network.data.sensors) {
    const bucket = worst.get(sensor.region_id);
    if (bucket) bucket.push(sensor);
    else worst.set(sensor.region_id, [sensor]);
  }

  const severity = (readings: SensorReading[]) => {
    if (readings.some((row) => row.status === 'ALARM')) return 'ALARM' as const;
    if (readings.some((row) => row.status === 'ELEVATED')) return 'ELEVATED' as const;
    if (readings.some((row) => row.status === 'NORMAL')) return 'NORMAL' as const;
    return 'OFFLINE' as const;
  };

  return (
    <>
      {Array.from(worst.entries()).map(([regionId, readings]) => {
        const region = regions.get(regionId);
        if (!region) return null;
        const status = severity(readings);
        return (
          <Marker
            key={regionId}
            position={[region.latitude, region.longitude]}
            icon={glyphIcon('square', SENSOR_STATUS_HEX[status], 11)}
            pane={paneName('sensors')}
            zIndexOffset={500}
            eventHandlers={onSelectRegion ? { click: () => onSelectRegion(regionId) } : undefined}
          >
            <Tooltip direction="top" offset={[0, -7]}>
              Simulated sensors &middot; {region.name} &middot; {SENSOR_STATUS[status]?.label}
            </Tooltip>
            <Popup>
              <div className={POPUP_CLASS}>
                <p className={POPUP_TITLE}>{region.name} &middot; simulated instruments</p>
                <ul className="space-y-0.5">
                  {readings.map((row) => (
                    <li key={row.sensor_code} className="flex items-baseline justify-between gap-2">
                      <span className="text-2xs text-dim">{row.label}</span>
                      <span
                        className="tnum shrink-0 font-mono text-2xs"
                        style={{ color: SENSOR_STATUS_HEX[row.status] }}
                      >
                        {formatReading(row.reading, row.unit)}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className={POPUP_META}>
                  SIMULATED SENSOR DATA &middot; software model, no hardware &middot;{' '}
                  {relativeTime(readings[0]?.recorded_at ?? null)}
                </p>
              </div>
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}
// ------------------------------------------------------------ alert radius

/**
 * A ground circle around every region at or above the HIGH threshold.
 *
 * The radius is an indicative warning footprint scaled by how far past the
 * threshold the score sits - 8 km at the line, 30 km at 100. It is drawn in
 * metres on the ground rather than pixels, so it stays honest as the operator
 * zooms in, and it is explicitly not a modelled runout: the popup and the
 * legend both call it indicative.
 */
export function HaloLayer({
  enabled,
  points,
  thresholds,
}: {
  enabled: boolean;
  points: RiskPoint[];
  thresholds: { high: number; critical: number };
}) {
  if (!enabled) return null;
  const flagged = points.filter((point) => point.risk_score >= thresholds.high);

  return (
    <>
      {flagged.map((point) => {
        const span = Math.max(1, 100 - thresholds.high);
        const past = Math.min(1, (point.risk_score - thresholds.high) / span);
        const hex = RISK_HEX[point.risk_level];
        return (
          <Circle
            key={point.region.id}
            center={[point.region.latitude, point.region.longitude]}
            radius={8000 + past * 22000}
            interactive={false}
            pane={paneName('halo')}
            pathOptions={{
              color: hex,
              weight: 1,
              opacity: 0.5,
              fillColor: hex,
              fillOpacity: 0.07,
              dashArray: '3 4',
            }}
          />
        );
      })}
    </>
  );
}
// --------------------------------------------------------- people exposed

/**
 * Population as circle area, deliberately in a neutral colour.
 *
 * This layer answers a different question from the risk layer - "how many
 * people are in the way" - and it must not be read as a second opinion on
 * danger. So it is grey-blue, never on the risk ramp, and the radius follows
 * the square root of the population because area is what the eye compares.
 */
export function ExposureLayer({
  enabled,
  points,
}: {
  enabled: boolean;
  points: RiskPoint[];
}) {
  if (!enabled) return null;
  const withPeople = points.filter(
    (point) => (point.region.population_exposed ?? 0) > 0,
  );

  return (
    <>
      {withPeople.map((point) => (
        <Circle
          key={point.region.id}
          center={[point.region.latitude, point.region.longitude]}
          radius={Math.sqrt(point.region.population_exposed ?? 0) * 62}
          pane={paneName('exposure')}
          pathOptions={{
            color: '#7FB2E5',
            weight: 1,
            opacity: 0.35,
            fillColor: '#7FB2E5',
            fillOpacity: 0.1,
          }}
        >
          <Tooltip direction="top">
            {people(point.region.population_exposed)} exposed &middot; {point.region.name}
          </Tooltip>
        </Circle>
      ))}
    </>
  );
}
// ------------------------------------------------------------ region names

/**
 * Place names beside the discs.
 *
 * Non-interactive on purpose: a label is the widest thing on the map and, left
 * clickable, it would intercept clicks meant for the region next to it. Off by
 * default because 74 names at national zoom is a wall of text.
 */
export function LabelsLayer({
  enabled,
  points,
  zoom,
}: {
  enabled: boolean;
  points: RiskPoint[];
  zoom: number;
}) {
  if (!enabled) return null;

  return (
    <>
      {points.map((point) => (
        <Marker
          key={point.region.id}
          position={[point.region.latitude, point.region.longitude]}
          icon={labelIcon(point.region.name, markerRadius(point.risk_score, zoom))}
          pane={paneName('labels')}
          interactive={false}
          keyboard={false}
          zIndexOffset={700}
        />
      ))}
    </>
  );
}

/** Shown under the map, so the reader is told what they can and cannot conclude. */
export function overlayFootnote(mode: string): string {
  return `Markers are placed at region centroids, not at slope scale. Alert radii are indicative warning footprints, not modelled runout. Basemap tiles are third-party cartography. Risk layer: ${mode}.`;
}

export function formatSensorTime(value: string | null): string {
  return value ? formatDateTime(value) : '—';
}



