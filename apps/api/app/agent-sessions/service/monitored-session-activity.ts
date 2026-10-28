import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { monitoredActivityTargetKey } from "@repo/api/src/types/monitored-activity-target";
import {
  ArtifactRefTargetKind,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import type { SyncedMonitoredSessionActivityEvent } from "@repo/api/src/types/session-monitored-activity";
import { BranchActivityPersistStatus } from "@/app/branches/branch-activity-evidence";
import { persistBranchActivityAtomsInTransaction } from "@/app/branches/branch-activity-evidence-batch";
import { chunksOf } from "@/lib/chunks-of";
import { ensureInternalBranchActivityTargets } from "./artifact-links/internal-branch-target";
import {
  type SessionPullRequestDetailMap,
  type SessionPullRequestDetailRef,
  type SessionPullRequestLaneResult,
  sessionPullRequestDetailKey,
} from "./artifact-links/pull-request-details";
import type {
  SessionBranchRepositoryAuthorityMap,
  SessionRepositoryIdentityProbe,
} from "./artifact-links/shared";
import { resolveMonitoredActivityHoldExpiry } from "./monitored-activity-hold-ceiling";
import {
  canonicalMonitoredSourceEventId,
  claimLegacyMonitoredActivityAliases,
  classifyLegacyMonitoredActivityReplays,
  emptyPersistMonitoredSessionActivityResult,
  MonitoredActivityOutcome,
  type PersistMonitoredSessionActivityResult,
} from "./monitored-session-activity-persistence";
import {
  partitionMonitoredCandidatesByTrust,
  persistMonitoredActivityQuarantineRows,
} from "./monitored-session-activity-quarantine";
import {
  assertEveryMonitoredCandidateAccounted,
  createRetainedMonitoredActivityRowReader,
  findCeilingSettledMonitoredTargetKeys,
  partitionUnwrittenMonitoredActivityCandidates,
  retainMonitoredActivityEvidence,
  retractRetainedMonitoredActivity,
  writtenMonitoredActivityIdentities,
} from "./monitored-session-activity-retention";
import {
  isValidMonitoredActivityTarget,
  type MonitoredActivityCandidate,
  monitoredActivityCandidateIdentity,
  type ResolvedActivityTarget,
  uniqueMonitoredActivityTargets,
} from "./monitored-session-activity-shared";
import {
  classifyMonitoredActivityTargets,
  isRetryOwnedMonitoredDisposition,
  monitoredTargetDispositionTransportSkippable,
  partitionUnresolvedMonitoredCandidates,
} from "./monitored-session-transport-resolution";
import type { AgentSessionUpsertTx } from "./records";
import { bindParameterChunkSize } from "./write-chunking";

/**
 * Persist capability-gated monitored-session activity after Branch and PR rows
 * have materialized. Activity-only Branch targets may materialize their
 * internal Artifact/BranchDetail data plane, while unresolved PRs suppress the
 * Desktop acknowledgement so a later retry can converge without losing valid
 * siblings committed by this attempt.
 *
 * `pullRequestLane` is the PR lane's own output for the SAME `artifactRefs`
 * (ISS-6450) — attribution reads it rather than re-deriving every row from an
 * `(organizationId, repositoryFullName, number)` lookup. Only targets that lane
 * never saw reach the strict indexed compatibility lookup here.
 *
 * Its two halves arrive as ONE value, never as sibling arguments: the rows and
 * the deferral report only mean anything about the same lane run, and reading
 * one run's verdict against another's rows is the drift ISS-9181 exists to
 * kill. As one parameter the seam cannot be handed a mismatched pair.
 */
export async function persistMonitoredSessionActivity(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    projectId?: string | null;
    sessionArtifactId: string;
    artifactRefs: SyncedArtifactRef[] | undefined;
    /**
     * The materialized rows AND the lane's own report of what it deferred, for
     * the SAME `artifactRefs`, so the classifier can tell a target that lane is
     * still going to write from one the provider says is absent — see
     * `pullRequestLaneVerdict`.
     */
    pullRequestLane: SessionPullRequestLaneResult;
    repositoryIdentity: SessionRepositoryIdentityProbe;
    receivedAt?: Date;
    /**
     * ISS-11427: when the CLOUD first stored this session. Absent or `null` means
     * this delivery is the first, so no hold can have elapsed yet.
     */
    monitoredActivityHeldSince?: Date | null;
  }
): Promise<PersistMonitoredSessionActivityResult> {
  const receivedAt = input.receivedAt ?? new Date();
  const candidates = collectCandidates(input.artifactRefs);
  if (candidates.length === 0) {
    return emptyPersistMonitoredSessionActivityResult();
  }
  const resolvedTargets = await resolveTargets(tx, candidates, {
    organizationId: input.organizationId,
    pullRequestDetails: input.pullRequestLane.details,
    repositoryAuthorityByFullName: input.repositoryIdentity.authorities,
  });
  const targetDispositions = await classifyMonitoredActivityTargets(
    tx,
    candidates,
    resolvedTargets,
    {
      organizationId: input.organizationId,
      repositoryIdentity: input.repositoryIdentity,
      pullRequestLaneDeferrals: input.pullRequestLane.deferrals,
    }
  );
  // ISS-9182: the transport skip is applied AFTER the trust partition, never
  // before it. A transport-only ref is TERMINAL now — retained and then
  // acknowledged — and skipping the partition first left its `occurredAt` the
  // one value on this path no future boundary ever saw, so a producer's clock
  // alone decided the date on a persisted row. A future-dated one is
  // quarantined here with every other future candidate and stays retry-owned.
  const trust = await partitionMonitoredCandidatesByTrust(
    tx,
    { ...input, receivedAt },
    candidates
  );
  const transportSkippedCandidates = trust.trustedCandidates.filter(
    (candidate) =>
      candidate.transportOnly &&
      !resolvedTargets.has(monitoredActivityTargetKey(candidate.target)) &&
      monitoredTargetDispositionTransportSkippable(
        targetDispositions.get(monitoredActivityTargetKey(candidate.target))
      )
  );
  const transportSkippedIdentities = new Set(
    transportSkippedCandidates.map(monitoredActivityCandidateIdentity)
  );
  const pipelineCandidates = trust.trustedCandidates.filter(
    (candidate) =>
      !transportSkippedIdentities.has(
        monitoredActivityCandidateIdentity(candidate)
      )
  );
  await materializeInternalBranchTargets(
    tx,
    {
      organizationId: input.organizationId,
      projectId: input.projectId ?? null,
      repositoryAuthorityByFullName: input.repositoryIdentity.authorities,
    },
    pipelineCandidates,
    resolvedTargets
  );
  const resolvedCandidates = pipelineCandidates.flatMap((candidate) => {
    const target = resolvedTargets.get(
      monitoredActivityTargetKey(candidate.target)
    );
    return target ? [{ candidate, target }] : [];
  });
  const unresolvedCandidates = pipelineCandidates.filter(
    (candidate) =>
      !resolvedTargets.has(monitoredActivityTargetKey(candidate.target))
  );
  const transportSkippedCount = transportSkippedCandidates.length;
  // ISS-9181: an unresolved target used to hold the acknowledgement whatever
  // its reason, which withheld an already-committed Session forever whenever
  // the reason could never change. Only the retry-owned remainder holds now.
  // ISS-11427: one pass over the HELD candidates — unresolved and retry-owned —
  // before either gate reads it. #8064 review (whitlockk, tamsinb): a resolved or
  // already-terminal ref must not be in scope, because the whole-session
  // escalation inside would then let one stale ref expire a fresh sibling's
  // hold. See `collectExpiredMonitoredActivityHolds` for why it is a set and
  // not a predicate each gate calls.
  const heldCandidates = unresolvedCandidates.filter((candidate) =>
    isRetryOwnedMonitoredDisposition(
      targetDispositions.get(monitoredActivityTargetKey(candidate.target))
    )
  );
  const readRetainedRows = createRetainedMonitoredActivityRowReader(
    tx,
    input,
    candidates
  );
  const holdExpiry = resolveMonitoredActivityHoldExpiry(
    heldCandidates,
    receivedAt,
    input.monitoredActivityHeldSince ?? null,
    heldCandidates.length === 0
      ? new Set()
      : await findCeilingSettledMonitoredTargetKeys(readRetainedRows)
  );
  const expiredHoldIdentities = holdExpiry.expired;
  const unresolvedPartition = partitionUnresolvedMonitoredCandidates(
    unresolvedCandidates,
    targetDispositions,
    expiredHoldIdentities,
    holdExpiry.ceilingSettled
  );
  const legacyReplays = await classifyLegacyMonitoredActivityReplays(
    tx,
    input.organizationId,
    input.sessionArtifactId,
    resolvedCandidates
  );
  await persistMonitoredActivityQuarantineRows(
    tx,
    input,
    legacyReplays.futureCandidates.map(({ candidate, receivedAt }) => ({
      candidate,
      receivedAt,
    }))
  );
  const legacyFutureKeys = new Set(
    legacyReplays.futureCandidates.map(({ candidate }) =>
      canonicalMonitoredSourceEventId(
        input.sessionArtifactId,
        candidate.target,
        candidate.event
      )
    )
  );
  const pending = resolvedCandidates.filter(
    ({ candidate }) =>
      !(
        legacyReplays.matchingKeys.has(
          canonicalMonitoredSourceEventId(
            input.sessionArtifactId,
            candidate.target,
            candidate.event
          )
        ) ||
        legacyFutureKeys.has(
          canonicalMonitoredSourceEventId(
            input.sessionArtifactId,
            candidate.target,
            candidate.event
          )
        )
      )
  );
  const records = pending.map(({ candidate, target }) => ({
    branchArtifactId: target.branchArtifactId,
    atom: {
      version: BranchActivityAtomVersion.V1,
      source: BranchActivitySource.MonitoredSession,
      sourceEventId: canonicalMonitoredSourceEventId(
        input.sessionArtifactId,
        candidate.target,
        candidate.event
      ),
      occurredAt: candidate.event.occurredAt,
      kind: candidate.event.kind,
      attribution: target.pullRequestDetailId
        ? {
            kind: BranchActivityAttributionKind.PullRequest,
            pullRequestId: target.pullRequestDetailId,
          }
        : { kind: BranchActivityAttributionKind.Branch },
      completeness: candidate.event.completeness,
    },
  }));
  const results =
    records.length === 0
      ? []
      : await persistBranchActivityAtomsInTransaction(tx, {
          organizationId: input.organizationId,
          records,
          receivedAt,
        });
  await claimLegacyMonitoredActivityAliases(
    tx,
    input,
    pending,
    results,
    receivedAt
  );
  const batchFutureCount = results.filter(
    (result) => result.status === BranchActivityPersistStatus.FutureTimestamp
  ).length;
  const futureRejectedCount =
    trust.futureCandidates.length +
    legacyReplays.futureCandidates.length +
    batchFutureCount;
  const outcomeCounts = unresolvedPartition.outcomeCounts;
  outcomeCounts[MonitoredActivityOutcome.Replayed] =
    legacyReplays.matchingKeys.size;
  outcomeCounts[MonitoredActivityOutcome.TransportTargetSkipped] =
    transportSkippedCount;
  outcomeCounts[MonitoredActivityOutcome.TargetRetryRequired] =
    unresolvedPartition.retryOwnedCount;
  outcomeCounts[MonitoredActivityOutcome.FutureRetryRequired] =
    trust.futureCandidates.length + legacyReplays.futureCandidates.length;
  for (const [index, result] of results.entries()) {
    if (result.status === BranchActivityPersistStatus.FutureTimestamp) {
      outcomeCounts[MonitoredActivityOutcome.FutureRetryRequired] += 1;
      continue;
    }
    if (result.status === BranchActivityPersistStatus.Inserted) {
      outcomeCounts[MonitoredActivityOutcome.Inserted] += 1;
    }
    if (result.status === BranchActivityPersistStatus.Replayed) {
      outcomeCounts[MonitoredActivityOutcome.Replayed] += 1;
    }
    if (
      result.status !== BranchActivityPersistStatus.Inserted &&
      result.status !== BranchActivityPersistStatus.Replayed
    ) {
      throw new Error(
        `monitored session activity rejected for ${monitoredActivityTargetKey(pending[index].candidate.target)}: ${result.status}`
      );
    }
  }
  // ISS-9182: a candidate the pipeline wrote nothing for used to be counted and
  // then dropped. One this delivery SETTLED is now filed on the session
  // artifact instead; one a retry still owns is left to the delivery that
  // settles it, which is also the delivery that files it. The guard below
  // refuses a delivery that lost a candidate to neither.
  const writtenIdentities = writtenMonitoredActivityIdentities({
    sessionArtifactId: input.sessionArtifactId,
    resolvedCandidates,
    replayedKeys: legacyReplays.matchingKeys,
    pending,
    results,
  });
  await retractRetainedMonitoredActivity(
    tx,
    input,
    { candidates, writtenIdentities },
    readRetainedRows
  );
  const quarantinedIdentities = new Set(
    [
      ...trust.futureCandidates,
      ...legacyReplays.futureCandidates.map(({ candidate }) => candidate),
    ].map(monitoredActivityCandidateIdentity)
  );
  const { retainable, retryOwnedIdentities } =
    partitionUnwrittenMonitoredActivityCandidates({
      candidates,
      writtenIdentities,
      quarantinedIdentities,
      dispositions: targetDispositions,
      expiredHoldIdentities,
      sweptHoldIdentities: holdExpiry.sweptByEscalation,
    });
  const retainedIdentities = await retainMonitoredActivityEvidence(
    tx,
    { ...input, receivedAt },
    retainable,
    readRetainedRows
  );
  assertEveryMonitoredCandidateAccounted({
    candidates,
    writtenIdentities,
    quarantinedIdentities,
    retainedIdentities,
    retryOwnedIdentities,
  });
  return {
    retryRequired:
      unresolvedPartition.retryOwnedCount > 0 || futureRejectedCount > 0,
    // ISS-11427: the MONITORED-ACTIVITY hold specifically, which is the one the
    // ceiling bounds and therefore the one whose start `monitoredActivityHeldSince`
    // records. `retryRequired` above is wider — a quarantined future candidate
    // withholds the ack too — and keying the clock on it would let an arm the
    // ceiling never expires pin the hold's start instant forever.
    holdRetained: unresolvedPartition.retryOwnedCount > 0,
    persistedCount:
      legacyReplays.matchingKeys.size + results.length - batchFutureCount,
    outcomeCounts,
    futureRejectedCount,
  };
}

