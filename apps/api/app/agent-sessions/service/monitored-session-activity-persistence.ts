import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { monitoredActivityTargetKey } from "@repo/api/src/types/monitored-activity-target";
import type { SyncedMonitoredSessionActivityEvent } from "@repo/api/src/types/session-monitored-activity";
import {
  BRANCH_ACTIVITY_ATOM_COLUMN_COUNT,
  BranchActivityPersistStatus,
} from "@/app/branches/branch-activity-evidence";
import { chunksOf } from "@/lib/chunks-of";
import { isWithinTrustedFutureBoundary } from "@/lib/trusted-timestamp";
import {
  type MonitoredActivityCandidate,
  monitoredActivitySourceEventId,
  type ResolvedActivityTarget,
} from "./monitored-session-activity-shared";
import type { AgentSessionUpsertTx } from "./records";
import { bindParameterChunkSize } from "./write-chunking";

export type ResolvedActivityCandidate = {
  candidate: MonitoredActivityCandidate;
  target: ResolvedActivityTarget;
};

/**
 * Stable diagnostics for acknowledgement decisions made per candidate.
 *
 * `TransportTargetSkipped` counts the transport-only lane;
 * `TargetIntentionallyAbsent`, `TargetRepositoryUnfetchable` and
 * `TargetRepositoryOutOfScope` count the TRUSTED population ISS-9181 stopped
 * holding forever. The two populations are
 * disjoint by construction — a transport-only skip is filtered out before the
 * trust partition — and each acknowledged skip gets its own member so
 * acknowledging it cannot make it invisible, which is exactly what ISS-6476 ->
 * ISS-6980 did to this population once already.
 *
 * ISS-9182 gives each HELD disposition a member for the same reason, but as a
 * BREAKDOWN and never a narrowing: `TargetRetryRequired` still counts every
 * held candidate, so a held candidate lands in two members and only the ones
 * {@link monitoredActivityCandidateCount} admits sum to a candidate count.
 */
export const MonitoredActivityOutcome = {
  Inserted: "inserted",
  Replayed: "replayed",
  TransportTargetSkipped: "transport_target_skipped",
  TargetIntentionallyAbsent: "target_intentionally_absent",
  /**
   * Acknowledged on the same terms as `TargetIntentionallyAbsent` and split
   * out of it so the two causes are not one bucket: that one is the provider
   * saying no such PR exists, this one is a PR behind a read the organization
   * cannot perform (ISS-9182 review r4053480710).
   */
  TargetRepositoryUnfetchable: "target_repository_unfetchable",
  TargetRepositoryOutOfScope: "target_repository_out_of_scope",
  TargetRetryRequired: "target_retry_required",
  TargetRepositoryIdentityUnknown: "target_repository_identity_unknown",
  TargetAuthorityConflict: "target_authority_conflict",
  TargetProviderIdentityAmbiguous: "target_provider_identity_ambiguous",
  TargetNotMaterialized: "target_not_materialized",
  FutureRetryRequired: "future_retry_required",
  /**
   * ISS-11427: a held candidate the server RESOLVED at the wall-clock ceiling
   * rather than leaving the desktop to exhaust its bounded `ack_omitted` budget
   * and abandon the row. Its evidence is retained, so this counts an
   * acknowledgement, never a discard.
   *
   * A candidate of its OWN (unlike the four ISS-9182 breakdown members): an
   * expired candidate leaves `TargetRetryRequired`, so nothing else counts it.
   * Its classified disposition is still tallied in that disposition's own
   * breakdown member, so the two together say "classified X, abandoned at the
   * ceiling".
   */
  TargetHoldExpired: "target_hold_expired",
  /**
   * A held candidate on a target an EARLIER delivery's ceiling already
   * settled: acknowledged and retained like `TargetHoldExpired`, but counted
   * apart so the abandonment warn fires once per target rather than once per
   * re-offer. A candidate of its own, so the population stays in the total.
   */
  TargetHoldSettled: "target_hold_settled",
} as const;
export type MonitoredActivityOutcome =
  (typeof MonitoredActivityOutcome)[keyof typeof MonitoredActivityOutcome];
export type MonitoredActivityOutcomeCounts = Record<
  MonitoredActivityOutcome,
  number
>;

