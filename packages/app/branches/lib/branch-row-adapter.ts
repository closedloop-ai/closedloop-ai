import {
  BranchStatus,
  BranchTagAvailability,
  classifyBranchProvenance,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { isSupportedBranchProjectionVersion } from "@repo/api/src/types/branch-projection";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import {
  BranchRowStatus,
  branchPersonKey,
  RENDER_MISSING,
  RENDER_UNATTRIBUTED,
  type BranchRow as RenderBranchRow,
} from "./branch-row";

/**
 * Wire `BranchStatus` (branch.ts) to the render status used by both List paths.
 * Closed-without-merge remains distinct from Draft so the approved status
 * filter and Active-branches predicate preserve canonical lifecycle meaning.
 */
const STATUS_MAP: Record<BranchStatus, BranchRowStatus> = {
  [BranchStatus.Open]: BranchRowStatus.Open,
  [BranchStatus.Review]: BranchRowStatus.Review,
  [BranchStatus.Merged]: BranchRowStatus.Merged,
  [BranchStatus.Draft]: BranchRowStatus.Draft,
  [BranchStatus.Blocked]: BranchRowStatus.Blocked,
  [BranchStatus.Closed]: BranchRowStatus.Closed,
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
 * Canonical list `dataState` wins over its additive top-level compatibility
 * field; when both are absent, the optional render field remains omitted.
 */
export function adaptBranchRow(
  row: WireBranchRow,
  options?: { now?: number; preferCanonicalLastActive?: boolean }
): RenderBranchRow {
  const projection = isSupportedBranchProjectionVersion(row.canonicalProjection)
    ? row.canonicalProjection
    : undefined;
  const ownerIdentity = projection?.common.people.owner ?? row.ownerIdentity;
  const ownerPerson = ownerIdentity?.person;
  const owner =
    personDisplayName(ownerPerson) ?? row.owner ?? RENDER_UNATTRIBUTED;
  const ownerKey = ownerPerson ? branchPersonKey(ownerPerson) : owner;
  const collaborators =
    (projection?.common.people.collaborators ?? row.collaborators)?.people.map(
      (person) => ({
        key: branchPersonKey(person),
        name: personDisplayName(person) ?? person.login ?? person.id,
        ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : {}),
        ...(person.profileUrl ? { profileUrl: person.profileUrl } : {}),
      })
    ) ?? [];
  const repo =
    projection?.common.identity.repositoryFullName ??
    row.repoFullName ??
    RENDER_MISSING;
  const lastActive =
    projection?.common.lastActiveAt ?? row.canonicalLastActiveAt;
  const now = options?.now ?? Date.now();
  const canonicalLastActivityAt = metricTimestamp(lastActive, now);
  const legacyLastActivityAt = validTimestamp(row.lastActivityAt, now);
  const lastActivityAt = resolveLastActivityAt({
    canonicalLastActivityAt,
    hasCanonicalLastActive: lastActive !== undefined,
    legacyLastActivityAt,
    preferCanonicalLastActive: options?.preferCanonicalLastActive === true,
  });
  const tags = projection?.common.tags.items ?? row.tags ?? [];
  const tagAvailability =
    projection?.common.tags.availability ??
    row.tagAvailability ??
    BranchTagAvailability.Unavailable;
  const dataState = projection?.list?.dataState ?? row.dataState;
  return {
    id: row.id,
    branchName: row.branchName,
    ...optionalDataState(dataState),
    baseBranch: row.baseBranch ?? RENDER_MISSING,
    repo,
    owner,
    ownerKey,
    collaborators,
    tags: [...tags],
    tagAvailability,
    tagPermissions: projection?.common.tags.permissions ?? row.tagPermissions,
    artifactId: projection?.common.identity.artifactId ?? row.artifactId,
    status: toRenderStatus(row.status),
    prNumber: row.prNumber,
    prTitle: row.prTitle,
    prUrl: row.prUrl,
    hasPullRequest:
      (projection?.common.pullRequests.associatedCount ?? 0) > 0 ||
      row.prNumber !== null,
    prRepo: row.prNumber === null ? null : repo,
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
    // FEA-3285: derive provenance from the branch name at the shared read
    // boundary — one SSOT classifier both surfaces call, so a branch buckets
    // identically on web and desktop with no stored column / migration.
    provenance: classifyBranchProvenance(row.branchName),
    lastActivityLabel: lastActivityAt
      ? formatLastActivityLabel(lastActivityAt, options)
      : RENDER_MISSING,
    // Carry the raw ISO so client-side sort-by-"lastActivity" is correct
    // regardless of the order the data source returns rows in (not just the
    // local source's pre-sorted newest-first).
    lastActivityAt,
    canonicalIdentity:
      projection?.common.identity.artifactId ?? row.artifactId ?? row.id,
  };
}

export function adaptBranchRows(
  rows: WireBranchRow[],
  options?: { now?: number; preferCanonicalLastActive?: boolean }
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

function personDisplayName(
  person: { displayName?: string; login?: string } | null | undefined
): string | null {
  return person?.displayName ?? person?.login ?? null;
}

function metricTimestamp(
  result: WireBranchRow["canonicalLastActiveAt"],
  now: number
): string | undefined {
  if (
    result?.state !== BranchMetricAvailability.Complete &&
    result?.state !== BranchMetricAvailability.Partial
  ) {
    return;
  }
  return validTimestamp(result.value, now);
}

function validTimestamp(
  value: string | undefined,
  now: number
): string | undefined {
  if (!value) {
    return;
  }
  const instant = Date.parse(value);
  return !Number.isNaN(instant) && instant <= now ? value : undefined;
}

function resolveLastActivityAt({
  canonicalLastActivityAt,
  hasCanonicalLastActive,
  legacyLastActivityAt,
  preferCanonicalLastActive,
}: {
  canonicalLastActivityAt: string | undefined;
  hasCanonicalLastActive: boolean;
  legacyLastActivityAt: string | undefined;
  preferCanonicalLastActive: boolean;
}): string | undefined {
  if (preferCanonicalLastActive && hasCanonicalLastActive) {
    return canonicalLastActivityAt;
  }
  return legacyLastActivityAt ?? canonicalLastActivityAt;
}

/** Preserve omission when an older producer does not send list freshness. */
function optionalDataState(
  dataState: WireBranchRow["dataState"]
): Pick<RenderBranchRow, "dataState"> {
  if (dataState !== undefined) {
    return { dataState };
  }
  return {};
}