async function materializeInternalBranchTargets(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    projectId: string | null;
    repositoryAuthorityByFullName: SessionBranchRepositoryAuthorityMap;
  },
  candidates: readonly MonitoredActivityCandidate[],
  resolvedTargets: Map<string, ResolvedActivityTarget>
): Promise<void> {
  const branchTargets = uniqueMonitoredActivityTargets(
    candidates.flatMap((candidate) =>
      candidate.target.kind === ArtifactRefTargetKind.Branch &&
      !candidate.transportOnly &&
      !resolvedTargets.has(monitoredActivityTargetKey(candidate.target))
        ? [candidate.target]
        : []
    )
  );
  const materialized = await ensureInternalBranchActivityTargets(tx, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    targets: branchTargets.map((target) => ({
      repositoryAuthority: input.repositoryAuthorityByFullName.get(
        target.repositoryFullName
      ),
      repositoryFullName: target.repositoryFullName,
      branchName: target.branchName,
    })),
  });
  for (const target of branchTargets) {
    const branchArtifactId = materialized.get(branchTargetIdentity(target));
    if (branchArtifactId !== undefined) {
      resolvedTargets.set(monitoredActivityTargetKey(target), {
        branchArtifactId,
        pullRequestDetailId: null,
      });
    }
  }
}

