"use client";

import { priorityOrdinal } from "@repo/api/src/types/search-query";
import { foldToDisplayedSessionStatus } from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import type {
  SessionsSeamCellRenderer,
  SessionTableRow,
} from "@repo/app/agents/lib/session-list-row";
import { ArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { sessionStatusView } from "@repo/app/shared/lib/artifact-status-adapter";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { groupRowEntries } from "@repo/app/shared/lib/table-grouping";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import type { GridTableV2Group } from "@repo/design-system/components/ui/grid-table-v2";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { TableTextCell } from "@repo/design-system/components/ui/table-cell-primitives";
import type {
  TableFieldOption,
  TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { priorityLabel } from "@repo/design-system/lib/priority-order";
import { cn } from "@repo/design-system/lib/utils";
import { compareNullableNumber } from "@repo/lib/sort-comparators";
import { Link } from "@repo/navigation/link";
import type { ReactNode } from "react";
import { isModifiedClick } from "../../../shared/lib/modified-click";
import { resolveHarnessLabel } from "../../lib/harness-labels";
import {
  compareSessionPriorityBands,
  SESSION_GROUP_UNSPECIFIED,
} from "../../lib/session-grouping";
import { sessionRowOwner } from "../../lib/session-owner";
import {
  resolveRenderedSessionColumnIds,
  selectOfferableSessionColumns,
} from "../../lib/sessions-column-visibility";
import {
  SESSIONS_AUTONOMY_COLUMN_ID,
  SESSIONS_BRANCHES_COLUMN_ID,
  SESSIONS_COLUMN_SPECS,
  SESSIONS_COST_COLUMN_ID,
  SESSIONS_HARNESS_COLUMN_ID,
  SESSIONS_ISSUES_COLUMN_ID,
  SESSIONS_OWNER_COLUMN_ID,
  SESSIONS_PRIORITY_COLUMN_ID,
  SESSIONS_PROJECTS_COLUMN_ID,
  SESSIONS_STATUS_COLUMN_ID,
  SESSIONS_TAGS_COLUMN_ID,
  SESSIONS_UPDATED_COLUMN_ID,
  type SessionsColumnId,
} from "../../lib/sessions-table-columns";
import { renderSessionCell as renderSharedSessionCell } from "./session-cell-renderers";
import {
  ownerId,
  ownerName,
  SESSIONS_GROUP_FIELDS,
  sessionsGroupCanonicalValue,
} from "./sessions-list-group-values";
import {
  SESSIONS_CUSTOM_FIELD_COLUMN_PREFIX,
  SESSIONS_LEAD_SORT_FIELD,
  type SessionsListSortField,
} from "./sessions-list-view-state";
import { rememberOpenedSessionRow } from "./use-sessions-focus-restoration";

/**
 * How a `SessionTableRow` becomes grid content for `SessionsListSurfaceV2`:
 * which columns this mount can fill, what each cell renders, and how the rows
 * sort, group and yield their facet options.
 *
 * Split out of the surface itself, which owns composition — the toolbar, the
 * view-state wiring and the non-row states — while this owns the projection.
 * Everything here is pure of the surface's state: each function takes the rows
 * (or one row) and returns what to render, so a change to the geometry cannot
 * reach in and change the composition, or the other way round.
 */

/**
 * The gates this surface satisfies, as a value the SHARED derivation reads.
 *
 * ISS-10301 emptied it: the only structural entry was `grid-table-v2`, and that
 * key is retired. Kept as a declared value rather than deleted so a column
 * landing behind a gate this surface DOES satisfy has a place to say so, and so
 * `selectOfferableSessionColumns` keeps one derivation to read.
 */
const SESSIONS_LIST_SURFACE_GATES: Readonly<Record<string, boolean>> = {};

/**
 * ISS-8712: the gates this surface satisfies, plus whatever the HOST resolved.
 *
 * The structural set is EMPTY since ISS-10301 (see above), but the merge stays:
 * `sessions-artifact-tags` is a real PostHog read that only the host holds.
 * Merging host-supplied answers over the structural ones keeps ONE derivation
 * while letting a key whose answer this module cannot
 * know arrive from the reader that can.
 */
function surfaceGates(
  hostGates: Readonly<Record<string, boolean>> | undefined
): Readonly<Record<string, boolean>> {
  return hostGates
    ? { ...SESSIONS_LIST_SURFACE_GATES, ...hostGates }
    : SESSIONS_LIST_SURFACE_GATES;
}

/**
 * The column specs this build and this MOUNT may offer, asked of the canonical
 * derivation rather than re-decided here.
 *
 * `hostSuppliedColumnIds` is the seam half: `Owning project` and `Linked issues`
 * are cloud-only projections off the raw session record, which a
 * `SessionTableRow` does not carry, so a column whose seam the host did not
 * supply is dropped along with its grid track — "a locally-fed Sessions list
 * must not grow two columns of em dashes", per
 * `SESSIONS_SEAM_REQUIRED_COLUMN_IDS`.
 *
 * Routed through `selectOfferableSessionColumns` because that helper is the ONE
 * answer to "may this build + this mount offer this column at all", and it
 * checks `spec.gate` as well as the seam. `SessionsTable` carries the same
 * instruction beside its own call, having already paid for the hand-written
 * copy once.
 */
export function offerableColumnSpecs(
  seamRenderers: ReadonlyMap<string, SessionsSeamCellRenderer>,
  hostGates?: Readonly<Record<string, boolean>>
): readonly (typeof SESSIONS_COLUMN_SPECS)[number][] {
  return selectOfferableSessionColumns(SESSIONS_COLUMN_SPECS, {
    enabledGates: surfaceGates(hostGates),
    hostSuppliedColumnIds: [...seamRenderers.keys()],
  });
}

/**
 * Whether a canonical column spec declares itself sortable.
 *
 * The `in` check rather than a plain `spec.sortable` read: the `as const` on
 * `SESSIONS_COLUMN_SPECS` narrows each entry to its own exact shape, so the
 * optional field is absent from the union members that omit it and a direct read
 * does not type-check. Mirrors how `SESSIONS_COLUMN_WIDTH_PX` reads `minWidthPx`
 * off the same union.
 */
export function isSortableSpec(
  spec: (typeof SESSIONS_COLUMN_SPECS)[number]
): boolean {
  return "sortable" in spec && spec.sortable === true;
}

/** Sort options: the lead column plus every spec the geometry marks sortable. */
export const SORT_OPTIONS: readonly TableFieldOption[] = [
  { id: "name", label: "Session" },
  ...SESSIONS_COLUMN_SPECS.filter(isSortableSpec).map((spec) => ({
    id: spec.id,
    label: spec.label,
  })),
];

/**
 * Only low-cardinality columns group usefully. Grouping by cost or a timestamp
 * produces one group per row, so the set is deliberately not "every column".
 *
 * DERIVED from `SESSIONS_GROUP_FIELDS` rather than written out beside it
 * (ISS-8296). A hand-listed `Set<string>` here would let a new groupable column
 * ship without declaring whether its bands can be dropped on or what its empty
 * band means — the side-inventory shape that reopens exactly the hole the
 * exhaustive table closes. Keying the set off that table makes the declaration
 * unavoidable, and makes this the client-side sibling of the type-derived
 * capability matrix ISS-7213 owns for custom fields.
 */
export const GROUPABLE_COLUMN_IDS: ReadonlySet<string> = new Set(
  Object.keys(SESSIONS_GROUP_FIELDS)
);

export const FILTERABLE_COLUMN_IDS: ReadonlySet<string> = new Set([
  SESSIONS_STATUS_COLUMN_ID,
  SESSIONS_OWNER_COLUMN_ID,
]);

export const GROUP_OPTIONS: readonly TableFieldOption[] =
  SESSIONS_COLUMN_SPECS.filter((spec) => GROUPABLE_COLUMN_IDS.has(spec.id)).map(
    (spec) => ({ id: spec.id, label: spec.label })
  );

/** The lead name's own type, which {@link SessionsListLeadCell} always applies. */
const SESSIONS_LEAD_NAME_CLASS = "truncate font-medium text-sm";

export function renderSessionCell(
  columnId: string,
  row: SessionTableRow,
  seamRenderers: ReadonlyMap<string, SessionsSeamCellRenderer>,
  { card = false }: { card?: boolean } = {}
) {
  // Seam first: these ids are cloud-only projections this surface cannot
  // derive, so they are a property of the MOUNT, not of the column.
  const seam = seamRenderers.get(columnId);
  if (seam) {
    return seam(row, { uncapped: card });
  }
  // ISS-7902: the SAME renderer `SessionsTable` uses, for all 14 non-seam
  // columns. This surface used to re-implement four of them and drop the other
  // ten through the text cell below, which is what every "v2 column X renders
  // raw" ticket was reporting. Status keeps `syncPresentation` (ISS-5279),
  // Harness resolves its label, Autonomy gets the shared tier chip (FEA-4206),
  // and Cost keeps the tooltip that names an `Unavailable` / `NoTokenUsage` row
  // — none of which a per-column branch here can be trusted to re-derive.
  const shared = renderSharedSessionCell(columnId, row);
  if (shared !== null) {
    return shared;
  }
  // Only for ids the shared renderer does not claim — a column whose whole
  // presentation IS its text.
  //
  // The shared sentinel is returned from HERE rather than from inside
  // `TableTextCell`, which returns it itself for an empty value. The two render
  // identically in the grid, but callers still match on element TYPE
  // (`value.type === GridEmptyValue`), so a `TableTextCell` wrapping the em dash
  // is opaque to them. No `alignEnd` here: right-alignment is a GRID fact, and
  // this file's grid host — {@link renderSessionGridCell} — states it.
  const value = sessionCellValue(columnId, row);
  if (value === "") {
    return <GridEmptyValue />;
  }
  return <TableTextCell value={value} />;
}

/**
 * The one column whose figures read down the track, so the one the grid host
 * right-aligns. Named rather than compared inline, so "which columns are
 * numeric" has a single owner as the geometry grows.
 */
function isNumericColumn(columnId: string): boolean {
  return columnId === SESSIONS_COST_COLUMN_ID;
}

/**
 * The lead cell: the session name, and only the name.
 *
 * With a route the name is a real `@repo/navigation` `Link`, which both the web
 * router and the desktop hash-store adapter intercept — AGENTS.md admits no
 * other in-app navigation mechanism, and `GridTableV2` offers only `onRowClick`,
 * which it explicitly forbids.
 *
 * The seam returns `string | null`, not `string`, for the reason FEA-4051 gives
 * beside the same cell in `SyncedSessionsTable`: a host that cannot resolve a
 * route for a row has nothing honest to return, and a `""`/`"#"` fallback is a
 * fully-styled link that navigates nowhere. `null` renders the plain name.
 *
 * `group-hover:underline` rather than `hover:underline` because the row already
 * carries `group`, so the affordance answers the pointer being anywhere on the
 * row rather than only on the anchor's own line box. And the anchor sizes to its
 * text — `block` would make the whole ~700px lead track a live link.
 *
 * No repository sub-line: ISS-5666 / ISS-5770 cleared this cell down to the name
 * on the shipped Sessions table, and Repository is a default-on column of its
 * own, so a sub-line here states one fact twice and truncates the column's copy
 * to do it.
 */
export function SessionsListLeadCell({
  className,
  getSessionHref,
  row,
  showStatusIcon = false,
}: {
  /**
   * ISS-7902: extra classes are appended through `cn` (twMerge) rather than
   * replacing the base. A caller passing only a colour must not silently drop
   * `truncate` and let a long session name widen the identity track.
   */
  className?: string;
  getSessionHref?: (row: SessionTableRow) => string | null;
  row: SessionTableRow;
  showStatusIcon?: boolean;
}) {
  const nameClass = cn(SESSIONS_LEAD_NAME_CLASS, className);
  const href = getSessionHref?.(row) ?? null;
  // The narrow list's status glyph sits beside the link, not inside it, so the
  // link's accessible name stays the session name; the Branches lead
  // (`renderApprovedBranchLead`) places its glyph the same way.
  const statusIcon = showStatusIcon ? (
    <ArtifactStatus
      variant={ArtifactStatusVariant.Icon}
      // ISS-10364 (operator ruling): an unrecognized raw status reads
      // Active everywhere, so the narrow icon folds the displayed status
      // the wide Status pill shows rather than the raw producer value.
      view={sessionStatusView(row.id, row.status)}
    />
  ) : null;
  if (href === null) {
    return (
      <span className={nameClass}>
        <span className="flex min-w-0 items-center gap-2">
          {statusIcon}
          <TableTextCell value={row.name} />
        </span>
      </span>
    );
  }
  const content = (
    <span className="flex min-w-0 items-center gap-2">
      <TableTextCell value={row.name} />
    </span>
  );
  return (
    <span className="flex min-w-0 items-center gap-2">
      {statusIcon}
      <Link
        className={cn(nameClass, "group-hover:underline")}
        href={href}
        // ISS-9555: which row the reader left the list from, recorded for the
        // remount that follows. UNGATED by the FLAG, because it changes nothing
        // on its own — a module-level write with no reader while the
        // focus-restoration key is closed — and gating it would put a second
        // read of that key on a component the grid renders once per row.
        //
        // Gated on the click actually NAVIGATING THIS TAB. `Link` runs the
        // caller's `onClick` before its own modified-click check, so a
        // Cmd/Ctrl/middle click opens the session in a new tab while this list
        // stays mounted right here — recording a row the reader never left the
        // list for, to be resumed on some later, unrelated return. Same guard,
        // same reason, as the Sessions recovery Link (ISS-4534).
        onClick={(event) => {
          if (!isModifiedClick(event)) {
            rememberOpenedSessionRow(row.id);
          }
        }}
      >
        {content}
      </Link>
    </span>
  );
}

function sessionCellValue(columnId: string, row: SessionTableRow): string {
  const value = SESSION_CELL_READERS[columnId]?.(row);
  return value ?? "";
}

/**
 * Column id → the row field it reads. A map rather than a `row[columnId]` index
 * because the column ids are display geometry and the row fields are a
 * projection: `cost` reads `costLabel`, `updated` reads `lastActivityLabel`.
 * Indexing by id would silently render blanks for every one of those.
 *
 * An id missing from here is not a blank cell, it is a LIE in two places, which
 * is why {@link SESSIONS_SORTABLE_IDS_WITHOUT_SORT_RULE} exists. `TableTextCell`
 * renders `""` as the em dash that means "this record has no value here", so a
 * `lastActivity` with no entry printed "—" on a row whose `lastActivityLabel`
 * the `updated` column beside it was already showing. And {@link sortRows} reads
 * through here, so a sortable id with no entry compared `""` against `""` on
 * every row, left the order untouched, and still lit the header arrow and the
 * Sort menu's "Sorted by …". Both were live for `status`, `owner` and
 * `lastActivity`, and the em-dash half for `pr` and `merge`.
 */
const SESSION_CELL_READERS: Readonly<
  Record<string, (row: SessionTableRow) => string | null | undefined>
> = {
  // Not a render path since FEA-4206 gave the cell its own chip branch, and not
  // the SORT path since ISS-7902 gave it a numeric one — see
  // {@link SESSION_NUMERIC_SORT_READERS}. Kept because `groupKey` still reaches
  // through here for any id a `controlledView` host names, and a grouped
  // Autonomy band wants the score rather than a blank.
  [SESSIONS_AUTONOMY_COLUMN_ID]: (row) =>
    row.autonomy == null ? null : String(row.autonomy),
  branch: (row) => row.branch,
  branches: (row) => row.branch,
  cost: (row) => row.costLabel,
  duration: (row) => row.durationLabel,
  // ISS-7902: the RESOLVED label, which is what the cell renders. Read raw, the
  // `harness` group band read "codex" over a column of "Codex" pills, and an
  // empty harness banded under "—" while its cell read "Claude".
  [SESSIONS_HARNESS_COLUMN_ID]: (row) => resolveHarnessLabel(row.harness),
  lastActivity: (row) => row.lastActivityLabel,
  merge: (row) => row.mergeStatusLabel,
  model: (row) => row.model,
  // Read by `sortRows`, `groupKey` and the client Status facet only —
  // `renderSessionCell` reaches its own badge/person branch for these two
  // before the fallback.
  owner: (row) => ownerName(row),
  pr: (row) => row.pullRequestSummaryLabel,
  // ISS-10332: the word the band header and a menu option render for this
  // value — `No priority` for an unset one, `Unknown priority` for a member
  // only a newer peer knows — and the v1 table's own `Unspecified` for a
  // producer that omitted the field, so one saved view bands one row under
  // one word whichever table paints it (visual QA, 2026-09-22).
  [SESSIONS_PRIORITY_COLUMN_ID]: (row) =>
    row.priority === undefined
      ? SESSION_GROUP_UNSPECIFIED
      : priorityLabel(row.priority),
  repo: (row) => row.repo,
  started: (row) => row.startedLabel,
  // ISS-7902: the DISPLAYED word, folded exactly as the badge folds it, for the
  // reason ISS-5366 gives beside `sessionGroupBand` — a band header reading the
  // raw `error` over pills reading "Failed" is the band contradicting the cells
  // inside it. The facet's option ID stays the raw stored value; only the label
  // comes from here (see {@link collectStatuses}).
  [SESSIONS_STATUS_COLUMN_ID]: (row) =>
    SESSION_STATUS_LABELS[foldToDisplayedSessionStatus(row.status)],
  // ISS-8013 (whitlockk, PR #6009): `updatedLabel` ALONE, with no fallback to
  // `lastActivityLabel`. The cell this projection is supposed to mirror is
  // `renderTimestampCell(row.updatedLabel ?? null)` in `session-cell-renderers`
  // — reached FIRST by both this surface's `renderSessionCell` and the v1
  // `SessionsTable`, and returning `GridEmptyValue` rather than `null` for an
  // absent label, so the shared renderer CLAIMS the cell and this map is never
  // consulted for the render. A version-skewed producer that serves no
  // `recordUpdatedAt` therefore shows an em dash here, not a borrowed
  // `Last active` time.
  //
  // The fallback was reachable only through `groupKey`, where it produced
  // exactly the ISS-5366 defect the `status` reader above exists to prevent: a
  // band headed "5m ago" over a column of em dashes. It also disagreed with
  // `SESSION_NUMERIC_SORT_READERS.updated`, which reads `updatedAtMs` and parks
  // an absent value last — the shape whitlockk flagged. Removing it settles all
  // three on the ONE fact the cell states.
  updated: (row) => row.updatedLabel ?? null,
};

/**
 * Columns whose ORDER is a number the row carries, not the string its cell
 * shows. {@link sortRows} reads these first, because `localeCompare` on a
 * formatted value is lexicographic: `["88","50","12","0","100","9"]` sorts to
 * `0, 100, 12, 50, 88, 9` — a 9 ranked above a 100 (ISS-7902) — and `$1,234.00`
 * ranks below `$9.50` while `2h 40m` ranks below `5m` (ISS-8013).
 *
 * `null` sorts last in BOTH directions ({@link compareNullableNumber}): an
 * absent measurement is not a low one, so it must not lead the ascending list,
 * and a MEASURED ZERO must outrank it.
 *
 * ISS-8013 added the five time/money columns. Until then this held Autonomy
 * alone, because `SessionTableRow` carried a LABEL for each of the others and no
 * underlying value, so there was nothing here to sort them by — the row now
 * carries both (`costValue`, `durationMs`, `startedAtMs`, …). Every one of them
 * reads the field its OWN label was formatted from, which is the part that has
 * to stay true: `updated` and `lastActivity` render near-identical phrases from
 * different clocks, so a reader pointed one field sideways is a wrong order
 * nothing on screen contradicts.
 */
const SESSION_NUMERIC_SORT_READERS: Readonly<
  Record<string, (row: SessionTableRow) => number | null>
> = {
  [SESSIONS_AUTONOMY_COLUMN_ID]: (row) => row.autonomy ?? null,
  [SESSIONS_COST_COLUMN_ID]: (row) => row.costValue ?? null,
  duration: (row) => row.durationMs ?? null,
  lastActivity: (row) => row.lastActivityAtMs ?? null,
  // ISS-10332: the wire ordinal (low→high), the SAME one the cloud sort
  // compares (`session-sort-comparators.ts`), so a client-sorted page and a
  // server-sorted one agree on which end "ascending" is. Read through
  // `priorityOrdinal`, the sanctioned accessor: a member only a newer peer
  // knows has no ordinal here, and folding that miss to `null` parks it last
  // with the unset rows, as `compareNullableNumber` parks every absent
  // measurement — a raw index would hand the comparator `undefined` and
  // corrupt the whole page's order (ISS-10332 review).
  [SESSIONS_PRIORITY_COLUMN_ID]: (row) =>
    row.priority == null ? null : (priorityOrdinal(row.priority) ?? null),
  started: (row) => row.startedAtMs ?? null,
  [SESSIONS_UPDATED_COLUMN_ID]: (row) => row.updatedAtMs ?? null,
};

/**
 * How a column sorts. `Unsortable` is a real answer, not an absence — it is what
 * a column whose spec carries no `sortable` flag declares.
 */
const SessionSortRule = {
  /** Ordered by a NUMBER the row carries; see {@link SESSION_NUMERIC_SORT_READERS}. */
  Numeric: "numeric",
  /** Ordered by the rendered text, which for this column genuinely IS its order. */
  Text: "text",
  /** Offers no sort control at all. */
  Unsortable: "unsortable",
} as const;
type SessionSortRule = (typeof SessionSortRule)[keyof typeof SessionSortRule];

/**
 * EVERY canonical column, and how it sorts.
 *
 * ISS-8013 (whitlockk, PR #6009): exhaustive over `SessionsColumnId` rather than the
 * two hand-listed side inventories this replaces. A new entry in
 * `SESSIONS_COLUMN_SPECS` widens that union, and a `Record` keyed on it is then
 * missing a key — so the column cannot COMPILE until someone states how it
 * sorts. The previous shape (a `Set` of text ids, checked by a test) let a new
 * `sortable: true` column build and fall through to label ordering until the
 * suite happened to run, which is the same class of gap as the one this ticket
 * was filed for.
 *
 * Deriving it instead — "sortable and not numeric is text" — is what must NOT
 * happen: that classifies every future column as text BY DEFAULT and makes the
 * guard below unfailable, which is how five columns shipped sorting by their own
 * currency punctuation. The declaration is deliberately manual; only its
 * COMPLETENESS is mechanical.
 */
const SESSION_SORT_RULE_BY_COLUMN_ID: Readonly<
  Record<SessionsColumnId, SessionSortRule>
> = {
  [SESSIONS_STATUS_COLUMN_ID]: SessionSortRule.Text,
  [SESSIONS_PRIORITY_COLUMN_ID]: SessionSortRule.Numeric,
  // ISS-8712: a row can carry MANY tags, so there is no single value to rank it
  // by — the same reason the other multi-valued columns above are unsortable.
  // The spec is `sortable: false`, so no header offers the sort this declines.
  [SESSIONS_TAGS_COLUMN_ID]: SessionSortRule.Unsortable,
  owner: SessionSortRule.Text,
  [SESSIONS_AUTONOMY_COLUMN_ID]: SessionSortRule.Numeric,
  [SESSIONS_PROJECTS_COLUMN_ID]: SessionSortRule.Unsortable,
  repo: SessionSortRule.Text,
  [SESSIONS_BRANCHES_COLUMN_ID]: SessionSortRule.Unsortable,
  [SESSIONS_ISSUES_COLUMN_ID]: SessionSortRule.Unsortable,
  [SESSIONS_HARNESS_COLUMN_ID]: SessionSortRule.Text,
  model: SessionSortRule.Text,
  duration: SessionSortRule.Numeric,
  [SESSIONS_COST_COLUMN_ID]: SessionSortRule.Numeric,
  started: SessionSortRule.Numeric,
  [SESSIONS_UPDATED_COLUMN_ID]: SessionSortRule.Numeric,
  lastActivity: SessionSortRule.Numeric,
  pr: SessionSortRule.Unsortable,
  merge: SessionSortRule.Unsortable,
};

/**
 * Every column the canonical geometry marks sortable states HOW it sorts, AND is
 * backed by the reader that rule names.
 *
 * A structural invariant rather than a per-id list. {@link sortRows} falls
 * through to {@link sessionCellValue}, so a `sortable: true` spec that names
 * neither a numeric reader nor a cell reader is a sort control that either moves
 * nothing (`""` against `""` on every row) or moves rows into the order of their
 * own formatting — while the header arrow, the Sort menu's "Sorted by …" and the
 * Clear-sort control all say it sorted. Exported so that fails a test rather
 * than shipping.
 *
 * This is the RUNTIME half of the pair. {@link SESSION_SORT_RULE_BY_COLUMN_ID}
 * makes an unclassified column fail `tsc`; this catches the case the type system
 * cannot see — a rule DECLARED whose reader was never written, or a column
 * marked `sortable` in the geometry while its rule here says `Unsortable`.
 *
 * ISS-8013 widened this from "has a CELL reader" to "has a SORT RULE". The
 * older, narrower invariant was satisfied by all five of the columns it was
 * meant to protect: each had a cell reader, returning the label the sort was
 * wrong about.
 */
export const SESSIONS_SORTABLE_IDS_WITHOUT_SORT_RULE: readonly string[] =
  SESSIONS_COLUMN_SPECS.filter(isSortableSpec)
    .map((spec) => spec.id)
    .filter((id) => !sortRuleIsBacked(id));

/**
 * Status facet options: one per distinct STORED status, labelled with the word
 * its badge renders.
 *
 * The id stays the raw value because that is what the filter compares against
 * (`facets.statuses.includes(row.status)`) and what a host puts in a query;
 * relabelling is display only. Sorted by the visible label, since that is the
 * order a reader scans — the same shape {@link collectOwners} uses.
 */
export function collectStatuses(rows: readonly SessionTableRow[]) {
  const labelById = new Map<string, string>();
  for (const row of rows) {
    if (!labelById.has(row.status)) {
      // Through the READER, not a second copy of its expression: the two are
      // meant to name the same word, and re-spelling the fold here is how the
      // facet chip and the cell would quietly stop agreeing.
      labelById.set(
        row.status,
        sessionCellValue(SESSIONS_STATUS_COLUMN_ID, row)
      );
    }
  }
  return [...labelById.entries()]
    .sort(([, left], [, right]) => left.localeCompare(right))
    .map(([id, label]) => ({ id, label }));
}

/**
 * Owner facet options: one per distinct owner ID, labelled with that owner's
 * display name — the same shape the shipped Sessions owner facet uses, where
 * the toggle threads the canonical `userIds` filter and the name is only the
 * label. Two people sharing a name therefore get two options, which is the point.
 *
 * Sorted by the visible label, since that is the order a reader scans.
 */
export function collectOwners(rows: readonly SessionTableRow[]) {
  const labelById = new Map<string, string>();
  for (const row of rows) {
    const id = ownerId(row);
    if (!labelById.has(id)) {
      labelById.set(id, ownerName(row));
    }
  }
  return [...labelById.entries()]
    .sort(([, left], [, right]) => left.localeCompare(right))
    .map(([id, label]) => ({ id, label }));
}

export function sortRows(
  rows: readonly SessionTableRow[],
  sortBy: SessionsListSortField | null,
  direction: SortDirection
): SessionTableRow[] {
  if (sortBy === null) {
    return [...rows];
  }
  const sign = direction === "asc" ? 1 : -1;
  const numericReader = SESSION_NUMERIC_SORT_READERS[sortBy];
  if (numericReader) {
    return [...rows].sort((a, b) =>
      compareNullableNumber(numericReader(a), numericReader(b), direction)
    );
  }
  return [...rows].sort((a, b) => {
    const left =
      sortBy === SESSIONS_LEAD_SORT_FIELD
        ? a.name
        : sessionCellValue(sortBy, a);
    const right =
      sortBy === SESSIONS_LEAD_SORT_FIELD
        ? b.name
        : sessionCellValue(sortBy, b);
    return left.localeCompare(right) * sign;
  });
}

/**
 * Every id {@link SessionsListSortField} admits, as a lookup.
 *
 * Derived from the canonical specs rather than re-listed, so a column added to
 * the declaration becomes sortable-by-id here without this file being edited.
 */
const SESSIONS_LIST_SORT_FIELDS: readonly SessionsListSortField[] = [
  SESSIONS_LEAD_SORT_FIELD,
  ...SESSIONS_COLUMN_SPECS.map((spec) => spec.id),
];

const SESSIONS_LIST_SORT_FIELD_BY_ID: Readonly<
  Record<string, SessionsListSortField>
> = Object.fromEntries(
  SESSIONS_LIST_SORT_FIELDS.map((id): [string, SessionsListSortField] => [
    id,
    id,
  ])
);

/**
 * The narrowing seam between the design-system menus, whose sort callbacks hand
 * back a bare `string`, and the closed {@link SessionsListSortField} the view
 * state stores.
 *
 * Every id these menus can emit is built from `SESSIONS_COLUMN_SPECS` in the
 * first place, so the `null` is a boundary guard rather than an expected path —
 * and `null` is the honest degradation for an id this surface cannot sort by,
 * since it renders the list unsorted instead of sorting every row to `""`.
 */
export function toSessionsListSortField(
  fieldId: string
): SessionsListSortField | null {
  if (fieldId.startsWith(SESSIONS_CUSTOM_FIELD_COLUMN_PREFIX)) {
    return fieldId as SessionsListSortField;
  }
  return SESSIONS_LIST_SORT_FIELD_BY_ID[fieldId] ?? null;
}

/**
 * What a custom-field column contributes to a band: the LABEL it is keyed on,
 * plus the canonical value a drop would write (ISS-8296).
 *
 * A pair rather than the bare string this seam used to return, because the two
 * are genuinely different facts and the old shape could only carry one. Passing
 * an id through the single-string seam would have changed the band's rendered
 * NAME, which ISS-7902 fixed on purpose.
 */
export type SessionsGroupContribution = { key: string; value?: string };

export type SessionsGroupValueResolver = (
  field: string,
  row: SessionTableRow
) => SessionsGroupContribution | undefined;

export function buildGroups(
  rows: readonly SessionTableRow[],
  grouping: TableGroupingState,
  resolveGroupValue?: SessionsGroupValueResolver
): GridTableV2Group<SessionTableRow>[] {
  const primaryField = grouping.primary.fieldId;
  if (primaryField === null) {
    return [];
  }
  const secondaryField = grouping.secondary.fieldId;
  return partition(
    rows,
    primaryField,
    grouping.primary.order,
    resolveGroupValue
  ).map((band) => ({
    ...band,
    subgroups:
      secondaryField === null
        ? undefined
        : partition(
            band.items,
            secondaryField,
            grouping.secondary.order,
            resolveGroupValue
          ),
  }));
}

type SessionBand = {
  key: string;
  /**
   * The rendered band name. Equal to the key for every field except Owner,
   * whose bands are keyed on the owner's id and named by display name
   * (ISS-7505).
   */
  label: string;
  items: SessionTableRow[];
  value?: string;
  droppable: boolean;
};

type BandAccumulator = {
  label: string;
  items: SessionTableRow[];
  value?: string;
  /** Set once the band can no longer name ONE value every row agrees on. */
  poisoned: boolean;
};

/**
 * Bucket rows by their band key, and decide each band's canonical value
 * (ISS-8296).
 *
 * A band carries a value only when EVERY row in it yields the SAME DEFINED one.
 * Stated over rows rather than over "the distinct values", because collecting
 * values then filtering out an absent one leaves exactly one value and enables
 * a drop that would rewrite the rows that had none. An absent value POISONS.
 * (Owner bands are keyed on id since ISS-7505, so `{id:"u1",name:"Jane"}` and
 * an id-less `{name:"Jane"}` are two bands now, not one poisoned one.)
 */
function partition(
  rows: readonly SessionTableRow[],
  field: string,
  order: TableGroupOrder,
  resolveGroupValue?: SessionsGroupValueResolver
): SessionBand[] {
  const contributionOf = (row: SessionTableRow) => {
    const contribution = resolveGroupValue?.(field, row);
    const band = contribution
      ? { key: contribution.key, label: contribution.key }
      : groupBand(field, row);
    return {
      ...band,
      value: contribution
        ? contribution.value
        : sessionsGroupCanonicalValue(field, row),
    };
  };
  const ordered = groupRowEntries(
    rows,
    contributionOf,
    ({ label, value }, row): BandAccumulator => {
      return { items: [row], label, poisoned: value === undefined, value };
    },
    {
      order,
      appendContribution: (bucket, { value }) => {
        if (value === undefined || value !== bucket.value) {
          bucket.poisoned = true;
        }
      },
      // ISS-10332: Priority is the first ORDINAL dimension here; every other one is
      // nominal, which is why a label sort was right until now. Its bands rank by
      // the value they hold (most urgent first, unset after LOW, an omitted value
      // last), the same order `comparePrioritySections` gives the Documents grid.
      // A band's rows all share one value by construction (they are bucketed on
      // its label), so the first row speaks for the band. The ordering is a fact
      // about the priority values, never about the words, so the `Unspecified`
      // band cannot land mid-list the way a string sort put it (visual QA,
      // 2026-09-22).
      compare:
        field === SESSIONS_PRIORITY_COLUMN_ID
          ? ([, left], [, right]) =>
              compareSessionPriorityBands(left.items[0], right.items[0])
          : // Ordered by the NAME a reader scans, not the key: an Owner key is
            // an id (ISS-7505). The key only breaks a tie between two owners
            // who share a name, so their order is stable across renders.
            ([leftKey, left], [rightKey, right]) =>
              left.label.localeCompare(right.label) ||
              leftKey.localeCompare(rightKey),
    }
  );
  return ordered.map(([key, bucket]) => ({
    droppable: !bucket.poisoned,
    items: bucket.items,
    key,
    label: bucket.label,
    value: bucket.poisoned ? undefined : bucket.value,
  }));
}

/**
 * A row's band identity (`key`) and the name its header renders (`label`).
 *
 * ISS-7902: Status no longer short-circuits to the raw stored word. Its reader
 * now returns the DISPLAYED label — the same one the badge in every cell of the
 * band renders — so the band naming and the cells beneath it agree, which is
 * `sessionGroupBand`'s ISS-5366 contract on the shipped table.
 *
 * ISS-7505: Owner is keyed on the owner's ID and labelled by {@link ownerName}.
 * A display name is only how we spell an owner, so two people sharing one are
 * two bands, each headed by that name — the identity the Owner facet already
 * filters on (`collectOwners`) and the shipped table already bands on
 * (`sessionGroupBand`). An owner the projection carried no id for falls back to
 * its name, as it does there, rather than being mislabelled unassigned; a row
 * with no owner at all keeps the one unassigned band.
 */
function groupBand(
  field: string,
  row: SessionTableRow
): { key: string; label: string } {
  if (field === SESSIONS_OWNER_COLUMN_ID) {
    const label = ownerName(row);
    return { key: sessionRowOwner(row)?.id ?? label, label };
  }
  const label = sessionCellValue(field, row) || "—";
  return { key: label, label };
}

/**
 * The columns a brand-new view of this surface starts with: everything this
 * build and this MOUNT can offer, minus the canonical default-hidden seed.
 *
 * The seed, not "every column the menu offers": the canonical default
 * deliberately ships `Updated`, `PR`, `Merge`, `Owning project`, `Linked
 * issues` and `Tags` OFF, and this grid overflows by ~1,000px at its
 * documented default, so seeding from the menu opened a first screen four
 * tracks wider than the design. Derived through the same gate-and-seam
 * resolution the table renders by, so a seam-required column a host wires
 * lands in the default set exactly when the seed leaves it shown — which is how
 * `Priority` ships shown by default (ISS-10332, operator ruling 5) while the
 * linked-entity pair a host wires stays off until the reader asks for it.
 */
export function defaultVisibleColumnIds(
  seamRenderers: ReadonlyMap<string, SessionsSeamCellRenderer>
): Set<string> {
  return new Set(
    resolveRenderedSessionColumnIds({
      enabledGates: surfaceGates(undefined),
      hostSuppliedColumnIds: [...seamRenderers.keys()],
    })
  );
}

/**
 * The GRID's cell: {@link renderSessionCell}'s content, plus the alignment that
 * belongs to the grid rather than to the column.
 *
 * `SessionsTable` keeps this exact split — `renderCellForGrid` wraps
 * `renderCellForCard`'s output — and the reason is that right-aligning currency
 * exists so the decimal points line up DOWN A COLUMN. A card body is a stacked
 * key/value list with no column to align to, so the same class flings `$4.12` to
 * the far edge of a half-width field. Keeping alignment out of the cell renderer
 * is what lets the two mounts share one without sharing that.
 *
 * The wrapper cannot be replaced by the Cost spec's own `justify-end`:
 * `GridTableV2` forwards `column.className` to its HEADER only, never to
 * `GridTableV2Cell`, so the track styles the word "Cost" and nothing beneath it
 * (codex-review, ISS-7902). Before this surface routed Cost through the shared
 * renderer the alignment arrived by accident, from `TableNumberCell`'s default
 * `alignEnd`; `SessionCostCell` owns no alignment class of its own, by ISS-4996's
 * one-shared-empty-glyph contract, so the figure AND the no-usage dash went flush
 * left under a right-aligned header.
 */
export function renderSessionGridCell(
  columnId: string,
  row: SessionTableRow,
  seamRenderers: ReadonlyMap<string, SessionsSeamCellRenderer>
): ReactNode {
  const cell = renderSessionCell(columnId, row, seamRenderers);
  if (!isNumericColumn(columnId)) {
    return cell;
  }
  return <span className="flex w-full justify-end">{cell}</span>;
}

/** Captured-main card cells wrap and leave numeric values naturally aligned. */
export function renderSessionCardCell(
  columnId: string,
  row: SessionTableRow,
  seamRenderers: ReadonlyMap<string, SessionsSeamCellRenderer>
): ReactNode {
  return renderSessionCell(columnId, row, seamRenderers, { card: true });
}

/**
 * Whether the rule {@link SESSION_SORT_RULE_BY_COLUMN_ID} declares for a column
 * is actually backed by the reader that rule names.
 *
 * `Unsortable` answers `false` deliberately: reached only from
 * {@link SESSIONS_SORTABLE_IDS_WITHOUT_SORT_RULE}, which asks about columns the
 * GEOMETRY already marks sortable, so the two sources contradicting each other
 * is a finding rather than a pass.
 */
function sortRuleIsBacked(id: SessionsColumnId): boolean {
  const rule = SESSION_SORT_RULE_BY_COLUMN_ID[id];
  if (rule === SessionSortRule.Numeric) {
    return SESSION_NUMERIC_SORT_READERS[id] !== undefined;
  }
  if (rule === SessionSortRule.Text) {
    return SESSION_CELL_READERS[id] !== undefined;
  }
  return false;
}
