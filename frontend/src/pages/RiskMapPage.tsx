/**
 * The risk map screen.
 *
 * The dashboard answers "what does the country look like"; this screen answers
 * "what is happening in that one region, and why". The map is the index and the
 * rail on the right is the record: pick a marker and everything the platform
 * knows about that region arrives in one request to `/api/risk/{region}` - the
 * score, the factor breakdown behind it, the weather that fed it, the terrain it
 * sits on, its open alerts, nearby recorded landslides and recent citizen
 * reports.
 *
 * One request rather than six, deliberately. The backend assembles the whole
 * record from a single scoring pass, so the explanation on screen is the
 * explanation *of the score on screen*. Fetching the pieces separately would let
 * a poll land between them and put a HIGH score next to the reasons for a
 * MODERATE one, which is the sort of quiet inconsistency nobody notices until it
 * matters.
 *
 * The filters narrow the map layer server-side (`state`, `min_score`) rather
 * than hiding markers in the browser, so the band counts under the legend always
 * describe what is actually drawn.
 */
import { MapPin } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { ForecastStrip, peakSentence } from '../charts/ForecastChart';
import { PageHeader } from '../components/AppShell';
import { AlertStatusChip, EventSeverityChip, ModeChip, SeverityChip } from '../components/Chips';
import { FactorBreakdown, FactorRow } from '../components/FactorBreakdown';
import { Panel, ResourceBody } from '../components/Panel';
import { KeyValue, RiskReadout } from '../components/Readouts';
import { RegionPicker, StateFilter, useSelectedRegion } from '../components/RegionPicker';
import { DemoConsole } from '../components/ScenarioControls';
import { EmptyState, StaleNote } from '../components/States';
import {
  coords,
  count as fmtCount,
  decimal,
  degrees,
  formatDate,
  km,
  metres,
  mm,
  mmPerHour,
  percentPoints,
  place,
  relativeTime,
  titleCase,
} from '../lib/format';
import { RiskMap } from '../maps/RiskMap';
import { api } from '../services/api';
import { usePlatform } from '../state/PlatformContext';
import { useResource } from '../state/useResource';
import type { RegionRiskResponse, RiskMapResponse } from '../types/api';

/**
 * The score floors offered as a filter.
 *
 * Expressed as scores rather than band names because that is what the endpoint
 * takes, and because "61 and above" is unambiguous where "HIGH" could be read as
 * "HIGH only".
 */
const FLOORS: { value: number; label: string }[] = [
  { value: 0, label: 'All monitored regions' },
  { value: 41, label: 'Score 41+ (moderate up)' },
  { value: 61, label: 'Score 61+ (high up)' },
  { value: 81, label: 'Score 81+ (critical)' },
];

