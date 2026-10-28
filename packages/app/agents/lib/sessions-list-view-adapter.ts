import {
  EMPTY_TABLE_GROUPING,
  type TableFieldOption,
  type TableGroupingState,
} from "@repo/design-system/components/ui/table-toolbar-model";
import type { DateRange } from "../../shared/lib/format-utils";
import type {
  SessionsListSortField,
  SessionsListSortRule,
  SessionsListViewState,
} from "../components/sessions/sessions-list-view-state";
import {
  EMPTY_SESSIONS_CUSTOM_FIELD_FILTERS,
  isSessionsCustomFieldColumnId,
  resolveSessionsSearchTerm,
  SESSIONS_LEAD_SORT_FIELD,
} from "../components/sessions/sessions-list-view-state";
import type { SessionFacetFilters } from "./session-filter-adapter";
import { coerceSessionGroupBy, SessionGroupBy } from "./session-grouping";
import {
  columnIdToSessionSortKey,
  type SessionSortDir,
  SessionSortKey,
  type SessionSortRule,
  sessionSortKeyToColumnId,
} from "./session-sort-group";
import {
  SESSIONS_COLUMN_SPECS,
  SESSIONS_PRIORITY_COLUMN_ID,
} from "./sessions-table-columns";

/**
 * ISS-7052 Part A: the one translation between a Sessions HOST's view state and
 * the `SessionsListViewState` that `SessionsListSurfaceV2` speaks.
 *
 * Both hosts — the web page's `useSessionsViewState("sessions:web")` and the
 * desktop `SessionsView` — already own this state and persist it into a saved
 * view. Neither should learn the surface's vocabulary, and the surface should
 * not learn theirs, so the mapping lives here once instead of twice.
 *
 * Four of the six axes are genuinely 1:1 (`facets`, `dateRange`, `scopeUserId`,
 * and `page` — the surface's page is 0-based, `resolvePaginationBounds` clamps
 * to `[0, totalPages - 1]`, which is the same base the web URL's `?page=` uses).
 * The other two are not, and both have bitten this repo before:
 *
 *  - **Sort** is a COLUMN ID on the surface and a SERVER SORT KEY on the host,
 *    and they differ for exactly one column out of ten: Owner is `owner` to the
 *    table and `user` to the API. {@link columnIdToSessionSortKey} /
 *    {@link sessionSortKeyToColumnId} are the canonical bridge (FEA-4300); this
 *    module is the only place that calls them for the v2 surface, and
 *    {@link toSessionsListSortField} narrows the resulting `string` to the
 *    closed union so a typo cannot compile.
 *  - **Grouping** is a two-level {@link TableGroupingState} on the surface and a
 *    single {@link SessionGroupBy} on the host. See
 *    {@link SESSIONS_HOST_GROUP_OPTION_IDS} for why that asymmetry is capped
 *    rather than papered over.
 */
