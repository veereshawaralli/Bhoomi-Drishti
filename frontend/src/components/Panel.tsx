/**
 * The panel every screen is assembled from, and the wrapper that gives it its
 * loading, error, stale and empty states for free.
 *
 * `ResourceBody` exists because those four states have to be handled on every
 * one of roughly forty panels, and a screen that handles them by hand will
 * eventually handle one of them wrongly - usually by blanking real data when a
 * poll fails. Passing a `Resource<T>` through here makes the correct behaviour
 * the default and the render function only ever sees data that arrived.
 */
import type { ReactNode } from 'react';

import { cx } from '../lib/risk';
import type { Resource } from '../state/useResource';
import { ErrorState, PanelLoading, StaleNote } from './States';

export interface PanelProps {
  title?: ReactNode;
  /** Small line beside the title: provenance, a count, "updated 12 s ago". */
  note?: ReactNode;
  /** Right-hand side of the head - chips, filters, buttons. */
  right?: ReactNode;
  /** A background refresh is in flight. Shows a quiet dot, never a spinner
   *  over the data: the screen must not flash every few seconds. */
  busy?: boolean;
  /** Drop the body padding, for a map, a table or a chart that bleeds. */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}

export function Panel({
  title,
  note,
  right,
  busy,
  flush,
  className,
  bodyClassName,
  children,
}: PanelProps) {
  const head = title || note || right || busy;
  return (
    <section className={cx('panel flex min-w-0 flex-col', className)}>
      {head && (
        <header className="panel-head">
          <div className="flex min-w-0 items-baseline gap-2">
            {title && <h2 className="panel-title truncate">{title}</h2>}
            {note && <span className="truncate text-2xs text-faint">{note}</span>}
            {busy && (
              <span
                className="h-1.5 w-1.5 shrink-0 animate-blip rounded-full bg-accent"
                title="Refreshing"
                aria-label="Refreshing"
              />
            )}
          </div>
          {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
        </header>
      )}
      <div className={cx('min-w-0 flex-1', flush ? '' : 'p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export interface ResourceBodyProps<T> {
  resource: Resource<T>;
  /** Render function. Only ever called with data that actually arrived. */
  children: (data: T) => ReactNode;
  /** Shown when the request succeeded but carried nothing, and before a
   *  disabled resource has anything to fetch. */
  empty?: ReactNode;
  /** Decides "succeeded but carried nothing" - usually `(d) => !d.items.length`. */
  isEmpty?: (data: T) => boolean;
  loadingRows?: number;
  loadingLabel?: string;
}

/**
 * Order matters here.
 *
 * Data wins over error, because a stale reading with a visible warning is more
 * useful than an empty panel. Error wins over loading, so a failure is not
 * hidden behind a skeleton on the next poll. Loading only shows when there is
 * genuinely nothing yet.
 */
export function ResourceBody<T>({
  resource,
  children,
  empty,
  isEmpty,
  loadingRows,
  loadingLabel,
}: ResourceBodyProps<T>) {
  const { data, error, loading, reload } = resource;

  if (data !== null) {
    const blank = isEmpty ? isEmpty(data) : false;
    return (
      <>
        {error && <StaleNote error={error} onRetry={reload} className="mb-3" />}
        {blank ? empty ?? null : children(data)}
      </>
    );
  }
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading) return <PanelLoading rows={loadingRows} label={loadingLabel} />;
  return <>{empty ?? null}</>;
}
