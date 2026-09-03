/**
 * Choosing a region: a list, a dropdown, and a plain select.
 *
 * The whole region table is fetched once and filtered in the browser. The API
 * accepts `q` and `state` server-side, but the monitored network is a few dozen
 * regions, so a round trip per keystroke would buy nothing and cost a debounce,
 * a race between superseded responses, and a search box that stutters while an
 * officer types. Filtering in memory is instant and cannot get out of order.
 *
 * Three shapes are exported because three different jobs need one:
 * `RegionList` for a panel that is always showing its list, `RegionPicker` for
 * a header or a toolbar where the list has to fold away, and `RegionSelect` for
 * a form field that sits in a column of other form fields and should look like
 * one. All three read the same fetch, so none of them can show a different
 * network from the others.
 */
import { Check, ChevronDown, MapPin, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { count as fmtCount, place } from '../lib/format';
import { cx } from '../lib/risk';
import { api } from '../services/api';
import { usePlatform } from '../state/PlatformContext';
import { useResource, type Resource } from '../state/useResource';
import type { Region, RegionListResponse } from '../types/api';
import { EmptyState, InlineError, SkeletonText } from './States';

/**
 * The monitored network, fetched once.
 *
 * Keyed on the platform `version` so a manual refresh retries it - the usual
 * reason this list is empty is that the backend was not running at boot.
 */
export function useRegions(): Resource<RegionListResponse> {
  const { version } = usePlatform();
  return useResource<RegionListResponse>((signal) => api.regions({ limit: 500 }, signal), [
    version,
  ]);
}

/** Lower-cased haystack for one region: name, district, state and code. */
function haystack(region: Region): string {
  return `${region.name} ${region.district} ${region.state} ${region.code}`.toLowerCase();
}

/** Every whitespace-separated token must appear somewhere. "kerala idu" works. */
export function filterRegions(
  regions: Region[],
  query: string,
  state?: string | null,
): Region[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return regions.filter((region) => {
    if (state && region.state !== state) return false;
    if (!tokens.length) return true;
    const text = haystack(region);
    return tokens.every((token) => text.includes(token));
  });
}

// ----------------------------------------------------------- state dropdown

/**
 * The states present in the network, from the API's own `states` array rather
 * than derived from the rows - the backend already computed it, and deriving it
 * again would quietly disagree if a region were ever filtered out server-side.
 */
export function StateFilter({
  value,
  onChange,
  states,
  className,
  allLabel = 'All states',
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  states: string[];
  className?: string;
  allLabel?: string;
}) {
  return (
    <select
      className={cx('field py-1.5 text-xs', className)}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || null)}
      aria-label="Filter by state"
    >
      <option value="">{allLabel}</option>
      {states.map((state) => (
        <option key={state} value={state}>
          {state}
        </option>
      ))}
    </select>
  );
}

// ------------------------------------------------------------------- the list

function RegionRow({
  region,
  active,
  onPick,
}: {
  region: Region;
  active: boolean;
  onPick: (region: Region) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={cx(
          'flex w-full items-center gap-2 border-l-2 px-2.5 py-1.5 text-left transition-colors',
          active
            ? 'border-accent bg-accent/10'
            : 'border-transparent hover:border-accent/50 hover:bg-raised/70',
        )}
        onClick={() => onPick(region)}
        aria-current={active}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cx('truncate text-xs', active ? 'text-accent' : 'text-ink')}>
              {region.name}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-faint">{region.code}</span>
          </span>
          <span className="block truncate text-2xs text-faint">
            {place(region.district, region.state)}
          </span>
        </span>
        {region.historical_landslide_count !== null && (
          <span
            className="tnum shrink-0 font-mono text-2xs text-faint"
            title="Recorded landslides in the archive for this region"
          >
            {fmtCount(region.historical_landslide_count)}
          </span>
        )}
        {active && <Check className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />}
      </button>
    </li>
  );
}

/**
 * Search field, state filter and a scrolling list of regions.
 *
 * The count line under the search box is not filler: with a filter applied it is
 * the only way to tell "no results" apart from "the list is still loading", and
 * during a demonstration it confirms out loud how many regions are monitored.
 */