export type SessionsHostViewState = {
  sortKey: SessionSortKey | null;
  sortDir: SessionSortDir;
  /**
   * ISS-8335: the sort rules AFTER the primary, in priority order.
   *
   * The v2 toolbar stacks rules; `sortKey`/`sortDir` are one. Held here rather
   * than in host-component state because a rule the host merely REMEMBERS is a
   * rule the query never sends: the surface is server-driven
   * (`resolveSessionsRows` returns its rows untouched), so an order the server
   * did not produce is an order that does not exist. Keeping the rest of the
   * list in the host's vocabulary is what lets the page persist it and put it on
   * the wire beside the primary.
   *
   * Split from the primary rather than replacing it with one `sorts` list: the
   * page's URL and saved view have a single sort SLOT, `sortKey`/`sortDir` is
   * that slot's spelling, and every v1 consumer still reads it. The same shape
   * `groupBy` already uses for its primary dimension.
   */
  secondarySorts: readonly SessionSortRule[];
  groupBy: SessionGroupBy;
  facets: SessionFacetFilters;
  dateRange: DateRange;
  visibleColumns: Set<string>;
  page: number;
  /**
   * ISS-8037: the host's `?userId=` OWNER SCOPE, or `null` when unscoped.
   *
   * An axis of the HOST's vocabulary too, and not merely of the surface's,
   * because it is the only shape in which a host can hear the removal. The
   * surface reports one settled `SessionsListViewState` per event
   * (`useSessionsListView`'s `staged` ref composes "Clear all"'s several
   * synchronous writes into it), so an axis carried here rides that single
   * report and lands in the host's single URL write. A scope removed through a
   * separate host callback instead is a SECOND write built from the same
   * pre-click search-params snapshot, which restores whatever the first one
   * cleared — the ISS-4728 trap the web page documents at
   * `handleRemoveSelectedUser` and again at `handleScopeChange`.
   *
   * The web page owns it as a URL param, so a host that strips the param on a
   * `null` is honouring the axis; nothing on the surface ever SETS one.
   */
  scopeUserId: string | null;
  /**
   * ISS-8966: the host's free-text SEARCH term, or `""` when nothing is
   * searched.
   *
   * REQUIRED here even though the surface's own axis is optional, and the
   * asymmetry is deliberate. The surface's is optional so a saved view written
   * before the axis existed still restores; this one is not persisted — it is
   * the in-memory contract between a host and the surface — so requiring it
   * makes a shell that owns a search term answer for it rather than have it
   * dropped in silence. That silent drop is the ISS-8335 defect exactly: a
   * control that renders, reports its change, and evaporates before the next
   * render.
   *
   * A host with no search of its own says so with `""`. The web shell is one:
   * its cloud list route does not model `search` at all (`withListQuery` strips
   * the field), so there is nothing on that surface for a term to narrow and
   * nothing to name.
   *
   * Nothing on the surface SETS a term; the only write it makes is clearing one.
   * A host that owns `?search=` therefore honours this axis by STRIPPING the
   * param when it arrives empty, inside the same single write that carries the
   * cleared facets, for the reason {@link scopeUserId} spells out. NO HOST DOES
   * THAT TODAY: the web page's change handler
   * (`applySessionsHostViewChange`) reads only the window, the facets, the
   * scope, the sort, the grouping and the columns, and it has no term to strip
   * because it never supplies one. That is a contract for the shell that mounts
   * this surface with a real term, not a description of a live write.
   */
  search: string;
};

/**
 * The group dimensions a HOST can persist, which is a strict subset of the four
 * the v2 toolbar can render (`GROUP_OPTIONS` adds `model`).
 *
 * The surface is offered only these because the hosts' persisted `groupBy` is a
 * closed {@link SessionGroupBy} whose menu is built from `Object.values`, so
 * widening it to carry `model` would grow the v1 View menu a "Model" entry on
 * the flag-OFF path too. The alternative — offering Model and silently dropping
 * it on reload — is a control that moves and does not stick, which is worse than
 * one that was never offered. Grouping by Model on the v2 surface is a product
 * decision, not an implementation detail, so it stays unoffered here until
 * someone asks for it.
 */
export const SESSIONS_HOST_GROUP_OPTION_IDS: readonly string[] = [
  SessionGroupBy.Status,
  SessionGroupBy.Owner,
  SessionGroupBy.Harness,
  // ISS-10332: persisted as `SessionGroupBy.Priority` by both hosts' view
  // state, so it round-trips rather than snapping back to None.
  SessionGroupBy.Priority,
];

/**
 * {@link SESSIONS_HOST_GROUP_OPTION_IDS} as the option list the v2 toolbar's
 * Group control takes, which is the form a controlled host actually passes.
 *
 * The cap was a constant nothing consumed, so the surface went on offering the
 * full `GROUP_OPTIONS` — including the Model this adapter coerces straight back
 * to `None` — and selecting it snapped back without changing the query. Labels
 * come from `SESSIONS_COLUMN_SPECS`, the same source `GROUP_OPTIONS` reads, so
 * the capped menu cannot spell a dimension differently from the full one.
 */
