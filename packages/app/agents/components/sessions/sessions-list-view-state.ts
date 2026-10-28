"use client";

import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import type { TableGroupingState } from "@repo/design-system/components/ui/table-toolbar-model";
import { useRef, useState } from "react";
import { LIST_CUSTOM_FIELD_COLUMN_PREFIX } from "../../../custom-fields/lib/list-custom-field-columns";
import type { DateRange } from "../../../shared/lib/format-utils";
import type { SessionFacetFilters } from "../../lib/session-filter-adapter";
import type { SessionsListReadState } from "../../lib/sessions-list-read-state";
import type { SessionsColumnId } from "../../lib/sessions-table-columns";
import type { SessionsCustomFieldFilters } from "./sessions-list-custom-fields";

/** The lead ("Session") column's sort field. It has no entry in the column specs. */
export const SESSIONS_LEAD_SORT_FIELD = "name";
// ISS-12663: the prefix every list's custom-field columns share.
export const SESSIONS_CUSTOM_FIELD_COLUMN_PREFIX =
  LIST_CUSTOM_FIELD_COLUMN_PREFIX;
export type SessionsCustomFieldColumnId =
  `${typeof SESSIONS_CUSTOM_FIELD_COLUMN_PREFIX}${string}`;

export function isSessionsCustomFieldColumnId(
  value: string
): value is SessionsCustomFieldColumnId {
  return value.startsWith(SESSIONS_CUSTOM_FIELD_COLUMN_PREFIX);
}

/**
 * What {@link SessionsListViewState.sortBy} may name: a data column's id, or the
 * lead column's {@link SESSIONS_LEAD_SORT_FIELD}.
 *
 * A CLOSED union rather than `string`, because the neighbouring vocabulary is
 * one value away from this one and the difference is silent. The Owner column's
 * id is `owner` while its SERVER sort key is `user`; every other column spells
 * both the same. So a host adapting `useSessionsViewState` (which persists a
 * `SessionSortKey`) reads like an identity function and is wrong for exactly one
 * column out of ten. Typed as `string`, passing `user` compiled and then sorted
 * on a column that does not exist — `sessionCellValue` has no `user` reader, so
 * every row produced `""` and the list came back in its original order, looking
 * merely unsorted rather than broken. Now it fails `tsc` at the adapter, which
 * is the only place that can fix it. `columnIdToSessionSortKey` /
 * `sessionSortKeyToColumnId` in `../../lib/session-sort-group` are the mappers.
 */
export type SessionsListSortField =
  | SessionsColumnId
  | SessionsCustomFieldColumnId
  | typeof SESSIONS_LEAD_SORT_FIELD;

export type SessionsListSortRule = {
  fieldId: SessionsListSortField;
  direction: SortDirection;
};

/**
 * The view state that decides WHICH rows `SessionsListSurfaceV2` renders and in
 * what shape: the sort, the grouping, every filter facet, the date window, the
 * visible columns, and the page.
 *
 * ISS-7865: this is the surface's QUERY, not merely its appearance. A host that
 * paginates and filters server-side (every real Sessions host does) reads this
 * to build its read, so every axis a host can express has to be expressible
 * here — the alternative is a control that moves a value no query ever sees.
 */
