/**
 * The FILE name still says "transport" and the exports no longer do: ISS-9181
 * widened this module past transport-only refs. Renaming the file moves its
 * `pull-request-population-declaration` entry in `source-gate-allowlist.json`,
 * which is shrink-only and ratcheted by path, so the moved entry reads as new
 * debt and fails `check:source-gates`. Renaming it needs that entry retired
 * first — the read here is a session's own PR refs, deliberately outside both
 * sanctioned populations.
 */

import {
  type MonitoredActivityTarget,
  MonitoredTargetDisposition,
  monitoredActivityTargetKey,
} from "@repo/api/src/types/monitored-activity-target";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { sessionPullRequestDetailKey } from "./artifact-links/pull-request-details";
import {
  pullRequestLaneDeferralAwaitsRepositoryRead,
  type SessionPullRequestLaneDeferralMap,
} from "./artifact-links/pull-request-lane-deferral";
import {
  ServerRepositoryFetchAuthority,
  ServerRepositoryIdentity,
  type SessionRepositoryIdentityProbe,
  serverRepositoryFetchAuthority,
  serverRepositoryIdentity,
} from "./artifact-links/shared";
import {
  emptyMonitoredActivityOutcomeCounts,
  MonitoredActivityOutcome,
  type MonitoredActivityOutcomeCounts,
} from "./monitored-session-activity-persistence";
import type {
  MonitoredActivityCandidate,
  ResolvedActivityTarget,
} from "./monitored-session-activity-shared";
import {
  isValidMonitoredActivityTarget,
  monitoredActivityCandidateIdentity,
  uniqueMonitoredActivityTargets,
} from "./monitored-session-activity-shared";
import type { AgentSessionUpsertTx } from "./records";

/**
 * Classify every unresolved monitored-activity target by whether it can still
 * converge. Only a PR the server has no row for and no lane was going to write
 * one for, a repository-default Branch, or a repository this organization holds
 * no server-owned identity for is terminal; every ambiguity remains retry-owned
 * and therefore unacknowledged.
 *
 * ISS-9181 widened WHICH candidates are classified past `transportOnly`. A
 * TRUSTED candidate whose target never resolves used to be counted as one
 * undifferentiated `retryRequired` lump, which withheld an already-committed
 * Session from the acknowledgement forever whenever the target could not
 * converge at all.
 */
export async function classifyMonitoredActivityTargets(
  tx: AgentSessionUpsertTx,
  candidates: readonly MonitoredActivityCandidate[],
  resolvedTargets: ReadonlyMap<string, ResolvedActivityTarget>,
  input: {
    organizationId: string;
    repositoryIdentity: SessionRepositoryIdentityProbe;
    /**
     * `persistSessionPullRequestDetails`' own report of what it deferred, for
     * the SAME refs, already run in THIS transaction. Required rather than
     * defaulted because the safe answer differs by caller: an empty map says
     * the lane deferred nothing, which sends every unresolved PR target to the
     * existence read and acknowledges the ones it finds no row for.
     */
    pullRequestLaneDeferrals: SessionPullRequestLaneDeferralMap;
  }
): Promise<Map<string, MonitoredTargetDisposition>> {
  const unresolved = uniqueMonitoredActivityTargets(
    candidates.flatMap((candidate) =>
      resolvedTargets.has(monitoredActivityTargetKey(candidate.target))
        ? []
        : [candidate.target]
    )
  ).filter(isValidMonitoredActivityTarget);
  const laneVerdicts = new Map<string, PullRequestLaneVerdict>();
  for (const target of unresolved) {
    if (target.kind === ArtifactRefTargetKind.PullRequest) {
      laneVerdicts.set(
        monitoredActivityTargetKey(target),
        pullRequestLaneVerdict(
          target,
          input.repositoryIdentity,
          input.pullRequestLaneDeferrals
        )
      );
    }
  }
  const unresolvedPullRequests = unresolved.filter(
    (target): target is PullRequestTarget =>
      target.kind === ArtifactRefTargetKind.PullRequest &&
      laneVerdicts.get(monitoredActivityTargetKey(target))?.laneOwned !== true
  );
  // ONE bounded statement for the whole unresolved set, never one per target:
  // this runs inside the sync write transaction, under the p95 latency budget
  // on `POST /desktop/agent-sessions/sync`. Only the targets the PR lane does
  // not still own are in it, because they are the only ones an existence row
  // can settle — see {@link pullRequestLaneVerdict}.
  const existingPullRequests =
    unresolvedPullRequests.length === 0
      ? []
      : await tx.pullRequestDetail.findMany({
          where: {
            organizationId: input.organizationId,
            OR: unresolvedPullRequests.map((target) => ({
              repositoryFullName: target.repositoryFullName,
              number: target.prNumber,
            })),
          },
          select: { repositoryFullName: true, number: true },
        });
  const dispositions = new Map<string, MonitoredTargetDisposition>();
  for (const target of unresolved) {
    const key = monitoredActivityTargetKey(target);
    const verdict = laneVerdicts.get(key);
    dispositions.set(
      key,
      classifyTarget(target, input.repositoryIdentity, {
        existingPullRequests,
        laneOwned: verdict?.laneOwned === true,
        repositoryUnfetchable: verdict?.repositoryUnfetchable === true,
      })
    );
  }
  return dispositions;
}

