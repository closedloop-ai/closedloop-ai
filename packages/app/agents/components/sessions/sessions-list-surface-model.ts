import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import type { GridTableV2Group } from "@repo/design-system/components/ui/grid-table-v2";
import type { TableGroupingState } from "@repo/design-system/components/ui/table-toolbar-model";
import {
  DateRange,
  DEFAULT_DATE_RANGE,
  getStableUtcDateWindowForRange,
} from "../../../shared/lib/format-utils";
import {
  hasAnyActiveSessionFacet,
  type SessionFacetFilters,
} from "../../lib/session-filter-adapter";
import {
  buildSessionsCustomFieldFacetGroups,
  filterSessionsByCustomFields,
  hasSessionsCustomFieldSortColumn,
  type SessionsCustomFieldFilter,
  type SessionsCustomFieldFilters,
  type SessionsCustomFieldsController,
  sessionsCustomFieldGroupContribution,
  sortSessionsByCustomField,
  sortSessionsByStableId,
} from "./sessions-list-custom-fields";
import { applyFacetToggle } from "./sessions-list-facets";
import { ownerId } from "./sessions-list-group-values";
import type { SessionsGroupDropController } from "./sessions-list-interactions";
import {
  buildGroups,
  SORT_OPTIONS,
  sortRows,
} from "./sessions-list-surface-rows";
import {
  EMPTY_SESSIONS_CUSTOM_FIELD_FILTERS,
  isSessionsCustomFieldColumnId,
  SESSIONS_LEAD_SORT_FIELD,
  type SessionsListSortRule,
  type SessionsListViewPatch,
  type SessionsListViewState,
} from "./sessions-list-view-state";

export function resolveSessionsRows({
  customFieldFilters,
  customFields,
  dateRange,
  facets,
  isServerDriven,
  now,
  rows,
  scopeUserId,
  search,
  sorts,
}: {
  customFieldFilters: SessionsCustomFieldFilters;
  customFields?: SessionsCustomFieldsController;
  /**
   * ISS-8217: the selected window, required for the same reason
   * {@link resolveSessionsRows} requires `scopeUserId` — a caller that forgets
   * it fails typecheck instead of silently serving a list the toolbar claims is
   * windowed.
   */
  dateRange: DateRange;
  facets: SessionFacetFilters;
  isServerDriven: boolean;
  /** Injectable clock for the window bound; defaults to the current instant. */
  now?: Date;
  rows: readonly SessionTableRow[];
  /**
   * ISS-8037: the owner scope, required rather than optional so a caller that
   * forgets it fails typecheck instead of silently serving an unscoped list.
   * `null` is the unscoped value.
   */
  scopeUserId: string | null;
  /**
   * ISS-8966: the RESOLVED search term (`resolveSessionsSearchTerm`), required
   * for the same reason `scopeUserId` and `dateRange` are — a caller that
   * forgets it fails typecheck instead of serving a list the chip row claims is
   * searched. `""` is the unsearched value.
   */
  search: string;
  sorts: readonly SessionsListSortRule[];
}) {
  if (isServerDriven) {
    return { filtered: rows, sorted: rows };
  }
  const windowStartMs = resolveSessionsWindowStartMs(dateRange, now);
  const builtInFiltered = rows.filter(
    (row) =>
      // ISS-8037: the scope narrows here too, so it means the same thing in
      // both modes. Counted in `resolveSessionsFiltersActive` and given a chip
      // by the surface either way — a mount where it were merely IGNORED would
      // name a narrowing that never happened.
      (scopeUserId === null || ownerId(row) === scopeUserId) &&
      // ISS-8966: and so does the search, for the identical reason. The count
      // below reports a term as an active filter in BOTH arms, so a client mount
      // that counted one without applying it would offer "Clear filters" over a
      // list nothing had narrowed.
      matchesSessionsSearch(row, search) &&
      isWithinSessionsDateWindow(row, windowStartMs) &&
      (facets.statuses.length === 0 || facets.statuses.includes(row.status)) &&
      (facets.userIds.length === 0 || facets.userIds.includes(ownerId(row)))
  );
  const filtered = customFields
    ? filterSessionsByCustomFields(
        builtInFiltered,
        customFields,
        customFieldFilters
      )
    : builtInFiltered;
  return {
    filtered,
    sorted: sortSessionsByRules(filtered, sorts, customFields),
  };
}