export type SessionsListViewState = {
  /**
   * A COLUMN ID and NOT a `SessionSortKey` — enforced by the type, not just
   * described by it. See {@link SessionsListSortField}.
   */
  sortBy: SessionsListSortField | null;
  sortDir: SortDirection;
  /** Ordered sort clauses. Missing restores the legacy scalar sort above. */
  sorts?: readonly SessionsListSortRule[];
  grouping: TableGroupingState;
  /**
   * ISS-7865: the CANONICAL `SessionFacetFilters`, not a per-surface subset, so
   * a host passes the value it already sends to its server read and gets one
   * back it can pass straight on — no adapter, and no second vocabulary that
   * could name the same facet differently.
   *
   * The Owner facet is USER IDS: two different people can share a display name,
   * so a name-keyed facet cannot tell their rows apart. An owner with no id
   * filters under {@link UNASSIGNED_OWNER_ID}. `projectIds` rides along as part
   * of the canonical type, but this surface offers no Project facet — desktop
   * cannot resolve cloud projects, so its own facet query omits it too.
   */
  facets: SessionFacetFilters;
  /**
   * ISS-8216: the custom-field facet selections, keyed by custom-field COLUMN
   * id. The one filter axis the surface used to keep in a private `useState`
   * beside this state, so a saved view restored every other axis and left this
   * one narrowing the list unrepresented (whitlockk, #6074).
   *
   * An ABSENT key is a view written before this axis existed, NOT an empty
   * selection a reader chose. Both narrow nothing and neither may read as
   * "filter applied", so every reader resolves them to the same thing — but a
   * saved view has to MATERIALIZE the absent one rather than pass it through,
   * because its value is applied as a patch. See `sessionsSavedViewValue`.
   */
  customFieldFilters?: SessionsCustomFieldFilters;
  /**
   * ISS-7865: the toolbar's date window, as the SHARED `DateRange` token and
   * not a resolved pair of timestamps — the host owns the resolution and its
   * stability contract (`getStableUtcDateWindowForRange` quantizes to UTC days
   * so the query identity survives a remount), and a surface emitting fresh
   * `Date`s would churn that key every render. Replaces a private `useState`
   * that reached no query: the control moved and nothing narrowed.
   */
  dateRange: DateRange;
  visibleColumnIds: ReadonlySet<string>;
  /**
   * Summary cards hidden by the current view. MISSING is "no opinion", not
   * "none hidden": `resolveHiddenSummaryCardIds` lets an absent axis defer to
   * the host's own hidden set, where an empty one overrides it (ISS-8722).
   */
  hiddenSummaryCardIds?: ReadonlySet<string>;
  page: number;
  /**
   * ISS-8037: the cross-surface `?userId=` OWNER SCOPE — the user a link from
   * another surface narrowed this list to — or `null` for the unscoped view.
   *
   * An AXIS rather than a pair of host props, and that is the whole fix. The
   * scope narrows the host's reads exactly as a facet does, so it needs the
   * chip and the removal path a facet has; but removal has to compose with
   * `ActiveFiltersBar`'s "Clear all", which fires `clearAllFilters()` and then
   * one `onToggle` per selected value SYNCHRONOUSLY with no render between.
   * A remover living outside this state is a SECOND host write derived from the
   * pre-click snapshot, so it re-asserts whatever the first write just cleared —
   * the failure `mergeSessionScopeChips` already documents on v1 (review cid
   * 3701353686). Here it rides {@link useSessionsListView}'s `staged` ref like
   * every other axis, so one click settles on one state.
   *
   * Distinct from `facets.userIds` even though the two share the Owner facet's
   * label vocabulary: this one is not multi-select, the user never set it on
   * this surface, and a host owns it as a URL param rather than as facet state.
   * Not folding it in here is what left a scoped-away list rendering the
   * genuinely-empty state — "no sessions" at an org with plenty.
   */
  scopeUserId: string | null;
  /**
   * ISS-8966: the free-text SEARCH term narrowing this list, or `""`/absent when
   * nothing is searched.
   *
   * An AXIS for the reason {@link scopeUserId} is one. A search narrows exactly
   * as a facet does, so it needs the chip, the "is anything narrowing this list"
   * count and the removal path a facet has — and its removal has to compose with
   * `ActiveFiltersBar`'s "Clear all", which fires `clearAllFilters()` and then
   * one `onToggle` per selected value SYNCHRONOUSLY with no render between. A
   * term cleared through a second host callback is a second write off the
   * pre-click snapshot, so it re-asserts what the first write just cleared.
   * Riding {@link useSessionsListView}'s `staged` ref settles one click on one
   * state. Left out entirely, a search matching nothing rendered the onboarding
   * "no sessions yet" over an account with plenty — this ticket's own defect.
   *
   * OPTIONAL rather than required, unlike the axes beside it. A saved view
   * written before this axis existed carries no key, and
   * `deserializeSessionsListViewState` returns `null` for a payload missing a
   * REQUIRED axis — so requiring it would discard the reader's entire stored
   * view rather than restore it without a search. Absent and `""` mean the same
   * thing, so both resolve through {@link resolveSessionsSearchTerm}.
   *
   * Nothing on the surface SETS one, and NO SHIPPED HOST SUPPLIES one yet. The
   * web page declares `search: ""` because its cloud list route does not model
   * the field at all, and the desktop shell that does own `?search=` still
   * renders the v1 table. This is the seam that mount needs (ISS-8909), not a
   * description of a term in flight today — a host that carries one supplies it
   * and hears the clear back; the only write this surface makes is the clear.
   */
  search?: string;
};

