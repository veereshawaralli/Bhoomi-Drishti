/**
 * TypeScript mirrors of the API payloads.
 *
 * Hand-written against the FastAPI routers rather than generated, and kept in
 * one file so a change on the wire shows up as a compile error in every screen
 * that reads it instead of an `undefined` on a dashboard during a demo.
 *
 * Two conventions worth knowing:
 *
 * - `data_mode` travels with the value it describes. It is never inferred in
 *   the UI: the backend stamps LIVE / DEMO / SIMULATED where the number is
 *   produced, and the badge components read exactly that field.
 * - Anything the backend can legitimately not know is `| null`, not optional.
 *   Optional (`?`) means "this key may be absent from the response", which is
 *   a different thing and is used only where that is genuinely true.
 */

export type RiskLevel = 'VERY LOW' | 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';

export type DataMode = 'LIVE' | 'DEMO' | 'SIMULATED' | 'MIXED';

export type ScenarioKey =
  | 'NORMAL'
  | 'HEAVY_RAINFALL'
  | 'EXTREME_RAINFALL'
  | 'CRITICAL_RISK';

export type AlertStatus = 'NEW' | 'ACKNOWLEDGED' | 'IN PROGRESS' | 'RESOLVED';

export type AlertSeverity = 'HIGH' | 'CRITICAL';

export type ReportStatus = 'NEW' | 'UNDER REVIEW' | 'VERIFIED' | 'DISMISSED';

export type EventSeverity = 'MINOR' | 'MODERATE' | 'MAJOR' | 'SEVERE';

export type Role = 'CITIZEN' | 'OFFICER' | 'ADMIN';

export type SensorType =
  | 'RAIN_GAUGE'
  | 'SOIL_MOISTURE'
  | 'PORE_PRESSURE'
  | 'TILT'
  | 'VIBRATION';

export type SensorStatus = 'NORMAL' | 'ELEVATED' | 'ALARM' | 'OFFLINE';

/** The 16 model inputs, in the order the model was trained on. */
export type FeatureName =
  | 'rainfall_1h'
  | 'rainfall_6h'
  | 'rainfall_24h'
  | 'rainfall_72h'
  | 'rainfall_7d'
  | 'rainfall_anomaly'
  | 'elevation'
  | 'slope'
  | 'soil_moisture'
  | 'temperature'
  | 'humidity'
  | 'vegetation_index'
  | 'historical_landslide_count'
  | 'distance_to_river'
  | 'soil_type'
  | 'land_cover';

export type Features = Record<FeatureName, number>;

// --------------------------------------------------------------- geography

export interface Region {
  id: number;
  code: string;
  name: string;
  district: string;
  state: string;
  zone: string | null;
  latitude: number;
  longitude: number;
  historical_landslide_count: number | null;
  annual_rainfall_mm: number | null;
  population_exposed: number | null;
  area_km2: number | null;
  data_source: string | null;
}

export interface RegionListResponse {
  count: number;
  states: string[];
  regions: Region[];
}

// -------------------------------------------------------------- prediction

/**
 * One group of features and how much it moved the model's decision.
 *
 * `share_percent` is the number to draw: the group's share of the total
 * movement the model weighed, in both directions, so bars are comparable
 * between a raising and a lowering factor. `contribution` is the signed
 * log-odds behind it, kept for anyone who wants to audit the arithmetic.
 */
export interface Factor {
  feature: string;
  label: string;
  contribution: number;
  direction: 'raising' | 'lowering' | 'neutral';
  share_percent: number;
  value: number;
  value_text: string;
  evidence: string | null;
}

export interface FeatureDetail {
  feature: FeatureName;
  label: string;
  value: number;
  value_text: string;
  contribution: number;
  share_percent: number;
}

export interface Explanation {
  method: string;
  method_label: string;
  reference: string;
  additive: boolean;
  share_basis: string;
  baseline_log_odds: number;
  total_log_odds: number;
  top_factors: Factor[];
  protective_factors: Factor[];
  factors: Factor[];
  feature_detail: FeatureDetail[];
  summary: string;
  disclaimer: string;
}