/**
 * What the PR lane's report means for ONE target: whether the lane still owns
 * it, and — when it does not — whether the reason is that the repository
 * cannot be fetched at all rather than the provider denying the PR.
 *
 * The lane's verdict is read, never re-derived. Every fact this needs — which
 * refs the lane ran over, how it collapsed them, what admitted the head-branch
 * attempt, whether it materialized — is the lane's own, and a second
 * derivation of them from the same `artifactRefs` is what produced PR #7621's
 * five defects. This composes two facts from two owners instead:
 * the lane's deferral, and this organization's fetch authority.
 *
 * A target ABSENT from the map is one the lane resolved or never ran over, and
 * the existence read settles both.
 *
 * A deferral the desktop converges by itself keeps the target lane-owned
 * whatever the repository can be read for: the lane records a ref with no head
 * branch name BEFORE it consults repository authority, so it has not
 * established that a later delivery cannot land the row. Withholding such a
 * target sends it to the existence read, back as `IntentionallyAbsent`, and
 * acknowledges a Session whose monitored-activity evidence the desktop never
 * resends.
 *
 * Only the deferral that WAITS on a read is gated, and only on this delivery:
 * the lane tried the head branch and it would not materialize, so a repository
 * this organization holds no fetch-conferring source for is one the lane could
 * not write now. That is a fact about THIS delivery, not a claim that no later
 * one can ever land the row — an installation, a public-repository row or a
 * webhook still settles it, which is why
 * `monitored-session-activity-retention.ts` files the evidence rather than
 * discarding it.
 */
function pullRequestLaneVerdict(
  target: PullRequestTarget,
  probe: SessionRepositoryIdentityProbe,
  deferrals: SessionPullRequestLaneDeferralMap
): PullRequestLaneVerdict {
  const deferral = deferrals.get(
    sessionPullRequestDetailKey(target.repositoryFullName, target.prNumber)
  );
  if (deferral === undefined) {
    return { laneOwned: false, repositoryUnfetchable: false };
  }
  if (!pullRequestLaneDeferralAwaitsRepositoryRead(deferral)) {
    return { laneOwned: true, repositoryUnfetchable: false };
  }
  // `=== None`, never `!== Held`: only "every source was read and none
  // conferred a fetch" may stop the lane claiming a target. `NotProbed` is
  // the absence of an answer and must hold, exactly as its identity sibling
  // does in `classifyTarget`.
  const unfetchable =
    serverRepositoryFetchAuthority(probe, target.repositoryFullName) ===
    ServerRepositoryFetchAuthority.None;
  return { laneOwned: !unfetchable, repositoryUnfetchable: unfetchable };
}

/**
 * Split unresolved candidates into the ones a later delivery can still land
 * and the ones it never will, tallying every classified candidate — held as
 * well as acknowledged — under its own outcome.
 *
 * A candidate carrying NO disposition is retry-owned. An unclassified target
 * is an unanswered question, and acknowledging on an unanswered question is
 * the evidence loss this partition exists to prevent.
 */
