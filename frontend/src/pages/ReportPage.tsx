/**
 * The citizen reporting portal.
 *
 * Filing is deliberately open. Someone who has just watched a crack open across
 * a road should not have to create an account before they can say so, and the
 * backend agrees: `POST /api/citizen-report` accepts anonymous callers while
 * `GET` on the same path needs the officer role. That asymmetry shapes this
 * screen - a citizen sees receipts for what they filed in this session and never
 * the national queue, because asking for it would only earn a 403.
 *
 * Three things here are deliberate.
 *
 * The dropdowns are fetched from `/api/citizen-report/options` rather than
 * written out here. Those same values are a `Literal` in `CitizenReportIn`, and a
 * form holding its own copy will eventually offer a choice the validator
 * rejects. The hint beside each choice is the server's wording too.
 *
 * The location is picked on a map. Nobody standing on a hillside knows their
 * latitude, and a report without a usable position cannot be routed, mapped or
 * checked against a slope. Clicking the map, choosing a monitored region and
 * sharing the browser's location all fill the same two numbers, which stay
 * visible and editable. The nearest region is computed on this screen with the
 * same flat-earth distance and the same radius the backend snaps by, so the
 * portal can say which officer's queue the report will reach *before* it is
 * filed - and can say plainly when it will reach none.
 *
 * The photograph screening is offered rather than applied quietly, and the
 * disclaimer travels with it verbatim as served. It is a deterministic
 * image-feature heuristic, not a trained network: decision support that does not
 * replace assessment by a qualified engineer or a site visit.
 */