/** The weather that fed the score, with its provenance named beside it. */
function WeatherBlock({ data }: { data: RegionRiskResponse }) {
  const reading = data.weather;
  const provider = data.weather_provider;

  if (!reading) {
    return (
      <p className="text-xs leading-relaxed text-faint">
        No weather reading is stored for this region yet. {provider.note}
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 pb-1">
        <span className="min-w-0 truncate font-mono text-2xs text-faint">{provider.provider}</span>
        <ModeChip mode={provider.mode} compact />
      </div>
      <KeyValue label="Rain now" value={mmPerHour(reading.rainfall_mm)} title="Rate during the current hour, not a total" />
      <KeyValue label="Past 6 h" value={mm(reading.rainfall_6h)} />
      <KeyValue label="Past 24 h" value={mm(reading.rainfall_24h)} />
      <KeyValue label="Past 72 h" value={mm(reading.rainfall_72h)} />
      <KeyValue label="Past 7 d" value={mm(reading.rainfall_7d)} />
      <KeyValue
        label="Anomaly"
        value={`${decimal(reading.rainfall_anomaly, 2)}×`}
        title="Seven-day rainfall against the seasonal normal for this zone. 1.0 is normal."
      />
      <KeyValue label="Soil moisture" value={percentPoints(reading.soil_moisture_pct)} />
      <KeyValue label="Observed" value={relativeTime(reading.observed_at)} />
      {reading.fallback_reason && (
        <p className="pt-1 text-2xs leading-relaxed text-risk-moderate">
          Live fetch failed, modelled reading used instead - {reading.fallback_reason}
        </p>
      )}
    </div>
  );
}

/**
 * The ground itself.
 *
 * Terrain is the half of the model that does not change hour to hour, and it is
 * the half a demonstration tends to skip past - which is a shame, because slope
 * and soil are why two districts an hour apart score differently under the same
 * storm. `dem_source` is printed rather than hidden: these figures come from a
 * documented demo DEM, and the platform never claims a live satellite feed.
 */
function TerrainBlock({ terrain }: { terrain: RegionRiskResponse['terrain'] }) {
  if (!terrain.available) {
    return (
      <div className="space-y-2">
        <p className="text-xs leading-relaxed text-faint">{terrain.note}</p>
        <KeyValue label="Source" value={terrain.dem_source} mono={false} />
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <KeyValue label="Elevation" value={metres(terrain.elevation_m)} />
      <KeyValue label="Slope" value={degrees(terrain.slope_deg)} title="Mean slope over the cell. Steeper ground fails at lower rainfall." />
      {terrain.relief_m !== null && <KeyValue label="Local relief" value={metres(terrain.relief_m)} />}
      <KeyValue label="Soil" value={titleCase(terrain.soil_type)} mono={false} />
      <KeyValue label="Land cover" value={titleCase(terrain.land_cover)} mono={false} />
      <KeyValue
        label="Vegetation"
        value={decimal(terrain.vegetation_index, 2)}
        title="NDVI-style index, 0 to 1. Roots hold soil, so higher usually lowers risk."
      />
      <KeyValue label="To nearest river" value={km(terrain.distance_to_river_km)} />
      {terrain.lithology && <KeyValue label="Lithology" value={titleCase(terrain.lithology)} mono={false} />}
      <div className="rule my-1.5" />
      <p className="text-2xs leading-relaxed text-faint">
        Source <span className="text-dim">{terrain.dem_source}</span> · {terrain.data_mode} data.
        Static between runs - the platform does not query a satellite live.
      </p>
    </div>
  );
}

/**
 * Everything held on one region, in the order it should be read: the score, then
 * why, then where it is going, then the ground and the weather under it, then the
 * human record - alerts raised, landslides recorded nearby, reports filed.
 */
function RegionDetail({
  data,
  thresholds,
}: {
  data: RegionRiskResponse;
  thresholds: { high: number; critical: number };
}) {
  const { region, risk, explanation, forecast, alerts, nearby_events, recent_reports } = data;
  const factors = explanation?.top_factors ?? risk.top_factors;
  // Kept separate rather than netted off, the way the backend computes them: a
  // panel that only ever reports bad news is easy to stop believing, and "the
  // forest cover here is the reason this is not worse" is operational
  // information. `top_factors` holds only the drivers pushing risk up, so
  // without this the protective side of the attribution would never be seen.
  const protective = explanation?.protective_factors ?? [];
  // Both lists are drawn against the same scale - the largest raising share in
  // the panel - so a 5% protective bar looks like 5% beside a 52% driver. Giving
  // the protective rows their own maximum would fill the track and make a minor
  // stabilising factor read as though it were holding the whole slope together.
  const protectiveScale =
    factors.slice(0, 6).reduce((max, factor) => Math.max(max, factor.share_percent), 0) || 100;

  return (
    <div className="space-y-3">
      <Panel
        title={region.name}
        note={place(region.district, region.state)}
        right={<ModeChip mode={risk.data_mode} compact />}
      >
        <div className="space-y-3">
          <RiskReadout
            score={risk.risk_score}
            level={risk.risk_level}
            confidence={risk.confidence}
            marks={[thresholds.high, thresholds.critical]}
            caption={`Scored ${relativeTime(risk.predicted_at)} by ${risk.model_name} ${
              risk.model_version
            } on the ${risk.model_backend} backend.`}
          />
          <div className="rule" />
          <KeyValue label="Code" value={region.code} />
          <KeyValue label="Coordinates" value={coords(region.latitude, region.longitude)} />
          <KeyValue
            label="Recorded events"
            value={fmtCount(region.historical_landslide_count)}
            title="Landslides held for this region in the historical archive"
          />
          <KeyValue label="Scenario" value={risk.scenario} />
          {risk.defaulted_fields.length > 0 && (
            <p className="pt-1 text-2xs leading-relaxed text-risk-moderate">
              {fmtCount(risk.defaulted_fields.length)} feature
              {risk.defaulted_fields.length === 1 ? '' : 's'} fell back to a schema default:{' '}
              {risk.defaulted_fields.join(', ')}.
            </p>
          )}
        </div>
      </Panel>

      <Panel
        title="Why this score"
        note={explanation?.method_label ?? 'Feature attribution'}
      >
        <FactorBreakdown
          factors={factors}
          summary={explanation?.summary}
          disclaimer={explanation?.disclaimer}
          methodLabel={explanation?.method_label}
          limit={6}
        >
          {protective.length > 0 && (
            <div className="space-y-1.5 border-t border-hairline pt-2.5">
              <p className="text-2xs uppercase tracking-wider text-faint">
                What is holding this slope up
              </p>
              <ul className="divide-y divide-hairline/60">
                {protective.slice(0, 3).map((factor) => (
                  <FactorRow key={factor.feature} factor={factor} scale={protectiveScale} />
                ))}
              </ul>
            </div>
          )}
        </FactorBreakdown>
      </Panel>

      <Panel
        title="Next 72 hours"
        note={peakSentence(forecast.peak)}
        right={
          <Link to="/forecast" className="btn btn-ghost">
            Full forecast
          </Link>
        }
      >
        <div className="space-y-2">
          <ForecastStrip points={forecast.points} peak={forecast.peak} />
          <p className="text-2xs leading-relaxed text-faint">{forecast.summary}</p>
        </div>
      </Panel>

      <Panel title="Weather feeding the model" bodyClassName="p-3">
        <WeatherBlock data={data} />
      </Panel>

      <Panel title="Terrain" bodyClassName="p-3">
        <TerrainBlock terrain={data.terrain} />
      </Panel>

      {alerts.length > 0 && (
        <Panel title="Alerts for this region" note={`${fmtCount(alerts.length)} on record`} flush>
          <ul className="divide-y divide-hairline/60">
            {alerts.map((alert) => (
              <li key={alert.id} className="space-y-1 px-3 py-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <SeverityChip severity={alert.severity} />
                  <AlertStatusChip status={alert.status} />
                  <span className="ml-auto font-mono text-2xs text-faint">
                    {relativeTime(alert.created_at)}
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-dim">{alert.cause}</p>
                <p className="text-2xs leading-relaxed text-faint">{alert.recommended_action}</p>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {nearby_events.length > 0 && (
        <Panel
          title="Recorded nearby"
          note="Archive of past landslides - history, not a prediction"
          flush
        >
          <ul className="divide-y divide-hairline/60">
            {nearby_events.slice(0, 6).map((event) => (
              <li key={event.id} className="flex items-start gap-2 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-ink">{event.location}</span>
                  <span className="block text-2xs text-faint">
                    {formatDate(event.event_date)} · {mm(event.rainfall_mm)} rain
                    {event.fatalities ? ` · ${fmtCount(event.fatalities)} lives lost` : ''}
                  </span>
                </span>
                <EventSeverityChip severity={event.severity} />
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {recent_reports.length > 0 && (
        <Panel title="Citizen reports" note="Unverified observations from the public" flush>
          <ul className="divide-y divide-hairline/60">
            {recent_reports.slice(0, 5).map((report) => (
              <li key={report.id} className="space-y-1 px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 truncate text-xs text-ink">{report.observation_type}</span>
                  <span className="ml-auto shrink-0 font-mono text-2xs text-faint">
                    {relativeTime(report.created_at)}
                  </span>
                </div>
                <p className="line-clamp-2 text-2xs leading-relaxed text-faint">
                  {report.description}
                </p>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

export default function RiskMapPage() {
  const {
    version,
    refreshSeconds,
    thresholds,
    dataMode,
    selectedRegionId,
    selectRegion,
    lastSimulation,
  } = usePlatform();
  const { region, regions, select } = useSelectedRegion();

  const [state, setState] = useState<string | null>(null);
  const [floor, setFloor] = useState(0);

  const riskMap = useResource<RiskMapResponse>(
    (signal) => api.riskMap({ state: state ?? undefined, min_score: floor || undefined }, signal),
    [version, state, floor],
    { pollSeconds: refreshSeconds },
  );

  // The detail request is disabled until a region is chosen, so the `?? 0` is
  // never reached - `enabled: false` means the fetcher is not called at all.
  const chosen = selectedRegionId;
  const detail = useResource<RegionRiskResponse>(
    (signal) => api.regionRisk(chosen ?? 0, {}, signal),
    [version, chosen],
    { enabled: chosen !== null, pollSeconds: refreshSeconds },
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Risk map"
        lead="Every monitored region, scored by the model for the active scenario. Select a marker for the score, the reasons behind it and the record held for that region."
        right={
          <>
            <RegionPicker
              selected={region}
              onPick={(picked) => select(picked.id)}
              className="w-52"
              align="right"
            />
            <StateFilter
              value={state}
              onChange={setState}
              states={regions.data?.states ?? []}
              className="w-auto"
            />
            <select
              className="field w-auto py-1.5 text-xs"
              value={floor}
              onChange={(event) => setFloor(Number(event.target.value))}
              aria-label="Minimum risk score"
            >
              {FLOORS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <ModeChip mode={dataMode} />
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <Panel
          title="Monitored network"
          note={
            riskMap.data
              ? `${fmtCount(riskMap.data.count)} of ${fmtCount(
                  riskMap.data.total_regions,
                )} regions drawn · ${riskMap.data.scenario_label}`
              : undefined
          }
          busy={riskMap.refreshing}
          flush
          className="xl:sticky xl:top-16 xl:self-start"
        >
          <ResourceBody resource={riskMap} loadingRows={6} loadingLabel="Scoring the network">
            {(data) => (
              <RiskMap
                points={data.points}
                counts={data.band_counts}
                thresholds={thresholds}
                highlighted={lastSimulation?.highlighted}
                selectedRegionId={selectedRegionId}
                onSelectRegion={selectRegion}
                version={version}
                dataMode={data.data_mode}
                busy={riskMap.refreshing}
                className="h-[28rem] lg:h-[34rem] xl:h-[calc(100vh-11rem)]"
              />
            )}
          </ResourceBody>
        </Panel>

        <div className="space-y-3">
          <Panel
            title="Demonstration"
            note="Every control here re-scores the whole network through the model."
          >
            <DemoConsole onFocusRegion={selectRegion} />
          </Panel>

          {chosen === null && (
            <Panel title="Region detail">
              <EmptyState
                title="No region selected"
                hint="Choose a marker on the map, or pick one from the selector above."
                icon={<MapPin className="h-5 w-5" />}
              />
            </Panel>
          )}

          {chosen !== null && !detail.data && (
            <Panel title="Region detail">
              <ResourceBody
                resource={detail}
                loadingRows={6}
                loadingLabel="Reading the region record"
              >
                {() => null}
              </ResourceBody>
            </Panel>
          )}

          {chosen !== null && detail.data && (
            <>
              {detail.error && <StaleNote error={detail.error} onRetry={detail.reload} />}
              <RegionDetail data={detail.data} thresholds={thresholds} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