function collectCandidates(
  artifactRefs: SyncedArtifactRef[] | undefined
): MonitoredActivityCandidate[] {
  const byIdentity = new Map<string, MonitoredActivityCandidate>();
  for (const ref of artifactRefs ?? []) {
    if (
      ref.kind !== ArtifactRefTargetKind.Branch &&
      ref.kind !== ArtifactRefTargetKind.PullRequest
    ) {
      continue;
    }
    const carrier = ref.monitoredSessionActivity;
    if (!carrier) {
      continue;
    }
    const target =
      ref.kind === ArtifactRefTargetKind.Branch
        ? {
            kind: ArtifactRefTargetKind.Branch,
            repositoryFullName: normalizeRepoFullName(ref.repositoryFullName),
            branchName: ref.branchName,
          }
        : {
            kind: ArtifactRefTargetKind.PullRequest,
            repositoryFullName: normalizeRepoFullName(ref.repositoryFullName),
            prNumber: ref.prNumber,
          };
    if (!isValidMonitoredActivityTarget(target)) {
      continue;
    }
    for (const event of carrier.events) {
      const conservativeEvent =
        carrier.completeness === BranchActivityEvidenceCompleteness.Partial
          ? {
              ...event,
              completeness: BranchActivityEvidenceCompleteness.Partial,
            }
          : event;
      const key = `${monitoredActivityTargetKey(target)}:${conservativeEvent.sourceEventId}`;
      const existing = byIdentity.get(key);
      byIdentity.set(
        key,
        reconcileCandidate(
          existing,
          {
            target,
            event: conservativeEvent,
            transportOnly: ref.monitoredActivityOnly === true,
          },
          key
        )
      );
    }
  }
  return [...byIdentity.values()].sort(
    (left, right) =>
      Date.parse(right.event.occurredAt) - Date.parse(left.event.occurredAt) ||
      monitoredActivityTargetKey(left.target).localeCompare(
        monitoredActivityTargetKey(right.target)
      ) ||
      left.event.sourceEventId.localeCompare(right.event.sourceEventId)
  );
}

