/**
 * ISS-5315 — the Sessions list "Group by" dimension, matching the prototype's
 * View-menu section (None / Status / Harness / Owner).
 *
 * Pure data over already-mapped `SessionTableRow`s, with no React and no query
 * awareness, so both shells band the same rows the same way and the behavior is
 * unit-testable on its own. The display-label maps it reads are the same
 * dependency-light modules the CELLS read, so a band header and the cell beneath
 * it cannot name one value two ways (#4480 review).
 *
 * **Grouping bands the rows ON SCREEN, and says so.** The prototype groups a
 * fully client-held corpus; the production list is server-paginated, so the only
 * population this module can honestly speak about is the current page. Each band
 * label is therefore the dimension's VALUE alone — never a count — because a
 * count here would read as "how many sessions are Active" when it only ever
 * means "how many on this page". The Sessions table enforces that by passing
 * `showGroupCount={false}` to `GridTable`; the page-scoped nature is stated in
 * the toolbar's copy, and the pager stays visible so the reader can see there is
 * more.
 */

import { foldToDisplayedSessionStatus } from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { groupRowEntries } from "@repo/app/shared/lib/table-grouping";
import { TableGroupOrder } from "@repo/design-system/components/ui/table-toolbar-model";
import {
  comparePriorityByRank,
  priorityLabel,
} from "@repo/design-system/lib/priority-order";
import { PRIORITY_COLUMN_LABEL } from "../../shared/lib/priority-constants";
import { resolveHarnessLabel } from "./harness-labels";
import { sessionRowOwner } from "./session-owner";
import { SESSIONS_PRIORITY_COLUMN_ID } from "./sessions-table-columns";

/** The dimensions the Sessions list can band on. */
export const SessionGroupBy = {
  None: "none",
  Status: "status",
  Harness: "harness",
  Owner: "owner",
  /** ISS-10332: the Session artifact's priority, banded by its rendered label. */
  Priority: "priority",
} as const;
export type SessionGroupBy =
  (typeof SessionGroupBy)[keyof typeof SessionGroupBy];

/** Band label for a row whose owner is not attributed. */
export const SESSION_GROUP_UNATTRIBUTED_OWNER = "Unattributed";

/** Band label for a row whose grouped dimension carries no value. */
export const SESSION_GROUP_UNSPECIFIED = "Unspecified";

/**
 * The table column each dimension bands on. The grouped column is hidden while
 * grouping is active so the value is not printed twice (band header + cell) —
 * the same call the prototype makes. {@link hideSessionGroupedColumn} is the ONE
 * place that deletion happens; both shells reach it through the shared
 * `SessionsTable`, so neither adapter has to remember it (#4480 review).
 */
export const SESSION_GROUP_COLUMN_ID: Record<
  SessionGroupBy,
  string | undefined
> = {
  [SessionGroupBy.None]: undefined,
  [SessionGroupBy.Status]: "status",
  [SessionGroupBy.Harness]: "harness",
  [SessionGroupBy.Owner]: "owner",
  [SessionGroupBy.Priority]: SESSIONS_PRIORITY_COLUMN_ID,
};

/** Human label for each dimension, for the View menu's segmented control. */
export const SESSION_GROUP_BY_LABELS: Record<SessionGroupBy, string> = {
  [SessionGroupBy.None]: "None",
  [SessionGroupBy.Status]: "Status",
  [SessionGroupBy.Harness]: "Harness",
  [SessionGroupBy.Owner]: "Owner",
  [SessionGroupBy.Priority]: PRIORITY_COLUMN_LABEL,
};

/** Coerce an unknown persisted/URL value to a known dimension. */
export function coerceSessionGroupBy(value: unknown): SessionGroupBy {
  const known = Object.values(SessionGroupBy).find(
    (dimension) => dimension === value
  );
  return known ?? SessionGroupBy.None;
}

/**
 * Band `rows` by `groupBy`, preserving the rows' existing (server-sorted) order
 * both between bands — a band appears where its first member does — and inside
 * each band. Returns `undefined` for {@link SessionGroupBy.None} so a caller can
 * hand the result straight to `GridTable`'s optional `groups` prop.
 *
 * Bands are keyed by IDENTITY and labelled by DISPLAY TEXT, which are not the
 * same thing: two distinct users who share a display name are two owners, while
 * two raw statuses the fold resolves to one value are one band. Collapsing on
 * the label alone merged the first pair and split the second (#4480 review).
 * Which raw statuses share a band is `normalizeDisplayedSessionStatus`, not a
 * list here — ISS-6581 removed the list, which by then named a retired trio as
 * one band when the fold had already split it.
 */
export function buildSessionGroups(
  rows: readonly SessionTableRow[],
  groupBy: SessionGroupBy
): { key: string; label: string; items: SessionTableRow[] }[] | undefined {
  if (groupBy === SessionGroupBy.None) {
    return undefined;
  }
  // ISS-10332: the one ordinal dimension. Bands appear where the ranking puts
  // them (most urgent first, unset after LOW, omitted last), not where their
  // first member happened to land in the server order, which for a list
  // sorted by anything else is no order at all (visual QA, 2026-09-22). Every
  // other dimension keeps first-seen order.
  const order =
    groupBy === SessionGroupBy.Priority
      ? TableGroupOrder.Ascending
      : TableGroupOrder.Custom;
  return groupRowEntries(
    rows,
    (row) => sessionGroupBand(row, groupBy),
    ({ key, label }, row) => ({ items: [row], key, label }),
    {
      order,
      compare: ([, left], [, right]) =>
        compareSessionPriorityBands(left.items[0], right.items[0]),
    }
  ).map(([, band]) => band);
}

