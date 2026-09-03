/**
 * Sign-in, and an honest account of what signing in is for.
 *
 * This page sits outside the shell: one form, no sidebar, nothing else to click.
 * It is reached in two ways - deliberately, from the header, or by a guard that
 * intercepted a request for an officer screen. In the second case the guard hands
 * over the path it stopped, and signing in continues to it rather than dumping
 * the officer on the dashboard to find their way back.
 *
 * The demo accounts are listed because they are seeded with published passwords
 * and a reviewer needs to be able to open the officer desk without guesswork. The
 * list is fetched from `/api/auth/demo-accounts`, which cross-checks the database
 * before advertising anything, so if seeding was turned off this shows nothing
 * rather than offering credentials that would fail. The role table beside it comes
 * from `/api/auth/roles` for the same reason a form should never hold its own copy
 * of a validator: the screen and the dependencies that actually enforce access
 * must not be able to drift apart.
 *
 * Nothing here is a security boundary. The token is a demo JWT signed with a
 * secret that ships in the repository, and every write is re-checked on the
 * server. Saying so on the page is more useful than implying otherwise.
 */
import { ArrowRight, KeyRound, LogIn, Mountain, ShieldAlert, UserCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { InlineError, Spinner } from '../components/States';
import { cx } from '../lib/risk';
import { api, asApiError, type ApiError } from '../services/api';
import { usePlatform } from '../state/PlatformContext';
import { useResource } from '../state/useResource';
import type { DemoAccountsResponse, Role, RolesResponse } from '../types/api';

/** Where a guard sent us from, if it sent us. */
interface GuardState {
  from?: string;
}

const ROLE_TONE: Record<Role, string> = {
  CITIZEN: 'border-risk-verylow/45 bg-risk-verylow/10 text-risk-verylow',
  OFFICER: 'border-accent/45 bg-accent/10 text-accent',
  ADMIN: 'border-risk-moderate/45 bg-risk-moderate/10 text-risk-moderate',
};

/** One seeded account, offered as a button that fills the form. */
function AccountRow({
  username,
  password,
  role,
  fullName,
  organisation,
  active,
  onUse,
}: {
  username: string;
  password: string;
  role: Role;
  fullName: string;
  organisation: string;
  active: boolean;
  onUse: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onUse}
      aria-pressed={active}
      className={cx(
        'w-full rounded-panel border px-3 py-2 text-left transition-colors',
        active
          ? 'border-accent/60 bg-accent/10'
          : 'border-hairline bg-raised/30 hover:border-accent/40',
      )}
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className="truncate font-mono text-xs text-ink">{username}</span>
        <span
          className={cx(
            'shrink-0 rounded-full border px-1.5 py-px font-mono text-[10px] uppercase tracking-wider',
            ROLE_TONE[role],
          )}
        >
          {role}
        </span>
      </span>
      <span className="mt-0.5 block truncate text-2xs leading-tight text-dim">
        {fullName} · {organisation}
      </span>
      <span className="mt-0.5 block font-mono text-2xs leading-tight text-faint">
        password: {password}
      </span>
    </button>
  );
}