import {
  Camera,
  CheckCircle2,
  ClipboardList,
  Crosshair,
  MapPin,
  ScanLine,
  Send,
  ShieldAlert,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Circle, MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import { PageHeader } from '../components/AppShell';
import { Chip, ReportStatusChip } from '../components/Chips';
import { Panel, ResourceBody } from '../components/Panel';
import { KeyValue, Meter } from '../components/Readouts';
import { RegionSelect, useRegions } from '../components/RegionPicker';
import { EmptyState, InlineError, Spinner } from '../components/States';
import {
  coords,
  decimal,
  fileSize,
  formatDateTime,
  km as formatKm,
  percentPoints,
  truncate,
} from '../lib/format';
import { cx } from '../lib/risk';
import { INDIA_CENTER, INDIA_ZOOM, basemapFor } from '../maps/basemaps';
import { glyphIcon } from '../maps/markers';
import { api, asApiError, uploadUrl, type ApiError } from '../services/api';
import { usePlatform } from '../state/PlatformContext';
import { useResource } from '../state/useResource';
import type {
  ImageAnalysisResult,
  OptionChoice,
  Region,
  ReportOptionsResponse,
  ReportSubmitResponse,
} from '../types/api';

/** The theme accent. The pin marks a position, not a risk reading. */
const PIN_HEX = '#48C9E6';

/** Degrees to kilometres, near enough over a 60 km radius. */
const KM_PER_DEGREE = 111.0;

/** How severe the reporter says it is. Not a model output, so not a risk band. */
const SEVERITY_TONE: Record<string, string> = {
  LOW: 'text-risk-low',
  MEDIUM: 'text-risk-moderate',
  HIGH: 'text-risk-high',
};

interface Snap {
  /** The closest monitored region, whatever the distance. */
  nearest: Region | null;
  /** The closest one *inside* the radius - what the backend would snap to. */
  region: Region | null;
  km: number;
}

/** A request to move the map, made only by controls that are not the map itself. */
interface FlyTo {
  lat: number;
  lon: number;
  zoom?: number;
  /** Fresh on every request, so a repeat of the same coordinates still moves. */
  key: number;
}
/**
 * Distance from a point to a region centroid, in kilometres.
 *
 * Mirrors `report_service.nearest_region`: a local flat-earth approximation
 * rather than a great circle. Over 60 km the error is metres, and matching the
 * backend's arithmetic matters more here than matching the globe - this screen
 * promises which queue a report will land in, and it must not disagree with the
 * code that actually routes it.
 */
function distanceKm(lat: number, lon: number, region: Region): number {
  const dy = (region.latitude - lat) * KM_PER_DEGREE;
  const dx = (region.longitude - lon) * KM_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/** Nearest monitored region, and whether it is close enough to route to. */
function nearestRegion(regions: Region[], lat: number, lon: number, radiusKm: number): Snap {
  let best: Region | null = null;
  let bestKm = Number.POSITIVE_INFINITY;
  for (const region of regions) {
    const away = distanceKm(lat, lon, region);
    if (away < bestKm) {
      best = region;
      bestKm = away;
    }
  }
  if (best === null) return { nearest: null, region: null, km: Number.POSITIVE_INFINITY };
  return { nearest: best, region: bestKm <= radiusKm ? best : null, km: bestKm };
}

function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}
/**
 * The server's complaint about one field, or the standing hint when it has none.
 *
 * A 422 from FastAPI arrives as a list of `loc`/`msg` pairs, which the API client
 * flattens into `ApiError.fields` keyed by field name. Showing each message under
 * its own input is the difference between "invalid input" and "the description
 * needs at least 10 characters".
 */
function FieldNote({
  error,
  field,
  hint,
}: {
  error: ApiError | null;
  field: string;
  hint?: ReactNode;
}) {
  const message = error?.fields[field];
  if (message) {
    return <p className="mt-1 text-2xs leading-tight text-risk-high">{message}</p>;
  }
  if (!hint) return null;
  return <p className="mt-1 text-2xs leading-tight text-faint">{hint}</p>;
}

/** Turns a click anywhere on the map into a position. */
function ClickToPlace({ onPlace }: { onPlace: (lat: number, lon: number) => void }) {
  useMapEvents({
    click(event) {
      onPlace(event.latlng.lat, event.latlng.lng);
    },
  });
  return null;
}

/**
 * Moves the view when something other than the map asks it to.
 *
 * Keyed on a whole object rather than on the coordinates, so a map click - which
 * sets coordinates but no target - never yanks the view out from under the
 * person who just clicked.
 */
function Recentre({ target }: { target: FlyTo | null }) {
  const map = useMap();
  useEffect(() => {
    if (!target) return;
    map.setView([target.lat, target.lon], target.zoom ?? Math.max(map.getZoom(), 9));
  }, [target, map]);
  return null;
}
/**
 * The location picker.
 *
 * A small map with one job: put a pin where the reporter is standing. The dashed
 * ring is the routing radius, drawn so a reporter in a remote valley can see for
 * themselves that no monitored region is close - which is a real answer, not a
 * failure. The teal diamond, when it appears, is the region the report will be
 * filed against.
 */
function PlacePicker({
  lat,
  lon,
  placed,
  snap,
  radiusKm,
  target,
  onPlace,
}: {
  lat: number;
  lon: number;
  placed: boolean;
  snap: Snap;
  radiusKm: number;
  target: FlyTo | null;
  onPlace: (lat: number, lon: number) => void;
}) {
  const basemap = basemapFor('dark');
  return (
    <div className="space-y-1.5">
      <div className="relative h-60 overflow-hidden rounded-panel border border-hairline sm:h-72">
        <MapContainer
          center={INDIA_CENTER}
          zoom={INDIA_ZOOM}
          minZoom={4}
          maxZoom={18}
          scrollWheelZoom
          attributionControl
          className="absolute inset-0 h-full w-full bg-ground"
        >
          <TileLayer
            url={basemap.url}
            attribution={basemap.attribution}
            maxZoom={18}
            maxNativeZoom={basemap.maxZoom}
          />
          <ClickToPlace onPlace={onPlace} />
          <Recentre target={target} />
          {placed && (
            <Circle
              center={[lat, lon]}
              radius={radiusKm * 1000}
              pathOptions={{
                color: PIN_HEX,
                weight: 1,
                opacity: 0.35,
                fillOpacity: 0.04,
                dashArray: '4 5',
              }}
            />
          )}
          {placed && snap.region && (
            <Marker
              position={[snap.region.latitude, snap.region.longitude]}
              icon={glyphIcon('diamond', '#3FB8A0', 12)}
            />
          )}
          {placed && <Marker position={[lat, lon]} icon={glyphIcon('teardrop', PIN_HEX, 16)} />}
        </MapContainer>
      </div>
      <p className="text-2xs leading-relaxed text-faint">
        {placed
          ? `Pin at ${coords(lat, lon)}. The dashed ring is the ${formatKm(radiusKm, 0)} routing radius; the diamond is the monitored region inside it.`
          : 'Click anywhere on the map to drop a pin. Tiles come from a public basemap and are cartography, not satellite imagery.'}
      </p>
    </div>
  );
}
/**
 * What the screening heuristic saw, and what it refuses to claim.
 *
 * `confidence` arrives as percentage points capped at 80, and the caption says
 * what that number is a measure of - the margin between the top two categories,
 * not a probability that the slope will fail. The disclaimer is printed as
 * served rather than paraphrased, because a paraphrase is where a hedge quietly
 * turns into a verdict.
 */
function ScreeningCard({ result }: { result: ImageAnalysisResult }) {
  return (
    <div className="space-y-2 rounded-panel border border-hairline bg-raised/40 p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-display text-xs font-semibold text-ink">{result.category_label}</p>
        <span className="tnum font-mono text-2xs text-dim">{percentPoints(result.confidence)}</span>
      </div>
      <Meter value={result.confidence} hex={PIN_HEX} label="Screening confidence" />
      {result.features.length > 0 && (
        <ul className="space-y-1">
          {result.features.map((feature) => (
            <li key={feature} className="flex gap-1.5 text-2xs leading-relaxed text-dim">
              <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-faint" aria-hidden />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      )}
      {result.alternatives && result.alternatives.length > 0 && (
        <p className="text-2xs leading-relaxed text-faint">
          Next closest:{' '}
          {result.alternatives
            .map((other) => `${other.category} (${decimal(other.score, 2)})`)
            .join(', ')}
          . Those are raw heuristic scores on their own scale, not percentages.
        </p>
      )}
      <p className="border-t border-hairline pt-2 text-2xs leading-relaxed text-dim">
        <span className="text-ink">Recommended:</span> {result.recommendation}
      </p>
      <p className="text-2xs leading-relaxed text-faint">{result.method}</p>
      <p className="flex items-start gap-1.5 text-2xs leading-relaxed text-risk-moderate">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{result.disclaimer}</span>
      </p>
    </div>
  );
}
/**
 * The receipt for a report that has just been filed.
 *
 * The acknowledgement sentence is the server's, not this screen's, so what the
 * reporter is told about routing is what actually happened to their report. The
 * screening shown here is the one the backend ran on the stored photograph -
 * attaching an image always screens it, which is why this appears whether or not
 * the reporter asked for a preview.
 */
function Receipt({
  report,
  onShowOnMap,
}: {
  report: ReportSubmitResponse;
  onShowOnMap: () => void;
}) {
  const analysis = report.image_analysis;
  const photo = uploadUrl(report.image_url);
  return (
    <Panel
      className="mb-3 border-risk-verylow/40"
      title="Report filed"
      note={report.report_code}
      right={<ReportStatusChip status={report.status} />}
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]">
        <div className="min-w-0 space-y-2">
          <p className="flex items-start gap-2 text-xs leading-relaxed text-ink">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-risk-verylow" aria-hidden />
            <span>{report.acknowledgement}</span>
          </p>
          <div className="rule" />
          <KeyValue label="Filed" value={formatDateTime(report.created_at)} />
          <KeyValue
            label="Queue"
            value={report.region_name ?? 'Manual routing'}
            title={
              report.region_id === null
                ? 'No monitored region was inside the routing radius, so no officer owns it yet.'
                : 'The officer responsible for this region sees it as NEW.'
            }
          />
          <KeyValue label="Position" value={coords(report.latitude, report.longitude)} />
          <KeyValue label="Reported as" value={`${report.observation_type} · ${report.severity}`} />
          <p className="text-2xs leading-relaxed text-faint">
            Nothing here auto-verifies and nothing auto-raises an alert. The report is evidence for
            an officer, not an input to the model — treating an unverified photograph as ground
            truth is how an early-warning system loses its credibility. Keep the code above if you
            want to ask about this report later.
          </p>
          {report.region_id !== null && (
            <button type="button" className="btn btn-ghost" onClick={onShowOnMap}>
              <MapPin className="h-3.5 w-3.5" aria-hidden />
              Show {report.region_name} on the map
            </button>
          )}
        </div>
        <div className="min-w-0 space-y-2">
          {photo && (
            <img
              src={photo}
              alt={`Photograph filed with report ${report.report_code}`}
              className="h-32 w-full rounded-panel border border-hairline object-cover"
            />
          )}
          {analysis?.category_label ? (
            <div className="space-y-1.5 rounded-panel border border-hairline bg-raised/40 p-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <p className="font-display text-xs font-semibold text-ink">
                  {analysis.category_label}
                </p>
                <span className="tnum font-mono text-2xs text-dim">
                  {percentPoints(analysis.confidence ?? 0)}
                </span>
              </div>
              <p className="text-2xs leading-relaxed text-dim">{analysis.recommendation}</p>
              {analysis.disclaimer && (
                <p className="text-2xs leading-relaxed text-risk-moderate">{analysis.disclaimer}</p>
              )}
            </div>
          ) : (
            <p className="text-2xs leading-relaxed text-faint">
              {report.has_image
                ? 'The photograph was stored but could not be screened, which changes nothing about the report itself.'
                : 'No photograph was attached, so the report stands on its description. A photograph is the single most useful thing to add.'}
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}

/** What makes a report useful, and what this portal is not. */
function Guidance({
  radiusKm,
  imageNote,
  maxMb,
  acceptedTypes,
}: {
  radiusKm: number;
  imageNote: string | null;
  maxMb: number;
  acceptedTypes: string[];
}) {
  return (
    <Panel title="Before you file">
      <div className="space-y-2.5">
        <p className="flex items-start gap-2 text-2xs leading-relaxed text-risk-high">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            This is not an emergency service. If anyone is in danger right now, call local emergency
            services or your district control room first — then file this, so the record exists.
          </span>
        </p>
        <div className="rule" />
        <ul className="space-y-2 text-2xs leading-relaxed text-dim">
          <li>
            <span className="text-ink">Describe what you can see, not what it might mean.</span> “A
            crack about 20 m long across the upper carriageway, wider than it was yesterday” is worth
            far more to an officer than “landslide risk here”.
          </li>
          <li>
            <span className="text-ink">Attach a photograph if you can.</span>{' '}
            {imageNote ?? 'A photograph is the single most useful thing you can add to a report.'}{' '}
            {acceptedTypes.join(', ')}, up to {decimal(maxMb, 0)} MB.
          </li>
          <li>
            <span className="text-ink">Put the pin close to what you saw.</span> A position within{' '}
            {formatKm(radiusKm, 0)} of a monitored region reaches that officer’s queue
            automatically. Further out is still recorded, and routed by hand.
          </li>
          <li>
            <span className="text-ink">A name and phone number are optional.</span> They only let an
            officer come back with one question. Without them the report still counts.
          </li>
        </ul>
        <p className="border-t border-hairline pt-2 text-2xs leading-relaxed text-faint">
          Reports are stored exactly as filed and carry the LIVE DATA label: they are human
          observations, not model output and not demo data. They never move a risk score by
          themselves.
        </p>
      </div>
    </Panel>
  );
}

/**
 * The observation types, as cards rather than a dropdown.
 *
 * The server ships a hint with each choice and the hint is the whole point: a
 * reporter deciding between "ground crack" and "soil movement" needs the
 * distinction spelled out, and it is spelled out once, on the server, for both
 * this form and the API documentation.
 */
function ChoiceCards({
  choices,
  value,
  onChange,
  disabled,
}: {
  choices: OptionChoice[];
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      {choices.map((choice) => {
        const active = choice.value === value;
        return (
          <button
            key={choice.value}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(choice.value)}
            className={cx(
              'rounded-panel border px-2.5 py-2 text-left transition-colors disabled:opacity-50',
              active
                ? 'border-accent/60 bg-accent/10'
                : 'border-hairline bg-raised/30 hover:border-accent/40',
            )}
          >
            <span className={cx('block text-xs font-semibold', active ? 'text-accent' : 'text-ink')}>
              {choice.label}
            </span>
            {choice.hint && (
              <span className="mt-0.5 block text-2xs leading-tight text-faint">{choice.hint}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default function ReportPage() {
  const { maxUploadMb, capabilities, refresh, version, selectedRegionId, selectRegion } =
    usePlatform();
  const navigate = useNavigate();
  const regions = useRegions();
  const options = useResource<ReportOptionsResponse>((signal) => api.reportOptions(signal), [
    version,
  ]);

  const [regionId, setRegionId] = useState<number | null>(null);
  const [latText, setLatText] = useState('');
  const [lonText, setLonText] = useState('');
  const [locationText, setLocationText] = useState('');
  const [observationType, setObservationType] = useState('');
  const [severity, setSeverity] = useState('');
  const [observedOn, setObservedOn] = useState(todayIso());
  const [description, setDescription] = useState('');
  const [reporterName, setReporterName] = useState('');
  const [reporterPhone, setReporterPhone] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [target, setTarget] = useState<FlyTo | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [filed, setFiled] = useState<ReportSubmitResponse[]>([]);

  const [screening, setScreening] = useState<ImageAnalysisResult | null>(null);
  const [screenBusy, setScreenBusy] = useState(false);
  const [screenError, setScreenError] = useState<ApiError | null>(null);

  const [geoBusy, setGeoBusy] = useState(false);
  const [geoNote, setGeoNote] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement | null>(null);
  /** So a region selected on another screen prefills this form exactly once. */
  const prefilled = useRef(false);

  const served = options.data;
  const radiusKm = served?.snap_radius_km ?? 60;
  const acceptedTypes = served?.accepted_image_types ?? ['.jpg', '.jpeg', '.png', '.webp'];
  const rows = regions.data?.regions ?? [];
  // The defaults come from the served options rather than from constants here,
  // and only fill a field the reporter has not touched.
  useEffect(() => {
    if (!served) return;
    setObservationType((current) => current || served.observation_types[0]?.value || '');
    setSeverity(
      (current) => current || served.severities[1]?.value || served.severities[0]?.value || '',
    );
  }, [served]);

  function applyRegion(region: Region) {
    setRegionId(region.id);
    setLatText(region.latitude.toFixed(4));
    setLonText(region.longitude.toFixed(4));
    setTarget({ lat: region.latitude, lon: region.longitude, zoom: 10, key: Date.now() });
    setLocationText((current) =>
      current.trim() ? current : `${region.name}, ${region.district}, ${region.state}`,
    );
  }

  // Arriving here with a region already selected on the map or forecast screen
  // starts the form on that region instead of on an empty map.
  useEffect(() => {
    if (prefilled.current || selectedRegionId === null) return;
    const hit = (regions.data?.regions ?? []).find((row) => row.id === selectedRegionId);
    if (!hit) return;
    prefilled.current = true;
    applyRegion(hit);
  }, [selectedRegionId, regions.data]);

  function chooseRegion(id: number | null) {
    if (id === null) {
      setRegionId(null);
      return;
    }
    const hit = rows.find((row) => row.id === id);
    if (hit) applyRegion(hit);
    else setRegionId(id);
  }

  /** A map click moves the pin but never the view. */
  function place(lat: number, lon: number) {
    setLatText(lat.toFixed(4));
    setLonText(lon.toFixed(4));
    setGeoNote(null);
  }
  /**
   * The browser's own location, asked for only when the button is pressed.
   *
   * No geolocation happens on load: a reporting portal that quietly reads your
   * position the moment you open it deserves the permission prompt it gets.
   */
  function shareLocation() {
    if (!('geolocation' in navigator)) {
      setGeoNote('This browser does not offer a location.');
      return;
    }
    setGeoBusy(true);
    setGeoNote(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setGeoBusy(false);
        const { latitude, longitude } = position.coords;
        setLatText(latitude.toFixed(4));
        setLonText(longitude.toFixed(4));
        setTarget({ lat: latitude, lon: longitude, zoom: 12, key: Date.now() });
      },
      (failure) => {
        setGeoBusy(false);
        setGeoNote(
          failure.message || 'The browser would not share a location. Place the pin by hand.',
        );
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  const lat = Number(latText);
  const lon = Number(lonText);
  const latOk = latText.trim() !== '' && Number.isFinite(lat) && lat >= -90 && lat <= 90;
  const lonOk = lonText.trim() !== '' && Number.isFinite(lon) && lon >= -180 && lon <= 180;
  const placed = latOk && lonOk;

  /** Where this report will land, worked out the same way the backend works it out. */
  const snap = useMemo<Snap>(() => {
    if (!placed) return { nearest: null, region: null, km: Number.POSITIVE_INFINITY };
    return nearestRegion(regions.data?.regions ?? [], lat, lon, radiusKm);
  }, [placed, lat, lon, radiusKm, regions.data]);

  const chosen = regionId === null ? null : (rows.find((row) => row.id === regionId) ?? null);
  /** An explicit region wins: `report_service.create` only snaps when none was sent. */
  const destination = chosen ?? snap.region;
  // A local preview, revoked when it is replaced - an object URL held for the
  // life of the tab is a leak, and a phone photograph is not small.
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  const extension = file ? extensionOf(file.name) : '';
  const typeOk = !file || acceptedTypes.includes(extension);
  const sizeOk = !file || file.size <= maxUploadMb * 1024 * 1024;

  const trimmedLocation = locationText.trim();
  const trimmedDescription = description.trim();
  const ready =
    placed &&
    trimmedLocation.length >= 4 &&
    trimmedLocation.length <= 200 &&
    trimmedDescription.length >= 10 &&
    trimmedDescription.length <= 3000 &&
    observationType !== '' &&
    severity !== '' &&
    typeOk &&
    sizeOk;

  function clearPhoto() {
    setFile(null);
    setScreening(null);
    setScreenError(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  /** Screening a photograph files nothing. It is a look before you send. */
  async function screen() {
    if (!file || !typeOk || !sizeOk) return;
    setScreenBusy(true);
    setScreenError(null);
    try {
      setScreening(await api.analyseImage(file));
    } catch (cause) {
      setScreenError(asApiError(cause, '/image-analysis'));
    } finally {
      setScreenBusy(false);
    }
  }

  /**
   * Multipart, because the photograph is part of the report rather than a
   * follow-up step. Optional fields are omitted rather than sent empty, so the
   * backend stores a null instead of a blank string.
   */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);

    const form = new FormData();
    form.append('location_text', trimmedLocation);
    form.append('latitude', String(lat));
    form.append('longitude', String(lon));
    form.append('observation_type', observationType);
    form.append('severity', severity);
    form.append('description', trimmedDescription);
    if (reporterName.trim()) form.append('reporter_name', reporterName.trim());
    if (reporterPhone.trim()) form.append('reporter_phone', reporterPhone.trim());
    if (observedOn) form.append('observed_on', observedOn);
    if (regionId !== null) form.append('region_id', String(regionId));
    if (file) form.append('image', file);

    try {
      const result = await api.submitReport(form);
      setFiled((current) => [result, ...current]);
      setDescription('');
      clearPhoto();
      // The officer desk badge and the dashboard's report count both just
      // changed, and neither of them knows it yet.
      refresh();
    } catch (cause) {
      setError(asApiError(cause, '/citizen-report'));
    } finally {
      setBusy(false);
    }
  }

  const receipt = filed[0] ?? null;
  return (
    <div>
      <PageHeader
        title="Report what you can see"
        lead="A photograph and a position from someone standing on the road are the only ground truth this platform gets. Filing needs no account; reading the queue does."
        right={
          <>
            <Chip
              className="border-risk-verylow/45 bg-risk-verylow/10 text-risk-verylow"
              title="A citizen report is a human observation, stored exactly as filed. It is not model output, and not demo data."
            >
              LIVE DATA
            </Chip>
            {capabilities.can_review_reports && (
              <button type="button" className="btn btn-ghost" onClick={() => navigate('/officer')}>
                <ClipboardList className="h-3.5 w-3.5" aria-hidden />
                Officer desk
              </button>
            )}
          </>
        }
      />

      {receipt && (
        <Receipt
          report={receipt}
          onShowOnMap={() => {
            if (receipt.region_id !== null) selectRegion(receipt.region_id);
            navigate('/map');
          }}
        />
      )}

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,23rem)]">
        <div className="min-w-0 space-y-3">
          <Panel title="Where" note="Click the map, choose a region, or type the coordinates">
            <div className="space-y-3">
              <PlacePicker
                lat={lat}
                lon={lon}
                placed={placed}
                snap={snap}
                radiusKm={radiusKm}
                target={target}
                onPlace={place}
              />
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="min-w-0">
                  <label className="label" htmlFor="report-region">
                    Monitored region
                  </label>
                  <RegionSelect
                    id="report-region"
                    value={regionId}
                    onChange={chooseRegion}
                    blankLabel="Let the position decide"
                    className="py-1 text-xs"
                  />
                  <FieldNote
                    error={error}
                    field="region_id"
                    hint="Choosing one files the report against that region whatever the distance, and moves the map there."
                  />
                </div>
                <div className="min-w-0">
                  <span className="label">From this device</span>
                  <button
                    type="button"
                    className="btn btn-ghost w-full py-1.5 text-xs"
                    onClick={shareLocation}
                    disabled={geoBusy}
                  >
                    {geoBusy ? (
                      <Spinner className="h-3.5 w-3.5" />
                    ) : (
                      <Crosshair className="h-3.5 w-3.5" aria-hidden />
                    )}
                    {geoBusy ? 'Asking the browser…' : 'Use my location'}
                  </button>
                  <p
                    className={cx(
                      'mt-1 text-2xs leading-tight',
                      geoNote ? 'text-risk-moderate' : 'text-faint',
                    )}
                  >
                    {geoNote ?? 'Asked for only when you press it, never on load.'}
                  </p>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="min-w-0">
                  <label className="label" htmlFor="report-lat">
                    Latitude
                  </label>
                  <input
                    id="report-lat"
                    className="field py-1 text-xs tnum"
                    inputMode="decimal"
                    placeholder="30.7280"
                    value={latText}
                    onChange={(event) => setLatText(event.target.value)}
                  />
                  <FieldNote
                    error={error}
                    field="latitude"
                    hint={latOk ? 'Between −90 and 90.' : 'Needs a number between −90 and 90.'}
                  />
                </div>
                <div className="min-w-0">
                  <label className="label" htmlFor="report-lon">
                    Longitude
                  </label>
                  <input
                    id="report-lon"
                    className="field py-1 text-xs tnum"
                    inputMode="decimal"
                    placeholder="79.0620"
                    value={lonText}
                    onChange={(event) => setLonText(event.target.value)}
                  />
                  <FieldNote
                    error={error}
                    field="longitude"
                    hint={lonOk ? 'Between −180 and 180.' : 'Needs a number between −180 and 180.'}
                  />
                </div>
              </div>
              <div className="min-w-0">
                <label className="label" htmlFor="report-place">
                  Describe the place
                </label>
                <input
                  id="report-place"
                  className="field py-1 text-xs"
                  placeholder="NH-58 near Chamba, above the second hairpin"
                  maxLength={200}
                  value={locationText}
                  onChange={(event) => setLocationText(event.target.value)}
                />
                <FieldNote
                  error={error}
                  field="location_text"
                  hint="A landmark, road number or village name — whatever would help someone find the spot. 4 to 200 characters."
                />
              </div>
              <p className="rounded-panel bg-raised/60 px-3 py-2 text-2xs leading-relaxed text-muted">
                {!placed ? (
                  <>
                    Drop a pin before filing. Without a position the report cannot be routed to a
                    region, drawn on the map, or checked against a slope.
                  </>
                ) : chosen ? (
                  <>
                    This will be filed against{' '}
                    <span className="text-ink">{chosen.name}</span> because you picked that region,
                    whatever the distance — {formatKm(distanceKm(lat, lon, chosen), 1)} from your
                    pin. It reaches the officer queue for {chosen.district}, {chosen.state}.
                  </>
                ) : snap.region ? (
                  <>
                    Nothing chosen, so the position decides: this reaches{' '}
                    <span className="text-ink">{snap.region.name}</span>, the nearest monitored
                    region at {formatKm(snap.km, 1)} — inside the {formatKm(radiusKm, 0)} routing
                    radius drawn on the map.
                  </>
                ) : snap.nearest ? (
                  <>
                    No monitored region is within {formatKm(radiusKm, 0)} of this pin — the nearest,{' '}
                    <span className="text-ink">{snap.nearest.name}</span>, is{' '}
                    {formatKm(snap.km, 0)} away. The report is still stored, and queued for manual
                    routing rather than dropped.
                  </>
                ) : (
                  <>
                    No regions are loaded yet, so routing cannot be worked out on this screen. The
                    report is still stored, and the backend will match it or queue it for manual
                    routing.
                  </>
                )}
              </p>
            </div>
          </Panel>
          <Panel title="What you saw" note="The dropdowns come from the API, not from this screen">
            <ResourceBody resource={options}>
              {(servedOptions) => (
                <form className="space-y-3" onSubmit={submit}>
                  <div className="min-w-0">
                    <span className="label">Type of observation</span>
                    <ChoiceCards
                      choices={servedOptions.observation_types}
                      value={observationType}
                      onChange={setObservationType}
                      disabled={busy}
                    />
                    <FieldNote
                      error={error}
                      field="observation_type"
                      hint="Pick the closest match. An officer re-reads every report anyway."
                    />
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_11rem]">
                    <div className="min-w-0">
                      <span className="label">How urgent does it look?</span>
                      <div className="flex flex-wrap gap-1.5">
                        {servedOptions.severities.map((choice) => {
                          const active = choice.value === severity;
                          return (
                            <button
                              key={choice.value}
                              type="button"
                              aria-pressed={active}
                              disabled={busy}
                              onClick={() => setSeverity(choice.value)}
                              className={cx(
                                'rounded-panel border px-2.5 py-1.5 text-2xs font-semibold transition-colors disabled:opacity-50',
                                active
                                  ? 'border-current bg-raised/70'
                                  : 'border-hairline bg-raised/30 hover:border-current',
                                SEVERITY_TONE[choice.value] ?? 'text-muted',
                              )}
                            >
                              {choice.label}
                            </button>
                          );
                        })}
                      </div>
                      <FieldNote
                        error={error}
                        field="severity"
                        hint="Your judgement of the risk to people or the road right now, not a model output."
                      />
                    </div>
                    <div className="min-w-0">
                      <label className="label" htmlFor="report-date">
                        When did you see it?
                      </label>
                      <input
                        id="report-date"
                        type="date"
                        className="field py-1 text-xs"
                        max={todayIso()}
                        value={observedOn}
                        onChange={(event) => setObservedOn(event.target.value)}
                      />
                      <FieldNote
                        error={error}
                        field="observed_on"
                        hint="Defaults to today. It cannot be in the future."
                      />
                    </div>
                  </div>
                  <div className="min-w-0">
                    <label className="label" htmlFor="report-description">
                      What is happening
                    </label>
                    <textarea
                      id="report-description"
                      className="field min-h-[7rem] py-1.5 text-xs leading-relaxed"
                      maxLength={3000}
                      placeholder="How wide is the crack, how long, is it growing, is water coming out of the slope, is the road still usable, how many houses are below it…"
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                    />
                    <div className="mt-1 flex items-baseline justify-between gap-3">
                      <FieldNote
                        error={error}
                        field="description"
                        hint="Measurements and landmarks are worth more than adjectives. 10 to 3000 characters."
                      />
                      <span
                        className={cx(
                          'tnum shrink-0 text-2xs',
                          trimmedDescription.length < 10 ? 'text-risk-moderate' : 'text-faint',
                        )}
                      >
                        {trimmedDescription.length}/3000
                      </span>
                    </div>
                  </div>
                  <div className="rule" />
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="min-w-0">
                      <label className="label" htmlFor="report-name">
                        Your name <span className="text-faint">(optional)</span>
                      </label>
                      <input
                        id="report-name"
                        className="field py-1 text-xs"
                        maxLength={128}
                        placeholder="Left blank files anonymously"
                        value={reporterName}
                        onChange={(event) => setReporterName(event.target.value)}
                      />
                      <FieldNote error={error} field="reporter_name" hint={null} />
                    </div>
                    <div className="min-w-0">
                      <label className="label" htmlFor="report-phone">
                        Phone <span className="text-faint">(optional)</span>
                      </label>
                      <input
                        id="report-phone"
                        className="field py-1 text-xs tnum"
                        maxLength={24}
                        inputMode="tel"
                        placeholder="Only if an officer may call you back"
                        value={reporterPhone}
                        onChange={(event) => setReporterPhone(event.target.value)}
                      />
                      <FieldNote error={error} field="reporter_phone" hint={null} />
                    </div>
                  </div>
                  <p className="text-2xs leading-relaxed text-faint">
                    Both are optional and only reach the officer reviewing the report. A report with
                    no name is treated the same as one with a name — it just cannot be followed up
                    with you.
                  </p>
                  <button
                    type="submit"
                    className="btn btn-accent w-full py-1.5 text-xs"
                    disabled={!ready || busy}
                  >
                    {busy ? (
                      <Spinner className="h-3.5 w-3.5" />
                    ) : (
                      <Send className="h-3.5 w-3.5" aria-hidden />
                    )}
                    {busy
                      ? 'Filing…'
                      : destination
                        ? `File this report to ${destination.name}`
                        : 'File this report'}
                  </button>
                  {!ready && !busy && (
                    <p className="text-2xs leading-relaxed text-faint">
                      Still needed: a pin on the map, a place description of at least four
                      characters, and at least ten characters describing what you saw. The button
                      turns on by itself — nothing is submitted half-filled.
                    </p>
                  )}
                  <InlineError error={error} />
                </form>
              )}
            </ResourceBody>
          </Panel>
        </div>
        <div className="min-w-0 space-y-3">
          <Panel
            title="Photograph"
            note="Optional, and screened only if you ask"
            right={
              file ? (
                <button
                  type="button"
                  className="btn btn-ghost px-2 py-1 text-2xs"
                  onClick={clearPhoto}
                >
                  <Trash2 className="h-3 w-3" aria-hidden />
                  Remove
                </button>
              ) : undefined
            }
          >
            <div className="space-y-2.5">
              <input
                ref={fileInput}
                type="file"
                accept={acceptedTypes.join(',')}
                className="hidden"
                onChange={(event) => {
                  const next = event.target.files?.[0] ?? null;
                  setFile(next);
                  setScreening(null);
                  setScreenError(null);
                }}
              />
              {preview ? (
                <img
                  src={preview}
                  alt="The photograph you selected"
                  className="h-40 w-full rounded-panel border border-hairline object-cover"
                />
              ) : (
                <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-panel border border-dashed border-hairline bg-raised/30 px-4 text-center">
                  <Camera className="h-6 w-6 text-faint" aria-hidden />
                  <p className="text-2xs leading-relaxed text-faint">
                    A photograph of the crack, the rockfall or the slope. It is stored with the
                    report and is what an officer looks at first.
                  </p>
                </div>
              )}
              <button
                type="button"
                className="btn btn-ghost w-full py-1.5 text-xs"
                onClick={() => fileInput.current?.click()}
              >
                <Upload className="h-3.5 w-3.5" aria-hidden />
                {file ? 'Choose a different photograph' : 'Choose a photograph'}
              </button>
              {file && (
                <p className="tnum text-2xs leading-tight text-dim">
                  {truncate(file.name, 34)} · {fileSize(file.size)}
                </p>
              )}
              {file && !typeOk && (
                <p className="text-2xs leading-relaxed text-risk-high">
                  {extension ? `${extension} files are not accepted.` : 'That file has no extension.'}{' '}
                  Accepted: {acceptedTypes.join(', ')}.
                </p>
              )}
              {file && typeOk && !sizeOk && (
                <p className="text-2xs leading-relaxed text-risk-high">
                  That photograph is {fileSize(file.size)}, over the {decimal(maxUploadMb, 0)} MB
                  limit. Most phone cameras have a smaller-size or “share” export that fits.
                </p>
              )}
              <div className="rule" />
              <button
                type="button"
                className="btn btn-ghost w-full py-1.5 text-xs"
                onClick={screen}
                disabled={!file || !typeOk || !sizeOk || screenBusy}
              >
                {screenBusy ? (
                  <Spinner className="h-3.5 w-3.5" />
                ) : (
                  <ScanLine className="h-3.5 w-3.5" aria-hidden />
                )}
                {screenBusy ? 'Screening…' : 'Screen this photograph'}
              </button>
              <p className="text-2xs leading-relaxed text-faint">
                Screening is a separate, optional step and changes nothing about what gets filed —
                the photograph is screened on the server anyway when the report is submitted. Ask for
                it here if you want to see the result before you file.
              </p>
              {screening && <ScreeningCard result={screening} />}
              <InlineError error={screenError} />
            </div>
          </Panel>
          <Guidance
            radiusKm={radiusKm}
            imageNote={served?.image_note ?? null}
            maxMb={maxUploadMb}
            acceptedTypes={acceptedTypes}
          />
          <Panel
            title="Earlier in this session"
            note={filed.length > 1 ? `${filed.length - 1} more` : undefined}
          >
            {filed.length > 1 ? (
              <ul className="space-y-1.5">
                {filed.slice(1).map((report) => (
                  <li
                    key={report.id}
                    className="rounded-panel border border-hairline bg-raised/30 px-2.5 py-2"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-2xs text-accent">{report.report_code}</span>
                      <ReportStatusChip status={report.status} />
                    </div>
                    <p className="mt-1 text-2xs leading-tight text-ink">
                      {truncate(report.location_text, 46)}
                    </p>
                    <p className="mt-0.5 text-2xs leading-tight text-faint">
                      {report.observation_type} ·{' '}
                      <span className={SEVERITY_TONE[report.severity] ?? 'text-muted'}>
                        {report.severity}
                      </span>{' '}
                      · {formatDateTime(report.created_at)}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title="Nothing else filed yet"
                hint="Reports you file here are listed with their codes so you keep them. They are not fetched back from the server - reading the queue needs an officer account."
                icon={<ClipboardList className="h-5 w-5" aria-hidden />}
              />
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