export function partitionUnresolvedMonitoredCandidates(
  candidates: readonly MonitoredActivityCandidate[],
  dispositions: ReadonlyMap<string, MonitoredTargetDisposition>,
  expiredHoldIdentities: ReadonlySet<string>,
  /**
   * Held candidates on a target an EARLIER delivery's ceiling settled, new
   * mentions included: counted as `TargetHoldSettled` rather than
   * `TargetHoldExpired`, which would report one abandonment per sync.
   */
  ceilingSettledIdentities: ReadonlySet<string>
): UnresolvedMonitoredCandidatePartition {
  const outcomeCounts = emptyMonitoredActivityOutcomeCounts();
  let retryOwnedCount = 0;
  for (const candidate of candidates) {
    const disposition = dispositions.get(
      monitoredActivityTargetKey(candidate.target)
    );
    // ISS-11427: the CLASSIFIED disposition still lands in its own breakdown
    // member, so `target_not_materialized` keeps meaning "classified as this"
    // and an existing query over it is unchanged. The EFFECTIVE one decides
    // whether the acknowledgement is still held.
    if (disposition !== undefined) {
      outcomeCounts[
        MONITORED_TARGET_DISPOSITION_OUTCOME[disposition].outcome
      ] += 1;
    }
    const effective = effectiveMonitoredTargetDisposition({
      disposition,
      holdExpired: expiredHoldIdentities.has(
        monitoredActivityCandidateIdentity(candidate)
      ),
    });
    if (effective === MonitoredTargetDisposition.HoldExpired) {
      const outcome = ceilingSettledIdentities.has(
        monitoredActivityCandidateIdentity(candidate)
      )
        ? MonitoredActivityOutcome.TargetHoldSettled
        : MonitoredActivityOutcome.TargetHoldExpired;
      outcomeCounts[outcome] += 1;
      continue;
    }
    if (isRetryOwnedMonitoredDisposition(effective)) {
      retryOwnedCount += 1;
    }
  }
  return { retryOwnedCount, outcomeCounts };
}

/**
 * The outcome each disposition is counted under, and whether it still holds
 * the Session's acknowledgement.
 *
 * An exhaustive `Record` rather than a set of the acknowledged members: a set
 * widens to `string`, so a disposition added later would compile, fall to the
 * retry-owned default, and change the answer with nothing failing. Here a new
 * member fails `tsc` until someone judges which side it belongs on and which
 * counter it lands in.
 *
 * ISS-9182 gave the four held dispositions an outcome of their own. Before
 * that they shared `null` and were indistinguishable in production, so
 * attributing a hold took a database query.
 */
const MONITORED_TARGET_DISPOSITION_OUTCOME: Record<
  MonitoredTargetDisposition,
  {
    outcome: MonitoredActivityOutcome;
    retryOwned: boolean;
    /**
     * Whether a TRANSPORT-ONLY candidate with this disposition is skipped
     * rather than persisted. Carried here so the one consumer derives it from
     * this table instead of comparing against a member by name: a bare `===`
     * pair silently admits a member added later to neither side, and a set of
     * the skippable members widens to `string` and does the same.
     */
    transportSkippable: boolean;
  }
> = {
  [MonitoredTargetDisposition.IntentionallyAbsent]: {
    outcome: MonitoredActivityOutcome.TargetIntentionallyAbsent,
    retryOwned: false,
    transportSkippable: true,
  },
  // A pure split of `IntentionallyAbsent`, so it sits on that member's side of
  // every column here: the acknowledgement and the transport-only skip are
  // unchanged and only the counter it lands in is new.
  [MonitoredTargetDisposition.RepositoryUnfetchable]: {
    outcome: MonitoredActivityOutcome.TargetRepositoryUnfetchable,
    retryOwned: false,
    transportSkippable: true,
  },
  [MonitoredTargetDisposition.RepositoryOutOfScope]: {
    outcome: MonitoredActivityOutcome.TargetRepositoryOutOfScope,
    retryOwned: false,
    transportSkippable: false,
  },
  [MonitoredTargetDisposition.RepositoryIdentityUnknown]: {
    outcome: MonitoredActivityOutcome.TargetRepositoryIdentityUnknown,
    retryOwned: true,
    transportSkippable: false,
  },
  [MonitoredTargetDisposition.AuthorityConflict]: {
    outcome: MonitoredActivityOutcome.TargetAuthorityConflict,
    retryOwned: true,
    transportSkippable: false,
  },
  [MonitoredTargetDisposition.ProviderIdentityAmbiguous]: {
    outcome: MonitoredActivityOutcome.TargetProviderIdentityAmbiguous,
    retryOwned: true,
    transportSkippable: false,
  },
  [MonitoredTargetDisposition.TargetNotMaterialized]: {
    outcome: MonitoredActivityOutcome.TargetNotMaterialized,
    retryOwned: true,
    transportSkippable: false,
  },
  // ISS-11427: the one member `classifyTarget` never returns. It is substituted
  // per candidate once the hold passes its ceiling, and it is NOT retry-owned —
  // that substitution is the whole bound. `transportSkippable` stays false: the
  // transport-only skip is decided against the RAW classification before the
  // trust partition, so an expired candidate follows the ordinary pipeline into
  // retention rather than being skipped without filing its evidence.
  [MonitoredTargetDisposition.HoldExpired]: {
    outcome: MonitoredActivityOutcome.TargetHoldExpired,
    retryOwned: false,
    transportSkippable: false,
  },
};