export interface WeatherReading {
  region_id: number;
  region_code: string;
  observed_at: string;
  is_forecast: boolean;
  provider: string;
  data_mode: 'LIVE' | 'DEMO';
  /** Rainfall during this hour, i.e. an mm/h rate - not an accumulation. */
  rainfall_mm: number;
  rainfall_1h: number;
  rainfall_6h: number;
  rainfall_24h: number;
  rainfall_72h: number;
  rainfall_7d: number;
  rainfall_anomaly: number;
  temperature_c: number | null;
  humidity_pct: number | null;
  soil_moisture_pct: number | null;
  /** Present only when a live fetch failed and the model was used instead. */
  fallback_reason?: string;
  /** Present only when a non-default scenario altered the reading. */
  scenario_applied?: ScenarioKey;
  horizon_hours?: number;
}

export interface Prediction {
  region_id: number | null;
  region_code: string | null;
  region_name: string | null;
  risk_score: number;
  risk_level: RiskLevel;
  confidence: number;
  probability: number;
  model_backend: string;
  model_name: string;
  model_version: string;
  scenario: string;
  data_mode: DataMode;
  defaulted_fields: FeatureName[];
  top_factors: Factor[];
  features: Features;
  predicted_at: string;
  weather?: WeatherReading;
  explanation?: Explanation | null;
}

export interface PredictResponse extends Prediction {
  terrain: Terrain;
  overrides_applied: Partial<Record<string, number>> | null;
  nearest_region_km?: number;
  note?: string;
}

export interface PredictRequestBody {
  region_id?: number;
  region_code?: string;
  latitude?: number;
  longitude?: number;
  rainfall_1h?: number;
  rainfall_6h?: number;
  rainfall_24h?: number;
  rainfall_72h?: number;
  rainfall_7d?: number;
  rainfall_anomaly?: number;
  soil_moisture?: number;
  scenario?: ScenarioKey;
  explain?: boolean;
}

// ----------------------------------------------------------------- terrain

export type Terrain =
  | {
      available: false;
      data_mode: string;
      dem_source: string;
      note: string;
    }
  | {
      available: true;
      elevation_m: number;
      slope_deg: number;
      aspect_deg: number | null;
      relief_m: number | null;
      curvature: number | null;
      soil_type: string;
      soil_depth_m: number | null;
      land_cover: string;
      vegetation_index: number;
      distance_to_river_km: number;
      distance_to_road_km: number | null;
      lithology: string | null;
      dem_source: string;
      data_mode: string;
    };

// -------------------------------------------------------------- risk map

export interface RiskPoint {
  region: Region;
  risk_score: number;
  risk_level: RiskLevel;
  confidence: number;
  scenario: string;
  data_mode: DataMode;
  predicted_at: string;
  rainfall_24h: number;
  soil_moisture: number;
  slope_deg: number;
}

export type BandCounts = Record<RiskLevel, number>;

export interface RiskMapResponse {
  generated_at: string;
  data_mode: DataMode;
  scenario: ScenarioKey;
  scenario_label: string;
  count: number;
  total_regions: number;
  points: RiskPoint[];
  band_counts: BandCounts;
  high_risk_count: number;
  critical_count: number;
  country_risk: number;
  avg_score: number;
  max_score: number;
  note: string;
}

// --------------------------------------------------------------- forecast

export interface ForecastPoint {
  label: string;
  hours: number;
  valid_at: string;
  risk_score: number;
  risk_level: RiskLevel;
  confidence: number;
  /** Rainfall rate at that hour in mm/h, not a total for the period. */
  rainfall_mm: number;
  soil_moisture_pct: number | null;
}

export interface ForecastResponse {
  region_id: number;
  region_code: string;
  region_name: string;
  district: string;
  state: string;
  issued_at: string;
  scenario: ScenarioKey;
  scenario_label: string;
  data_mode: DataMode;
  model_backend: string;
  points: ForecastPoint[];
  peak: ForecastPoint;
  summary: string;
  note: string | null;
}

// ---------------------------------------------------------------- weather

export interface WeatherResponse {
  region_id: number;
  region_code: string;
  region_name: string;
  scenario: ScenarioKey;
  scenario_label: string;
  data_mode: DataMode;
  provider: string;
  live_configured: boolean;
  current: WeatherReading;
  hourly: WeatherReading[];
  note: string;
}