export function resolveSessionsPageSize(
  controlledPageSize: number,
  uncontrolledPageSize: number,
  hasControlledChange: boolean
): number {
  return hasControlledChange ? controlledPageSize : uncontrolledPageSize;
}

function sortSessionsByRules(
  rows: readonly SessionTableRow[],
  sorts: readonly SessionsListSortRule[],
  customFields: SessionsCustomFieldsController | undefined
): SessionTableRow[] {
  const hasCustomFieldSort =
    customFields !== undefined &&
    sorts.some(
      (sort) =>
        isSessionsCustomFieldColumnId(sort.fieldId) &&
        hasSessionsCustomFieldSortColumn(customFields, sort.fieldId)
    );
  let sorted = hasCustomFieldSort ? sortSessionsByStableId(rows) : [...rows];
  for (let index = sorts.length - 1; index >= 0; index -= 1) {
    const sort = sorts[index];
    if (!sort) {
      continue;
    }
    if (customFields && isSessionsCustomFieldColumnId(sort.fieldId)) {
      sorted = sortSessionsByCustomField(
        sorted,
        customFields,
        sort.fieldId,
        sort.direction,
        { preservePriorSortsOnTie: true }
      );
      continue;
    }
    sorted = sortRows(sorted, sort.fieldId, sort.direction);
  }
  return sorted;
}

export function resolveSessionsSortControls(isServerDriven: boolean) {
  if (!isServerDriven) {
    return {
      leadSortKey: SESSIONS_LEAD_SORT_FIELD,
      sortOptions: SORT_OPTIONS,
    } as const;
  }
  return {
    leadSortKey: undefined,
    sortOptions: SORT_OPTIONS.filter(
      (option) => option.id !== SESSIONS_LEAD_SORT_FIELD
    ),
  } as const;
}

export function resolveSessionsFiltersActive({
  customWindowActive,
  dateRange,
  ...nonWindowFilters
}: {
  /**
   * ISS-9107: an explicit `?from=`/`?to=` window owns the read, superseding the
   * preset. Counted for the same reason `search` is: uncounted, a window that
   * matched nothing leaves `filtersActive` false, so the body hands the empty
   * state `hasActiveFilters: false` and a reader with plenty of sessions is told
   * they have none, with no "Clear filters" way back — and here that is
   * unrecoverable, because the preset pill they can reach is already the one
   * they are on.
   */
  customWindowActive: boolean;
  dateRange: DateRange;
} & SessionsNonWindowFilters): boolean {
  if (customWindowActive) {
    return true;
  }
  // ISS-8217: the window counts in BOTH arms, because it now NARROWS in both —
  // server-driven through the host's query, client-side through
  // `resolveSessionsRows`. While only the server arm applied it, a client mount
  // whose window emptied the list rendered the genuinely-empty state: "no
  // sessions yet" at an org with plenty, and no "clear filters" way back.
  if (dateRange !== DEFAULT_DATE_RANGE) {
    return true;
  }
  return resolveSessionsNonWindowFiltersActive(nonWindowFilters);
}

export function resolveSessionsCustomFieldFacetGroups(
  controller: SessionsCustomFieldsController | undefined,
  filters: SessionsCustomFieldFilters,
  onToggle: (columnId: string, value: string) => void,
  onRangeChange: (
    columnId: string,
    next: { min?: number; max?: number }
  ) => void
) {
  if (!controller) {
    return [];
  }
  return buildSessionsCustomFieldFacetGroups(
    controller,
    filters,
    onToggle,
    onRangeChange
  );
}

export function resolveCustomFieldGroups(
  isGrouped: boolean,
  rows: readonly SessionTableRow[],
  grouping: TableGroupingState,
  customFields: SessionsCustomFieldsController | undefined
) {
  if (!isGrouped) {
    return;
  }
  return buildGroups(rows, grouping, (field, row) => {
    if (!(customFields && isSessionsCustomFieldColumnId(field))) {
      return;
    }
    return sessionsCustomFieldGroupContribution(customFields, field, row.id);
  });
}