export const SESSIONS_HOST_GROUP_OPTIONS: readonly TableFieldOption[] =
  SESSIONS_COLUMN_SPECS.filter((spec) =>
    SESSIONS_HOST_GROUP_OPTION_IDS.includes(spec.id)
  ).map((spec) => ({ id: spec.id, label: spec.label }));

/**
 * ISS-10332 (#7762 review): {@link SESSIONS_HOST_GROUP_OPTIONS} for a host whose
 * source cannot write a `priority` — an older Desktop build's local store —
 * where grouping by it folds every row into one band.
 */
export const SESSIONS_HOST_GROUP_OPTIONS_WITHOUT_PRIORITY: readonly TableFieldOption[] =
  SESSIONS_HOST_GROUP_OPTIONS.filter(
    (option) => option.id !== SESSIONS_PRIORITY_COLUMN_ID
  );

const SESSIONS_LIST_SORT_FIELDS: ReadonlySet<SessionsListSortField> =
  new Set<SessionsListSortField>([
    SESSIONS_LEAD_SORT_FIELD,
    ...SESSIONS_COLUMN_SPECS.map((spec) => spec.id),
  ]);

function isSessionsListSortField(
  columnId: string
): columnId is SessionsListSortField {
  return (SESSIONS_LIST_SORT_FIELDS as ReadonlySet<string>).has(columnId);
}

/**
 * Narrow a table column id to the surface's closed sort union.
 *
 * Returns `null` for anything the surface cannot sort on, which renders the list
 * in its natural order rather than sorting every row against a reader that does
 * not exist — the failure mode the union was closed to prevent (a `user` passed
 * where `owner` belonged produced `""` for every row and looked merely
 * unsorted).
 */
export function toSessionsListSortField(
  columnId: string | null
): SessionsListSortField | null {
  if (columnId === null || !isSessionsListSortField(columnId)) {
    return null;
  }
  return columnId;
}

/** The host's persisted grouping as the surface's two-level state. */
export function toTableGroupingState(
  groupBy: SessionGroupBy
): TableGroupingState {
  if (groupBy === SessionGroupBy.None) {
    return EMPTY_TABLE_GROUPING;
  }
  return {
    ...EMPTY_TABLE_GROUPING,
    primary: { ...EMPTY_TABLE_GROUPING.primary, fieldId: groupBy },
  };
}

/**
 * The surface's grouping as the host's single dimension.
 *
 * Only `primary` survives: the host has one slot. `coerceSessionGroupBy` maps
 * anything it does not know — including the `model` the surface could render if
 * it were ever offered — back to `None` rather than persisting a value the host
 * cannot read again.
 */
export function toSessionGroupBy(grouping: TableGroupingState): SessionGroupBy {
  return coerceSessionGroupBy(grouping.primary.fieldId ?? SessionGroupBy.None);
}

/** Host state → the view state `SessionsListSurfaceV2` renders from. */
export function toSessionsListViewState(
  host: SessionsHostViewState
): SessionsListViewState {
  const sortBy = toSessionsListSortField(
    sessionSortKeyToColumnId(host.sortKey)
  );
  return {
    sortBy,
    sortDir: host.sortDir,
    // ISS-8335: the WHOLE ordered list the toolbar renders — the primary slot
    // followed by the rest. With no primary there is no list at all: a secondary
    // rule cannot lead, because the page has nowhere to persist a lead rule
    // other than `sortKey`, so promoting one here would render a first rule the
    // next reload could not restore.
    sorts: sortBy
      ? [
          { direction: host.sortDir, fieldId: sortBy },
          ...toSurfaceSortRules(host.secondarySorts),
        ]
      : [],
    grouping: toTableGroupingState(host.groupBy),
    facets: host.facets,
    dateRange: host.dateRange,
    visibleColumnIds: host.visibleColumns,
    page: host.page,
    scopeUserId: host.scopeUserId,
    search: host.search,
  };
}