export interface WeatherProviderStatus {
  mode: 'LIVE' | 'DEMO';
  provider: string;
  live_configured: boolean;
  note: string;
}

// ----------------------------------------------------------------- alerts

export interface Alert {
  id: number;
  alert_code: string;
  region_id: number;
  region_name: string | null;
  region_code: string | null;
  severity: AlertSeverity;
  risk_score: number;
  status: AlertStatus;
  cause: string;
  recommended_action: string;
  scenario: string;
  data_mode: DataMode;
  assigned_to: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
}

export interface AlertStats {
  total: number;
  new: number;
  acknowledged: number;
  in_progress: number;
  resolved: number;
  high: number;
  critical: number;
}

export interface AlertListResponse {
  count: number;
  alerts: Alert[];
  stats: AlertStats;
  thresholds: { high: number; critical: number };
}

export interface SweepResponse {
  scenario: ScenarioKey;
  scenario_label: string;
  data_mode: DataMode;
  regions_scored: number;
  predictions_stored: number;
  alerts_raised: number;
  alerts: Alert[];
  count: number;
  band_counts: BandCounts;
  high_risk_count: number;
  critical_count: number;
  avg_score: number;
  max_score: number;
  country_risk: number;
}

// -------------------------------------------------------- region detail

/**
 * The `risk` block of `/api/risk/{id}` is a projection of a prediction, not a
 * whole one: the region is named once at the top level, and the explanation and
 * weather are lifted out into siblings rather than nested twice.
 */
export type RegionRisk = Omit<
  Prediction,
  'region_id' | 'region_code' | 'region_name' | 'weather' | 'explanation'
>;

export interface RegionRiskResponse {
  region: Region;
  risk: RegionRisk;
  explanation: Explanation | null;
  weather: WeatherReading | null;
  terrain: Terrain;
  forecast: {
    points: ForecastPoint[];
    peak: ForecastPoint;
    summary: string;
  };
  alerts: Alert[];
  recent_reports: CitizenReport[];
  nearby_events: LandslideEvent[];
  weather_provider: WeatherProviderStatus;
}


// ---------------------------------------------------------------- what-if

export interface WhatIfBody {
  region_id: number;
  rainfall_multiplier?: number;
  rainfall_add_mm_h?: number;
  soil_moisture_pct?: number;
  slope_deg?: number;
  vegetation_index?: number;
  distance_to_river_km?: number;
  historical_landslide_count?: number;
  future_hours?: number;
}

export interface InputChange {
  field: string;
  label: string;
  value: number;
  value_text: string;
}

export interface FeatureChange {
  feature: FeatureName;
  label: string;
  before: number;
  after: number;
  delta: number;
}

export interface WhatIfChanges {
  risk_score_before: number;
  risk_score_after: number;
  risk_score_delta: number;
  risk_level_before: RiskLevel;
  risk_level_after: RiskLevel;
  band_changed: boolean;
  confidence_before: number;
  confidence_after: number;
  inputs_changed: InputChange[];
  features_changed: FeatureChange[];
  lead_time_hours?: number;
}

export interface WhatIfResponse {
  region: Pick<
    Region,
    | 'id'
    | 'code'
    | 'name'
    | 'district'
    | 'state'
    | 'latitude'
    | 'longitude'
    | 'population_exposed'
  >;
  baseline: Prediction;
  modified: Prediction;
  changes: WhatIfChanges;
  interpretation: string;
  scenario: ScenarioKey;
  scenario_label: string;
  data_mode: 'SIMULATED';
  note: string;
}

// --------------------------------------------------------------- scenarios

export interface Scenario {
  key: ScenarioKey;
  label: string;
  description: string;
  /** The physical modifiers, already formatted: "x2.5", "+8 percentage points". */
  changes: Record<string, string>;
  active: boolean;
  data_mode: DataMode;
}

export interface ScenarioListResponse {
  active: ScenarioKey;
  active_label: string;
  version: number;
  scenarios: Scenario[];
  note: string;
}

