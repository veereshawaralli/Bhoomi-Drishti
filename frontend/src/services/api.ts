/**
 * The only place this frontend talks to the network.
 *
 * Three things are centralised here on purpose.
 *
 * Errors. `backend/app/main.py:_problem` emits one shape for every failure -
 * `{error, status, message, path, fields?}` - so this module can turn all of
 * them into a single `ApiError` and every screen can have exactly one error
 * path. A dropped connection is folded into the same shape with `status: 0`,
 * because from the point of view of a panel that has to render something, "the
 * backend refused" and "the backend is not running" are the same event with
 * different wording.
 *
 * Authentication. The bearer token lives in one variable and one storage key.
 * A 401 on any call clears it, so an expired session cannot leave the app
 * showing officer controls that will fail the moment they are pressed.
 *
 * Cancellation. Every function takes an `AbortSignal`. The dashboard polls
 * while the user navigates, and an in-flight request for a page that has been
 * left must not resolve into a component that no longer exists.
 */
import type {
  Alert,
  AlertListResponse,
  AlertUpdateBody,
  CitizenReport,
  DemoAccountsResponse,
  ForecastResponse,
  HealthResponse,
  HistoryNearResponse,
  HistoryResponse,
  ImageAnalysisResult,
  InfoResponse,
  LoginBody,
  LoginResponse,
  ManualAlertBody,
  MeResponse,
  ModelCard,
  OverviewResponse,
  PlaybookResponse,
  PredictRequestBody,
  PredictResponse,
  RegionListResponse,
  RegionRiskResponse,
  ReportListResponse,
  ReportOptionsResponse,
  ReportSubmitResponse,
  ReportTriageBody,
  RiskMapResponse,
  RolesResponse,
  ScenarioKey,
  ScenarioListResponse,
  SensorConditionsResponse,
  SensorHistoryResponse,
  SensorNetworkResponse,
  SensorSimulateResponse,
  SensorType,
  SimulateSensorBody,
  SimulationBody,
  SimulationResetResponse,
  SimulationResponse,
  SweepResponse,
  UserListResponse,
  WeatherResponse,
  WhatIfBody,
  WhatIfResponse,
} from '../types/api';
/** Same-origin `/api` unless told otherwise, with any trailing slash removed. */
export const API_BASE = (import.meta.env.VITE_API_BASE ?? '/api').replace(/\/+$/, '');

const TOKEN_KEY = 'bhoomi-drishti.token';

/**
 * Every failure the client can see, in one class.
 *
 * `fields` arrives only on a 422 and maps a field name to the reason it was
 * rejected, which is what the citizen report form shows inline next to the input
 * rather than as a banner at the top.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly fields: Record<string, string>;
  readonly detail: unknown;
  /** True when the request never reached the backend at all. */
  readonly offline: boolean;

  constructor(init: {
    status: number;
    message: string;
    path: string;
    fields?: Record<string, string>;
    detail?: unknown;
    offline?: boolean;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.path = init.path;
    this.fields = init.fields ?? {};
    this.detail = init.detail;
    this.offline = init.offline ?? false;
  }

  /** Whether retrying the identical request could plausibly succeed. */
  get retryable(): boolean {
    return this.offline || this.status === 0 || this.status >= 500;
  }
}

/** A cancelled request is not a failure; screens ignore it rather than report it. */
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Coerce anything thrown into an `ApiError`.
 *
 * Every mutation handler in the app - acknowledge an alert, triage a report,
 * load a scenario - wants exactly one type in its catch block. Without this a
 * programming error inside a handler would surface as a silent dead button
 * rather than as a message the operator can read.
 */
export function asApiError(cause: unknown, path = 'unknown'): ApiError {
  if (cause instanceof ApiError) return cause;
  return new ApiError({
    status: 0,
    path,
    message: cause instanceof Error ? cause.message : 'Unexpected failure.',
    detail: cause,
  });
}
// ------------------------------------------------------------------- token

let token: string | null = readToken();
const listeners = new Set<(value: string | null) => void>();

function readToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    // Private browsing modes throw on access rather than returning null.
    return null;
  }
}

export function getToken(): string | null {
  return token;
}

/**
 * Store or clear the bearer token.
 *
 * Persisted so a reload does not sign an officer out mid-incident. The JWT
 * carries its own expiry and the backend verifies it on every request, so a
 * stale value in storage is rejected rather than trusted - and `request` clears
 * it on the first 401 it sees.
 */
export function setToken(next: string | null): void {
  token = next;
  try {
    if (next) window.localStorage.setItem(TOKEN_KEY, next);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable: the token still works for this tab's lifetime.
  }
  listeners.forEach((listener) => listener(next));
}