/**
 * A surface change → the host's vocabulary.
 *
 * `sortKey` comes back as the SERVER key, so a host can hand it straight to the
 * read it already issues.
 *
 * ISS-8335: the parameter is the WHOLE {@link SessionsListViewState} and not a
 * structural subset of it, which is the entire defect this signature used to
 * carry. It listed eight axes; the surface's state had grown to eleven. A
 * variable of the wider type is a legal argument for the narrower one and
 * excess-property checking does not run on anything but a fresh object literal,
 * so `sorts` and `hiddenSummaryCardIds` were dropped here in silence — no error
 * at the call site, no error here, and toolbar controls that moved and snapped
 * back. Taking the exact type means a new axis is now a `tsc`
 * failure in {@link SESSIONS_VIEW_STATE_AXIS_OWNERS} rather than an affordance
 * that quietly stops working.
 */
export function toSessionsHostViewState(
  next: SessionsListViewState
): SessionsHostViewState {
  const sorts = next.sorts ?? [];
  return {
    sortKey:
      next.sortBy === null
        ? null
        : (columnIdToSessionSortKey(next.sortBy) as SessionSortKey),
    sortDir: next.sortDir,
    // ISS-8335: everything after the lead rule. Read off `sorts` rather than
    // recomposed from `sortBy`, because `sorts` is what the toolbar actually
    // edited — the surface keeps `sortBy`/`sortDir` in step with `sorts[0]`, and
    // rebuilding the tail from the scalar pair could only ever return an empty
    // one, which is the drop this axis exists to stop.
    secondarySorts: toHostSortRules(sorts.slice(1)),
    groupBy: toSessionGroupBy(next.grouping),
    facets: next.facets,
    dateRange: next.dateRange,
    // FEA-4222: the BUILT-IN half only. A host's `visibleColumns` is the page's
    // persisted vocabulary — a closed list of declared column ids — and a
    // `custom-field:*` id is not in it, so handing one back is not merely
    // useless, it is corrupting: the web page diffs this set against its own
    // and calls `toggleColumn` for each difference, and that setter does NOT
    // filter against its valid-id list, so the unknown id lands in the saved
    // view's `hiddenColumns` and is persisted to localStorage forever.
    // The custom half is the host's own — see {@link SessionsHostLocalView}.
    visibleColumns: new Set(
      [...next.visibleColumnIds].filter(
        (columnId) => !isSessionsCustomFieldColumnId(columnId)
      )
    ),
    page: next.page,
    scopeUserId: next.scopeUserId,
    // Normalized on the way back so the host stores the same spelling the
    // surface filtered and chipped by — an untrimmed term reaching a host's
    // `?search=` write would re-enter as a filter the surface then resolves to
    // nothing, and the two would disagree about whether a search is applied.
    search: resolveSessionsSearchTerm(next.search),
  };
}

/**
 * Who owns each axis of {@link SessionsListViewState} once a Sessions HOST
 * drives the v2 surface.
 *
 * The surface's state is strictly wider than the page's persisted vocabulary,
 * and that asymmetry is permanent rather than a gap to close: the page stores
 * its view in a URL and a saved view whose schema is a single sort key and a
 * single {@link SessionGroupBy}. What is NOT permanent is losing the difference
 * in silence, which is what ISS-8335 was filed for.
 */
export const SessionsViewAxisOwner = {
  /** Round-trips through {@link SessionsHostViewState} into the page's saved view. */
  Host: "host",
  /**
   * The page persists it through a DEDICATED prop pair rather than this view
   * state — `hiddenSummaryCards` + `onToggleSummaryCard`.
   */
  HostProp: "host-prop",
  /**
   * No persisted slot exists, so `SessionsListV2Host` holds it in component
   * state for the life of the mount; persisting it is a schema change to the
   * saved view, not a host fix. `customFieldFilters` is the axis that takes it.
   */
  HostLocal: "host-local",
  /**
   * Split down the middle: part of the axis round-trips, part is session-scoped.
   * `grouping`'s PRIMARY level is the page's `groupBy` and reaches the server
   * read; its secondary level and both levels' order/`showEmptyGroups` have
   * nowhere to go, so the host holds them and reconciles the two halves through
   * {@link reconcileSessionsGrouping}.
   */
  Split: "split",
} as const;
export type SessionsViewAxisOwner =
  (typeof SessionsViewAxisOwner)[keyof typeof SessionsViewAxisOwner];

