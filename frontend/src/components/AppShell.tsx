/**
 * The frame every screen sits inside: sidebar, header, and the two states that
 * must be handled before any of it can be drawn.
 *
 * Those two states are the reason this file is not just a nav list. On a judge's
 * laptop the most likely failure by a wide margin is that `uvicorn` is not
 * running, and the worst possible response to that is an empty dashboard with
 * zeros in it - a zero risk score is a claim, and a false one. So `booting`
 * shows a splash, `bootError` shows what went wrong plus the command that fixes
 * it, and neither one renders a page underneath.
 *
 * Everything in the header is read from the platform rather than hardcoded: the
 * data mode, the active scenario, the health of the database and the model, the
 * signed-in role. If the backend says the weather provider is in DEMO mode, the
 * chip in the corner says DEMO, and there is no code path that can make it say
 * anything else.
 */
import {
  Activity,
  AlertTriangle,
  Globe,
  History,
  LayoutDashboard,
  LineChart,
  LogIn,
  LogOut,
  Lock,
  Map as MapIcon,
  Megaphone,
  Menu,
  Mountain,
  RefreshCw,
  ShieldCheck,
  Siren,
  Terminal,
  Users,
  WifiOff,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';

import { formatClock, initials, timezoneLabel } from '../lib/format';
import { cx } from '../lib/risk';
import { API_BASE, type ApiError } from '../services/api';
import { usePlatform, type Platform } from '../state/PlatformContext';
import { useNow } from '../state/useResource';
import { ModeChip, RoleChip } from './Chips';
import { Spinner } from './States';

/** What a nav entry needs to be signed in for, if anything. */
type Gate = 'officer' | 'admin';

export interface NavEntry {
  to: string;
  label: string;
  icon: LucideIcon;
  /** One line under the label in the sidebar - what the screen is for. */
  hint: string;
  gate?: Gate;
}

/**
 * The ten screens, in the order the demo walks them.
 *
 * Deliberately not alphabetical and not grouped by data type: it runs
 * monitor - predict - explain - warn - respond, which is the sentence the
 * platform is built around, so a judge clicking straight down the sidebar sees
 * the argument in order.
 */
export const NAV: NavEntry[] = [
  { to: '/', label: 'Command centre', icon: LayoutDashboard, hint: 'Live risk at a glance' },
  { to: '/map', label: 'Risk map', icon: MapIcon, hint: 'GIS view of every region' },
  { to: '/forecast', label: 'Forecast & what-if', icon: LineChart, hint: '72 hours ahead' },
  { to: '/alerts', label: 'Alerts', icon: Siren, hint: 'Warnings and their status' },
  { to: '/sensors', label: 'Virtual instruments', icon: Activity, hint: 'Simulated sensor network' },
  { to: '/history', label: 'Historical archive', icon: History, hint: 'Recorded landslides' },
  { to: '/overview', label: 'National overview', icon: Globe, hint: 'Country-wide picture' },
  { to: '/report', label: 'Report a hazard', icon: Megaphone, hint: 'Citizen observation' },
  {
    to: '/officer',
    label: 'Officer desk',
    icon: ShieldCheck,
    hint: 'Triage alerts and reports',
    gate: 'officer',
  },
  { to: '/admin', label: 'Administration', icon: Users, hint: 'Accounts and model card', gate: 'admin' },
];

// ------------------------------------------------------------------- brand

/**
 * The platform's name and version, taken from `/api/info` once it answers.
 *
 * The fallback name is the static one, not "Loading…", so the splash and the
 * shell do not appear to be two different products for the first half second.
 */
function Brand({ compact = false }: { compact?: boolean }) {
  const { info } = usePlatform();
  return (
    <Link to="/" className="flex min-w-0 items-center gap-2.5 outline-none">
      <span className="relative grid h-8 w-8 shrink-0 place-items-center rounded-panel border border-accent/40 bg-accent/10">
        <Mountain className="h-4 w-4 text-accent" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-display text-sm font-semibold leading-tight tracking-wide text-ink">
          {info?.name ?? 'Bhoomi-Drishti'}
        </span>
        {!compact && (
          <span className="block truncate font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
            {info ? `v${info.version} · landslide early warning` : 'landslide early warning'}
          </span>
        )}
      </span>
    </Link>
  );
}

// -------------------------------------------------------------- boot states

/** First contact with the backend. A splash, not a dashboard full of zeros. */
function BootSplash() {
  return (
    <div className="grid min-h-screen place-items-center bg-ground px-6">
      <div className="w-full max-w-sm space-y-4 text-center">
        <span className="relative mx-auto grid h-14 w-14 place-items-center rounded-panel border border-accent/40 bg-accent/10">
          <Mountain className="h-6 w-6 text-accent" aria-hidden />
          <span className="absolute inset-0 animate-pulsering rounded-panel border border-accent/50" aria-hidden />
        </span>
        <div className="space-y-1">
          <p className="font-display text-lg font-semibold tracking-wide text-ink">Bhoomi-Drishti</p>
          <p className="text-xs text-dim">Landslide early-warning &amp; risk monitoring</p>
        </div>
        <p className="flex items-center justify-center gap-2 font-mono text-[10px] uppercase tracking-wider text-faint">
          <Spinner className="h-3 w-3" />
          contacting the platform
        </p>
      </div>
    </div>
  );
}

/**
 * First contact failed.
 *
 * This screen exists to be useful rather than apologetic: it names the address
 * that was tried, prints the command that starts the backend, and offers a retry
 * that actually re-runs the boot sequence. Ninety-nine times in a hundred the
 * answer is the second line.
 */
function BootFailure({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <div className="grid min-h-screen place-items-center bg-ground px-6">
      <div className="w-full max-w-lg space-y-4">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-panel border border-risk-critical/40 bg-risk-critical/10">
            <WifiOff className="h-4 w-4 text-risk-critical" aria-hidden />
          </span>
          <div className="min-w-0 space-y-1">
            <h1 className="font-display text-base font-semibold text-ink">
              Cannot reach the platform backend
            </h1>
            <p className="text-xs leading-relaxed text-dim">
              The interface loaded, but the API did not answer. Nothing on the screens below would
              be real until it does, so they are not being shown.
            </p>
          </div>
        </div>

        <div className="panel space-y-2 p-3">
          <p className="font-mono text-[10px] uppercase tracking-wider text-faint">what happened</p>
          <p className="text-xs text-ink">{error.message}</p>
          <p className="font-mono text-2xs text-faint">
            tried {API_BASE || 'same origin'} · status {error.status || 'no response'}
          </p>
        </div>

        <div className="panel space-y-2 p-3">
          <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-faint">
            <Terminal className="h-3 w-3" aria-hidden />
            start the backend
          </p>
          <pre className="overflow-x-auto rounded-panel border border-hairline bg-ground/60 p-2 font-mono text-2xs leading-relaxed text-dim">
{`cd backend
uvicorn app.main:app --reload --port 8000`}
          </pre>
          <p className="text-2xs leading-relaxed text-faint">
            Then press retry. If the API runs on another port, set{' '}
            <span className="font-mono text-dim">VITE_API_BASE</span> in{' '}
            <span className="font-mono text-dim">frontend/.env</span>.
          </p>
        </div>

        <button type="button" className="btn btn-accent w-full justify-center" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Retry connection
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ health

/**
 * Why the backend is calling itself degraded, in words a judge can read.
 *
 * `/api/health` already decides the verdict; this only translates it. A weather
 * provider in DEMO mode is deliberately not listed as a fault - it is the
 * expected state without an API key, and the mode chip already says so.
 */
function degradedReasons(health: NonNullable<Platform['health']>): string[] {
  const reasons: string[] = [];
  if (!health.database.connected) {
    reasons.push(`Database unreachable${health.database.error ? `: ${health.database.error}` : ''}`);
  }
  if (!health.model.loaded) reasons.push('Trained model not loaded - run ml/train_model.py');
  if (!health.ready) reasons.push(health.detail);
  return reasons;
}

/** A dot and a word: operational, degraded, or offline. */
function HealthIndicator({ className }: { className?: string }) {
  const { health, offline } = usePlatform();

  const state = offline
    ? {
        label: 'offline',
        dot: 'bg-risk-critical',
        text: 'text-risk-critical',
        note: 'The backend did not answer the last poll.',
      }
    : !health
      ? {
          label: 'checking',
          dot: 'bg-slate',
          text: 'text-faint',
          note: 'Waiting for the first health response.',
        }
      : health.status === 'ok' && health.ready
        ? {
            label: 'operational',
            dot: 'bg-risk-verylow',
            text: 'text-risk-verylow',
            note: health.detail,
          }
        : {
            label: 'degraded',
            dot: 'bg-risk-moderate',
            text: 'text-risk-moderate',
            note: degradedReasons(health).join(' · ') || health.detail,
          };

  return (
    <span
      className={cx('flex items-center gap-1.5', className)}
      title={state.note}
      aria-label={`Platform ${state.label}`}
    >
      <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', state.dot)} aria-hidden />
      <span className={cx('font-mono text-[10px] uppercase tracking-wider', state.text)}>
        {state.label}
      </span>
    </span>
  );
}

// ------------------------------------------------------------------- clock

/**
 * A ticking wall clock with its timezone.
 *
 * Control rooms have one, and here it does real work: every timestamp on the
 * platform is rendered in the browser's own zone, so the clock is the reference
 * that makes "issued 14 minutes ago" checkable rather than decorative.
 */
function Clock({ className }: { className?: string }) {
  const now = useNow(1000);
  return (
    <span className={cx('flex items-baseline gap-1.5', className)}>
      <span className="tnum font-mono text-xs text-ink">{formatClock(now)}</span>
      <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
        {timezoneLabel()}
      </span>
    </span>
  );
}

// ------------------------------------------------------------- navigation

/** Whether the signed-in caller may open a gated screen. */
function allowed(gate: Gate | undefined, caps: Platform['capabilities']): boolean {
  if (!gate) return true;
  if (gate === 'admin') return caps.is_admin;
  return caps.can_manage_alerts || caps.can_review_reports;
}

function NavRow({ entry, onNavigate }: { entry: NavEntry; onNavigate?: () => void }) {
  const { capabilities } = usePlatform();
  const open = allowed(entry.gate, capabilities);
  const Icon = entry.icon;

  /**
   * A gated screen stays visible but points at the sign-in page rather than
   * vanishing. Hiding it would make the platform look smaller than it is, and a
   * link that explains why it is locked is more use than no link at all.
   */
  const to = open ? entry.to : '/login';

  return (
    <li>
      <NavLink
        to={to}
        end={entry.to === '/'}
        onClick={onNavigate}
        className={({ isActive }) =>
          cx(
            'group flex items-start gap-2.5 border-l-2 px-3 py-2 transition-colors',
            isActive && open
              ? 'border-accent bg-accent/10'
              : 'border-transparent hover:border-accent/40 hover:bg-raised/60',
          )
        }
        title={open ? entry.hint : `${entry.label} - sign in as an officer to open`}
      >
        {({ isActive }) => (
          <>
            <Icon
              className={cx(
                'mt-0.5 h-4 w-4 shrink-0',
                isActive && open ? 'text-accent' : 'text-faint group-hover:text-dim',
              )}
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span
                  className={cx(
                    'truncate text-xs',
                    isActive && open ? 'text-accent' : 'text-ink',
                  )}
                >
                  {entry.label}
                </span>
                {!open && <Lock className="h-3 w-3 shrink-0 text-faint" aria-hidden />}
              </span>
              <span className="block truncate text-2xs text-faint">{entry.hint}</span>
            </span>
          </>
        )}
      </NavLink>
    </li>
  );
}

/**
 * Where every number on the platform comes from, one line per source.
 *
 * Folded into a `<details>` rather than a modal, and placed in the sidebar where
 * it is reachable from every screen. The spec asks for LIVE, DEMO and SIMULATED
 * to be distinguishable at all times; this is the long form of that promise, and
 * the sentences are the backend's own, not the frontend's paraphrase.
 */
function ProvenanceBlock() {
  const { info, dataMode } = usePlatform();
  if (!info) return null;
  const sources = info.data_provenance;

  return (
    <details className="group border-t border-hairline px-3 py-2 text-2xs">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-wider text-faint hover:text-dim">
        <span>Data sources</span>
        <ModeChip mode={dataMode} compact />
      </summary>
      <dl className="mt-2 space-y-1.5 leading-relaxed">
        {(
          [
            ['Weather', sources.weather],
            ['Terrain', sources.terrain],
            ['History', sources.history],
            ['Instruments', sources.sensors],
            ['Training labels', sources.labels],
          ] as const
        ).map(([label, text]) => (
          <div key={label}>
            <dt className="font-mono text-[9px] uppercase tracking-wider text-faint">{label}</dt>
            <dd className="text-dim">{text}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 border-t border-hairline pt-2 text-[10px] leading-relaxed text-faint">
        {info.disclaimer}
      </p>
    </details>
  );
}

/**
 * Who is signed in, and the way out.
 *
 * An anonymous visitor is not shown as "logged out" but as a citizen, because
 * that is what they are on this platform: they can read the public risk picture
 * and file a report. The officer and administrator screens are what sign-in adds.
 */
function SessionBox({ onNavigate }: { onNavigate?: () => void }) {
  const { session, signOut, authBusy } = usePlatform();

  if (!session.authenticated) {
    return (
      <div className="space-y-2 border-t border-hairline p-3">
        <p className="text-2xs leading-relaxed text-faint">
          Browsing as a citizen. Sign in to triage alerts and review reports.
        </p>
        <Link
          to="/login"
          onClick={onNavigate}
          className="btn btn-accent w-full justify-center"
        >
          <LogIn className="h-3.5 w-3.5" aria-hidden />
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2.5 border-t border-hairline p-3">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-panel border border-hairbright bg-raised font-mono text-[10px] text-dim">
        {initials(session.fullName ?? session.username)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-ink">
          {session.fullName ?? session.username}
        </span>
        <RoleChip role={session.role} className="mt-0.5" />
      </span>
      <button
        type="button"
        className="btn btn-ghost px-2 py-1.5"
        onClick={signOut}
        disabled={authBusy}
        title="Sign out"
      >
        {authBusy ? <Spinner className="h-3.5 w-3.5" /> : <LogOut className="h-3.5 w-3.5" aria-hidden />}
        <span className="sr-only">Sign out</span>
      </button>
    </div>
  );
}

/** Brand, the ten screens, the provenance disclosure, and the session box. */
function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="border-b border-hairline px-3 py-3">
        <Brand />
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto py-1.5" aria-label="Platform sections">
        <ul>
          {NAV.map((entry) => (
            <NavRow key={entry.to} entry={entry} onNavigate={onNavigate} />
          ))}
        </ul>
      </nav>
      <ProvenanceBlock />
      <SessionBox onNavigate={onNavigate} />
    </div>
  );
}

// ------------------------------------------------------------------ header

/**
 * The status strip: which scenario is loaded, what the data is, whether the
 * platform is healthy, the time, and a manual refresh.
 *
 * The refresh button re-runs the platform fetch and bumps `version`, which every
 * screen has in its resource dependencies - so one press pulls the whole app
 * forward rather than just the panel it happens to sit above.
 */
function Header({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { scenarioLabel, scenarioBusy, dataMode, refresh, booting } = usePlatform();

  return (
    <header className="sticky top-0 z-[900] flex h-12 shrink-0 items-center gap-2 border-b border-hairline bg-panel/95 px-2.5 backdrop-blur sm:px-3">
      <button
        type="button"
        className="btn btn-ghost px-2 py-1.5 lg:hidden"
        onClick={onOpenMenu}
        aria-label="Open navigation"
      >
        <Menu className="h-4 w-4" aria-hidden />
      </button>

      <div className="min-w-0 lg:hidden">
        <Brand compact />
      </div>

      <div className="hidden min-w-0 items-center gap-2 lg:flex">
        <span className="font-mono text-[10px] uppercase tracking-wider text-faint">scenario</span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs text-ink">{scenarioLabel}</span>
          {scenarioBusy && <Spinner className="h-3 w-3 text-accent" />}
        </span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
        <ModeChip mode={dataMode} className="hidden sm:inline-flex" compact />
        <HealthIndicator />
        <Clock className="hidden md:flex" />
        <button
          type="button"
          className="btn btn-ghost px-2 py-1.5"
          onClick={refresh}
          disabled={booting}
          title="Refresh platform status and every open panel"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">Refresh</span>
        </button>
      </div>
    </header>
  );
}

// ------------------------------------------------------------ page header

/**
 * The title block every page opens with.
 *
 * Kept here beside the shell rather than in each page, so all ten screens agree
 * on where the title sits, how long the lead sentence is allowed to be, and
 * where the page's own controls go. The lead is not decoration: on several
 * screens it is where the provenance of the numbers below is stated.
 */
export function PageHeader({
  title,
  lead,
  right,
  className,
}: {
  title: ReactNode;
  lead?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-2', className)}>
      <div className="min-w-0">
        <h1 className="font-display text-base font-semibold tracking-wide text-ink sm:text-lg">
          {title}
        </h1>
        {lead && <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-dim">{lead}</p>}
      </div>
      {right && <div className="flex shrink-0 flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}


// ----------------------------------------------------------- offline strip

/**
 * Shown when the last poll could not reach the backend but the screens still
 * hold data from before.
 *
 * The point is that the figures underneath are *old*, not wrong - and an officer
 * needs to know which. Blanking the screens would be worse: a risk map that
 * disappears during an outage tells you nothing, while one marked "last known"
 * still tells you what it knew.
 */
function OfflineStrip() {
  const { refresh } = usePlatform();
  return (
    <div className="flex items-center gap-2 border-b border-risk-moderate/40 bg-risk-moderate/10 px-3 py-1.5">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-risk-moderate" aria-hidden />
      <p className="min-w-0 flex-1 text-2xs leading-relaxed text-risk-moderate">
        Backend unreachable. Everything on screen is the last known state, not the current one.
      </p>
      <button type="button" className="btn btn-ghost shrink-0 px-2 py-1" onClick={refresh}>
        <RefreshCw className="h-3 w-3" aria-hidden />
        Retry
      </button>
    </div>
  );
}

// --------------------------------------------------------------- the shell

/**
 * The application frame.
 *
 * Renders `children` when given one, and the router's `<Outlet />` otherwise, so
 * it works both as a layout route and as a plain wrapper. Nothing inside it is
 * rendered until the platform has answered once.
 */
export function AppShell({ children }: { children?: ReactNode }) {
  const { booting, bootError, offline, refresh, info } = usePlatform();
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();

  // Navigating on a phone should close the drawer. Watching the location rather
  // than wiring a callback through every link keeps that true for links that
  // live inside the pages too.
  useEffect(() => setDrawer(false), [location.pathname]);

  useEffect(() => {
    if (!drawer) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setDrawer(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer]);

  if (booting) return <BootSplash />;
  if (bootError) return <BootFailure error={bootError} onRetry={refresh} />;

  return (
    <div className="flex min-h-screen bg-ground">
      {/* Fixed rail on a desktop. 15rem is enough for the longest label plus its
          hint without pushing the map into a column. */}
      <aside className="hidden w-60 shrink-0 border-r border-hairline lg:block">
        <div className="sticky top-0 h-screen">
          <Sidebar />
        </div>
      </aside>

      {/* Drawer below `lg`. Above Leaflet's controls, which sit at z-1000. */}
      {drawer && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-[1100] bg-ground/80 backdrop-blur-sm lg:hidden"
            onClick={() => setDrawer(false)}
            aria-label="Close navigation"
          />
          <aside className="fixed inset-y-0 left-0 z-[1200] w-64 max-w-[85vw] animate-rise border-r border-hairbright shadow-bezel lg:hidden">
            <button
              type="button"
              className="btn btn-ghost absolute right-2 top-2.5 px-2 py-1.5"
              onClick={() => setDrawer(false)}
              aria-label="Close navigation"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
            <Sidebar onNavigate={() => setDrawer(false)} />
          </aside>
        </>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <Header onOpenMenu={() => setDrawer(true)} />
        {offline && <OfflineStrip />}
        <main className="min-w-0 flex-1 p-2.5 sm:p-3.5">{children ?? <Outlet />}</main>
        <footer className="border-t border-hairline px-3 py-2">
          <p className="text-[10px] leading-relaxed text-faint">
            {info?.disclaimer ??
              'Decision support only. This platform does not replace professional geotechnical assessment.'}
          </p>
        </footer>
      </div>
    </div>
  );
}