/**
 * ISS-8216: the two writers behind
 * {@link resolveSessionsCustomFieldFacetGroups}' handlers, in the shape that
 * builder already takes.
 *
 * Each moves the filter AND the page in ONE functional patch, and the toggle
 * takes the RENDERED selection as well as the live one for the two reasons
 * {@link applyFacetToggle} documents — "Clear all" is `clearAllFilters()`
 * followed by one `onToggle` per selected value, synchronously and with no
 * render between, so a toggle deciding direction from the state its predecessor
 * just emptied puts the value straight back. Page 1 because narrowing
 * re-decides which rows fall in which page, so a reader who had paged forward
 * would otherwise keep the later page and have the first matching rows hidden
 * by their own filter (codex review).
 *
 * An absent `customFieldFilters` is a view stored before the axis existed — see
 * {@link SessionsListViewState.customFieldFilters}.
 */
export function resolveSessionsCustomFieldFilterHandlers(
  updateView: (patch: SessionsListViewPatch) => void,
  rendered: SessionsCustomFieldFilters
) {
  return {
    onRangeChange: (
      columnId: string,
      nextRange: { min?: number; max?: number }
    ) =>
      updateView((current) => ({
        customFieldFilters: setCustomFieldRange(
          current.customFieldFilters ?? EMPTY_SESSIONS_CUSTOM_FIELD_FILTERS,
          columnId,
          nextRange
        ),
        page: 0,
      })),
    onToggle: (columnId: string, value: string) =>
      updateView((current) => ({
        customFieldFilters: toggleCustomFieldFilterValue(
          current.customFieldFilters ?? EMPTY_SESSIONS_CUSTOM_FIELD_FILTERS,
          rendered,
          columnId,
          value
        ),
        page: 0,
      })),
  };
}

export function toggleCustomFieldFilterValue(
  current: SessionsCustomFieldFilters,
  rendered: SessionsCustomFieldFilters,
  columnId: string,
  value: string
): SessionsCustomFieldFilters {
  const next = new Map(current);
  next.set(columnId, {
    kind: "options",
    // The CANONICAL toggle the built-in facets already compose "Clear all" with,
    // not a second copy of the same rule — the two filter rows must not be able
    // to disagree about what one replayed click means.
    selectedValues: applyFacetToggle(
      selectedCustomFieldOptions(current.get(columnId)),
      selectedCustomFieldOptions(rendered.get(columnId)),
      value
    ),
  });
  return next;
}

function selectedCustomFieldOptions(
  filter: SessionsCustomFieldFilter | undefined
): readonly string[] {
  return filter?.kind === "options" ? filter.selectedValues : [];
}

export function setCustomFieldRange(
  current: SessionsCustomFieldFilters,
  columnId: string,
  nextRange: { min?: number; max?: number }
): SessionsCustomFieldFilters {
  const next = new Map(current);
  next.set(columnId, { kind: "range", ...nextRange });
  return next;
}