/**
 * THE GUARD (ISS-8335). Every axis of {@link SessionsListViewState}, classified.
 *
 * `satisfies Record<keyof SessionsListViewState, …>` is the load-bearing half:
 * adding an axis to the surface's view state fails typecheck HERE until someone
 * says who stores it, and {@link SessionsHostLocalAxis} then derives the host's
 * local-state shape from this table, so a `HostLocal` classification forces the
 * host to seed and thread it. `as const` keeps the literal values so that
 * derivation can discriminate.
 *
 * Before this existed, the answer to "who stores this axis?" could be "nobody,
 * and nothing says so" — a control rendered, reported its change, and the change
 * evaporated between the host and the next render.
 */
export const SESSIONS_VIEW_STATE_AXIS_OWNERS = {
  /**
   * ISS-8216: HOST-LOCAL, for the same reason `visibleColumnIds`' custom half
   * is not the page's — a `custom-field:*` id is UNREPRESENTABLE in the host's
   * vocabulary. {@link SessionsHostViewState.facets} is a closed
   * {@link SessionFacetFilters}, so there is no slot to round-trip this into and
   * inventing one is a saved-view schema change, not a host fix.
   *
   * It has to be held SOMEWHERE, though. ISS-8216 moved the axis off the
   * surface's private `useState` so a saved view could carry it, and a
   * controlled surface stores nothing (`useSessionsListView` reads
   * `controller.value`) — so an axis no host holds is a facet menu that ticks a
   * value and un-ticks it on the next render. That is the ISS-8335 defect, not
   * a smaller one.
   */
  customFieldFilters: SessionsViewAxisOwner.HostLocal,
  dateRange: SessionsViewAxisOwner.Host,
  facets: SessionsViewAxisOwner.Host,
  grouping: SessionsViewAxisOwner.Split,
  hiddenSummaryCardIds: SessionsViewAxisOwner.HostProp,
  page: SessionsViewAxisOwner.Host,
  scopeUserId: SessionsViewAxisOwner.Host,
  /**
   * ISS-8966: HOST — the only classification that can be right, and the one this
   * table can least prove. The term arrives from a URL a host owns and reaches
   * that host's own read, so it belongs in {@link SessionsHostViewState} beside
   * the owner scope. Held anywhere else it would be a filter the query never
   * sees: the surface would narrow rows the server had already chosen, or
   * (server-driven) claim a narrowing that never happened.
   *
   * READ THE LIMIT OF THE GUARD. `satisfies Record<keyof SessionsListViewState,
   * …>` forces an owner to be NAMED; it cannot check that one exists. The only
   * host in this repo supplies `search: ""` unconditionally and its change
   * handler does not read the field back, so this classification is a contract
   * for the shell ISS-8909 mounts, honoured vacuously until then. It is not the
   * ISS-8335 silent drop — there is no value to drop — but it would become one
   * the moment a host supplies a term without reading the clear back.
   */
  search: SessionsViewAxisOwner.Host,
  sortBy: SessionsViewAxisOwner.Host,
  sortDir: SessionsViewAxisOwner.Host,
  /**
   * ISS-8335: HOST, and it was `HostLocal` for exactly as long as a second rule
   * was allowed to be decorative.
   *
   * Component state made the control STICK, which is what that classification
   * was for — but sticking is not working. The surface is server-driven, so a
   * rule held only by the host reaches no query and changes no row, and the
   * toolbar then displayed "Status, then Owner" over rows the Owner rule had no
   * part in. The lead rule rides `sortKey`/`sortDir` and the rest rides
   * {@link SessionsHostViewState.secondarySorts}, so the whole axis round-trips
   * into the page's saved view and onto the wire.
   */
  sorts: SessionsViewAxisOwner.Host,
  /**
   * FEA-4222: SPLIT, and it was misclassified as `Host` for exactly as long as
   * the surface had only declared columns to show.
   *
   * The DECLARED ids round-trip into the page's saved view. The
   * `custom-field:*` ids cannot: the page's `visibleColumns` is derived as
   * `SESSIONS_ORDERABLE_COLUMN_IDS.filter(id => !hidden.has(id))`, a closed list
   * built from the column specs, so a custom id is not merely absent from it —
   * it is UNREPRESENTABLE in it. Round-tripping the whole axis through the host
   * therefore deleted every custom column on the very next render, which is why
   * the production Sessions grid rendered no custom-field header at all.
   */
  visibleColumnIds: SessionsViewAxisOwner.Split,
} as const satisfies Record<keyof SessionsListViewState, SessionsViewAxisOwner>;