export interface SimulationRegionDelta {
  region_id: number;
  region_code: string;
  region_name: string;
  district: string | null;
  state: string | null;
  latitude: number;
  longitude: number;
  population_exposed: number | null;
  before_score: number;
  before_level: RiskLevel;
  risk_score: number;
  risk_level: RiskLevel;
  confidence: number;
  delta: number;
  escalated: boolean;
}

export interface SimulationResponse {
  scenario: ScenarioKey;
  scenario_label: string;
  scenario_description: string;
  compared_with: ScenarioKey;
  data_mode: DataMode;
  badge: string;
  version: number;
  changes: Record<string, string>;
  regions_scored: number;
  regions_escalated: number;
  predictions_stored: number;
  alerts_raised: number;
  alerts: Alert[];
  band_counts: BandCounts;
  country_risk: number;
  max_score: number;
  regions: SimulationRegionDelta[];
  /** Region ids that changed band - what the map highlights. */
  highlighted: number[];
  worst_region: SimulationRegionDelta | null;
  overview: OverviewResponse;
  recommended_response: string[];
  headline_level: RiskLevel;
  note: string;
}

export interface SimulationResetResponse {
  scenario: ScenarioKey;
  scenario_label: string;
  data_mode: DataMode;
  version: number;
  regions_scored: number;
  predictions_stored: number;
  band_counts: BandCounts;
  overview: OverviewResponse;
  note: string;
}

export interface PlaybookResponse {
  playbook: Record<string, string[]>;
  note: string;
}

// ---------------------------------------------------------------- history

export interface LandslideEvent {
  id: number;
  event_id: string;
  region_id: number | null;
  region_code: string | null;
  event_date: string;
  location: string;
  district: string | null;
  state: string | null;
  latitude: number;
  longitude: number;
  rainfall_mm: number | null;
  slope_deg: number | null;
  elevation_m: number | null;
  severity: EventSeverity;
  trigger: string | null;
  fatalities: number | null;
  description: string | null;
  source: string;
  data_mode: string;
}

export interface EventsPerYear {
  year: number;
  total: number;
  MINOR: number;
  MODERATE: number;
  MAJOR: number;
  SEVERE: number;
}

export interface SeasonalPoint {
  month: string;
  month_number: number;
  events: number;
}

export interface RainBand {
  band: string;
  events: number;
}

export interface HighRiskRegion {
  location: string;
  district: string | null;
  state: string | null;
  count: number;
  severe: number;
  latitude: number;
  longitude: number;
  max_rainfall_mm: number;
}

export interface SeveritySplit {
  severity: EventSeverity;
  count: number;
}

export interface HistoryResponse {
  total: number;
  filtered: number;
  events: LandslideEvent[];
  filter_options: {
    states: string[];
    districts: string[];
    years: number[];
    severities: EventSeverity[];
  };
  charts: {
    events_per_year: EventsPerYear[];
    seasonal_pattern: SeasonalPoint[];
    rainfall_vs_events: RainBand[];
    high_risk_regions: HighRiskRegion[];
    severity_split: SeveritySplit[];
    provenance: { documented: number; modelled: number; note: string };
  };
  data_mode: DataMode;
}

// ---------------------------------------------------------- citizen reports

export interface ReportImageAnalysis {
  category: string | null;
  category_label: string | null;
  /** Percentage points, 0-100, capped at 80. Not a fraction, and not a
   *  probability of failure - format with `percentPoints`, never `percent`. */
  confidence: number | null;
  features: string[];
  recommendation: string | null;
  method: string | null;
  disclaimer: string | null;
}

export interface CitizenReport {
  id: number;
  report_code: string;
  region_id: number | null;
  region_name: string | null;
  reporter_name: string | null;
  location_text: string;
  latitude: number;
  longitude: number;
  observation_type: string;
  severity: string;
  /** The citizen's own account. Written once at submission and never edited. */
  description: string;
  /**
   * Triage notes, newest last, each stamped with the time and the officer's
   * name. Separate from `description` so that reviewing a report cannot
   * rewrite the evidence being reviewed.
   */
  officer_note: string | null;
  has_image: boolean;
  /** Path under the `/uploads` mount, or null when no photograph was attached. */
  image_url: string | null;
  image_analysis: ReportImageAnalysis | null;
  observed_on: string;
  status: ReportStatus;
  created_at: string;
}

