/**
 * The state the whole application has to agree on, in one place.
 *
 * Four things live here because a second copy of any of them would eventually
 * disagree with the first.
 *
 * The platform's self-description. `/api/info` carries the band boundaries,
 * band colours, alert thresholds, poll interval and data provenance. Screens
 * read those from here instead of holding their own copy, so the legend beside
 * the map cannot contradict the engine that assigned the bands.
 *
 * The active scenario. Loading one is a platform-wide act: the backend
 * re-scores every monitored region, stores the predictions and reconciles
 * alerts. Every open screen is therefore stale afterwards, which is what
 * `version` is for - screens list it among their dependencies and one bump
 * pulls all of them forward together.
 *
 * The session. `/api/auth/me` answers for anonymous callers too, so the app can
 * ask on load what this caller may do and render only those controls. When a
 * token expires mid-incident the API client clears it and this provider drops
 * to anonymous at once, so the interface never offers a button that would fail
 * the moment it was pressed.
 *
 * The selected region, shared between the map and every panel beside it.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

import { DEFAULT_THRESHOLDS, type Thresholds } from '../lib/risk';
import { api, asApiError, isAbort, onTokenChange, type ApiError } from '../services/api';
import type {
  Capabilities,
  DataMode,
  HealthResponse,
  InfoResponse,
  MeResponse,
  RiskBand,
  Role,
  Scenario,
  ScenarioKey,
  ScenarioListResponse,
  SimulationResetResponse,
  SimulationResponse,
} from '../types/api';
import { useResource } from './useResource';

// ----------------------------------------------------------------- session

/** Who the caller is, in the one shape every screen reads. */
export interface Session {
  authenticated: boolean;
  id: number | null;
  username: string;
  fullName: string | null;
  role: Role;
  rank: number;
  capabilities: Capabilities;
}

const NO_CAPABILITIES: Capabilities = {
  can_manage_alerts: false,
  can_review_reports: false,
  is_admin: false,
};

/**
 * Mirrors `backend/app/security.py:ANONYMOUS` - a citizen-level caller holding
 * no privileges. Used only until `/api/auth/me` answers.
 */
const ANONYMOUS: Session = {
  authenticated: false,
  id: null,
  username: 'anonymous',
  fullName: null,
  role: 'CITIZEN',
  rank: 1,
  capabilities: NO_CAPABILITIES,
};

function sessionFrom(me: MeResponse): Session {
  return {
    authenticated: me.authenticated,
    id: me.id,
    username: me.username,
    fullName: me.full_name,
    role: me.role,
    rank: me.rank,
    capabilities: me.capabilities ?? NO_CAPABILITIES,
  };
}

/** What the most recent scenario change reported about itself. */
interface LastRun {
  scenario: ScenarioKey;
  label: string;
  version: number;
}

// ---------------------------------------------------------------- contract

export interface Platform {
  /** `/api/info` - the platform describing itself. Null only before first load. */
  info: InfoResponse | null;
  /** `/api/health` - polled slowly, so an outage becomes visible rather than silent. */
  health: HealthResponse | null;
  /** First load has not finished. Show a splash, not an empty dashboard. */
  booting: boolean;
  /** First load failed. Nearly always "the backend is not running". */
  bootError: ApiError | null;
  /** The last attempt could not reach the backend at all. */
  offline: boolean;

  // Read from the API rather than duplicated here, so nothing can disagree.
  dataMode: DataMode;
  bands: RiskBand[];
  thresholds: Thresholds;
  /** Poll interval the backend recommends, in seconds. */
  refreshSeconds: number;
  maxUploadMb: number;
  disclaimer: string;