/**
 * The axes a host has to hold itself, derived from {@link
 * SESSIONS_VIEW_STATE_AXIS_OWNERS} rather than re-listed — a second list is how
 * the classification becomes decorative.
 */
export type SessionsHostLocalAxis = {
  [K in keyof SessionsListViewState]-?: (typeof SESSIONS_VIEW_STATE_AXIS_OWNERS)[K] extends
    | typeof SessionsViewAxisOwner.Host
    | typeof SessionsViewAxisOwner.HostProp
    ? never
    : K;
}[keyof SessionsListViewState];

/**
 * The concrete state a host keeps for {@link SessionsHostLocalAxis}.
 *
 * `visibleColumnIds` is the one axis whose local half is not the axis's own
 * value, and the departure is deliberate. Its host-local part is the set of
 * custom-field columns the reader switched OFF, stored as the HIDDEN ids in the
 * same direction the saved view's `hiddenColumns` and `hiddenSummaryCards`
 * already use. Storing the VISIBLE ids instead cannot express the difference
 * between "the reader hid this column" and "this column's definition had not
 * loaded when the set was captured", so a warm mount — where the definitions
 * query is already cached and the surface's new-column effect never fires —
 * would render no custom columns at all and look identical to a reader who had
 * hidden every one of them. Hidden-ids has no such ambiguity: unknown means
 * shown, which is also what a newly created field should be.
 */
export type SessionsHostLocalView = Required<
  Pick<
    SessionsListViewState,
    Exclude<SessionsHostLocalAxis, "visibleColumnIds">
  >
> & {
  /** @see SessionsHostLocalView */
  hiddenCustomFieldColumnIds: ReadonlySet<string>;
};

/**
 * The host-local axes AS THEY SHIP — the seed a host mounts with, and the value
 * "Reset view" has to restore.
 *
 * One constant rather than two literals (codex review cid 3880961540). These
 * axes live in a second store beside the page's saved view, so a reset reaches
 * them only if the host clears them itself; a seed and a reset spelling the
 * default separately is how the two drift into disagreeing about what "shipped"
 * means.
 */
export const DEFAULT_SESSIONS_HOST_LOCAL_VIEW: SessionsHostLocalView = {
  // The SHARED empty map, not a fresh one: the surface feeds this straight into
  // its row-derivation memo's dependency list.
  customFieldFilters: EMPTY_SESSIONS_CUSTOM_FIELD_FILTERS,
  grouping: EMPTY_TABLE_GROUPING,
  // Nothing hidden: a custom-field column ships VISIBLE, which is what makes a
  // field the reader just created appear without a second action.
  hiddenCustomFieldColumnIds: new Set<string>(),
};

/**
 * The grouping to render, given what the page persisted and what the host holds.
 *
 * The host's copy is authoritative WHILE the two agree on the primary
 * dimension, because only it carries the sub-group level and the per-level
 * order. The moment they disagree the page has changed `groupBy` behind the
 * surface — a saved view restoring, a "Reset view", a URL — and the page wins,
 * which necessarily drops a sub-group the page cannot express. Preferring the
 * host's copy there would let a reset leave the table still banded.
 */
export function reconcileSessionsGrouping(
  hostGroupBy: SessionGroupBy,
  localGrouping: TableGroupingState
): TableGroupingState {
  if (toSessionGroupBy(localGrouping) === hostGroupBy) {
    return localGrouping;
  }
  return toTableGroupingState(hostGroupBy);
}