function reconcileCandidate(
  existing: MonitoredActivityCandidate | undefined,
  candidate: MonitoredActivityCandidate,
  key: string
): MonitoredActivityCandidate {
  if (existing && !immutableEventsEqual(existing.event, candidate.event)) {
    throw new Error(`conflicting monitored activity carrier identity ${key}`);
  }
  const completeness =
    existing?.event.completeness ===
      BranchActivityEvidenceCompleteness.Partial ||
    candidate.event.completeness === BranchActivityEvidenceCompleteness.Partial
      ? BranchActivityEvidenceCompleteness.Partial
      : candidate.event.completeness;
  return {
    ...candidate,
    transportOnly: existing
      ? existing.transportOnly && candidate.transportOnly
      : candidate.transportOnly,
    event: { ...candidate.event, completeness },
  };
}

async function resolveTargets(
  tx: AgentSessionUpsertTx,
  candidates: MonitoredActivityCandidate[],
  context: {
    organizationId: string;
    pullRequestDetails: SessionPullRequestDetailMap;
    repositoryAuthorityByFullName: SessionBranchRepositoryAuthorityMap;
  }
): Promise<Map<string, ResolvedActivityTarget>> {
  const { organizationId } = context;
  const branchTargets = uniqueMonitoredActivityTargets(
    candidates
      .map((candidate) => candidate.target)
      .filter(
        (
          target
        ): target is Extract<
          MonitoredActivityCandidate["target"],
          { kind: "branch" }
        > => target.kind === ArtifactRefTargetKind.Branch
      )
  );
  const pullRequestTargets = uniqueMonitoredActivityTargets(
    candidates
      .map((candidate) => candidate.target)
      .filter(
        (
          target
        ): target is Extract<
          MonitoredActivityCandidate["target"],
          { kind: "pull_request" }
        > => target.kind === ArtifactRefTargetKind.PullRequest
      )
  );
  const resolved = new Map<string, ResolvedActivityTarget>();
  for (const chunk of chunksOf(
    branchTargets,
    BRANCH_TARGET_LOOKUP_CHUNK_SIZE
  )) {
    const branches = await tx.branchDetail.findMany({
      where: {
        organizationId,
        OR: chunk.map((target) => ({
          repositoryFullName: target.repositoryFullName,
          branchName: target.branchName,
        })),
      },
      select: {
        artifactId: true,
        repositoryFullName: true,
        branchName: true,
      },
    });
    for (const branch of branches) {
      resolved.set(
        monitoredActivityTargetKey({
          kind: ArtifactRefTargetKind.Branch,
          repositoryFullName: normalizeRepoFullName(branch.repositoryFullName),
          branchName: branch.branchName,
        }),
        { branchArtifactId: branch.artifactId, pullRequestDetailId: null }
      );
    }
  }
  const residual: PullRequestTarget[] = [];
  for (const target of pullRequestTargets) {
    const threaded = context.pullRequestDetails.get(
      sessionPullRequestDetailKey(target.repositoryFullName, target.prNumber)
    );
    if (threaded) {
      resolved.set(
        monitoredActivityTargetKey(target),
        toActivityTarget(threaded)
      );
      continue;
    }
    residual.push(target);
  }
  const residualRows = await resolveResidualPullRequestTargets(
    tx,
    residual,
    context
  );
  for (const [key, detail] of residualRows) {
    resolved.set(key, toActivityTarget(detail));
  }
  return resolved;
}

