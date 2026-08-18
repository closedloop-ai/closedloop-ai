import { createHash } from "node:crypto";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import {
  ArtifactRefTargetKind,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import {
  MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS_PER_SESSION,
  type SyncedMonitoredSessionActivityEvent,
} from "@repo/api/src/types/session-monitored-activity";
import { BranchActivityPersistStatus } from "@/app/branches/branch-activity-evidence";
import { persistBranchActivityAtomsInTransaction } from "@/app/branches/branch-activity-evidence-batch";
import {
  type SessionPullRequestDetailMap,
  type SessionPullRequestDetailRef,
  sessionPullRequestDetailKey,
} from "./artifact-links/pull-request-details";
import type { SessionBranchRepositoryAuthorityMap } from "./artifact-links/shared";
import type { AgentSessionUpsertTx } from "./records";

type MonitoredActivityCandidate = {
  target:
    | {
        kind: typeof ArtifactRefTargetKind.Branch;
        repositoryFullName: string;
        branchName: string;
      }
    | {
        kind: typeof ArtifactRefTargetKind.PullRequest;
        repositoryFullName: string;
        prNumber: number;
      };
  event: SyncedMonitoredSessionActivityEvent;
};

type ResolvedActivityTarget = {
  branchArtifactId: string;
  pullRequestDetailId: string | null;
};

/**
 * Persist capability-gated monitored-session activity after Branch and PR rows
 * have materialized. Missing targets and atom conflicts reject the surrounding
 * Session transaction so the Desktop cursor cannot acknowledge lost evidence.
 *
 * `pullRequestDetails` is the PR lane's own output for the SAME `artifactRefs`
 * (ISS-6450) — attribution reads it rather than re-deriving every row from an
 * `(organizationId, repositoryFullName, number)` lookup no index serves. Only
 * the targets that lane never saw reach the database here, on index-served keys
 * (see `resolveResidualPullRequestTargets`).
 */
export async function persistMonitoredSessionActivity(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    sessionArtifactId: string;
    artifactRefs: SyncedArtifactRef[] | undefined;
    pullRequestDetails: SessionPullRequestDetailMap;
    repositoryAuthorityByFullName: SessionBranchRepositoryAuthorityMap;
  }
): Promise<void> {
  const candidates = collectCandidates(input.artifactRefs);
  if (candidates.length === 0) {
    return;
  }
  const resolvedTargets = await resolveTargets(tx, candidates, input);
  const records = candidates.map((candidate) => {
    const target = resolvedTargets.get(targetKey(candidate.target));
    if (!target) {
      throw new Error(
        `monitored session activity target unresolved: ${targetKey(candidate.target)}`
      );
    }
    return {
      branchArtifactId: target.branchArtifactId,
      atom: {
        version: BranchActivityAtomVersion.V1,
        source: BranchActivitySource.MonitoredSession,
        sourceEventId: canonicalSourceEventId(
          input.sessionArtifactId,
          candidate.event
        ),
        occurredAt: candidate.event.occurredAt,
        attribution: target.pullRequestDetailId
          ? {
              kind: BranchActivityAttributionKind.PullRequest,
              pullRequestId: target.pullRequestDetailId,
            }
          : { kind: BranchActivityAttributionKind.Branch },
        completeness: candidate.event.completeness,
      },
    };
  });
  const results = await persistBranchActivityAtomsInTransaction(tx, {
    organizationId: input.organizationId,
    records,
  });
  for (const [index, result] of results.entries()) {
    if (
      result.status !== BranchActivityPersistStatus.Inserted &&
      result.status !== BranchActivityPersistStatus.Replayed
    ) {
      throw new Error(
        `monitored session activity rejected for ${targetKey(candidates[index].target)}: ${result.status}`
      );
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
    for (const event of carrier.events) {
      const conservativeEvent =
        carrier.completeness === BranchActivityEvidenceCompleteness.Partial
          ? {
              ...event,
              completeness: BranchActivityEvidenceCompleteness.Partial,
            }
          : event;
      const key = `${targetKey(target)}:${conservativeEvent.sourceEventId}`;
      const existing = byIdentity.get(key);
      if (existing && !eventsEqual(existing.event, conservativeEvent)) {
        throw new Error(
          `conflicting monitored activity carrier identity ${key}`
        );
      }
      byIdentity.set(key, { target, event: conservativeEvent });
    }
  }
  const candidates = [...byIdentity.values()].sort(
    (left, right) =>
      Date.parse(right.event.occurredAt) - Date.parse(left.event.occurredAt) ||
      targetKey(left.target).localeCompare(targetKey(right.target)) ||
      left.event.sourceEventId.localeCompare(right.event.sourceEventId)
  );
  const truncated =
    candidates.length >
    MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS_PER_SESSION;
  return candidates
    .slice(0, MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS_PER_SESSION)
    .map((candidate) =>
      truncated
        ? {
            ...candidate,
            event: {
              ...candidate.event,
              completeness: BranchActivityEvidenceCompleteness.Partial,
            },
          }
        : candidate
    );
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
  const branchTargets = uniqueTargets(
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
  const pullRequestTargets = uniqueTargets(
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
  const branches =
    branchTargets.length === 0
      ? []
      : await tx.branchDetail.findMany({
          where: {
            organizationId,
            OR: branchTargets.map((target) => ({
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
  const resolved = new Map<string, ResolvedActivityTarget>();
  for (const branch of branches) {
    resolved.set(
      targetKey({
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: normalizeRepoFullName(branch.repositoryFullName),
        branchName: branch.branchName,
      }),
      { branchArtifactId: branch.artifactId, pullRequestDetailId: null }
    );
  }
  const residual: PullRequestTarget[] = [];
  for (const target of pullRequestTargets) {
    const threaded = context.pullRequestDetails.get(
      sessionPullRequestDetailKey(target.repositoryFullName, target.prNumber)
    );
    if (threaded) {
      resolved.set(targetKey(target), toActivityTarget(threaded));
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

function uniqueTargets<T extends MonitoredActivityCandidate["target"]>(
  targets: T[]
): T[] {
  return [
    ...new Map(targets.map((target) => [targetKey(target), target])).values(),
  ];
}

function targetKey(target: MonitoredActivityCandidate["target"]): string {
  return target.kind === ArtifactRefTargetKind.Branch
    ? `branch:${target.repositoryFullName}:${target.branchName}`
    : `pull_request:${target.repositoryFullName}#${target.prNumber}`;
}

function canonicalSourceEventId(
  sessionArtifactId: string,
  event: SyncedMonitoredSessionActivityEvent
): string {
  const digest = createHash("sha256")
    .update(`${sessionArtifactId}\u0000${event.sourceEventId}`)
    .digest("hex");
  return `monitored_session_v1:${digest}`;
}

function eventsEqual(
  left: SyncedMonitoredSessionActivityEvent,
  right: SyncedMonitoredSessionActivityEvent
): boolean {
  return (
    left.kind === right.kind &&
    left.occurredAt === right.occurredAt &&
    left.completeness === right.completeness
  );
}

/**
 * Resolve PR targets the PR lane never handed us: `monitoredActivityOnly` refs
 * (a PR URL seen in a message — `collectPullRequestRefs` filters those out) and
 * refs it deferred for a missing or non-materialized head branch.
 *
 * Both index-served steps mirror the PR lane's own identity ladder:
 * `(repositoryId, number)` when an ACTIVE App install covers the repo, else the
 * repo-less `(organizationId, repositoryFullName, number)` unique index — which
 * is PARTIAL on `repository_id IS NULL`, so only a query that says so can use
 * it. The unscoped identity has no index at all and scans the org's whole
 * `pull_request_detail` (ISS-6450), so it runs only as a second pass over the
 * targets neither step matched: a row adopted by an install that is no longer
 * ACTIVE, and — since absence cannot be proven from a partial index — a PR this
 * org has never ingested, which then rejects the Session as it always has. That
 * is the SAME single unindexed scan the old code ran unconditionally, now
 * confined to that residue instead of every session carrying a PR ref.
 */
async function resolveResidualPullRequestTargets(
  tx: AgentSessionUpsertTx,
  targets: PullRequestTarget[],
  context: {
    organizationId: string;
    repositoryAuthorityByFullName: SessionBranchRepositoryAuthorityMap;
  }
): Promise<Map<string, SessionPullRequestDetailRef>> {
  const resolved = new Map<string, SessionPullRequestDetailRef>();
  if (targets.length === 0) {
    return resolved;
  }
  const repositoryIdFor = (target: PullRequestTarget) => {
    const authority = context.repositoryAuthorityByFullName.get(
      target.repositoryFullName
    );
    // A conflicted entry retains ONE of the ids that disagreed, so which one
    // survived reconciliation is arbitrary. Keying the residual lookup on it
    // would bind this session's activity to whichever install happened to win;
    // an unresolvable identity has to stay unresolved.
    if (!authority || authority.identityConflict) {
      return null;
    }
    return authority.repositoryId ?? null;
  };
  const indexedRows = await tx.pullRequestDetail.findMany({
    where: {
      organizationId: context.organizationId,
      OR: targets.flatMap((target) => {
        const repoLess = {
          repositoryFullName: target.repositoryFullName,
          number: target.prNumber,
          repositoryId: null,
        };
        const repositoryId = repositoryIdFor(target);
        return repositoryId
          ? [{ repositoryId, number: target.prNumber }, repoLess]
          : [repoLess];
      }),
    },
    select: RESIDUAL_PULL_REQUEST_SELECT,
  });
  const unmatched: PullRequestTarget[] = [];
  for (const target of targets) {
    const row = pickResidualRow(indexedRows, target, repositoryIdFor(target));
    if (row) {
      resolved.set(targetKey(target), {
        prDetailId: row.id,
        branchArtifactId: row.branchArtifactId,
      });
      continue;
    }
    unmatched.push(target);
  }
  // Only a target whose active repository we could NOT resolve may fall back to
  // a row matched on full name alone. When the id IS known and neither indexed
  // step matched it, a same-name row carrying some other `repository_id` is a
  // historical row from before a transfer or re-adoption — not this PR (wongk,
  // #5103). Binding to it would attach the activity to the wrong repository's
  // branch.
  const adoptable = unmatched.filter(
    (target) => repositoryIdFor(target) === null
  );
  if (adoptable.length === 0) {
    return resolved;
  }
  const adoptedRows = await tx.pullRequestDetail.findMany({
    where: {
      organizationId: context.organizationId,
      OR: adoptable.map((target) => ({
        repositoryFullName: target.repositoryFullName,
        number: target.prNumber,
      })),
    },
    select: RESIDUAL_PULL_REQUEST_SELECT,
  });
  for (const target of adoptable) {
    const row = pickResidualRow(adoptedRows, target, null);
    if (row) {
      resolved.set(targetKey(target), {
        prDetailId: row.id,
        branchArtifactId: row.branchArtifactId,
      });
    }
  }
  return resolved;
}

/**
 * Pick this target's row out of a batched result. Nulls-last, mirroring
 * `resolveExistingDesktopPrRow`'s `orderBy`: the App row for the resolved repo
 * wins, then an adopted row sharing the full name, then the repo-less row.
 *
 * Ties fail closed. More than one adopted row can share a full name and number
 * across repositories, and the pick among them would be whatever order the
 * batch came back in — putting the same source event on a different branch from
 * one retry to the next (wongk, #5103). An ambiguous identity resolves to
 * nothing, the same as an absent one.
 */
function pickResidualRow(
  rows: readonly ResidualPullRequestRow[],
  target: PullRequestTarget,
  repositoryId: string | null
): ResidualPullRequestRow | null {
  const sameNumber = rows.filter((row) => row.number === target.prNumber);
  if (repositoryId) {
    const adopted = sameNumber.find((row) => row.repositoryId === repositoryId);
    if (adopted) {
      return adopted;
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