  scenario: ScenarioKey;
  scenarioLabel: string;
  scenarios: Scenario[];
  activeScenario: Scenario | null;
  /** Scenario being applied right now, `'RESET'` for a stand-down, else null. */
  scenarioBusy: ScenarioKey | 'RESET' | null;
  scenarioError: ApiError | null;
  /** Last simulation: what the banner reports and what the map highlights. */
  lastSimulation: SimulationResponse | null;
  lastReset: SimulationResetResponse | null;
  /** Re-scores every region platform-wide. Resolves to null if it failed. */
  loadScenario: (
    key: ScenarioKey,
    compareWith?: ScenarioKey,
  ) => Promise<SimulationResponse | null>;
  resetScenario: () => Promise<SimulationResetResponse | null>;
  /** Dismiss the banner and the highlight without changing the world. */
  clearSimulation: () => void;

  /** Bumped whenever the stored world changes. Screens put it in their deps. */
  version: number;
  /** Refetch everything now - the manual refresh button, and every retry. */
  refresh: () => void;

  session: Session;
  /** `session.capabilities`, lifted out because almost every guard wants it. */
  capabilities: Capabilities;
  /** Rejects with an `ApiError` on bad credentials so the form can show it inline. */
  signIn: (username: string, password: string) => Promise<Session>;
  signOut: () => void;
  authBusy: boolean;

  selectedRegionId: number | null;
  selectRegion: (id: number | null) => void;
}

const PlatformContext = createContext<Platform | null>(null);

/** Throws outside the provider rather than handing back a plausible-looking null. */
export function usePlatform(): Platform {
  const value = useContext(PlatformContext);
  if (!value) throw new Error('usePlatform must be used inside <PlatformProvider>.');
  return value;
}

// --------------------------------------------------------------- provider

/** How often `/api/health` is checked, regardless of what else is happening. */
const HEALTH_POLL_SECONDS = 30;

