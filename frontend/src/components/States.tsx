/**
 * What a panel shows when it is not showing data.
 *
 * A monitoring screen is judged on its worst moment, not its best one, so each
 * of these states is written as carefully as the data itself.
 *
 * `ErrorState` distinguishes "the backend refused" from "the backend is not
 * running", because the second has an obvious fix and the first does not, and
 * it offers a retry only when retrying the identical request could plausibly
 * work - a 422 button that fails identically every time is a fake button.
 *
 * `StaleNote` is the case that matters most: data already on screen, a refresh
 * that just failed. The reading stays visible and this strip says how old it is.
 * Blanking a panel showing a CRITICAL region because one poll timed out would be
 * the worst possible behaviour for a warning tool.
 */
import { AlertTriangle, Inbox, Loader2, PlugZap, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';

import { cx } from '../lib/risk';
import type { ApiError } from '../services/api';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('h-4 w-4 animate-spin', className)} aria-hidden />;
}

/**
 * A shimmering placeholder block. Uses the `sweep` keyframe rather than a pulse
 * so several skeletons in a column do not blink in lockstep and read as an error.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cx('relative overflow-hidden rounded-panel bg-raised/70', className)}
      aria-hidden
    >
      <span className="absolute inset-y-0 -left-1/3 w-1/3 animate-sweep bg-gradient-to-r from-transparent via-white/5 to-transparent" />
    </div>
  );
}

/** Skeleton lines at text height, for a list or a paragraph. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cx('space-y-2', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={cx('h-3', index === lines - 1 ? 'w-2/3' : 'w-full')}
        />
      ))}
    </div>
  );
}

/** The first-load state for a panel of unknown height. */
export function PanelLoading({ label = 'Loading', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="p-4" role="status" aria-live="polite">
      <div className="mb-3 flex items-center gap-2 font-mono text-2xs uppercase tracking-wider text-faint">
        <Spinner className="h-3 w-3" />
        {label}
      </div>
      <SkeletonText lines={rows} />
    </div>
  );
}

/**
 * A failed request, with the one honest thing to do about it.
 *
 * `title` overrides the heading for a panel where "Could not load" is too vague.
 */
export function ErrorState({
  error,
  onRetry,
  title,
  className,
}: {
  error: ApiError;
  onRetry?: () => void;
  title?: string;
  className?: string;
}) {
  const offline = error.offline || error.status === 0;
  const Icon = offline ? PlugZap : AlertTriangle;
  return (
    <div
      className={cx('flex flex-col items-start gap-3 p-4', className)}
      role="alert"
    >
      <div className="flex items-start gap-2.5">
        <Icon
          className={cx('mt-0.5 h-4 w-4 shrink-0', offline ? 'text-risk-moderate' : 'text-risk-high')}
          aria-hidden
        />
        <div className="space-y-1">
          <p className="font-display text-xs font-semibold uppercase tracking-wider text-ink">
            {title ?? (offline ? 'Backend unreachable' : 'Could not load')}
          </p>
          <p className="max-w-prose text-xs leading-relaxed text-dim">{error.message}</p>
          <p className="font-mono text-2xs text-faint">
            {error.status > 0 ? `HTTP ${error.status} · ` : ''}
            {error.path}
          </p>
        </div>
      </div>
      {onRetry && error.retryable && (
        <button type="button" className="btn btn-ghost px-2 py-1" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Retry
        </button>
      )}
    </div>
  );
}

/** One line of red, for a form or a mutation that failed. */
export function InlineError({
  error,
  className,
}: {
  error: ApiError | string | null;
  className?: string;
}) {
  if (!error) return null;
  const message = typeof error === 'string' ? error : error.message;
  return (
    <p
      className={cx('flex items-start gap-1.5 text-xs leading-relaxed text-risk-high', className)}
      role="alert"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{message}</span>
    </p>
  );
}

/**
 * A refresh failed while data was on screen. The data stays; this says so.
 * Rendered as a strip inside the panel rather than as a modal, because the
 * reading behind it is still the most useful thing on the screen.
 */
export function StaleNote({
  error,
  onRetry,
  className,
}: {
  error: ApiError;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cx(
        'flex items-center gap-2 rounded-panel border border-risk-moderate/30 bg-risk-moderate/10 px-3 py-1.5',
        className,
      )}
      role="status"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-risk-moderate" aria-hidden />
      <span className="text-2xs leading-tight text-risk-moderate">
        Last refresh failed - showing the previous reading. {error.message}
      </span>
      {onRetry && (
        <button
          type="button"
          className="ml-auto shrink-0 font-mono text-2xs uppercase tracking-wider text-risk-moderate underline decoration-dotted hover:text-ink"
          onClick={onRetry}
        >
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * Nothing to show, and that is a legitimate answer.
 *
 * Distinct from an error on purpose: "no alerts anywhere in the country" is the
 * best possible state of this platform and must not look like a broken panel.
 */
export function EmptyState({
  title,
  hint,
  icon,
  className,
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-col items-center gap-2 px-4 py-10 text-center', className)}>
      <span className="text-faint" aria-hidden>
        {icon ?? <Inbox className="h-5 w-5" />}
      </span>
      <p className="font-display text-xs font-semibold uppercase tracking-wider text-dim">
        {title}
      </p>
      {hint && <p className="max-w-xs text-xs leading-relaxed text-faint">{hint}</p>}
    </div>
  );
}