/**
 * FEA-4222: the visible-column set to render, rejoining the page's persisted
 * half with the host's custom-field half.
 *
 * `customFieldColumnIds` is the set of columns that EXIST on this render — the
 * host derives it from the same `buildSessionsCustomFieldColumns` the surface
 * builds its headers from, so the two cannot disagree about which columns are
 * on offer. A column absent from that list contributes nothing here even if it
 * is still in `hiddenCustomFieldColumnIds`, so a field deleted org-wide stops
 * being reasoned about rather than lingering as a phantom.
 */
export function reconcileSessionsVisibleColumns(
  persistedVisibleColumnIds: ReadonlySet<string>,
  customFieldColumnIds: readonly string[],
  hiddenCustomFieldColumnIds: ReadonlySet<string>
): ReadonlySet<string> {
  return new Set([
    ...persistedVisibleColumnIds,
    ...customFieldColumnIds.filter(
      (columnId) => !hiddenCustomFieldColumnIds.has(columnId)
    ),
  ]);
}

/**
 * The inverse of {@link reconcileSessionsVisibleColumns}: what the host stores
 * after the surface reports a new visible set.
 *
 * Derived by SUBTRACTION from the columns that exist rather than by remembering
 * each toggle, so the stored set can never name a column the org no longer has.
 */
export function toHiddenCustomFieldColumnIds(
  nextVisibleColumnIds: ReadonlySet<string>,
  customFieldColumnIds: readonly string[]
): ReadonlySet<string> {
  return new Set(
    customFieldColumnIds.filter(
      (columnId) => !nextVisibleColumnIds.has(columnId)
    )
  );
}

/**
 * ISS-8335: host sort rules as the surface's COLUMN-id rules.
 *
 * `sessionSortKeyToColumnId` is the same bridge the primary crosses (`user` →
 * `owner`, FEA-4300), so the toolbar names a secondary rule's column the way its
 * header does, and `toSessionsListSortField` narrows the result to the surface's
 * closed union.
 */
export function toSurfaceSortRules(
  rules: readonly SessionSortRule[]
): SessionsListSortRule[] {
  const surfaceRules: SessionsListSortRule[] = [];
  for (const rule of rules) {
    const fieldId = toSessionsListSortField(
      sessionSortKeyToColumnId(rule.fieldId)
    );
    if (fieldId) {
      surfaceRules.push({ direction: rule.direction, fieldId });
    }
  }
  return surfaceRules;
}

/**
 * The inverse: surface rules as the host's SERVER-KEY rules.
 *
 * A column with no server key is skipped, and on this host that is a GUARD
 * rather than a drop. `resolveSessionsSortControls` offers a server-driven
 * surface only the columns `AGENT_SESSION_SORT_COLUMNS` accepts — the lead
 * `name` column and every sortable custom field are withheld precisely because
 * no producer can order by them — so nothing the toolbar can emit reaches the
 * skip. Keeping the guard rather than casting matters because the alternative is
 * worse than a missing rule: an unknown column reaching the route's `z.enum`
 * 400s the whole list, so one unorderable rule would empty the table.
 */
export function toHostSortRules(
  rules: readonly SessionsListSortRule[]
): SessionSortRule[] {
  const hostRules: SessionSortRule[] = [];
  for (const rule of rules) {
    const fieldId = columnIdToSessionSortKey(rule.fieldId);
    if (isSessionSortKey(fieldId)) {
      hostRules.push({ direction: rule.direction, fieldId });
    }
  }
  return hostRules;
}

/**
 * ISS-10361 (tamsinb review): exported rather than copied. `sessions-parity-
 * toolbar` narrows menu rules to the same closed union one step later, and a
 * second `Set` of `SessionSortKey` members is the SSOT drift that lets one copy
 * learn a new key and the other silently drop rules naming it.
 */
export function isSessionSortKey(value: string): value is SessionSortKey {
  return (SESSION_SORT_KEYS as ReadonlySet<string>).has(value);
}

const SESSION_SORT_KEYS: ReadonlySet<SessionSortKey> = new Set(
  Object.values(SessionSortKey)
);