/**
 * A host taking ownership of {@link SessionsListViewState}.
 *
 * `value` and `onChange` are one object rather than two optional props so the
 * type cannot express a controlled surface with nowhere to report to — that
 * shape renders live-looking menus, sort headers and facets whose every
 * interaction is silently dropped, which is a lying control, not a read-only
 * mode.
 */
export type SessionsListViewController = {
  value: SessionsListViewState;
  onChange: (next: SessionsListViewState) => void;
  /**
   * ISS-7865: how many rows the SERVER matched, across every page. Supplying it
   * declares that this host owns the QUERY — it filtered, sorted and applied
   * `limit`/`offset`, and `value`'s axes reach a real read.
   *
   * It lives on the controller, and not beside it, for the reason `value` and
   * `onChange` do: only a host that reports changes can act on them, so a row
   * count arriving without one would light nine facets, the sort headers and a
   * server-sized paginator over state nobody reads — every control moving and
   * nothing narrowing.
   */
  totalRows?: number;
  /**
   * Whether the host's total is settled for this view. Omitted preserves the
   * legacy contract: a supplied `totalRows` is settled, and an uncontrolled
   * surface derives its count from the rows it owns.
   */
  readState?: SessionsListReadState;
};

/**
 * ISS-7262 / ISS-7052 Part A: the view-state lift.
 *
 * Absent a `controller` the surface keeps its own state, which is what lets it
 * stand alone in Storybook and drop into a page with no wiring. Given one, every
 * write is reported to the host and nothing is stored here, so a host that
 * already owns filters/sort/columns — the desktop Sessions view, a page
 * persisting a saved view or a URL — drives the surface instead of fighting a
 * second copy of the same state.
 *
 * The updater takes a PATCH rather than a whole state because several
 * interactions move more than one axis (changing a filter also returns to page
 * 1), and because a single click can reach this more than once: the shared
 * `ActiveFiltersBar`'s "Clear all" calls `clearAllFilters()` and then one
 * `onToggle` per selected facet value, all synchronously.
 *
 * Uncontrolled that composes for free — `setUncontrolled` takes a functional
 * update, so React threads the latest state through each call. Controlled it
 * does not: `controller.value` is a prop and cannot change until the host
 * re-renders, so every call in one event would rebuild from the SAME pre-click
 * value and the last one would win, silently discarding the others. That is why
 * `staged` exists — it carries what we have already reported forward within the
 * event, and is dropped the moment the host hands back a different value.
 */