export interface ReportStats {
  total: number;
  new: number;
  under_review: number;
  verified: number;
  dismissed: number;
}

export interface ImageAnalysisResult {
  category: string;
  category_label: string;
  /** Percentage points, 0-100, capped at 80 by construction. */
  confidence: number;
  features: string[];
  recommendation: string;
  method: string;
  disclaimer: string;
  measurements?: Record<string, number>;
  /** Runners-up. `category` is the human label; `score` is the raw heuristic
   *  score on its own scale, not a percentage. */
  alternatives?: { category: string; score: number }[];
}

export interface ReportListResponse {
  count: number;
  reports: CitizenReport[];
  stats: ReportStats;
}

export interface ReportSubmitResponse extends CitizenReport {
  acknowledgement: string;
}

export interface OptionChoice {
  value: string;
  label: string;
  hint?: string;
}

/** The report form reads its dropdowns from the API so they cannot drift. */
export interface ReportOptionsResponse {
  observation_types: OptionChoice[];
  severities: OptionChoice[];
  statuses: ReportStatus[];
  image_note: string;
  accepted_image_types: string[];
  snap_radius_km: number;
  screening_disclaimer: string;
}

// ------------------------------------------------------- national overview

export interface OverviewBand {
  level: RiskLevel;
  count: number;
  percent: number;
}

export interface TopRegion {
  region_id: number;
  region_code: string;
  name: string;
  district: string;
  state: string;
  latitude: number;
  longitude: number;
  risk_score: number;
  risk_level: RiskLevel;
  confidence: number;
  population_exposed: number | null;
  historical_landslide_count: number | null;
}

export interface StateRollup {
  state: string;
  regions: number;
  max_score: number;
  high: number;
}

/**
 * Every figure on the national screen. All of it is computed by
 * `overview_service.build` from rows in the database - nothing on that page is
 * a constant chosen to look impressive, which is why the numbers move when the
 * scenario changes.
 *
 * `country_risk` is deliberately the mean of the worst decile of regions, not
 * the national mean: an average over many quiet districts would read LOW on
 * the day one district is being evacuated.
 */
export interface OverviewResponse {
  generated_at: string;
  data_mode: DataMode;
  scenario: ScenarioKey;
  scenario_label: string;
  regions_total: number;
  regions_scored: number;
  bands: OverviewBand[];
  avg_score: number;
  max_score: number;
  high_risk: number;
  critical: number;
  active_alerts: number;
  unresolved_alerts: number;
  alert_counts: AlertStats;
  events_total: number;
  events_this_year: number;
  reports_pending: number;
  sensors_alerting: number;
  sensors_total: number;
  /** People living under a HIGH or CRITICAL score right now. */
  population_exposed: number;
  states_monitored: number;
  states: StateRollup[];
  top_regions: TopRegion[];
  country_risk: number;
  note: string;
}

// -------------------------------------------------- virtual sensor network
// Software-modelled instruments. No hardware exists anywhere in this project,
// and every reading below is stamped SIMULATED at the point it is produced.

export interface SensorTypeSpec {
  key: SensorType;
  label: string;
  unit: string;
  elevated_at: number;
  alarm_at: number;
  purpose: string;
  /** The real instrument this stands in for, named so the number can be read. */
  real_world: string;
}

/** A live reading, computed from the same slope state the risk engine sees. */
export interface SensorReading {
  sensor_code: string;
  region_id: number;
  region_name: string;
  region_code: string;
  sensor_type: SensorType;
  label: string;
  reading: number;
  unit: string;
  status: SensorStatus;
  recorded_at: string;
  data_mode: 'SIMULATED';
  purpose: string;
  real_world: string;
  elevated_at: number;
  alarm_at: number;
}

export type SensorCounts = Record<SensorStatus, number> & {
  total: number;
  regions: number;
};

export interface SensorNetworkResponse {
  sensors: SensorReading[];
  counts: SensorCounts;
  mode: 'SIMULATED';
  note: string;
  types: SensorTypeSpec[];
  scenario: ScenarioKey;
  scenario_label: string;
}

/** A stored row, as the history chart plots it. */
export interface StoredSensorReading {
  id: number;
  sensor_code: string;
  region_id: number;
  region_name: string | null;
  region_code: string | null;
  sensor_type: SensorType;
  reading: number;
  unit: string;
  status: SensorStatus;
  recorded_at: string;
  data_mode: string;
}