/** Notified when the token changes, including when a 401 clears it. */
export function onTokenChange(listener: (value: string | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
// ----------------------------------------------------------------- requests

export type Query = Record<string, string | number | boolean | null | undefined>;

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Query;
  /** Sent as JSON. Mutually exclusive with `form`. */
  body?: unknown;
  /** Sent as multipart, for the report form's photograph. */
  form?: FormData;
  signal?: AbortSignal;
}

function url(path: string, query?: Query): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    // An empty filter means "no filter" and must not become `?state=`, which
    // the backend would read as a state literally named "".
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
}

/**
 * Recover per-field messages from a raw Pydantic error list.
 *
 * The multipart report endpoint validates through the model by hand and raises
 * 422 with the error list as its detail, so those errors arrive in `detail`
 * rather than `fields`. Normalising here means the form's inline errors work the
 * same on both paths.
 */
function fieldsFromDetail(detail: unknown): Record<string, string> {
  if (!Array.isArray(detail)) return {};
  const fields: Record<string, string> = {};
  for (const entry of detail) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as { loc?: unknown[]; msg?: unknown };
    const loc = Array.isArray(item.loc)
      ? item.loc.filter((part) => part !== 'body' && part !== 'query').map(String)
      : [];
    fields[loc.join('.') || 'request'] = String(item.msg ?? 'invalid');
  }
  return fields;
}
async function request<T>(path: string, options: Options = {}): Promise<T> {
  const target = url(path, options.query);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let payload: BodyInit | undefined;
  if (options.form) {
    // Deliberately no Content-Type: the browser has to add the multipart
    // boundary itself, and setting the header by hand strips it.
    payload = options.form;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(target, {
      method: options.method ?? 'GET',
      headers,
      body: payload,
      signal: options.signal,
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiError({
      status: 0,
      path,
      offline: true,
      message:
        'Cannot reach the backend. Start it with `uvicorn app.main:app --reload` ' +
        'in the backend folder, then retry.',
      detail: error,
    });
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    const problem = (parsed ?? {}) as {
      message?: string;
      detail?: unknown;
      fields?: Record<string, string>;
    };
    const detail = problem.detail;
    const fields =
      problem.fields ?? fieldsFromDetail(detail);
    const message =
      problem.message ??
      (typeof detail === 'string' ? detail : null) ??
      (typeof parsed === 'string' && parsed ? parsed : null) ??
      `Request failed with status ${response.status}.`;

    // An expired or rejected token is cleared immediately, so the app stops
    // offering controls the caller can no longer use.
    if (response.status === 401 && token) setToken(null);

    throw new ApiError({
      status: response.status,
      path,
      message,
      fields,
      detail,
    });
  }

  return parsed as T;
}

/** Absolute URL for an uploaded photograph path returned by the API. */
export function uploadUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return path.startsWith('/') ? path : `/${path}`;
}
// --------------------------------------------------------------- endpoints
//
// One function per endpoint, named for what it does rather than for its verb.
// `scenario` appears on most reads because the backend accepts it as a
// per-request override: the demo switches the platform-wide scenario, while a
// preview can score one screen under a different one without moving the world.

export const api = {
  // meta
  health: (signal?: AbortSignal) => request<HealthResponse>('/health', { signal }),
  info: (signal?: AbortSignal) => request<InfoResponse>('/info', { signal }),
  modelCard: (signal?: AbortSignal) => request<ModelCard>('/model-info', { signal }),

  // auth
  /** Stores the token on success, so nothing else has to remember to. */
  login: async (body: LoginBody, signal?: AbortSignal) => {
    const result = await request<LoginResponse>('/auth/login', {
      method: 'POST',
      body,
      signal,
    });
    setToken(result.access_token);
    return result;
  },
  logout: () => setToken(null),
  me: (signal?: AbortSignal) => request<MeResponse>('/auth/me', { signal }),
  roles: (signal?: AbortSignal) => request<RolesResponse>('/auth/roles', { signal }),
  demoAccounts: (signal?: AbortSignal) =>
    request<DemoAccountsResponse>('/auth/demo-accounts', { signal }),
  users: (signal?: AbortSignal) => request<UserListResponse>('/auth/users', { signal }),

  // regions and the map
  regions: (
    query: { state?: string; q?: string; limit?: number } = {},
    signal?: AbortSignal,
  ) => request<RegionListResponse>('/regions', { query, signal }),

  riskMap: (
    query: {
      scenario?: ScenarioKey;
      state?: string;
      min_score?: number;
      level?: string;
    } = {},
    signal?: AbortSignal,
  ) => request<RiskMapResponse>('/risk-map', { query, signal }),

  /** Accepts an id or a region code - the backend resolves either. */
  regionRisk: (
    region: number | string,
    query: { scenario?: ScenarioKey } = {},
    signal?: AbortSignal,
  ) => request<RegionRiskResponse>(`/risk/${region}`, { query, signal }),
  // prediction
  predict: (body: PredictRequestBody, signal?: AbortSignal) =>
    request<PredictResponse>('/predict', { method: 'POST', body, signal }),

  whatIf: (body: WhatIfBody, signal?: AbortSignal) =>
    request<WhatIfResponse>('/what-if', { method: 'POST', body, signal }),

  /** `store: false` for a preview that should not persist a curve. */
  forecast: (
    region: number | string,
    query: { scenario?: ScenarioKey; store?: boolean } = {},
    signal?: AbortSignal,
  ) => request<ForecastResponse>(`/forecast/${region}`, { query, signal }),

  weather: (
    region: number | string,
    query: { scenario?: ScenarioKey; back_hours?: number; forward_hours?: number } = {},
    signal?: AbortSignal,
  ) => request<WeatherResponse>(`/weather/${region}`, { query, signal }),

  // alerts
  alerts: (
    query: {
      status?: string;
      severity?: string;
      region_id?: number;
      limit?: number;
    } = {},
    signal?: AbortSignal,
  ) => request<AlertListResponse>('/alerts', { query, signal }),

  createAlert: (body: ManualAlertBody, signal?: AbortSignal) =>
    request<Alert>('/alerts', { method: 'POST', body, signal }),

  updateAlert: (id: number, body: AlertUpdateBody, signal?: AbortSignal) =>
    request<Alert>(`/alerts/${id}`, { method: 'PUT', body, signal }),

  /** Re-score everything and reconcile alerts. What the demo button ends up calling. */
  sweep: (query: { scenario?: ScenarioKey } = {}, signal?: AbortSignal) =>
    request<SweepResponse>('/alerts/sweep', { method: 'POST', query, signal }),
  // history
  history: (
    query: {
      state?: string;
      district?: string;
      year?: number;
      severity?: string;
      region_id?: number;
      limit?: number;
    } = {},
    signal?: AbortSignal,
  ) => request<HistoryResponse>('/history', { query, signal }),

  /** "Has this happened here before?" - asked from a region panel. */
  historyNear: (
    query: { lat: number; lon: number; radius_km?: number; limit?: number },
    signal?: AbortSignal,
  ) => request<HistoryNearResponse>('/history/near', { query, signal }),

  // citizen reports
  /** Multipart, because the photograph is part of the report and not a second step. */
  submitReport: (form: FormData, signal?: AbortSignal) =>
    request<ReportSubmitResponse>('/citizen-report', {
      method: 'POST',
      form,
      signal,
    }),

  reports: (
    query: {
      status?: string;
      region_id?: number;
      severity?: string;
      limit?: number;
    } = {},
    signal?: AbortSignal,
  ) => request<ReportListResponse>('/citizen-report', { query, signal }),

  triageReport: (id: number, body: ReportTriageBody, signal?: AbortSignal) =>
    request<CitizenReport>(`/citizen-report/${id}`, { method: 'PUT', body, signal }),

  reportOptions: (signal?: AbortSignal) =>
    request<ReportOptionsResponse>('/citizen-report/options', { signal }),

  /** Screen a photograph without filing anything. Decision support, not a verdict. */
  analyseImage: (file: File, signal?: AbortSignal) => {
    const form = new FormData();
    form.append('image', file);
    return request<ImageAnalysisResult>('/image-analysis', {
      method: 'POST',
      form,
      signal,
    });
  },
  // virtual sensors - software models of instruments, never hardware
  sensors: (
    query: { scenario?: ScenarioKey; region_id?: number; limit_regions?: number } = {},
    signal?: AbortSignal,
  ) => request<SensorNetworkResponse>('/sensors', { query, signal }),

  sensorHistory: (
    query: { region_id: number; sensor_type: SensorType; points?: number },
    signal?: AbortSignal,
  ) => request<SensorHistoryResponse>('/sensors/history', { query, signal }),

  simulateSensors: (
    body: SimulateSensorBody,
    query: { scenario?: ScenarioKey } = {},
    signal?: AbortSignal,
  ) =>
    request<SensorSimulateResponse>('/sensors/simulate', {
      method: 'POST',
      body,
      query,
      signal,
    }),

  sensorConditions: (signal?: AbortSignal) =>
    request<SensorConditionsResponse>('/sensors/conditions', { signal }),

  // scenarios and the demo controls
  scenarios: (signal?: AbortSignal) =>
    request<ScenarioListResponse>('/scenarios', { signal }),

  /** Loads a scenario platform-wide, re-scores every region, reports what moved. */
  runSimulation: (body: SimulationBody, signal?: AbortSignal) =>
    request<SimulationResponse>('/simulation', { method: 'POST', body, signal }),

  /** Stands the platform down to the NORMAL baseline. */
  resetSimulation: (signal?: AbortSignal) =>
    request<SimulationResetResponse>('/simulation/reset', { method: 'POST', signal }),

  playbook: (signal?: AbortSignal) =>
    request<PlaybookResponse>('/simulation/playbook', { signal }),

  // national picture
  overview: (
    query: { scenario?: ScenarioKey; top_n?: number } = {},
    signal?: AbortSignal,
  ) => request<OverviewResponse>('/overview', { query, signal }),
};

export type Api = typeof api;