async function resolveResidualPullRequestTargets(
  tx: AgentSessionUpsertTx,
  targets: PullRequestTarget[],
  context: {
    organizationId: string;
    repositoryAuthorityByFullName: SessionBranchRepositoryAuthorityMap;
  }
): Promise<Map<string, SessionPullRequestDetailRef>> {
  const resolved = new Map<string, SessionPullRequestDetailRef>();
  const validTargets = targets.filter(isValidMonitoredActivityTarget);
  if (validTargets.length === 0) {
    return resolved;
  }
  const repositoryIdFor = (target: PullRequestTarget) => {
    const authority = context.repositoryAuthorityByFullName.get(
      target.repositoryFullName
    );
    if (!authority || authority.identityConflict) {
      return null;
    }
    return authority.repositoryId ?? null;
  };
  const indexedRows: ResidualPullRequestRow[] = [];
  for (const chunk of chunksOf(
    validTargets,
    RESIDUAL_PULL_REQUEST_LOOKUP_CHUNK_SIZE
  )) {
    indexedRows.push(
      ...(await tx.pullRequestDetail.findMany({
        where: {
          organizationId: context.organizationId,
          OR: chunk.flatMap((target) => {
            const repositoryless = {
              repositoryFullName: target.repositoryFullName,
              number: target.prNumber,
              repositoryId: null,
            };
            const repositoryId = repositoryIdFor(target);
            return repositoryId
              ? [{ repositoryId, number: target.prNumber }, repositoryless]
              : [repositoryless];
          }),
        },
        select: RESIDUAL_PULL_REQUEST_SELECT,
      }))
    );
  }
  const unmatched: PullRequestTarget[] = [];
  for (const target of validTargets) {
    const row = pickResidualRow(indexedRows, target, repositoryIdFor(target));
    if (row) {
      resolved.set(monitoredActivityTargetKey(target), {
        prDetailId: row.id,
        branchArtifactId: row.branchArtifactId,
      });
    } else {
      unmatched.push(target);
    }
  }
  const adoptable = unmatched.filter(
    (target) => repositoryIdFor(target) === null
  );
  if (adoptable.length === 0) {
    return resolved;
  }
  const adoptedRows: ResidualPullRequestRow[] = [];
  for (const chunk of chunksOf(
    adoptable,
    ADOPTABLE_PULL_REQUEST_LOOKUP_CHUNK_SIZE
  )) {
    adoptedRows.push(
      ...(await tx.pullRequestDetail.findMany({
        where: {
          organizationId: context.organizationId,
          OR: chunk.map((target) => ({
            repositoryFullName: target.repositoryFullName,
            number: target.prNumber,
          })),
        },
        select: RESIDUAL_PULL_REQUEST_SELECT,
      }))
    );
  }
  for (const target of adoptable) {
    const row = pickResidualRow(adoptedRows, target, null);
    if (row) {
      resolved.set(monitoredActivityTargetKey(target), {
        prDetailId: row.id,
        branchArtifactId: row.branchArtifactId,
      });
    }
  }
  return resolved;
}