export function toggleSetMember(
  current: ReadonlySet<string>,
  key: string
): Set<string> {
  const next = new Set(current);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

export function resolveAddFieldAction(
  customFields: SessionsCustomFieldsController | undefined,
  setOpen: (open: boolean) => void
): (() => void) | undefined {
  if (!customFields?.onCreateField) {
    return;
  }
  return () => setOpen(true);
}

/**
 * ISS-8217: how often a client-driven mount re-reads the clock behind its date
 * window.
 *
 * The bound is UTC-day quantized, so it moves exactly once a day and this only
 * has to be fine enough that a mount left open across UTC midnight catches up.
 * Hourly costs at most 24 renders a day and bounds the staleness at an hour;
 * anything finer would re-render a large table to re-derive the same instant.
 * The surface disables the timer entirely when the window cannot move — server
 * driven, or an unbounded range.
 */
export const SESSIONS_DATE_WINDOW_TICK_MS = 60 * 60 * 1000;

/**
 * ISS-8217: the window's inclusive lower bound in epoch ms, or `null` when the
 * range is unbounded.
 *
 * Read through `getStableUtcDateWindowForRange` — the SAME helper both Sessions
 * hosts already call to build their server query window (the web page and the
 * desktop view) — rather than a second day-subtraction written here, so a
 * client-side mount and a server-hosted one cannot disagree about where "last
 * 7 days" begins.
 *
 * `all` yields NO bound: the helper returns an empty window for it, so the
 * unbounded case is structural rather than a very large lookback standing in
 * for one, which would silently drop every row older than the stand-in.
 *
 * Only the LOWER bound is applied. The helper's `endDate` is the end of the
 * current UTC day, so honouring it would drop a future-dated row — a clock-skewed
 * producer's session — out of every bounded window while leaving it visible
 * under `all`. "Last N days" is a lookback the reader sets to reach older work;
 * nothing they can select should hide a row for being too RECENT.
 */
function resolveSessionsWindowStartMs(
  dateRange: DateRange,
  now: Date | undefined
): number | null {
  const { startDate } = getStableUtcDateWindowForRange(dateRange, now);
  return startDate === undefined ? null : Date.parse(startDate);
}

/**
 * ISS-8217: whether a row's START instant falls in the window. The session's
 * start is the axis by operator ruling (2026-08-29) — a range means "sessions
 * that BEGAN in this window", chosen over last-activity because it is stable: a
 * row never leaves the window once it is in it.
 *
 * A row with no start instant STAYS. `startedAtMs` is null only when the
 * producer's timestamp did not parse — the same fact the Started cell renders as
 * an em dash — and excluding on it would let one malformed timestamp delete a
 * row from every bounded window, which is this ticket's own defect pointed the
 * other way.
 */
function isWithinSessionsDateWindow(
  row: SessionTableRow,
  windowStartMs: number | null
): boolean {
  if (windowStartMs === null) {
    return true;
  }
  const startedAtMs = row.startedAtMs;
  if (startedAtMs === undefined || startedAtMs === null) {
    return true;
  }
  return startedAtMs >= windowStartMs;
}

/**
 * ISS-8966: does a row match the free-text search term, case-insensitively?
 *
 * The FIELD SET is borrowed, not invented, and it is borrowed from BOTH desktop
 * free-text predicates rather than one of them (whitlockk, #6528). The list source
 * behind the desktop Sessions surface matches `name`, `externalSessionId`,
 * `harness`, `cwd`, `branch`, the attributed repository and the base branch
 * (`matchesSearch`, `shared-agent-sessions-api.ts`); the local SQLite page
 * matches `id`, `name`, `cwd` and `model` (`read-stores.ts`). This is their
 * UNION intersected with what a `SessionTableRow` actually carries, because
 * either arm under-matching is the same defect pointed two ways: a reader who
 * finds a session today by typing its repository would watch a client v2 mount
 * drop it, and a reader who finds one by model would watch the list source drop
 * it. A field the row model does not carry is dropped rather than substituted,
 * which is why `cwd` and the base branch are absent here and stay absent.
 *
 * The FOLDING RULE is not borrowed and cannot be. `toLowerCase` folds the whole
 * of Unicode; SQLite's `LIKE` folds ASCII only, so a term carrying non-ASCII
 * letters matches here and not there. Narrowing this to ASCII would make the
 * client arm wrong on its own terms rather than make the two agree, and widening
 * SQLite's is the producer's call, so the divergence stays and is stated.
 *
 * Matched against one joined haystack rather than field-by-field, the shape the
 * desktop matcher already uses, so the two cannot drift apart on the mechanics
 * as well as the fields. The separator is load-bearing: joined bare, a harness
 * and the branch after it would concatenate into a substring present in neither
 * field, and a term hitting that seam would match a session on a value it does
 * not have. (A term the reader typed WITH a space can still span two fields —
 * that is the desktop matcher's behaviour too, and making this arm alone
 * stricter would recreate the disagreement rather than settle it.)
 *
 * An empty term matches everything, so the caller does not have to branch.
 */
function matchesSessionsSearch(row: SessionTableRow, search: string): boolean {
  if (search === "") {
    return true;
  }
  const needle = search.toLowerCase();
  const haystack = [row.name, row.id, row.harness, row.branch, row.repo]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle) || matchesSessionModel(row, needle);
}

/**
 * The `model` half of {@link matchesSessionsSearch}, kept off the joined
 * haystack: it is the one field the LIST source does not search, so a reader
 * comparing the two arms can see exactly where they part without reading the
 * join.
 *
 * `needle` arrives already lowercased by the only caller.
 */
function matchesSessionModel(row: SessionTableRow, needle: string): boolean {
  return (row.model ?? "").toLowerCase().includes(needle);
}

