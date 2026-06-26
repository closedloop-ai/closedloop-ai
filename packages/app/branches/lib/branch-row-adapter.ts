import {
  BranchStatus,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import {
  BranchRowStatus,
  RENDER_MISSING,
  RENDER_UNATTRIBUTED,
  type BranchRow as RenderBranchRow,
} from "./branch-sample-data";

/**
 * Wire `BranchStatus` (branch.ts) -> render `BranchRowStatus` (branch-sample-data).
 * The render enum has no "closed"; a closed-without-merge branch is dormant, so
 * it maps to the muted "draft" variant (least-alarming). Epic B's table rework
 * can introduce a dedicated closed variant.
 */
const STATUS_MAP: Record<BranchStatus, BranchRowStatus> = {
  [BranchStatus.Open]: BranchRowStatus.Open,
  [BranchStatus.Review]: BranchRowStatus.Review,
  [BranchStatus.Merged]: BranchRowStatus.Merged,
  [BranchStatus.Draft]: BranchRowStatus.Draft,
  [BranchStatus.Blocked]: BranchRowStatus.Blocked,
  [BranchStatus.Closed]: BranchRowStatus.Draft,
};

/** Least-alarming render status for an unrecognized wire status (see below). */
const FALLBACK_STATUS = BranchRowStatus.Draft;

/**
 * Map a wire status to a render status. A newer producer could emit a
 * `BranchStatus` value this (older) renderer predates; rather than crash the
 * table on an `undefined` lookup, an unknown status degrades to the muted
 * `Draft` variant. Exported so the detail Properties panel (D8) renders the same
 * status chip mapping as the list (no divergent second mapping).
 */
export function toRenderStatus(status: BranchStatus): BranchRowStatus {
  return STATUS_MAP[status] ?? FALLBACK_STATUS;
}

/**
 * Project a wire `BranchRow` (branch.ts) into the render `BranchRow` consumed by
 * the existing `BranchesTable` / `useBranchFilterState` scaffold, so those
 * components stay unchanged (build-on-the-scaffold rule). NULL enrichment
 * degrades to render placeholders (string fields) or NULL (numeric fields, which
 * the table renders via its empty-value affordance) — never a fabricated 0.
 */
export function adaptBranchRow(
  row: WireBranchRow,
  options?: { now?: number }
): RenderBranchRow {
  return {
    id: row.id,
    branchName: row.branchName,
    baseBranch: row.baseBranch ?? RENDER_MISSING,
    repo: row.repoFullName ?? RENDER_MISSING,
    owner: row.owner ?? RENDER_UNATTRIBUTED,
    status: toRenderStatus(row.status),
    prNumber: row.prNumber,
    prTitle: row.prTitle,
    prUrl: row.prUrl,
    prState: row.prState,
    checksPassed: row.checksPassed,
    checksTotal: row.checksTotal,
    checksStatus: row.checksStatus,
    behind: row.behind,
    ahead: row.ahead,
    additions: row.additions,
    deletions: row.deletions,
    sessionCount: row.sessionIds.length,
    commentCount: null,
    lastActivityLabel: formatLastActivityLabel(row.lastActivityAt, options),
    // Carry the raw ISO so client-side sort-by-"lastActivity" is correct
    // regardless of the order the data source returns rows in (not just the
    // local source's pre-sorted newest-first).
    lastActivityAt: row.lastActivityAt,
  };
}

export function adaptBranchRows(
  rows: WireBranchRow[],
  options?: { now?: number }
): RenderBranchRow[] {
  return rows.map((row) => adaptBranchRow(row, options));
}

/** Format an ISO instant through the shared viewer-local relative formatter. */
function formatLastActivityLabel(
  iso: string,
  options?: { now?: number }
): string {
  const instant = Date.parse(iso);
  if (Number.isNaN(instant)) {
    return RENDER_MISSING;
  }
  return formatRelativeTime(new Date(instant), { now: options?.now });
}