export type PersistMonitoredSessionActivityResult = {
  retryRequired: boolean;
  /**
   * ISS-11427: whether a MONITORED-ACTIVITY hold survived this delivery — the
   * narrow half of `retryRequired`, and the only half the hold ceiling bounds.
   * `SessionDetail.monitoredActivityHeldSince` is opened and closed from it.
   */
  holdRetained: boolean;
  persistedCount: number;
  outcomeCounts: MonitoredActivityOutcomeCounts;
  futureRejectedCount: number;
};

export async function classifyLegacyMonitoredActivityReplays(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  sessionArtifactId: string,
  candidates: readonly ResolvedActivityCandidate[]
): Promise<{
  matchingKeys: Set<string>;
  futureCandidates: Array<{
    candidate: MonitoredActivityCandidate;
    receivedAt: Date;
  }>;
}> {
  if (candidates.length === 0) {
    return { matchingKeys: new Set(), futureCandidates: [] };
  }
  const candidatesByIdentity = new Map<string, ResolvedActivityCandidate[]>();
  const identities = new Map<
    string,
    { branchArtifactId: string; sourceEventId: string }
  >();
  for (const resolved of candidates) {
    const sourceEventId = canonicalLegacyMonitoredSourceEventId(
      sessionArtifactId,
      resolved.candidate.event
    );
    const identity = legacyActivityIdentity(
      resolved.target.branchArtifactId,
      sourceEventId
    );
    identities.set(identity, {
      branchArtifactId: resolved.target.branchArtifactId,
      sourceEventId,
    });
    const matchingCandidates = candidatesByIdentity.get(identity) ?? [];
    matchingCandidates.push(resolved);
    candidatesByIdentity.set(identity, matchingCandidates);
  }
  const rows: LegacyActivityRow[] = [];
  for (const chunk of chunksOf(
    [...identities.values()],
    LEGACY_REPLAY_READ_CHUNK_SIZE
  )) {
    rows.push(
      ...(await tx.branchActivityAtom.findMany({
        where: {
          organizationId,
          source: BranchActivitySource.MonitoredSession,
          OR: chunk,
        },
        select: {
          branchArtifactId: true,
          sourceEventId: true,
          occurredAt: true,
          activityKind: true,
          attributionKind: true,
          pullRequestDetailId: true,
          completeness: true,
          createdAt: true,
        },
      }))
    );
  }
  const matching = new Set<string>();
  const futureCandidates: Array<{
    candidate: MonitoredActivityCandidate;
    receivedAt: Date;
  }> = [];
  for (const row of rows) {
    const identity = legacyActivityIdentity(
      row.branchArtifactId,
      row.sourceEventId
    );
    for (const resolved of candidatesByIdentity.get(identity) ?? []) {
      if (!legacyRowMatches(resolved, row)) {
        continue;
      }
      if (isWithinTrustedFutureBoundary(row.occurredAt, row.createdAt)) {
        matching.add(
          canonicalMonitoredSourceEventId(
            sessionArtifactId,
            resolved.candidate.target,
            resolved.candidate.event
          )
        );
      } else {
        futureCandidates.push({
          candidate: resolved.candidate,
          receivedAt: row.createdAt,
        });
      }
    }
  }
  return { matchingKeys: matching, futureCandidates };
}