/** Whether a transport-only candidate with this disposition is skipped. */
export function monitoredTargetDispositionTransportSkippable(
  disposition: MonitoredTargetDisposition | undefined
): boolean {
  return disposition === undefined
    ? false
    : MONITORED_TARGET_DISPOSITION_OUTCOME[disposition].transportSkippable;
}

function classifyTarget(
  target: MonitoredActivityTarget,
  probe: SessionRepositoryIdentityProbe,
  context: {
    existingPullRequests: readonly ExistingPullRequestRow[];
    laneOwned: boolean;
    /** The lane withheld this key because the repository cannot be fetched. */
    repositoryUnfetchable: boolean;
  }
): MonitoredTargetDisposition {
  // First, and by the same predicate the observation lane uses: an
  // organization that holds no identity for this repository at all cannot
  // materialize the target on any later delivery, so holding the Session waits
  // on an event nobody has scheduled (ISS-6476's poison pill). A name no read
  // covered is the other thing entirely and holds.
  const identity = serverRepositoryIdentity(probe, target.repositoryFullName);
  if (identity === ServerRepositoryIdentity.NotProbed) {
    return MonitoredTargetDisposition.RepositoryIdentityUnknown;
  }
  if (identity === ServerRepositoryIdentity.None) {
    return MonitoredTargetDisposition.RepositoryOutOfScope;
  }
  const authority = probe.authorities.get(target.repositoryFullName);
  // A repo the server knows TWICE is unresolvable, not absent, so it holds.
  if (authority?.identityConflict) {
    return MonitoredTargetDisposition.AuthorityConflict;
  }
  if (target.kind === ArtifactRefTargetKind.PullRequest) {
    // The PR lane owns this identity — and can still act on it — so it defers
    // rather than denies and its silence is not the provider's. A ref the lane
    // would have materialized this delivery, on a repository the organization
    // cannot fetch, is not lane-owned: the existence read below decides that
    // one instead (PLN-2061 M1).
    if (context.laneOwned) {
      return MonitoredTargetDisposition.TargetNotMaterialized;
    }
    const matchingRows = context.existingPullRequests.filter(
      (row) =>
        row.repositoryFullName === target.repositoryFullName &&
        row.number === target.prNumber
    );
    // A row exists that the resolver could not key onto: an identity question,
    // not a provider-authoritative absence.
    if (matchingRows.length > 0) {
      return MonitoredTargetDisposition.ProviderIdentityAmbiguous;
    }
    // No row, and the read that would have written one can never run. The
    // provider never said this PR is absent, so it is not counted as though it
    // had (ISS-9182 review r4053480710).
    return context.repositoryUnfetchable
      ? MonitoredTargetDisposition.RepositoryUnfetchable
      : MonitoredTargetDisposition.IntentionallyAbsent;
  }
  // Only names the AUTHORITY read covered carry `authorities`: an identity-only
  // name gets `authorities: []` from `mergeIdentityOnlyRows`, and
  // `collectIdentityOnlyRepositoryNames` excludes anything the authority read
  // already answered. So for a `monitoredActivityOnly` branch ref this arm
  // never matches and the target falls to `TargetNotMaterialized` — still
  // retry-owned, exactly as it was before ISS-9181. The branch half of that
  // change buys an acknowledgement only when the repository is out of scope
  // entirely; a branch named in a message on an IN-scope repository is held.
  const defaultBranches = (authority?.authorities ?? []).flatMap((candidate) =>
    "defaultBranch" in candidate.evidence
      ? [candidate.evidence.defaultBranch]
      : []
  );
  return defaultBranches.includes(target.branchName)
    ? MonitoredTargetDisposition.IntentionallyAbsent
    : MonitoredTargetDisposition.TargetNotMaterialized;
}

