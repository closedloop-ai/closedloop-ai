import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
} from "@repo/api/src/types/artifact-activity";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import { MonitoredTargetDisposition } from "@repo/api/src/types/monitored-activity-target";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it } from "vitest";
import {
  BRANCH_ARTIFACT_ID,
  branchRef,
  EVENT,
  laneDeferrals,
  NO_PR_DETAILS,
  NO_PR_LANE_DEFERRALS,
  ORGANIZATION_ID,
  observedOnlyAlongside,
  onlyOutcome,
  PR_NUMBER,
  PULL_REQUEST_ID,
  persistenceTx,
  pullRequestRef,
  REPOSITORY,
  REPOSITORY_ID,
  RESOLVED_PR_DETAILS,
  WITHIN_HOLD_CEILING,
} from "@/__tests__/support/agent-sessions/monitored-session-activity.test-fixtures";
import { RepositoryIdentitySource } from "./artifact-links/authority-source-queries";
import {
  type SessionPullRequestDetailMap,
  sessionPullRequestDetailKey,
} from "./artifact-links/pull-request-details";
import { PullRequestLaneDeferral } from "./artifact-links/pull-request-lane-deferral";
import type { SessionRepositoryIdentityProbe } from "./artifact-links/shared";
import { persistMonitoredSessionActivity } from "./monitored-session-activity";
import { MonitoredActivityOutcome } from "./monitored-session-activity-persistence";
import { toSessionUntrackedRepositoryTargets } from "./session-untracked-repositories";

const SESSION_ARTIFACT_ID = "019ff900-0000-7000-8000-000000000004";
/**
 * ISS-11427: inside the monitored-activity hold ceiling — the shared fixture,
 * derived from `EVENT.occurredAt` and the ceiling itself. A delivery clock PAST
 * it makes every held case here expire, which is a different contract with its
 * own cases in `monitored-activity-hold-ceiling.test.ts`.
 */
const RECEIVED_AT = WITHIN_HOLD_CEILING;
/**
 * ISS-10628's production shape, confirmed against the prod DB on 2026-09-18: a
 * pull request on a repository the organization holds exactly one verified
 * `github_observed_repository` row for and no installation.
 */
const UNTRACKED_REPOSITORY = "prisma/prisma-engines";
const UNTRACKED_PR_NUMBER = 5860;
/** Past the 24h trusted-future skew from `RECEIVED_AT`. */
const FUTURE_EVENT = { ...EVENT, occurredAt: "2026-08-14T13:00:00.000Z" };

/** Identity known (a verified observed row), authority absent. */
const OBSERVED_ONLY_REPOSITORY: SessionRepositoryIdentityProbe = {
  authorities: new Map([
    [
      UNTRACKED_REPOSITORY,
      {
        repositoryId: null,
        providerRepositoryId: "provider-prisma-engines",
        authorities: [],
        identitySources: new Set([RepositoryIdentitySource.Observed]),
      },
    ],
  ]),
  probedNames: new Set([UNTRACKED_REPOSITORY]),
};

/** The repository WAS read for and nothing at all came back. */
const NO_IDENTITY_AT_ALL: SessionRepositoryIdentityProbe = {
  authorities: new Map(),
  probedNames: new Set([UNTRACKED_REPOSITORY]),
};

/** The organization now holds a server identity for the repository. */
const INSTALLED_REPOSITORY: SessionRepositoryIdentityProbe = {
  authorities: new Map([
    [
      UNTRACKED_REPOSITORY,
      {
        repositoryId: REPOSITORY_ID,
        providerRepositoryId: "provider-prisma-engines",
        authorities: [],
        identitySources: new Set([RepositoryIdentitySource.Installation]),
      },
    ],
  ]),
  probedNames: new Set([UNTRACKED_REPOSITORY]),
};

/** The PR lane's output once the target finally materializes. */
const INSTALLED_PR_DETAILS: SessionPullRequestDetailMap = new Map([
  [
    sessionPullRequestDetailKey(UNTRACKED_REPOSITORY, UNTRACKED_PR_NUMBER),
    { prDetailId: PULL_REQUEST_ID, branchArtifactId: BRANCH_ARTIFACT_ID },
  ],
]);

/** Both repositories read for, neither holding an identity. */
const NO_IDENTITY_FOR_EITHER: SessionRepositoryIdentityProbe = {
  authorities: new Map(),
  probedNames: new Set([UNTRACKED_REPOSITORY, REPOSITORY]),
};