export async function claimLegacyMonitoredActivityAliases(
  tx: AgentSessionUpsertTx,
  input: { organizationId: string; sessionArtifactId: string },
  pending: readonly ResolvedActivityCandidate[],
  results: readonly { status: BranchActivityPersistStatus }[],
  receivedAt: Date
): Promise<void> {
  const aliases = pending.flatMap(({ candidate, target }, index) => {
    const status = results[index]?.status;
    if (
      status !== BranchActivityPersistStatus.Inserted &&
      status !== BranchActivityPersistStatus.Replayed
    ) {
      return [];
    }
    const sourceEventId = canonicalMonitoredSourceEventId(
      input.sessionArtifactId,
      candidate.target,
      candidate.event
    );
    return [
      {
        version: BranchActivityAtomVersion.V1,
        organizationId: input.organizationId,
        branchArtifactId: target.branchArtifactId,
        source: BranchActivitySource.MonitoredSession,
        sourceEventId: canonicalLegacyMonitoredSourceEventId(
          input.sessionArtifactId,
          candidate.event
        ),
        compatibilityAliasForSourceEventId: sourceEventId,
        occurredAt: new Date(candidate.event.occurredAt),
        activityKind: candidate.event.kind,
        attributionKind: target.pullRequestDetailId
          ? BranchActivityAttributionKind.PullRequest
          : BranchActivityAttributionKind.Branch,
        pullRequestDetailId: target.pullRequestDetailId,
        completeness: candidate.event.completeness,
        createdAt: receivedAt,
      },
    ];
  });
  if (aliases.length === 0) {
    return;
  }
  for (const chunk of chunksOf(aliases, ALIAS_INSERT_CHUNK_SIZE)) {
    await tx.branchActivityAtom.createMany({
      data: chunk,
      skipDuplicates: true,
    });
  }
  const claims = new Set<string>();
  for (const chunk of chunksOf(aliases, ALIAS_VERIFY_READ_CHUNK_SIZE)) {
    const stored = await tx.branchActivityAtom.findMany({
      where: {
        organizationId: input.organizationId,
        OR: chunk.map((alias) => ({
          branchArtifactId: alias.branchArtifactId,
          source: alias.source,
          sourceEventId: alias.sourceEventId,
        })),
      },
      select: {
        branchArtifactId: true,
        source: true,
        sourceEventId: true,
        compatibilityAliasForSourceEventId: true,
      },
    });
    for (const row of stored) {
      claims.add(aliasClaimIdentity(row));
    }
  }
  if (aliases.some((alias) => !claims.has(aliasClaimIdentity(alias)))) {
    throw new Error("monitored activity rollback identity conflict");
  }
}

export function canonicalMonitoredSourceEventId(
  sessionArtifactId: string,
  target: MonitoredActivityCandidate["target"],
  event: SyncedMonitoredSessionActivityEvent
): string {
  return monitoredActivitySourceEventId(
    "monitored_session_v2",
    sessionArtifactId,
    monitoredActivityTargetKey(target),
    event.sourceEventId
  );
}

export function canonicalLegacyMonitoredSourceEventId(
  sessionArtifactId: string,
  event: SyncedMonitoredSessionActivityEvent
): string {
  return monitoredActivitySourceEventId(
    "monitored_session_v1",
    sessionArtifactId,
    event.sourceEventId
  );
}

export function emptyPersistMonitoredSessionActivityResult(): PersistMonitoredSessionActivityResult {
  return {
    retryRequired: false,
    holdRetained: false,
    persistedCount: 0,
    outcomeCounts: emptyMonitoredActivityOutcomeCounts(),
    futureRejectedCount: 0,
  };
}

export function emptyMonitoredActivityOutcomeCounts(): MonitoredActivityOutcomeCounts {
  return {
    [MonitoredActivityOutcome.Inserted]: 0,
    [MonitoredActivityOutcome.Replayed]: 0,
    [MonitoredActivityOutcome.TransportTargetSkipped]: 0,
    [MonitoredActivityOutcome.TargetIntentionallyAbsent]: 0,
    [MonitoredActivityOutcome.TargetRepositoryUnfetchable]: 0,
    [MonitoredActivityOutcome.TargetRepositoryOutOfScope]: 0,
    [MonitoredActivityOutcome.TargetRetryRequired]: 0,
    [MonitoredActivityOutcome.TargetRepositoryIdentityUnknown]: 0,
    [MonitoredActivityOutcome.TargetAuthorityConflict]: 0,
    [MonitoredActivityOutcome.TargetProviderIdentityAmbiguous]: 0,
    [MonitoredActivityOutcome.TargetNotMaterialized]: 0,
    [MonitoredActivityOutcome.FutureRetryRequired]: 0,
    [MonitoredActivityOutcome.TargetHoldExpired]: 0,
    [MonitoredActivityOutcome.TargetHoldSettled]: 0,
  };
}

function legacyRowMatches(
  resolved: ResolvedActivityCandidate,
  row: LegacyActivityRow
): boolean {
  const expectedAttributionKind = resolved.target.pullRequestDetailId
    ? BranchActivityAttributionKind.PullRequest
    : BranchActivityAttributionKind.Branch;
  const completenessMatches =
    row.completeness === BranchActivityEvidenceCompleteness.Complete ||
    row.completeness === BranchActivityEvidenceCompleteness.Partial;
  return (
    row.occurredAt.getTime() ===
      Date.parse(resolved.candidate.event.occurredAt) &&
    (row.activityKind === null ||
      row.activityKind === resolved.candidate.event.kind) &&
    row.attributionKind === expectedAttributionKind &&
    row.pullRequestDetailId === resolved.target.pullRequestDetailId &&
    completenessMatches
  );
}