function pickResidualRow(
  rows: readonly ResidualPullRequestRow[],
  target: PullRequestTarget,
  repositoryId: string | null
): ResidualPullRequestRow | null {
  const sameNumber = rows.filter((row) => row.number === target.prNumber);
  if (repositoryId) {
    const exact = sameNumber.find((row) => row.repositoryId === repositoryId);
    if (exact) {
      return exact;
    }
  }
  const byFullName = sameNumber.filter(
    (row) => row.repositoryFullName === target.repositoryFullName
  );
  const adoptedMatches = byFullName.filter((row) => row.repositoryId !== null);
  if (adoptedMatches.length > 1) {
    return null;
  }
  return adoptedMatches[0] ?? byFullName[0] ?? null;
}

function branchTargetIdentity(target: {
  repositoryFullName: string;
  branchName: string;
}): string {
  return `${target.repositoryFullName}\u0000${target.branchName}`;
}

function immutableEventsEqual(
  left: SyncedMonitoredSessionActivityEvent,
  right: SyncedMonitoredSessionActivityEvent
): boolean {
  return left.kind === right.kind && left.occurredAt === right.occurredAt;
}

function toActivityTarget(
  detail: SessionPullRequestDetailRef
): ResolvedActivityTarget {
  return {
    branchArtifactId: detail.branchArtifactId,
    pullRequestDetailId: detail.prDetailId,
  };
}

