/**
 * The data-fetching hook every screen uses.
 *
 * Four behaviours here are deliberate, and each one comes from a way that a
 * live dashboard normally goes wrong.
 *
 * A failed refresh does not blank the screen. `data` from the last good
 * response stays put and `error` is set alongside it, so a panel showing a
 * CRITICAL region keeps showing it when one poll times out. Wiping the display
 * on a transient error is the worst possible behaviour for a warning tool.
 *
 * `loading` and `refreshing` are separate. The first load gets a skeleton; a
 * background poll gets a quiet indicator in the panel header and nothing else.
 * The screen must not flash every few seconds.
 *
 * Polling stops when the tab is hidden. A country-wide re-score is 74 model
 * evaluations, and there is no reason to spend them on a tab nobody is looking
 * at; the next poll after the tab is revealed catches up immediately.
 *
 * Every request is abortable, and a superseded request is abandoned rather than
 * allowed to resolve late and overwrite a newer answer.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, asApiError, isAbort } from '../services/api';

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  /** No data yet and a request is in flight. */
  loading: boolean;
  /** Data is on screen and a newer request is in flight. */
  refreshing: boolean;
  /** When `data` last arrived, for the "updated 12 s ago" line. */
  updatedAt: Date | null;
  /** Fetch again now. Wired to retry buttons and to manual refresh. */
  reload: () => void;
}

export interface ResourceOptions {
  /** Poll interval. Omit or pass 0 for a one-shot fetch. */
  pollSeconds?: number;
  /** When false, nothing is fetched - for a panel whose region is not chosen yet. */
  enabled?: boolean;
}
/**
 * @param fetcher receives an `AbortSignal` and must pass it to the API call.
 * @param deps    refetch when any of these change - region id, filters, and the
 *                platform `version` that a scenario change bumps.
 */
export function useResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: ResourceOptions = {},
): Resource<T> {
  const { pollSeconds = 0, enabled = true } = options;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [tick, setTick] = useState(0);

  // The fetcher is a new closure on every render. Held in a ref so it never
  // becomes a reason to refetch - `deps` is the only thing that decides that.
  const latest = useRef(fetcher);
  latest.current = fetcher;

  const hasData = useRef(false);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let live = true;

    if (hasData.current) setRefreshing(true);
    else setLoading(true);

    latest
      .current(controller.signal)
      .then((result) => {
        if (!live) return;
        hasData.current = true;
        setData(result);
        setError(null);
        setUpdatedAt(new Date());
      })
      .catch((cause: unknown) => {
        if (!live || isAbort(cause)) return;
        // Data already on screen is kept: a stale reading with a visible
        // warning beats an empty panel.
        setError(asApiError(cause));
      })
      .finally(() => {
        if (!live) return;
        setLoading(false);
        setRefreshing(false);
      });

    return () => {
      live = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, enabled]);
  // Polling, paused while the tab is hidden.
  useEffect(() => {
    if (!enabled || pollSeconds <= 0) return;

    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, pollSeconds * 1000);

    // Coming back to the tab should show current numbers straight away rather
    // than whatever was true when it was last looked at.
    const onVisible = () => {
      if (document.visibilityState === 'visible') reload();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, pollSeconds, reload]);

  return { data, error, loading, refreshing, updatedAt, reload };
}

/**
 * A resource that is fetched once and then only on demand.
 *
 * For things that do not change while the app is open: the role table, the
 * report form's dropdown options, the model card.
 */
export function useStatic<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[] = [],
): Resource<T> {
  return useResource(fetcher, deps);
}

/** A ticking clock, for the header readout. Cheap: one state update a second. */
export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