export interface SensorHistoryResponse {
  region_id: number;
  region_name: string;
  sensor_type: SensorType;
  label: string;
  unit: string;
  elevated_at: number;
  alarm_at: number;
  purpose: string;
  real_world: string;
  count: number;
  /** Oldest first, ready to plot. */
  readings: StoredSensorReading[];
  mode: 'SIMULATED';
  note: string;
}

export type SensorConditionKey = 'NORMAL' | 'HEAVY_RAIN' | 'CRITICAL';

export interface SensorCondition {
  key: SensorConditionKey;
  label: string;
  rainfall_multiplier: number;
  soil_moisture_added_pct: number;
}

export interface SensorConditionsResponse {
  conditions: SensorCondition[];
  sensor_types: SensorTypeSpec[];
  mode: 'SIMULATED';
  note: string;
}

export interface SimulateSensorBody {
  region_id: number;
  condition: SensorConditionKey;
  minutes: number;
}

export interface SensorSimulateResponse {
  region_id: number;
  region_name: string;
  scenario: ScenarioKey;
  scenario_label: string;
  data_mode: 'SIMULATED';
  inserted_rows: number;
  applied_condition: string;
  /** Scored through the same engine as the map, so it is comparable. */
  risk: Prediction;
  sensors: SensorReading[];
  alarming: string[];
  note: string;
}

// ------------------------------------------------------------------- auth

export interface Capabilities {
  can_manage_alerts: boolean;
  can_review_reports: boolean;
  is_admin: boolean;
}

export interface AuthUser {
  id: number;
  username: string;
  full_name: string | null;
  role: Role;
  organisation: string | null;
  phone: string | null;
}

export interface LoginResponse {
  access_token: string;
  token_type: 'bearer';
  expires_in_minutes: number;
  user: AuthUser;
  capabilities: Capabilities;
}

/**
 * `/api/auth/me` answers for anonymous callers too rather than returning 401,
 * because the app asks on load to decide which controls to render, and "you
 * are anonymous, here is what that allows" is a useful answer.
 */
export interface MeResponse {
  authenticated: boolean;
  id: number | null;
  username: string;
  full_name: string | null;
  role: Role;
  rank: number;
  capabilities: Capabilities;
}

export interface RoleSpec extends Capabilities {
  role: Role;
  rank: number;
  label: string;
  description: string;
}

export interface RolesResponse {
  roles: RoleSpec[];
  note: string;
}

export interface DemoAccount {
  username: string;
  password: string;
  role: Role;
  full_name: string;
  organisation: string;
}

/** Seeded credentials, listed on purpose so the demo needs no guesswork. */
export interface DemoAccountsResponse {
  accounts: DemoAccount[];
  note: string;
}

export interface UserListResponse {
  count: number;
  users: (AuthUser & { created_at: string })[];
}

// ------------------------------------------------------- meta / model card

export interface ModelStatus {
  loaded: boolean;
  backend: string;
  model_name: string;
  model_version: string;
  members: string[] | null;
  feature_count: number;
  trained_at: string | null;
  explanation: string;
}

export interface RiskBand {
  level: RiskLevel;
  /** Inclusive lower bound. Compare half-open: `min <= score < max`. */
  min: number;
  /** Exclusive upper bound, except for CRITICAL where 100 is included. */
  max: number;
  /** The inclusive-integer label the brief uses, e.g. `61-80`. Display only. */
  range: string;
  colour: string;
  meaning: string;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  database: {
    connected: boolean;
    dialect: string | null;
    error: string | null;
    rows: {
      regions?: number;
      alerts?: number;
      events?: number;
      reports?: number;
      sensor_rows?: number;
    };
  };
  model: { loaded: boolean; backend: string; path: string };
  weather: WeatherProviderStatus;
  scenario: ScenarioKey;
  ready: boolean;
  detail: string;
}

/**
 * The platform's own description of itself. The UI reads its band colours,
 * band boundaries and alert thresholds from here rather than keeping a second
 * copy, so the legend on the map cannot disagree with the engine that assigns
 * the bands.
 */