/**
 * ISS-10332: how two priority bands order, from a representative row of each.
 * Most urgent first and unset after LOW (`comparePriorityByRank`); a producer
 * that OMITTED the field ranks after unset, because "unknown to this peer" is
 * not a priority and must not sit among them. Shared by both tables so the
 * v1 and v2 band orders cannot diverge.
 */
export function compareSessionPriorityBands(
  left: SessionTableRow | undefined,
  right: SessionTableRow | undefined
): number {
  const leftOmitted = left?.priority === undefined;
  const rightOmitted = right?.priority === undefined;
  if (leftOmitted || rightOmitted) {
    return Number(leftOmitted) - Number(rightOmitted);
  }
  return comparePriorityByRank(left.priority, right.priority);
}

/**
 * The visible-column set the grid should render while `groupBy` is active — the
 * caller's set minus the banded column, because the band header already states
 * that value for every row beneath it.
 *
 * Returns the SAME set instance when nothing is banded, so a caller can use it
 * unconditionally without minting a new identity on every render.
 *
 * This is also what `isSyncStateFoldActive` must be judged against: with Status
 * banded there is no Status cell to fold the sync signal into, so the fold has
 * to stand down and hand the signal back to the Name cell rather than drop it
 * from the grid entirely (whitlockk, #4480).
 */
export function hideSessionGroupedColumn(
  visibleColumns: Set<string> | undefined,
  groupBy: SessionGroupBy
): Set<string> | undefined {
  const groupedColumnId = SESSION_GROUP_COLUMN_ID[groupBy];
  if (!(groupedColumnId && visibleColumns?.has(groupedColumnId))) {
    return visibleColumns;
  }
  const next = new Set(visibleColumns);
  next.delete(groupedColumnId);
  return next;
}

/**
 * A row's band identity and its display label for `groupBy`.
 *
 * Status and Harness route through the SAME maps their cells render
 * (`SESSION_STATUS_LABELS` after `normalizeDisplayedSessionStatus`, and
 * `resolveHarnessLabel`), so a failed session bands under "Failed" like its
 * pill rather than under the raw wire word `error`, and `Claude`/`claude` are
 * one harness rather than two. The normalization is also the identity, so any
 * two stored spellings the pill shows as one state land in one band rather than
 * two — however many that currently is, which is the fold's business and not a
 * number to hard-code here (ISS-6581: the count that used to be written out was
 * three, and stopped being true without this comment noticing).
 */
function sessionGroupBand(
  row: SessionTableRow,
  groupBy: SessionGroupBy
): { key: string; label: string } {
  if (groupBy === SessionGroupBy.Owner) {
    const owner = sessionRowOwner(row);
    const name = owner?.name?.trim();
    if (!name) {
      return {
        key: SESSION_GROUP_UNATTRIBUTED_OWNER,
        label: SESSION_GROUP_UNATTRIBUTED_OWNER,
      };
    }
    // Key on the user id when the projection carried one: two different people
    // named "Alex" are two owners, and a display name is not an identity.
    return { key: owner?.id ?? name, label: name };
  }
  if (groupBy === SessionGroupBy.Priority) {
    // ISS-10332: a producer that OMITTED the field bands under the unspecified
    // word rather than under "No priority", which would state a value nobody
    // read; an unset one bands under the design system's own "No priority",
    // the word the editor's menu offers for it.
    if (row.priority === undefined) {
      return {
        key: SESSION_GROUP_UNSPECIFIED,
        label: SESSION_GROUP_UNSPECIFIED,
      };
    }
    const label = priorityLabel(row.priority);
    return { key: row.priority ?? label, label };
  }
  if (groupBy === SessionGroupBy.Harness) {
    const harness = row.harness.trim();
    if (!harness) {
      return {
        key: SESSION_GROUP_UNSPECIFIED,
        label: SESSION_GROUP_UNSPECIFIED,
      };
    }
    const label = resolveHarnessLabel(harness);
    return { key: label, label };
  }
  const status = row.status.trim();
  if (!status) {
    return { key: SESSION_GROUP_UNSPECIFIED, label: SESSION_GROUP_UNSPECIFIED };
  }
  // ISS-5366: the DISPLAY-ONLY members (`stale`, `unknown`) must be matched
  // BEFORE the fold, never through it, or a row whose pill reads "Stale" bands
  // under "Active" — the band contradicting the cell inside it. That ordering is
  // now `foldToDisplayedSessionStatus`, the one derivation the badge reads too,
  // rather than a ternary written out here and there (ISS-7902).
  const normalized = foldToDisplayedSessionStatus(status);
  return { key: normalized, label: SESSION_STATUS_LABELS[normalized] };
}