function legacyActivityIdentity(
  branchArtifactId: string,
  sourceEventId: string
): string {
  return `${branchArtifactId}\u0000${sourceEventId}`;
}

function aliasClaimIdentity(row: {
  branchArtifactId: string;
  source: string;
  sourceEventId: string;
  compatibilityAliasForSourceEventId?: string | null;
}): string {
  return `${row.branchArtifactId}\u0000${row.source}\u0000${row.sourceEventId}\u0000${row.compatibilityAliasForSourceEventId ?? ""}`;
}

type LegacyActivityRow = {
  branchArtifactId: string;
  sourceEventId: string;
  occurredAt: Date;
  activityKind: string | null;
  attributionKind: string;
  pullRequestDetailId: string | null;
  completeness: string;
  createdAt: Date;
};

/** `OR` of `{branchArtifactId, sourceEventId}` beside the fixed org and source binds. */
const LEGACY_REPLAY_READ_CHUNK_SIZE = bindParameterChunkSize(2, 2);
/** Rows per alias `createMany`: every `BranchActivityAtom` column is bound. */
const ALIAS_INSERT_CHUNK_SIZE = bindParameterChunkSize(
  BRANCH_ACTIVITY_ATOM_COLUMN_COUNT,
  0
);
/** `OR` of `{branchArtifactId, source, sourceEventId}` beside the fixed org bind. */
const ALIAS_VERIFY_READ_CHUNK_SIZE = bindParameterChunkSize(3, 1);

/**
 * Whether an outcome counts a candidate of its own, or breaks down a member
 * that already counted it.
 *
 * ISS-9182 split the held lump per disposition WITHOUT narrowing
 * `TargetRetryRequired`, so a held candidate is tallied twice on purpose and
 * summing every member would report one candidate as two. An exhaustive
 * `Record` rather than a list of the breakdown members: a list widens to
 * `string`, so a member added later would be summed silently; here it fails
 * `tsc` until someone says which kind it is.
 */
const MONITORED_ACTIVITY_OUTCOME_COUNTS_ONE_CANDIDATE: Record<
  MonitoredActivityOutcome,
  boolean
> = {
  [MonitoredActivityOutcome.Inserted]: true,
  [MonitoredActivityOutcome.Replayed]: true,
  [MonitoredActivityOutcome.TransportTargetSkipped]: true,
  [MonitoredActivityOutcome.TargetIntentionallyAbsent]: true,
  // Counts a candidate of its own: it is a split of the acknowledged
  // population, never a breakdown of `TargetRetryRequired`.
  [MonitoredActivityOutcome.TargetRepositoryUnfetchable]: true,
  [MonitoredActivityOutcome.TargetRepositoryOutOfScope]: true,
  [MonitoredActivityOutcome.TargetRetryRequired]: true,
  [MonitoredActivityOutcome.TargetRepositoryIdentityUnknown]: false,
  [MonitoredActivityOutcome.TargetAuthorityConflict]: false,
  [MonitoredActivityOutcome.TargetProviderIdentityAmbiguous]: false,
  [MonitoredActivityOutcome.TargetNotMaterialized]: false,
  [MonitoredActivityOutcome.FutureRetryRequired]: true,
  // ISS-11427: counts a candidate of its own — see the member's docstring.
  [MonitoredActivityOutcome.TargetHoldExpired]: true,
  [MonitoredActivityOutcome.TargetHoldSettled]: true,
};

/**
 * How many candidates a batch's counts describe, the per-disposition breakdown
 * excluded because `TargetRetryRequired` already counted those candidates.
 */
export function monitoredActivityCandidateCount(
  counts: MonitoredActivityOutcomeCounts
): number {
  let total = 0;
  for (const outcome of Object.values(MonitoredActivityOutcome)) {
    if (MONITORED_ACTIVITY_OUTCOME_COUNTS_ONE_CANDIDATE[outcome]) {
      total += counts[outcome];
    }
  }
  return total;
}