/**
 * A repository name the URL parser erases — `https://github.com/../pull/5`
 * resolves to `/pull/5`. Read for, out of scope, so it settles and is retained.
 */
const ERASED_REPOSITORY = "..";
const NO_IDENTITY_FOR_ERASED: SessionRepositoryIdentityProbe = {
  authorities: new Map(),
  probedNames: new Set([ERASED_REPOSITORY]),
};

function untrackedPullRequestRef() {
  return {
    ...pullRequestRef(),
    repositoryFullName: UNTRACKED_REPOSITORY,
    prNumber: UNTRACKED_PR_NUMBER,
  };
}

/**
 * What the PR lane reports for this suite's PR ref: it carries no head branch
 * name, so the lane recorded it before consulting repository authority and the
 * next delivery writes the row from the desktop's own facts. Stated here
 * rather than derived from `artifactRefs` — a fixture that re-derived the
 * lane's verdict could not catch the two disagreeing, which is the defect the
 * report exists to remove.
 */
function headlessDeferrals(
  ...targets: readonly { repositoryFullName: string; prNumber: number }[]
) {
  return laneDeferrals(
    ...targets.map((target) => ({
      ...target,
      deferral: PullRequestLaneDeferral.AwaitingDesktopDelivery,
    }))
  );
}

const UNTRACKED_HEADLESS_DEFERRALS = headlessDeferrals({
  repositoryFullName: UNTRACKED_REPOSITORY,
  prNumber: UNTRACKED_PR_NUMBER,
});

function unresolvableTx() {
  const harness = persistenceTx();
  harness.tx.branchDetail.findMany.mockResolvedValue([]);
  harness.tx.pullRequestDetail.findMany.mockResolvedValue([]);
  return harness;
}