export function RegionList({
  selectedId,
  onPick,
  className,
  listClassName = 'max-h-72',
  showSearch = true,
  showStates = true,
  autoFocusSearch = false,
}: {
  selectedId?: number | null;
  onPick: (region: Region) => void;
  className?: string;
  /** Height cap for the scroller - a dropdown wants less than a sidebar. */
  listClassName?: string;
  showSearch?: boolean;
  showStates?: boolean;
  autoFocusSearch?: boolean;
}) {
  const regions = useRegions();
  const [query, setQuery] = useState('');
  const [state, setState] = useState<string | null>(null);

  const data = regions.data;
  const rows = useMemo(
    () => filterRegions(data?.regions ?? [], query, state),
    [data, query, state],
  );
  const total = data?.count ?? 0;
  const filtered = Boolean(query.trim() || state);

  return (
    <div className={cx('flex min-w-0 flex-col', className)}>
      {(showSearch || showStates) && (
        <div className="space-y-1.5 border-b border-hairline p-2">
          {showSearch && (
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint"
                aria-hidden
              />
              <input
                type="search"
                className="field py-1.5 pl-7 pr-7 text-xs"
                placeholder="Search region, district or state"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                autoFocus={autoFocusSearch}
                aria-label="Search regions"
              />
              {query && (
                <button
                  type="button"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-faint hover:text-accent"
                  onClick={() => setQuery('')}
                  title="Clear search"
                >
                  <X className="h-3 w-3" aria-hidden />
                  <span className="sr-only">Clear search</span>
                </button>
              )}
            </div>
          )}
          {showStates && data && data.states.length > 1 && (
            <StateFilter value={state} onChange={setState} states={data.states} />
          )}
          <p className="font-mono text-[10px] uppercase tracking-wider text-faint">
            {filtered
              ? `${fmtCount(rows.length)} of ${fmtCount(total)} monitored regions`
              : `${fmtCount(total)} monitored regions`}
          </p>
        </div>
      )}

      {/* Error and data are not exclusive: a failed refresh keeps the last list
          on screen with the warning above it. */}
      {regions.error && !data && (
        <div className="p-2">
          <InlineError error={regions.error} />
        </div>
      )}
      {regions.error && data && (
        <p className="px-2.5 py-1 text-2xs text-risk-moderate">
          Region list may be stale - {regions.error.message}
        </p>
      )}

      {!data && regions.loading && <SkeletonText lines={5} className="p-2.5" />}

      {data && rows.length === 0 && (
        <EmptyState
          title="No region matches"
          hint="Try a district or state name, or clear the filter."
          icon={<MapPin className="h-5 w-5" />}
        />
      )}

      {rows.length > 0 && (
        <ul className={cx('min-w-0 overflow-y-auto py-1', listClassName)}>
          {rows.map((region) => (
            <RegionRow
              key={region.id}
              region={region}
              active={region.id === selectedId}
              onPick={onPick}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// --------------------------------------------------------------- the dropdown

/**
 * The list, folded into a button.
 *
 * Closes on Escape and on a pointer press outside itself. `pointerdown` rather
 * than `click`, so the panel is gone before the press lands on whatever is
 * underneath - closing on `click` lets the first press outside be swallowed.
 *
 * The panel is absolutely positioned rather than portalled, and sits at
 * `z-[800]` so it clears Leaflet's own controls when this picker is used in a
 * toolbar above the map.
 */
export function RegionPicker({
  selected,
  onPick,
  placeholder = 'Select a region',
  className,
  align = 'left',
}: {
  selected: Region | null;
  onPick: (region: Region) => void;
  placeholder?: string;
  className?: string;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: PointerEvent) {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={cx('relative min-w-0', className)} ref={box}>
      <button
        type="button"
        className="btn w-full justify-between px-2.5 py-1.5 normal-case tracking-normal"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <MapPin className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
          <span className="min-w-0 truncate font-sans text-xs font-normal">
            {selected ? selected.name : <span className="text-faint">{placeholder}</span>}
          </span>
        </span>
        <ChevronDown
          className={cx('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>

      {open && (
        <div
          className={cx(
            'absolute top-full z-[800] mt-1 w-72 max-w-[85vw] animate-rise overflow-hidden rounded-panel border border-hairbright bg-panel shadow-bezel backdrop-blur',
            align === 'right' ? 'right-0' : 'left-0',
          )}
          role="listbox"
        >
          <RegionList
            selectedId={selected?.id ?? null}
            onPick={(region) => {
              onPick(region);
              setOpen(false);
            }}
            listClassName="max-h-64"
            autoFocusSearch
          />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- form control

/**
 * A native select, for a form.
 *
 * A form should look like a form: one control per row, tab order that works,
 * and the platform's own validation summary at the bottom. A custom dropdown in
 * the middle of the citizen report would be a worse experience on a phone, which
 * is where that report is most likely to be filed.
 */
export function RegionSelect({
  value,
  onChange,
  includeBlank = true,
  blankLabel = 'No specific region',
  className,
  id,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  includeBlank?: boolean;
  blankLabel?: string;
  className?: string;
  id?: string;
}) {
  const regions = useRegions();
  const rows = regions.data?.regions ?? [];

  return (
    <div className="min-w-0">
      <select
        id={id}
        className={cx('field', className)}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}
        disabled={rows.length === 0}
      >
        {includeBlank && <option value="">{blankLabel}</option>}
        {rows.length === 0 && !includeBlank && <option value="">Loading regions…</option>}
        {rows.map((region) => (
          <option key={region.id} value={region.id}>
            {region.name} — {place(region.district, region.state)}
          </option>
        ))}
      </select>
      {regions.error && <InlineError error={regions.error} className="mt-1" />}
    </div>
  );
}

/**
 * The platform's selected region, resolved from an id to a whole `Region`.
 *
 * The context holds only the id, because that is what survives a scenario reload
 * and what the API is called with. Screens that need the name and coordinates
 * resolve it here.
 *
 * Each caller fetches its own copy of the region list. That is deliberate: the
 * payload is small and does not change while the app is open, so a shared cache
 * would add invalidation rules to save one request.
 */
export function useSelectedRegion(): {
  region: Region | null;
  regions: Resource<RegionListResponse>;
  select: (id: number | null) => void;
} {
  const { selectedRegionId, selectRegion } = usePlatform();
  const regions = useRegions();
  const region =
    regions.data?.regions.find((item) => item.id === selectedRegionId) ?? null;
  return { region, regions, select: selectRegion };
}