export function useSessionsListView(
  controller: SessionsListViewController | undefined,
  createSeed: () => SessionsListViewState
): readonly [SessionsListViewState, (patch: SessionsListViewPatch) => void] {
  const [uncontrolled, setUncontrolled] = useState(createSeed);
  const staged = useRef<{
    against: SessionsListViewState;
    next: SessionsListViewState;
  } | null>(null);
  // A staged emission is only valid against the value it was built on. Once the
  // host commits (or replaces) that value, it has superseded us.
  if (staged.current && !Object.is(staged.current.against, controller?.value)) {
    staged.current = null;
  }
  const view = controller?.value ?? uncontrolled;
  const update = (patch: SessionsListViewPatch) => {
    if (controller) {
      const base = staged.current?.next ?? controller.value;
      const next = { ...base, ...resolvePatch(patch, base) };
      staged.current = { against: controller.value, next };
      controller.onChange(next);
      return;
    }
    setUncontrolled((current) => ({
      ...current,
      ...resolvePatch(patch, current),
    }));
  };
  return [view, update] as const;
}

/**
 * A view-state update: either the fields to overwrite, or a function computing
 * them from the state the patch will actually be applied to.
 *
 * The functional form is not a convenience. A patch whose new value DERIVES from
 * the old one — every facet toggle does, since toggling is "remove it if
 * present, else add it" — cannot be computed at render time when one event
 * reaches `update` more than once. `ActiveFiltersBar`'s "Clear all" is exactly
 * that: `clearAllFilters()` then one `onToggle` per selected value, synchronously
 * and with no render between. Computed against the render-time array, the second
 * toggle re-adds what the first removed, so clearing a two-value facet leaves one
 * value selected (whitlockk, #5566). Given a function, each call sees the state its
 * predecessor produced.
 */
export type SessionsListViewPatch =
  | Partial<SessionsListViewState>
  | ((current: SessionsListViewState) => Partial<SessionsListViewState>);

function resolvePatch(
  patch: SessionsListViewPatch,
  current: SessionsListViewState
): Partial<SessionsListViewState> {
  return typeof patch === "function" ? patch(current) : patch;
}

/**
 * The value {@link SessionFacetFilters.userIds} carries for rows whose owner
 * has no identity — no user at all, or a name-only projection.
 *
 * Part of the contract rather than a surface-local detail: a host adapting its
 * own owner filter into `userIds` has to know what the "Unassigned" option
 * selects, and no real user id is the empty string.
 */
export const UNASSIGNED_OWNER_ID = "";

export function resolveSessionsListSorts(
  view: Pick<SessionsListViewState, "sortBy" | "sortDir" | "sorts">
): readonly SessionsListSortRule[] {
  if (view.sorts) {
    return view.sorts;
  }
  if (view.sortBy === null) {
    return [];
  }
  return [{ direction: view.sortDir, fieldId: view.sortBy }];
}

/**
 * The reading of an absent {@link SessionsListViewState.customFieldFilters}:
 * nothing selected, nothing narrowed.
 *
 * A SHARED instance, because the surface feeds this straight into the
 * row-derivation memo's dependency list — a fresh `new Map()` per read would
 * re-filter and re-sort every row on every render.
 */
export const EMPTY_SESSIONS_CUSTOM_FIELD_FILTERS: SessionsCustomFieldFilters =
  new Map();

/**
 * ISS-8966: the reading of {@link SessionsListViewState.search} — the trimmed
 * term, or `""` when nothing is searched.
 *
 * ONE normalizer, called once per render by the surface, because absent, `""`
 * and `"   "` are three spellings of the same fact and every reader has to agree
 * on it. A row filter that treated `"  "` as a term while the "is anything
 * narrowing this list" count treated it as nothing is how a list empties itself
 * and then reports that the account has no sessions. The hosts trim at their own
 * URL boundary too (`searchParams.get("search")?.trim()`), so a term that
 * reaches here has usually been trimmed already; this is what makes that
 * incidental rather than load-bearing.
 */
export function resolveSessionsSearchTerm(search: string | undefined): string {
  return search?.trim() ?? "";
}

export function sessionsListSortPatch(
  sorts: readonly SessionsListSortRule[]
): Pick<SessionsListViewState, "sortBy" | "sortDir" | "sorts"> {
  const primary = sorts[0];
  return {
    sortBy: primary?.fieldId ?? null,
    sortDir: primary?.direction ?? "asc",
    sorts,
  };
}
