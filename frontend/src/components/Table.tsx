/**
 * The table every list on the platform is drawn with.
 *
 * Hand-rolled rather than pulled from a data-grid library, because what these
 * screens need is narrow and specific: mono numerals that do not reflow when
 * they update, column sorting, a row that can be selected, per-row severity
 * tinting, and columns that drop out on a phone instead of forcing a horizontal
 * scroll. A grid library would bring virtualisation, its own theme and a
 * thousand lines of features this platform never shows.
 *
 * Sorting is done in the browser and deliberately so. The API already limits
 * each list, and re-sorting a hundred alerts locally is instant; asking the
 * backend to re-sort would make clicking a column header a network round trip
 * that can fail. What this table does *not* do is paginate - the endpoints take
 * a `limit`, and a screen that needs more than one page asks for a bigger one.
 *
 * `columns` is a plain array of objects rather than `<Column>` children, so a
 * page can build its column set conditionally - the officer view of the alert
 * table has an actions column that the citizen view must not render at all.
 */
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { cx } from '../lib/risk';
import { EmptyState } from './States';

export type SortDirection = 'asc' | 'desc';

/** Values a column can be sorted on. `null` always sorts last, both ways. */
export type SortValue = number | string | null;

export interface Column<T> {
  /** Stable identity for the sort state. Not necessarily a field name. */
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Provide to make the column sortable. Omit and the header is inert. */
  sort?: (row: T) => SortValue;
  align?: 'left' | 'right';
  /** Tailwind width class, e.g. `w-24`, for a column that must not wobble. */
  width?: string;
  /** Header tooltip - where the figure comes from, or what it excludes. */
  hint?: string;
  /** Drop the column below this breakpoint. Eight columns do not fit a phone. */
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl';
}

/**
 * Written out in full rather than built by string concatenation, so Tailwind's
 * content scanner can actually see the class names in this file.
 */
const HIDE_BELOW: Record<NonNullable<Column<unknown>['hideBelow']>, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
};

interface SortState {
  key: string;
  direction: SortDirection;
}

/**
 * Compare two cell values.
 *
 * Missing values sort last in both directions, which is the only behaviour that
 * is not misleading: an alert with no acknowledgement time is not "earliest",
 * and a region with no recorded history is not "safest".
 */
function compare(a: SortValue, b: SortValue, direction: SortDirection): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const order =
    typeof a === 'number' && typeof b === 'number'
      ? a - b
      : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  return direction === 'asc' ? order : -order;
}

function SortIcon({ state }: { state: SortDirection | null }) {
  const shared = 'h-3 w-3 shrink-0';
  if (state === 'asc') return <ArrowUp className={cx(shared, 'text-accent')} aria-hidden />;
  if (state === 'desc') return <ArrowDown className={cx(shared, 'text-accent')} aria-hidden />;
  // Held at low opacity rather than hidden: an invisible affordance is not one.
  return <ChevronsUpDown className={cx(shared, 'text-faint opacity-40')} aria-hidden />;
}

function HeaderCell<T>({
  column,
  sort,
  onSort,
}: {
  column: Column<T>;
  sort: SortState | null;
  onSort: (key: string) => void;
}) {
  const sortable = Boolean(column.sort);
  const active = sort?.key === column.key ? sort.direction : null;
  const right = column.align === 'right';

  return (
    <th
      scope="col"
      className={cx(
        'sticky top-0 z-10 whitespace-nowrap border-b border-hairline bg-panel/95 px-2.5 py-2 font-mono text-[10px] font-medium uppercase tracking-wider text-faint backdrop-blur',
        right ? 'text-right' : 'text-left',
        column.width,
        column.hideBelow && HIDE_BELOW[column.hideBelow],
      )}
      aria-sort={active ? (active === 'asc' ? 'ascending' : 'descending') : undefined}
      title={column.hint}
    >
      {sortable ? (
        <button
          type="button"
          className={cx(
            'flex w-full items-center gap-1 uppercase tracking-wider transition-colors hover:text-accent',
            right && 'justify-end',
            active && 'text-accent',
          )}
          onClick={() => onSort(column.key)}
        >
          <span className="truncate">{column.header}</span>
          <SortIcon state={active} />
        </button>
      ) : (
        <span className="block truncate">{column.header}</span>
      )}
    </th>
  );
}

export interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  /** Must be stable across refreshes, or React re-mounts every row on a poll. */
  rowKey: (row: T) => string | number;
  /** Makes rows clickable. Rows also respond to Enter and Space when set. */
  onRowClick?: (row: T) => void;
  /** Marks the selected row - the alert whose detail panel is open. */
  isActive?: (row: T) => boolean;
  /** Per-row classes, used for severity tinting (a CRITICAL row reads red). */
  rowClassName?: (row: T) => string | undefined;
  /** Sort applied on first render. Users can change it; this is only the start. */
  initialSort?: SortState;
  /** Shown when `rows` is empty. Loading is the caller's job, not the table's. */
  empty?: ReactNode;
  emptyTitle?: string;
  emptyHint?: string;
  /** Tighter rows, for a table inside a side panel. */
  dense?: boolean;
  /** Height cap for the scroller, e.g. `max-h-[28rem]`. Header stays put. */
  maxHeight?: string;
  className?: string;
  /** Screen-reader description of the list. */
  caption?: string;
}

/**
 * A sortable table over an array the caller has already fetched.
 *
 * The table renders `rows` and nothing else - it does not fetch, poll or know
 * about loading. Pages wrap it in `ResourceBody`, which owns the skeleton, the
 * error and the stale-data note, so a failed refresh keeps the last good list on
 * screen rather than blanking a screen an officer may be reading from.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  isActive,
  rowClassName,
  initialSort,
  empty,
  emptyTitle = 'Nothing to show',
  emptyHint,
  dense = false,
  maxHeight,
  className,
  caption,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<SortState | null>(initialSort ?? null);

  /**
   * Third click clears the sort rather than cycling back to ascending, so the
   * order the API returned - which is usually "newest first", and meaningful -
   * can be got back without reloading the page.
   */
  function toggle(key: string) {
    setSort((current) => {
      if (current?.key !== key) return { key, direction: 'desc' };
      if (current.direction === 'desc') return { key, direction: 'asc' };
      return null;
    });
  }

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((item) => item.key === sort.key);
    if (!column?.sort) return rows;
    const pick = column.sort;
    // Copied first: sorting the caller's array in place would mutate the
    // resource's own data and make the next render order-dependent.
    return [...rows].sort((a, b) => compare(pick(a), pick(b), sort.direction));
  }, [rows, columns, sort]);

  if (!rows.length) {
    return <>{empty ?? <EmptyState title={emptyTitle} hint={emptyHint} />}</>;
  }

  const pad = dense ? 'px-2.5 py-1.5' : 'px-2.5 py-2';

  return (
    <div
      className={cx(
        'min-w-0 overflow-x-auto',
        maxHeight && 'overflow-y-auto',
        maxHeight,
        className,
      )}
    >
      <table className="w-full min-w-full border-collapse text-xs">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => (
              <HeaderCell key={column.key} column={column} sort={sort} onSort={toggle} />
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const active = isActive?.(row) ?? false;
            const clickable = Boolean(onRowClick);
            return (
              <tr
                key={rowKey(row)}
                className={cx(
                  'border-b border-hairline/60 transition-colors last:border-0',
                  clickable && 'cursor-pointer',
                  active ? 'bg-accent/10' : clickable && 'hover:bg-raised/60',
                  rowClassName?.(row),
                )}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={
                  onRowClick
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
                tabIndex={clickable ? 0 : undefined}
                aria-selected={clickable ? active : undefined}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cx(
                      'align-middle text-dim',
                      pad,
                      column.align === 'right' ? 'text-right' : 'text-left',
                      column.width,
                      column.hideBelow && HIDE_BELOW[column.hideBelow],
                    )}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------- cell helpers

/**
 * A figure in a cell: mono, tabular, and bright enough to be the thing the eye
 * lands on. `tnum` is what stops a risk score from shifting the column sideways
 * when 8 becomes 88 on the next poll.
 */
export function NumCell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <span className={cx('tnum font-mono text-ink', className)}>{children}</span>;
}

/**
 * Two stacked lines in one cell - a name above the place it is in.
 *
 * Used by every list that has a location column, so the alert table, the history
 * table and the citizen queue all put the same information in the same shape.
 */
export function TwoLine({
  primary,
  secondary,
  className,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
  className?: string;
}) {
  return (
    <span className={cx('block min-w-0', className)}>
      <span className="block truncate text-ink">{primary}</span>
      {secondary !== undefined && secondary !== null && (
        <span className="block truncate text-2xs text-faint">{secondary}</span>
      )}
    </span>
  );
}

/**
 * The buttons at the end of a row.
 *
 * Stops the click from reaching the row, so pressing "Acknowledge" on the alert
 * table acknowledges the alert instead of also opening its detail panel. Without
 * this the two actions fight, and the one that wins depends on event order.
 */
export function RowActions({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx('flex items-center justify-end gap-1', className)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      role="presentation"
    >
      {children}
    </span>
  );
}