describe("persistMonitoredSessionActivity retention (ISS-9182)", () => {
  it("holds a retry-owned target's evidence for a later delivery instead of filing it", async () => {
    const { tx, retained } = unresolvableTx();

    const result = await persistMonitoredSessionActivity(tx as never, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      artifactRefs: [untrackedPullRequestRef()],
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: UNTRACKED_HEADLESS_DEFERRALS,
      },
      repositoryIdentity: OBSERVED_ONLY_REPOSITORY,
      receivedAt: RECEIVED_AT,
    });

    // The HELD side of the pair. A retained row says "no evidence could be
    // written for this" and nothing can retract it, so filing one for a target
    // the desktop is still re-offering would be false the moment the retry
    // lands the atom. `retryRequired` is what keeps the evidence in play, so it
    // is asserted here and not left to the sibling case alone.
    expect(result.retryRequired).toBe(true);
    expect(result.persistedCount).toBe(0);
    expect(tx.branchActivityAtom.createMany).not.toHaveBeenCalled();
    expect(tx.artifactActivityEvent.createMany).not.toHaveBeenCalled();
    expect(retained()).toHaveLength(0);
  });

  it("does not duplicate the retained evidence on a second delivery", async () => {
    const { tx, retained } = unresolvableTx();
    const input = {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      // A settled target beside a retry-owned sibling — the shape that makes a
      // redelivery reachable at all. The acknowledgement is withheld per
      // DELIVERY, so the held sibling re-offers the settled target too.
      artifactRefs: [untrackedPullRequestRef(), pullRequestRef()],
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: headlessDeferrals(
          {
            repositoryFullName: UNTRACKED_REPOSITORY,
            prNumber: UNTRACKED_PR_NUMBER,
          },
          { repositoryFullName: REPOSITORY, prNumber: PR_NUMBER }
        ),
      },
      repositoryIdentity: NO_IDENTITY_AT_ALL,
      receivedAt: RECEIVED_AT,
    };

    const first = await persistMonitoredSessionActivity(tx as never, input);
    await persistMonitoredSessionActivity(tx as never, input);

    expect(first.retryRequired).toBe(true);
    // The writer DID run twice — the row count is held by the id it derives,
    // not by the second delivery skipping the write.
    expect(tx.artifactActivityEvent.createMany).toHaveBeenCalledTimes(2);
    expect(retained().map((row) => row.after.repositoryFullName)).toEqual([
      UNTRACKED_REPOSITORY,
    ]);
  });

  it("files an acknowledged target's evidence on the session artifact", async () => {
    const { tx, retained } = unresolvableTx();

    const result = await persistMonitoredSessionActivity(tx as never, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      artifactRefs: [untrackedPullRequestRef()],
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: UNTRACKED_HEADLESS_DEFERRALS,
      },
      repositoryIdentity: NO_IDENTITY_AT_ALL,
      receivedAt: RECEIVED_AT,
    });

    // The ACKNOWLEDGED side of the pair, and the whole point of the ordering:
    // the delivery that stops holding a target is the delivery that files its
    // evidence. ISS-9181's fetch-authority gate moves the production population
    // onto this side, so what is pinned here is what it will produce.
    expect(result.retryRequired).toBe(false);
    expect(result.persistedCount).toBe(0);
    expect(retained()).toHaveLength(1);
    expect(retained()[0]).toMatchObject({
      organizationId: ORGANIZATION_ID,
      artifactId: SESSION_ARTIFACT_ID,
      actorType: ArtifactActivityActorType.System,
      actorId: null,
      action: ArtifactActivityAction.MonitoredActivityRetained,
      createdAt: RECEIVED_AT,
      after: {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: UNTRACKED_REPOSITORY,
        prNumber: UNTRACKED_PR_NUMBER,
        url: `https://github.com/${UNTRACKED_REPOSITORY}/pull/${UNTRACKED_PR_NUMBER}`,
        eventKind: EVENT.kind,
        occurredAt: EVENT.occurredAt,
        completeness: BranchActivityEvidenceCompleteness.Complete,
        disposition: MonitoredTargetDisposition.RepositoryOutOfScope,
      },
    });
  });

  /**
   * ISS-9181 and ISS-9182 on ONE delivery — the composition neither chunk
   * could pin on its own, because they were built in separate worktrees.
   * Before ISS-9181 an observation-only PR target was held forever, so the
   * retention every other case here asserts had no way to reach this
   * population at all; after it, the delivery that finally acknowledges the
   * target is the same delivery that files its evidence.
   *
   * `observedOnlyAlongside` names the unfetchable repository beside an
   * installation-backed one, so a gate that answered globally rather than per
   * repository would take the other name's authority and fail here.
   */
  it("acknowledges and retains an observation-only PR target on one delivery", async () => {
    const { tx, retained } = unresolvableTx();

    const result = await persistMonitoredSessionActivity(tx as never, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      artifactRefs: [{ ...untrackedPullRequestRef(), branchName: "feat/head" }],
      pullRequestLane: {
        details: NO_PR_DETAILS,
        // NAMED, so the lane attempted the head branch and it would not
        // materialize — the one deferral the fetch-authority gate reaches.
        deferrals: laneDeferrals({
          repositoryFullName: UNTRACKED_REPOSITORY,
          prNumber: UNTRACKED_PR_NUMBER,
          deferral: PullRequestLaneDeferral.AwaitingRepositoryRead,
        }),
      },
      repositoryIdentity: observedOnlyAlongside(UNTRACKED_REPOSITORY),
      receivedAt: RECEIVED_AT,
    });

    // The acknowledgement half: not retry-owned, and counted under the member
    // ISS-9181 split out rather than folded into a provider absence.
    expect(result).toMatchObject({
      retryRequired: false,
      persistedCount: 0,
      outcomeCounts: onlyOutcome(
        MonitoredActivityOutcome.TargetRepositoryUnfetchable,
        1
      ),
    });
    // The retention half, on that same delivery.
    expect(tx.branchActivityAtom.createMany).not.toHaveBeenCalled();
    expect(retained()).toHaveLength(1);
    expect(retained()[0]?.after).toMatchObject({
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: UNTRACKED_REPOSITORY,
      prNumber: UNTRACKED_PR_NUMBER,
      url: `https://github.com/${UNTRACKED_REPOSITORY}/pull/${UNTRACKED_PR_NUMBER}`,
      disposition: MonitoredTargetDisposition.RepositoryUnfetchable,
    });
  });

  it("retains evidence for a transport-only target the pipeline skips", async () => {
    const { tx, retained } = unresolvableTx();

    const result = await persistMonitoredSessionActivity(tx as never, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      artifactRefs: [
        { ...untrackedPullRequestRef(), monitoredActivityOnly: true as const },
      ],
      pullRequestLane: {
        details: NO_PR_DETAILS,
        // `monitoredActivityOnly`, so `collectPullRequestRefs` excludes it and
        // the lane never ran over this identity at all.
        deferrals: NO_PR_LANE_DEFERRALS,
      },
      repositoryIdentity: OBSERVED_ONLY_REPOSITORY,
      receivedAt: RECEIVED_AT,
    });

    expect(result.retryRequired).toBe(false);
    expect(retained()).toHaveLength(1);
    expect(retained()[0]?.after).toMatchObject({
      repositoryFullName: UNTRACKED_REPOSITORY,
      disposition: MonitoredTargetDisposition.IntentionallyAbsent,
    });
  });

  it("holds a future-dated transport-only target rather than retaining it", async () => {
    const { tx, retained } = unresolvableTx();

    const result = await persistMonitoredSessionActivity(tx as never, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      artifactRefs: [
        {
          ...pullRequestRef(FUTURE_EVENT),
          repositoryFullName: UNTRACKED_REPOSITORY,
          prNumber: UNTRACKED_PR_NUMBER,
          monitoredActivityOnly: true as const,
        },
      ],
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: NO_PR_LANE_DEFERRALS,
      },
      repositoryIdentity: OBSERVED_ONLY_REPOSITORY,
      receivedAt: RECEIVED_AT,
    });

    // The sibling case above is this one with an in-boundary `occurredAt`, and
    // it retains. A transport-only ref is the one candidate the pipeline used
    // to settle without the trust partition ever seeing its timestamp, so the
    // producer's clock alone decided the date on a row nothing can retract.
    expect(result.futureRejectedCount).toBe(1);
    expect(result.retryRequired).toBe(true);
    expect(
      tx.monitoredSessionActivityQuarantine.createMany
    ).toHaveBeenCalledTimes(1);
    expect(retained()).toHaveLength(0);
  });

  it("retracts a retained row the untracked reader also accepts, once a later delivery writes the target's atom", async () => {
    const { tx, retained, allStored } = persistenceTx();
    const refs = [
      {
        ...pullRequestRef(),
        repositoryFullName: UNTRACKED_REPOSITORY,
        prNumber: UNTRACKED_PR_NUMBER,
      },
    ];

    const settled = await persistMonitoredSessionActivity(tx as never, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      artifactRefs: refs,
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: UNTRACKED_HEADLESS_DEFERRALS,
      },
      repositoryIdentity: NO_IDENTITY_AT_ALL,
      receivedAt: RECEIVED_AT,
    });

    expect(settled.retryRequired).toBe(false);
    expect(retained()).toHaveLength(1);
    // The untracked-repository reader parses the row this retraction later
    // matches, through the same schema, so it must accept it too.
    expect(toSessionUntrackedRepositoryTargets(retained())).toEqual({
      targets: [
        {
          kind: ArtifactRefTargetKind.PullRequest,
          repositoryFullName: UNTRACKED_REPOSITORY,
          prNumber: UNTRACKED_PR_NUMBER,
          url: `https://github.com/${UNTRACKED_REPOSITORY}/pull/${UNTRACKED_PR_NUMBER}`,
        },
      ],
      unreadableRowCount: 0,
    });

    // The org state changes, not the delivery: the repository is now one this
    // organization holds an identity for and the PR lane materializes the row.
    // No retry was owed, so nothing but this reconciliation is watching.
    await persistMonitoredSessionActivity(tx as never, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      artifactRefs: refs,
      pullRequestLane: {
        details: INSTALLED_PR_DETAILS,
        // The lane materialized the row this time, so it defers nothing.
        deferrals: NO_PR_LANE_DEFERRALS,
      },
      repositoryIdentity: INSTALLED_REPOSITORY,
      receivedAt: RECEIVED_AT,
    });

    expect(allStored()).toHaveLength(1);
    expect(retained()).toHaveLength(0);
  });

  it("carries a Branch target's branch name and tree url", async () => {
    const { tx, retained } = unresolvableTx();

    await persistMonitoredSessionActivity(tx as never, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      artifactRefs: [
        {
          ...branchRef("feat/engines fix", EVENT),
          repositoryFullName: UNTRACKED_REPOSITORY,
          monitoredActivityOnly: true as const,
        },
      ],
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: NO_PR_LANE_DEFERRALS,
      },
      repositoryIdentity: NO_IDENTITY_AT_ALL,
      receivedAt: RECEIVED_AT,
    });

    expect(retained()).toHaveLength(1);
    expect(retained()[0]?.after).toMatchObject({
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: UNTRACKED_REPOSITORY,
      branchName: "feat/engines fix",
      url: `https://github.com/${UNTRACKED_REPOSITORY}/tree/feat%2Fengines%20fix`,
    });
    expect(retained()[0]?.after).not.toHaveProperty("prNumber");
  });

  it("files the evidence with no url when the name has no address on the provider", async () => {
    const { tx, retained } = unresolvableTx();

    await persistMonitoredSessionActivity(tx as never, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      artifactRefs: [
        { ...pullRequestRef(), repositoryFullName: ERASED_REPOSITORY },
      ],
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: headlessDeferrals({
          repositoryFullName: ERASED_REPOSITORY,
          prNumber: PR_NUMBER,
        }),
      },
      repositoryIdentity: NO_IDENTITY_FOR_ERASED,
      receivedAt: RECEIVED_AT,
    });

    // The evidence still lands, carrying the name the producer claimed — only
    // the LINK is absent, because no path segment can hold `..`. Omitted, not
    // null: `MonitoredActivityRetainedSnapshot` declares absence by omission.
    expect(retained()).toHaveLength(1);
    expect(retained()[0]?.after.repositoryFullName).toBe(ERASED_REPOSITORY);
    expect(retained()[0]?.after).not.toHaveProperty("url");
  });

  it("retains nothing for a candidate whose evidence landed as a branch activity atom", async () => {
    const { tx, retained, allStored } = persistenceTx();

    await persistMonitoredSessionActivity(tx as never, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      artifactRefs: [pullRequestRef()],
      pullRequestLane: {
        details: RESOLVED_PR_DETAILS,
        deferrals: NO_PR_LANE_DEFERRALS,
      },
      repositoryIdentity: OBSERVED_ONLY_REPOSITORY,
      receivedAt: RECEIVED_AT,
    });

    expect(allStored()).toHaveLength(1);
    expect(retained()).toHaveLength(0);
    expect(tx.artifactActivityEvent.createMany).not.toHaveBeenCalled();
  });

  it("retains nothing for a candidate a quarantine anchor already holds", async () => {
    const { tx, retained } = persistenceTx();

    const result = await persistMonitoredSessionActivity(tx as never, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      artifactRefs: [
        pullRequestRef({ ...EVENT, occurredAt: "2026-08-14T13:00:00.000Z" }),
      ],
      pullRequestLane: {
        details: RESOLVED_PR_DETAILS,
        deferrals: NO_PR_LANE_DEFERRALS,
      },
      repositoryIdentity: OBSERVED_ONLY_REPOSITORY,
      receivedAt: RECEIVED_AT,
    });

    expect(result.futureRejectedCount).toBe(1);
    expect(
      tx.monitoredSessionActivityQuarantine.createMany
    ).toHaveBeenCalledTimes(1);
    expect(retained()).toHaveLength(0);
  });

  it("fails the delivery when a candidate reaches the end of the pipeline unaccounted", async () => {
    const { tx, retained } = unresolvableTx();
    // The store silently keeps nothing. The guard reads what the DATABASE
    // holds, so this is the shape a dropped candidate actually has.
    tx.artifactActivityEvent.createMany.mockResolvedValue({ count: 0 });

    await expect(
      persistMonitoredSessionActivity(tx as never, {
        organizationId: ORGANIZATION_ID,
        sessionArtifactId: SESSION_ARTIFACT_ID,
        artifactRefs: [untrackedPullRequestRef()],
        pullRequestLane: {
          details: NO_PR_DETAILS,
          deferrals: UNTRACKED_HEADLESS_DEFERRALS,
        },
        repositoryIdentity: NO_IDENTITY_AT_ALL,
        receivedAt: RECEIVED_AT,
      })
    ).rejects.toThrow(
      `monitored session activity dropped for pull_request:${UNTRACKED_REPOSITORY}#${UNTRACKED_PR_NUMBER}`
    );
    expect(retained()).toHaveLength(0);
  });

  it("keys the retained row on the target, so two targets in one delivery both land", async () => {
    const { tx, retained } = unresolvableTx();

    await persistMonitoredSessionActivity(tx as never, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      artifactRefs: [
        untrackedPullRequestRef(),
        { ...pullRequestRef(), prNumber: PR_NUMBER },
      ],
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: headlessDeferrals(
          {
            repositoryFullName: UNTRACKED_REPOSITORY,
            prNumber: UNTRACKED_PR_NUMBER,
          },
          { repositoryFullName: REPOSITORY, prNumber: PR_NUMBER }
        ),
      },
      repositoryIdentity: NO_IDENTITY_FOR_EITHER,
      receivedAt: RECEIVED_AT,
    });

    // One fixture repository cannot tell a per-target key from a per-session
    // one, so the delivery names two.
    expect(
      retained()
        .map((row) => row.after.repositoryFullName)
        .sort()
    ).toEqual([REPOSITORY, UNTRACKED_REPOSITORY]);
    expect(new Set(retained().map((row) => row.id)).size).toBe(2);
  });
});