/**
 * Narrow each band's `droppable` by what the HOST actually wired, per grouping
 * level (ISS-8296).
 *
 * `buildGroups` decides droppability from the canonical value alone, which is
 * the type-capability layer and is all a pure partition can know. Host wiring is
 * the second layer, and it is level-specific, which `resolveGroupDropHandler`
 * cannot be: that one answers "does a handler exist at all", so it admits one
 * when EITHER level is movable and re-checks the destination's own level once a
 * drop has fired. This pass is what carries the per-level answer to the RENDER.
 * Without it, a host with `canMove("owner")` true and `canMove("status")` false
 * renders every Status subgroup as an accepting target whose drop silently does
 * nothing — a `droppable` that lies, which is precisely what the capability
 * layer must never be allowed to do on its own.
 *
 * Only ever narrows: a band already refused stays refused.
 */
export function applyGroupDropWiring(
  groups: GridTableV2Group<SessionTableRow>[] | undefined,
  grouping: TableGroupingState,
  controller: SessionsGroupDropController | undefined
): GridTableV2Group<SessionTableRow>[] | undefined {
  if (!groups) {
    return groups;
  }
  const wired = (fieldId: string | null) =>
    Boolean(fieldId && controller?.canMove(fieldId));
  const primaryWired = wired(grouping.primary.fieldId);
  const secondaryWired = wired(grouping.secondary.fieldId);
  return groups.map((group) => ({
    ...group,
    droppable: group.droppable !== false && primaryWired,
    subgroups: group.subgroups?.map((subgroup) => ({
      ...subgroup,
      droppable: subgroup.droppable !== false && secondaryWired,
    })),
  }));
}

/** The narrowers other than the date window, which every mount counts alike. */
export type SessionsNonWindowFilters = {
  facets: SessionFacetFilters;
  isServerDriven: boolean;
  /** @see resolveSessionsRows — the same axis, counted rather than applied. */
  scopeUserId: string | null;
  /** @see resolveSessionsRows — the same axis, counted as well as applied. */
  search: string;
};

/**
 * Everything {@link resolveSessionsFiltersActive} counts except the window, so
 * ISS-11913 can tell a list the window alone empties from one a facet empties.
 */
export function resolveSessionsNonWindowFiltersActive({
  facets,
  isServerDriven,
  scopeUserId,
  search,
}: SessionsNonWindowFilters): boolean {
  // ISS-8966: a search term counts in BOTH arms, because it narrows in both —
  // server-driven through the host's own query, client-side through
  // `resolveSessionsRows`. Uncounted, a search that matched nothing leaves
  // `filtersActive` false, so `renderSessionsListBody` hands
  // `hasActiveFilters: false` to the empty state and a reader with plenty of
  // sessions is told they have none, with no "Clear filters" way back. The
  // server arm is where that is unrecoverable: there `listNarrowed` IS
  // `filtersActive`, so nothing else could catch the narrowing. It has not
  // reached a reader — no shipped host supplies a term yet (see
  // `SessionsListViewState.search`) — which is what makes this the seam for the
  // host that will, rather than a repair of a live regression.
  if (search !== "") {
    return true;
  }
  // ISS-8037: the owner scope counts in BOTH arms. It narrows every mount that
  // carries it, so a scoped-away list left uncounted rendered the
  // genuinely-empty state — telling a reader their org has no sessions when it
  // has plenty, and offering no way back.
  if (scopeUserId !== null) {
    return true;
  }
  if (isServerDriven) {
    return hasAnyActiveSessionFacet(facets);
  }
  return facets.statuses.length > 0 || facets.userIds.length > 0;
}

/**
 * ISS-11913: is a bounded preset window the only thing narrowing the Sessions
 * list? The condition under which Branches offers "Show all time"
 * (`resolveBranchesListState`), shared by the surface and the gate on
 * `useSessionsOutsideWindow`. The surface also counts custom-field filters,
 * which the hosts' gates do not, so its answer can only be narrower.
 */
export function isSessionsListNarrowedOnlyByWindow({
  customWindowActive,
  dateRange,
  otherFiltersActive,
}: SessionsWindowNarrowing): boolean {
  return (
    !(otherFiltersActive || customWindowActive) &&
    dateRange !== DateRange.AllTime
  );
}

export type SessionsWindowNarrowing = {
  customWindowActive: boolean;
  dateRange: DateRange;
  /** A facet, search, owner scope or custom-field filter is also narrowing. */
  otherFiltersActive: boolean;
};