export interface InfoResponse {
  name: string;
  version: string;
  tagline: string;
  purpose: string;
  model: ModelStatus;
  weather: WeatherProviderStatus;
  scenario: { active: ScenarioKey; label: string; version: number };
  data_mode: DataMode;
  /** One sentence per source, stating what is LIVE, DEMO, MIXED or SIMULATED. */
  data_provenance: {
    weather: string;
    terrain: string;
    history: string;
    sensors: string;
    labels: string;
  };
  risk_bands: RiskBand[];
  thresholds: { high: number; critical: number };
  refresh_seconds: number;
  max_upload_mb: number;
  disclaimer: string;
}

export interface CalibrationBin {
  bin_low: number;
  bin_high: number;
  count: number;
  mean_predicted: number;
  observed_rate: number;
}

export interface SplitMetrics {
  n: number;
  positive_rate: number;
  roc_auc: number;
  pr_auc: number;
  brier: number;
  log_loss: number;
  mean_predicted: number;
  /** Expected calibration error - how far the stated probability is from truth. */
  ece: number;
  calibration: CalibrationBin[];
}

export interface FeatureImportance {
  feature: FeatureName;
  group: string;
  importance: number;
}

export interface FeatureSummary {
  feature: FeatureName;
  mean: number;
  std: number;
  min: number;
  p50: number;
  max: number;
}

/**
 * The model card. Discriminated on `card_available`: when `ml/model_card.json`
 * is missing the endpoint still answers, saying what is scoring instead of
 * returning nothing.
 *
 * The metrics are high because they measure how faithfully the model recovers
 * the physical model it was trained against - not real-world forecast skill.
 * `limitations` says so, and the UI shows it above the numbers.
 */
export type ModelCard =
  | (ModelStatus & { card_available: false; note: string })
  | {
      card_available: true;
      status: ModelStatus;
      intended_use: string;
      limitations: string[];
      data_provenance: Record<string, string>;
      model_name: string;
      model_version: string;
      feature_schema_version: number | string;
      feature_order: FeatureName[];
      members: number | null;
      hyperparams: Record<string, unknown>;
      trained_at: string;
      training_rows: number;
      split_sizes: { train: number; validation: number; test: number };
      regions: { total: number; train: number; validation: number; test: number };
      metrics: Record<'train' | 'validation' | 'test', SplitMetrics>;
      label_noise_ceiling: {
        note: string;
        test_roc_auc: number;
        model_fraction_of_ceiling: number;
        correlation_with_true_probability: number;
      };
      importance_method: string;
      feature_importance: FeatureImportance[];
      band_distribution: {
        counts: BandCounts;
        percent: BandCounts;
        score_min: number;
        score_p50: number;
        score_p95: number;
        score_max: number;
      };
      confidence_reference: Record<string, number | string>;
      training_summary: FeatureSummary[];
      note: string;
    };

// ------------------------------------------------------------ request bodies

export interface AlertUpdateBody {
  status: AlertStatus;
  assigned_to?: string | null;
  note?: string | null;
}

export interface ManualAlertBody {
  region_id: number;
  severity: AlertSeverity;
  risk_score: number;
  cause: string;
  recommended_action: string;
  scenario?: string;
}

export interface ReportTriageBody {
  status: ReportStatus;
  note?: string | null;
}

export interface LoginBody {
  username: string;
  password: string;
}

/**
 * `compare_with` is scored alongside the requested scenario but never stored,
 * so the response can say how far each region *moved* - the difference between
 * "Wayanad is at 87" and "Wayanad went from 58 to 87 when rainfall tripled".
 */
export interface SimulationBody {
  scenario: ScenarioKey;
  compare_with?: ScenarioKey;
}

// ------------------------------------------------------------------- errors

/**
 * The single error shape the API emits for every failure, so the client has
 * one error path. `fields` is present only on 422s, mapping a field name to the
 * reason it was rejected, which is what the report form displays inline.
 */
export interface ApiProblem {
  error: true;
  status: number;
  message: string;
  path: string;
  fields?: Record<string, string>;
  detail?: unknown;
}

export interface HistoryNearResponse {
  count: number;
  radius_km: number;
  events: LandslideEvent[];
}