export function PlatformProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((n) => n + 1), []);

  const [session, setSession] = useState<Session>(ANONYMOUS);
  const [sessionReady, setSessionReady] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);

  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  const [lastSimulation, setLastSimulation] = useState<SimulationResponse | null>(null);
  const [lastReset, setLastReset] = useState<SimulationResetResponse | null>(null);
  const [scenarioBusy, setScenarioBusy] = useState<ScenarioKey | 'RESET' | null>(null);
  const [scenarioError, setScenarioError] = useState<ApiError | null>(null);

  const [selectedRegionId, setSelectedRegionId] = useState<number | null>(null);

  // `/api/info` and the scenario list are refetched on a version bump rather
  // than polled: nothing changes them except this application.
  const info = useResource<InfoResponse>((signal) => api.info(signal), [version]);
  const scenarios = useResource<ScenarioListResponse>(
    (signal) => api.scenarios(signal),
    [version],
  );
  // Health is polled on its own timer, because its whole job is to notice that
  // the backend went away - and an absent backend bumps no version.
  const health = useResource<HealthResponse>((signal) => api.health(signal), [version], {
    pollSeconds: HEALTH_POLL_SECONDS,
  });

  // Session bootstrap. This runs whether or not a token was restored from
  // storage, because "you are anonymous, and here is what that allows" is a
  // useful answer that decides which controls get rendered.
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    api
      .me(controller.signal)
      .then((result) => {
        if (live) setSession(sessionFrom(result));
      })
      .catch((cause: unknown) => {
        if (!live || isAbort(cause)) return;
        // The endpoint does not reject anonymous callers, so a failure here
        // means the backend is unreachable, not that the session is invalid.
        setSession(ANONYMOUS);
      })
      .finally(() => {
        if (live) setSessionReady(true);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, []);

  // The API client clears the token on any 401. That is the one way a session
  // can end without this provider doing it, so it is the only case handled
  // here - `signIn` and `signOut` set the session themselves.
  useEffect(
    () =>
      onTokenChange((value) => {
        if (value !== null) return;
        setSession(ANONYMOUS);
        refresh();
      }),
    [refresh],
  );

  const loadScenario = useCallback(
    async (key: ScenarioKey, compareWith?: ScenarioKey) => {
      setScenarioBusy(key);
      setScenarioError(null);
      try {
        const result = await api.runSimulation({
          scenario: key,
          compare_with: compareWith,
        });
        setLastSimulation(result);
        setLastReset(null);
        setLastRun({
          scenario: result.scenario,
          label: result.scenario_label,
          version: result.version,
        });
        refresh();
        return result;
      } catch (cause) {
        // Reported through state rather than thrown: the demo controls sit in
        // the header, and a failed scenario load must not unmount the app.
        setScenarioError(asApiError(cause, '/simulation'));
        return null;
      } finally {
        setScenarioBusy(null);
      }
    },
    [refresh],
  );

  const resetScenario = useCallback(async () => {
    setScenarioBusy('RESET');
    setScenarioError(null);
    try {
      const result = await api.resetSimulation();
      setLastReset(result);
      setLastSimulation(null);
      setLastRun({
        scenario: result.scenario,
        label: result.scenario_label,
        version: result.version,
      });
      refresh();
      return result;
    } catch (cause) {
      setScenarioError(asApiError(cause, '/simulation/reset'));
      return null;
    } finally {
      setScenarioBusy(null);
    }
  }, [refresh]);

  const clearSimulation = useCallback(() => {
    setLastSimulation(null);
    setLastReset(null);
    setScenarioError(null);
  }, []);

  const signIn = useCallback(
    async (username: string, password: string) => {
      setAuthBusy(true);
      try {
        // `api.login` stores the token. Its response carries the user but not
        // their rank, and `/api/auth/me` is the single shape the rest of the app
        // reads a session from, so ask it rather than assembling a near-copy.
        await api.login({ username, password });
        const next = sessionFrom(await api.me());
        setSession(next);
        refresh();
        return next;
      } finally {
        setAuthBusy(false);
      }
    },
    [refresh],
  );

  const signOut = useCallback(() => {
    // Clearing the token also notifies the listener above; doing it explicitly
    // here keeps the intent readable rather than hiding it in a side effect.
    api.logout();
    setSession(ANONYMOUS);
    refresh();
  }, [refresh]);

  const selectRegion = useCallback((id: number | null) => setSelectedRegionId(id), []);

  // A scenario change is answered by the simulation endpoint before `/api/info`
  // has been refetched, so for a moment the freshest truth is the response in
  // hand. Both sides carry the platform's version counter, which settles it.
  const fromInfo = info.data?.scenario ?? null;
  const ahead =
    lastRun && (!fromInfo || lastRun.version > fromInfo.version) ? lastRun : null;
  const scenario: ScenarioKey = ahead?.scenario ?? fromInfo?.active ?? 'NORMAL';
  const scenarioLabel = ahead?.label ?? fromInfo?.label ?? 'Normal weather';
  const scenarioList = scenarios.data?.scenarios ?? [];

  // Not memoised on purpose: `useResource` returns a fresh object each render,
  // so a `useMemo` here could never hold its identity and would only add a
  // dependency list to get wrong.
  const value: Platform = {
    info: info.data,
    health: health.data,
    booting: (info.loading && !info.data) || !sessionReady,
    bootError: info.data ? null : info.error,
    offline: Boolean(info.error?.offline || health.error?.offline),

    dataMode: info.data?.data_mode ?? 'DEMO',
    bands: info.data?.risk_bands ?? [],
    thresholds: info.data?.thresholds ?? DEFAULT_THRESHOLDS,
    refreshSeconds: info.data?.refresh_seconds ?? 30,
    maxUploadMb: info.data?.max_upload_mb ?? 5,
    disclaimer: info.data?.disclaimer ?? '',

    scenario,
    scenarioLabel,
    scenarios: scenarioList,
    activeScenario: scenarioList.find((item) => item.key === scenario) ?? null,
    scenarioBusy,
    scenarioError,
    lastSimulation,
    lastReset,
    loadScenario,
    resetScenario,
    clearSimulation,

    version,
    refresh,

    session,
    capabilities: session.capabilities,
    signIn,
    signOut,
    authBusy,

    selectedRegionId,
    selectRegion,
  };

  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>;
}
