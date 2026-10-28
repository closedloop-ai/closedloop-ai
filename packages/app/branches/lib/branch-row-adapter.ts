import {
  BranchParticipationKind,
  BranchStatus,
  BranchTagAvailability,
  classifyBranchProvenance,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import {
  type BranchPerson,
  branchPersonKey,
} from "@repo/api/src/types/branch-identity";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import {
  type BranchMembershipSession,
  isSupportedBranchProjectionVersion,
} from "@repo/api/src/types/branch-projection";
import {
  PROVENANCE_RELATIONSHIP_KIND_LABELS,
  ProvenanceRelationshipKind,
} from "@repo/api/src/types/provenance-relationship";
import {
  isRecognizedSessionStatus,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import {
  type BranchRowSession,
  BranchRowStatus,
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
    // ISS-8155: `||`, not `??`. The cloud PR projection now reports an unmeasured
    // base ref as `""`, and the Desktop overlay forwards it here; a nullish-only
    // guard rendered that as a blank cell — the hidden absence rather than the
    // named one this placeholder exists to give.
    baseBranch: row.baseBranch || RENDER_MISSING,
    repo,
    owner,
    ownerKey,
    ...optionalOwnerAvatar(ownerPerson),
    collaborators,
    tags: [...tags],
    tagAvailability,
    tagPermissions: projection?.common.tags.permissions ?? row.tagPermissions,
    artifactId: projection?.common.identity.artifactId ?? row.artifactId,
    ...optionalProject(row, projection),
    ...optionalCustomFields(row.customFields),
    ...optionalPriority(row.priority),
    status: toRenderStatus(row.status),
    rawStatus: row.status,
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
    sessionCount: branchSessionCount(row, projection),
    ...optionalRowSessions(projection?.common.membership.sessions),
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
/**
 * ISS-10332: verbatim, absence included — a `?? null` would turn "this
 * producer never served the field" into "this branch has no priority".
 */
function optionalPriority(
  priority: WireBranchRow["priority"]
): Pick<RenderBranchRow, "priority"> {
  return priority === undefined ? {} : { priority };
}

/**
 * ISS-12453: verbatim, absence included — same contract as
 * {@link optionalPriority}. Reads off the projection when one is present
 * rather than falling back with `??`, because a projection's `null` ("no
 * project") is a real answer `??` would otherwise collapse into `row`'s.
 */
function optionalProject(
  row: WireBranchRow,
  projection: NonNullable<WireBranchRow["canonicalProjection"]> | undefined
): Pick<RenderBranchRow, "projectId" | "projectName"> {
  const projectId = projection
    ? projection.common.identity.projectId
    : row.projectId;
  const projectName = projection
    ? projection.common.identity.projectName
    : row.projectName;
  return {
    ...(projectId === undefined ? {} : { projectId }),
    ...(projectName === undefined ? {} : { projectName }),
  };
}

function optionalDataState(
  dataState: WireBranchRow["dataState"]
): Pick<RenderBranchRow, "dataState"> {
  if (dataState !== undefined) {
    return { dataState };
  }
  return {};
}

const BRANCH_SESSION_CONTRIBUTION_LABEL =
  PROVENANCE_RELATIONSHIP_KIND_LABELS[ProvenanceRelationshipKind.Contribution];
const EMAIL_LIKE_OWNER_NAME = /^[^@\s]+@[^@\s]+$/u;

function branchSessionCount(
  row: WireBranchRow,
  projection: NonNullable<WireBranchRow["canonicalProjection"]> | undefined
): number {
  const describedCount =
    projection?.common.membership.sessions?.filter(
      (session) =>
        session.participation !== BranchParticipationKind.Reviewed &&
        nonBlankString(session.artifactId) !== null
    ).length ?? 0;
  const canonicalCount = projection?.common.membership.qualifyingSessionCount;
  if (
    canonicalCount !== undefined &&
    Number.isSafeInteger(canonicalCount) &&
    canonicalCount >= describedCount &&
    canonicalCount >= 0
  ) {
    return canonicalCount;
  }
  return Math.max(row.sessionIds.length, describedCount);
}

function optionalRowSessions(
  sessions: readonly BranchMembershipSession[] | undefined
): { sessions: BranchRowSession[] } | Record<string, never> {
  if (!sessions) {
    return {};
  }
  const adapted = sessions.flatMap(
    (session) => toBranchRowSession(session) ?? []
  );
  return adapted.length > 0 ? { sessions: adapted } : {};
}

function toBranchRowSession(
  session: BranchMembershipSession
): BranchRowSession | null {
  const id = nonBlankString(session.artifactId);
  const occurredAt = validIsoInstant(session.lastInteractionAt);
  if (
    !(id && session.displayedStatus && occurredAt) ||
    session.participation !== BranchParticipationKind.Wrote
  ) {
    return null;
  }
  const slug =
    nonBlankString(session.slug) ?? nonBlankString(session.name) ?? id;
  const navigableRef =
    nonBlankString(session.navigableRef) ?? nonBlankString(session.slug) ?? id;
  const ownerName = safeOwnerName(session.ownerName);
  const ownerUnavailable =
    session.ownerUnavailable === true ||
    (session.ownerName != null && ownerName === null);
  // ISS-10364: an unrecognized wire value (an older or newer producer's
  // `displayedStatus`) fails open to ACTIVE, like every other fold in this
  // vocabulary — there is no longer a display-only "we don't know" word to
  // fall back to.
  const status = isRecognizedSessionStatus(session.displayedStatus)
    ? session.displayedStatus
    : SESSION_STATUS.ACTIVE;
  return {
    id,
    slug,
    navigableRef,
    ownerName,
    ...(ownerUnavailable ? { ownerUnavailable: true } : {}),
    ...(session.ownerAvatarUrl
      ? { ownerAvatarUrl: session.ownerAvatarUrl }
      : {}),
    ...(session.rawStatus === undefined
      ? {}
      : { rawStatus: session.rawStatus }),
    status,
    relationshipLabel: BRANCH_SESSION_CONTRIBUTION_LABEL,
    occurredAt,
  };
}

function nonBlankString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function validIsoInstant(value: string | undefined): string | null {
  const trimmed = nonBlankString(value);
  return trimmed && Number.isFinite(Date.parse(trimmed)) ? trimmed : null;
}

function safeOwnerName(value: string | null | undefined): string | null {
  const name = nonBlankString(value);
  return name && !EMAIL_LIKE_OWNER_NAME.test(name) ? name : null;
}

/** Keep absent photos omitted for older Branches row producers. */
function optionalOwnerAvatar(person: BranchPerson | null | undefined): {
  ownerAvatarUrl?: string;
} {
  if (person?.avatarUrl) {
    return { ownerAvatarUrl: person.avatarUrl };
  }
  return {};
}

/**
 * ISS-12663: carried unchanged, and omitted when the producer omitted it, so
 * "values not loaded" stays distinct from a loaded row with none.
 */
function optionalCustomFields(
  customFields: WireBranchRow["customFields"]
): Pick<RenderBranchRow, "customFields"> {
  return customFields === undefined ? {} : { customFields };
}