type PullRequestTarget = Extract<
  MonitoredActivityCandidate["target"],
  { kind: "pull_request" }
>;

const RESIDUAL_PULL_REQUEST_SELECT = {
  id: true,
  branchArtifactId: true,
  repositoryId: true,
  repositoryFullName: true,
  number: true,
} as const;

type ResidualPullRequestRow = {
  id: string;
  branchArtifactId: string;
  repositoryId: string | null;
  repositoryFullName: string | null;
  number: number;
};

/**
 * Nothing bounds how many distinct targets one Session's activity may name
 * (ISS-9860), so every per-target `OR` list is sliced at the bind budget like
 * the per-event statements are; `organizationId` is the one fixed bind on each.
 */
const BRANCH_TARGET_LOOKUP_CHUNK_SIZE = bindParameterChunkSize(2, 1);
/**
 * A target whose repository identity is known spends two arms — `(repositoryId,
 * number)` and `(repositoryFullName, number)` — for four binds; the
 * `repositoryId: null` on the second arm renders `IS NULL` and binds nothing.
 */
const RESIDUAL_PULL_REQUEST_LOOKUP_CHUNK_SIZE = bindParameterChunkSize(4, 1);
const ADOPTABLE_PULL_REQUEST_LOOKUP_CHUNK_SIZE = bindParameterChunkSize(2, 1);
