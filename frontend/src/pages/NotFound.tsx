/**
 * The fallback route.
 *
 * A 404 inside a single-page app is nearly always a stale link or a typed path,
 * so this offers the real destinations rather than an apology. The list is `NAV`
 * itself, filtered by what this visitor may actually open - suggesting the
 * officer desk to an anonymous visitor would only send them into a guard.
 */
import { Compass, MoveLeft } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { NAV } from '../components/AppShell';
import { usePlatform } from '../state/PlatformContext';
import { cx } from '../lib/risk';

export default function NotFound() {
  const { capabilities } = usePlatform();
  const location = useLocation();
  const navigate = useNavigate();

  const open = NAV.filter((entry) => {
    if (entry.gate === 'admin') return capabilities.is_admin;
    if (entry.gate === 'officer') {
      return capabilities.can_manage_alerts || capabilities.can_review_reports;
    }
    return true;
  });

  return (
    <div className="mx-auto max-w-2xl py-8">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-panel border border-hairline bg-raised/60">
          <Compass className="h-5 w-5 text-accent" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="font-mono text-2xs uppercase tracking-widest text-faint">404</p>
          <h1 className="font-display text-lg font-semibold text-ink">No screen at that path</h1>
          <p className="mt-1 text-xs leading-relaxed text-dim">
            Nothing on this platform answers to{' '}
            <span className="font-mono text-ink">{location.pathname}</span>. Every screen the
            platform has is listed below.
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-1.5 sm:grid-cols-2">
        {open.map((entry) => (
          <Link
            key={entry.to}
            to={entry.to}
            className={cx(
              'group flex items-start gap-2.5 rounded-panel border border-hairline bg-raised/30 px-3 py-2.5',
              'transition-colors hover:border-accent/40 hover:bg-accent/5',
            )}
          >
            <entry.icon
              className="mt-0.5 h-4 w-4 shrink-0 text-faint group-hover:text-accent"
              aria-hidden
            />
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-ink">{entry.label}</span>
              <span className="block text-2xs leading-tight text-faint">{entry.hint}</span>
            </span>
          </Link>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-ghost" onClick={() => navigate(-1)}>
          <MoveLeft className="h-3.5 w-3.5" aria-hidden />
          Back to where you were
        </button>
        <Link to="/" className="btn btn-accent">
          Command centre
        </Link>
      </div>

      {!capabilities.can_review_reports && (
        <p className="mt-4 text-2xs leading-relaxed text-faint">
          Two screens are missing from that list on purpose: the officer desk and administration are
          only shown to accounts that can use them. Signing in adds them.
        </p>
      )}
    </div>
  );
}