type PullRequestTarget = Extract<
  MonitoredActivityCandidate["target"],
  { kind: "pull_request" }
>;

/** What one target's PR-lane report means to {@link classifyTarget}. */
type PullRequestLaneVerdict = {
  /** The lane deferred this target and can still land it. */
  laneOwned: boolean;
  /** The lane let it go because the repository cannot be fetched. */
  repositoryUnfetchable: boolean;
};

/** One `PullRequestDetail` existence row, as the classifier selects it. */
type ExistingPullRequestRow = {
  repositoryFullName: string | null;
  number: number;
};

export type UnresolvedMonitoredCandidatePartition = {
  /** Candidates still worth holding the Session's acknowledgement for. */
  retryOwnedCount: number;
  /**
   * Per-disposition tallies, held and acknowledged alike; the persistence
   * outcomes stay zero. `retryOwnedCount` also counts candidates the
   * classifier returned no disposition for, so it can exceed the held
   * tallies' sum.
   */
  outcomeCounts: MonitoredActivityOutcomeCounts;
};

/**
 * Whether a LATER delivery still owns this candidate, rather than this one
 * having settled it.
 *
 * Read off {@link MONITORED_TARGET_DISPOSITION_OUTCOME} rather than a set of
 * the retry-owned members: a set widens to `string`, so a disposition added
 * later would compile and fall to whichever side the set omits. Here it fails
 * `tsc` at the Record until someone judges it. An UNCLASSIFIED target is
 * retry-owned for the reason `partitionUnresolvedMonitoredCandidates` gives —
 * an unanswered question is not an answer.
 */
export function isRetryOwnedMonitoredDisposition(
  disposition: MonitoredTargetDisposition | undefined
): boolean {
  return disposition === undefined
    ? true
    : MONITORED_TARGET_DISPOSITION_OUTCOME[disposition].retryOwned;
}

/**
 * ISS-11427: the disposition that actually governs one CANDIDATE — the
 * classifier's, unless the hold has run past its wall-clock ceiling, in which
 * case {@link MonitoredTargetDisposition.HoldExpired}.
 *
 * THE SINGLE SOURCE for that substitution, and that is the point: the
 * acknowledgement gate (`partitionUnresolvedMonitoredCandidates`) and the
 * retention gate (`partitionUnwrittenMonitoredActivityCandidates`) both ask
 * here, so they cannot disagree about one candidate. If they could,
 * `assertEveryMonitoredCandidateAccounted` would fail the delivery — retained on
 * one side and still owed on the other is exactly the state it refuses.
 *
 * Substituted ONLY over a retry-owned disposition. An acknowledged one is
 * already terminal, so there is no hold to expire, and rewriting it would lose
 * the reason its retained row carries. An UNCLASSIFIED target (`undefined`) is
 * retry-owned by {@link isRetryOwnedMonitoredDisposition} and so is covered
 * here too — that arm is the one hold with no disposition to name, and leaving
 * it out would leave it unbounded.
 */
export function effectiveMonitoredTargetDisposition(input: {
  disposition: MonitoredTargetDisposition | undefined;
  /**
   * From `resolveMonitoredActivityHoldExpiry` (`monitored-activity-hold-ceiling.ts`),
   * computed once per delivery; includes targets an earlier ceiling settled.
   */
  holdExpired: boolean;
}): MonitoredTargetDisposition | undefined {
  if (
    !(input.holdExpired && isRetryOwnedMonitoredDisposition(input.disposition))
  ) {
    return input.disposition;
  }
  return MonitoredTargetDisposition.HoldExpired;
}