export default function LoginPage() {
  const { session, signIn, signOut, authBusy, info } = usePlatform();
  const location = useLocation();
  const navigate = useNavigate();

  const from = (location.state as GuardState | null)?.from ?? '/';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  const accounts = useResource<DemoAccountsResponse>((signal) => api.demoAccounts(signal), []);
  const roles = useResource<RolesResponse>((signal) => api.roles(signal), []);

  const ready = username.trim() !== '' && password !== '';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || authBusy) return;
    setError(null);
    try {
      await signIn(username.trim(), password);
      // `from` is a path this app owns - the guard put it there, not a query
      // string - so it is safe to navigate to directly.
      navigate(from, { replace: true });
    } catch (cause) {
      setError(asApiError(cause, '/auth/login'));
      setPassword('');
    }
  }

  function fill(account: { username: string; password: string }) {
    setUsername(account.username);
    setPassword(account.password);
    setError(null);
  }

  return (
    <div className="min-h-screen bg-ground px-5 py-10">
      <div className="mx-auto grid max-w-4xl gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="min-w-0">
          <Link to="/" className="flex min-w-0 items-center gap-2.5">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-panel border border-accent/40 bg-accent/10">
              <Mountain className="h-4 w-4 text-accent" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block truncate font-display text-sm font-semibold tracking-wide text-ink">
                {info?.name ?? 'Bhoomi-Drishti'}
              </span>
              <span className="block truncate font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                {info ? `v${info.version} · sign in` : 'sign in'}
              </span>
            </span>
          </Link>

          <div className="panel mt-4 p-4">
            {session.authenticated ? (
              <div className="space-y-3">
                <p className="flex items-start gap-2 text-xs leading-relaxed text-ink">
                  <UserCheck className="mt-0.5 h-4 w-4 shrink-0 text-risk-verylow" aria-hidden />
                  <span>
                    Already signed in as <span className="font-mono">{session.username}</span>
                    {session.fullName ? ` (${session.fullName})` : ''}, with the{' '}
                    {session.role.toLowerCase()} role.
                  </span>
                </p>
                <button
                  type="button"
                  className="btn btn-accent w-full py-1.5 text-xs"
                  onClick={() => navigate(from, { replace: true })}
                >
                  Continue to {from === '/' ? 'the command centre' : from}
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost w-full py-1.5 text-xs"
                  onClick={() => {
                    signOut();
                    setUsername('');
                    setPassword('');
                  }}
                >
                  Sign out and use a different account
                </button>
              </div>
            ) : (
              <form className="space-y-3" onSubmit={submit}>
                {from !== '/' && (
                  <p className="rounded-panel border border-risk-moderate/30 bg-risk-moderate/10 px-3 py-2 text-2xs leading-relaxed text-risk-moderate">
                    <span className="font-mono text-ink">{from}</span> needs an account with at
                    least the officer role. Signing in continues there.
                  </p>
                )}
                <div className="min-w-0">
                  <label className="label" htmlFor="login-username">
                    Username
                  </label>
                  <input
                    id="login-username"
                    className="field py-1.5 text-xs"
                    autoComplete="username"
                    autoFocus
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                  />
                </div>
                <div className="min-w-0">
                  <label className="label" htmlFor="login-password">
                    Password
                  </label>
                  <input
                    id="login-password"
                    type="password"
                    className="field py-1.5 text-xs"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </div>
                <button
                  type="submit"
                  className="btn btn-accent w-full py-1.5 text-xs"
                  disabled={!ready || authBusy}
                >
                  {authBusy ? (
                    <Spinner className="h-3.5 w-3.5" />
                  ) : (
                    <LogIn className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {authBusy ? 'Signing in…' : 'Sign in'}
                </button>
                <InlineError error={error} />
                <p className="text-2xs leading-relaxed text-faint">
                  A failed attempt says the same thing whether the username or the password was
                  wrong, so this form cannot be used to find out which accounts exist.
                </p>
              </form>
            )}
          </div>

          <Link
            to="/"
            className="mt-3 inline-flex items-center gap-1.5 text-2xs text-dim hover:text-accent"
          >
            Continue without signing in
            <ArrowRight className="h-3 w-3" aria-hidden />
          </Link>
          <p className="mt-1 text-2xs leading-relaxed text-faint">
            Reading risk, forecasts, the archive and the map needs no account, and neither does
            filing a hazard report.
          </p>
        </div>

        <div className="min-w-0 space-y-3">
          <div className="panel p-4">
            <p className="flex items-baseline gap-2 font-display text-xs font-semibold uppercase tracking-wider text-dim">
              <KeyRound className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
              Demo accounts
            </p>
            {accounts.loading ? (
              <p className="mt-2 flex items-center gap-2 text-2xs text-faint">
                <Spinner className="h-3 w-3" />
                asking the backend which accounts exist
              </p>
            ) : accounts.data && accounts.data.accounts.length > 0 ? (
              <div className="mt-2 space-y-1.5">
                {accounts.data.accounts.map((account) => (
                  <AccountRow
                    key={account.username}
                    username={account.username}
                    password={account.password}
                    role={account.role}
                    fullName={account.full_name}
                    organisation={account.organisation}
                    active={username === account.username}
                    onUse={() => fill(account)}
                  />
                ))}
              </div>
            ) : (
              <p className="mt-2 text-2xs leading-relaxed text-faint">
                {accounts.data?.note ??
                  'The account list could not be read. Sign in with an account from your own database.'}
              </p>
            )}
            {accounts.data && accounts.data.accounts.length > 0 && (
              <p className="mt-2 text-2xs leading-relaxed text-faint">
                {accounts.data.note} Tap one to fill the form.
              </p>
            )}
            <InlineError error={accounts.error} className="mt-2" />
          </div>

          <div className="panel p-4">
            <p className="font-display text-xs font-semibold uppercase tracking-wider text-dim">
              What each role may do
            </p>
            {roles.data ? (
              <>
                <div className="mt-2 space-y-2">
                  {roles.data.roles.map((spec) => (
                    <div key={spec.role} className="min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span
                          className={cx(
                            'shrink-0 rounded-full border px-1.5 py-px font-mono text-[10px] uppercase tracking-wider',
                            ROLE_TONE[spec.role],
                          )}
                        >
                          {spec.role}
                        </span>
                        <span className="truncate text-xs font-semibold text-ink">
                          {spec.label}
                        </span>
                      </div>
                      <p className="mt-0.5 text-2xs leading-relaxed text-dim">
                        {spec.description}
                      </p>
                    </div>
                  ))}
                </div>
                <p className="mt-2.5 text-2xs leading-relaxed text-faint">{roles.data.note}</p>
              </>
            ) : (
              <p className="mt-2 text-2xs text-faint">
                {roles.loading ? 'Reading the role model…' : 'The role model could not be read.'}
              </p>
            )}
          </div>

          <div className="panel p-4">
            <p className="flex items-start gap-2 text-2xs leading-relaxed text-risk-moderate">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                This is a demonstration deployment. The passwords above are seeded and published on
                purpose, and the token is signed with a secret that ships in the repository — treat
                nothing here as a security boundary. The role check that matters runs on the server
                for every write, not in this browser. Before putting the platform anywhere
                reachable, set <span className="font-mono text-ink">SEED_DEMO_USERS=false</span> and
                change <span className="font-mono text-ink">JWT_SECRET</span>.
              </span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
