import {
  MonitoredTargetDisposition,
  monitoredActivityTargetKey,
} from "@repo/api/src/types/monitored-activity-target";
import {
  ArtifactRefTargetKind,
  PR_INT_MAX,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import {
  AUTHORITATIVE_REPOSITORY,
  EVENT,
  laneDeferrals,
  NO_PR_LANE_DEFERRALS,
  NO_REPOSITORY_AUTHORITY,
  ORGANIZATION_ID,
  observedOnlyAlongside,
  PR_NUMBER,
  probedAlongside,
  REPOSITORY,
  REPOSITORY_ID,
  repositoryAuthority,
  UNPROBED_REPOSITORY,
} from "@/__tests__/support/agent-sessions/monitored-session-activity.test-fixtures";
import { PullRequestLaneDeferral } from "@/app/agent-sessions/service/artifact-links/pull-request-lane-deferral";
import type { SessionRepositoryIdentityProbe } from "@/app/agent-sessions/service/artifact-links/shared";
import {
  emptyMonitoredActivityOutcomeCounts,
  MonitoredActivityOutcome,
  monitoredActivityCandidateCount,
} from "@/app/agent-sessions/service/monitored-session-activity-persistence";
import {
  type MonitoredActivityCandidate,
  monitoredActivityCandidateIdentity,
} from "@/app/agent-sessions/service/monitored-session-activity-shared";
import {
  classifyMonitoredActivityTargets,
  partitionUnresolvedMonitoredCandidates,
} from "@/app/agent-sessions/service/monitored-session-transport-resolution";

/** The repository named in ISS-9181's production incident: upstream OSS. */
const OUT_OF_SCOPE_REPOSITORY = "prisma/prisma-engines";

/**
 * ISS-11427: no candidate here has held past the ceiling, so these cases still
 * measure the CLASSIFIER's answer rather than the wall-clock bound. The expiry
 * arm has its own cases in `monitored-activity-hold-ceiling.test.ts`.
 */
const NO_EXPIRED_HOLDS: ReadonlySet<string> = new Set();

/** Read for in the same delivery, and no source had an identity for it. */
const UNREACHABLE_REPOSITORY = "vercel/next.js";

function observedOnlyBesideUnreachable(): SessionRepositoryIdentityProbe {
  const probe = observedOnlyAlongside(OUT_OF_SCOPE_REPOSITORY);
  return {
    authorities: probe.authorities,
    probedNames: new Set([...probe.probedNames, UNREACHABLE_REPOSITORY]),
  };
}

describe("classifyMonitoredActivityTargets", () => {
  it("ignores out-of-range PR targets before provider lookups", async () => {
    const tx = {
      pullRequestDetail: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    const candidate = {
      target: {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: REPOSITORY,
        prNumber: PR_INT_MAX + 1,
      },
      event: EVENT,
      transportOnly: true,
    } satisfies MonitoredActivityCandidate;

    const dispositions = await classifyMonitoredActivityTargets(
      tx as never,
      [candidate],
      new Map(),
      {
        organizationId: ORGANIZATION_ID,
        repositoryIdentity: AUTHORITATIVE_REPOSITORY,
        pullRequestLaneDeferrals: NO_PR_LANE_DEFERRALS,
      }
    );

    expect(dispositions).toEqual(new Map());
    expect(tx.pullRequestDetail.findMany).not.toHaveBeenCalled();
  });

  // ISS-9181: every row here is a TRUSTED candidate (`transportOnly: false`).
  // Before this change the classifier selected `candidate.transportOnly` and
  // returned an empty map for all of them, so each row also pins the widening.
  it.each([
    {
      name: "repository the organization holds no identity for",
      target: {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: REPOSITORY,
        prNumber: PR_NUMBER,
      } as const,
      repositoryIdentity: NO_REPOSITORY_AUTHORITY,
      existingPullRequests: [],
      expected: MonitoredTargetDisposition.RepositoryOutOfScope,
    },
    {
      name: "conflicting repository identity",
      target: {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: REPOSITORY,
        prNumber: PR_NUMBER,
      } as const,
      repositoryIdentity: repositoryAuthority({
        repositoryId: REPOSITORY_ID,
        identityConflict: true,
      }),
      existingPullRequests: [],
      expected: MonitoredTargetDisposition.AuthorityConflict,
    },
    {
      name: "already-materialized pull request identity",
      target: {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: REPOSITORY,
        prNumber: PR_NUMBER,
      } as const,
      repositoryIdentity: AUTHORITATIVE_REPOSITORY,
      existingPullRequests: [
        { repositoryFullName: REPOSITORY, number: PR_NUMBER },
      ],
      expected: MonitoredTargetDisposition.ProviderIdentityAmbiguous,
    },
    {
      name: "provider-authoritative absent pull request",
      target: {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: REPOSITORY,
        prNumber: PR_NUMBER,
      } as const,
      repositoryIdentity: repositoryAuthority({
        providerRepositoryId: "provider-repository-1",
      }),
      existingPullRequests: [
        { repositoryFullName: REPOSITORY, number: PR_NUMBER + 1 },
        { repositoryFullName: "closedloop-ai/other", number: PR_NUMBER },
      ],
      expected: MonitoredTargetDisposition.IntentionallyAbsent,
    },
    {
      // An entry carrying no id and no conflict. `resolveSessionRepositoryIdentity` cannot
      // produce one (proved in `artifact-links/shared.test.ts`), so this row
      // pins the predicate's answer for a shape only a hand-built map has.
      name: "authority entry carrying no identity of any kind",
      target: {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: REPOSITORY,
        prNumber: PR_NUMBER,
      } as const,
      repositoryIdentity: repositoryAuthority({}),
      existingPullRequests: [],
      expected: MonitoredTargetDisposition.RepositoryOutOfScope,
    },
    {
      name: "repository default branch",
      target: {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: REPOSITORY,
        branchName: "main",
      } as const,
      repositoryIdentity: repositoryAuthority({
        repositoryId: REPOSITORY_ID,
        defaultBranch: "main",
      }),
      existingPullRequests: [],
      expected: MonitoredTargetDisposition.IntentionallyAbsent,
    },
    {
      name: "non-default branch",
      target: {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: REPOSITORY,
        branchName: "feat/not-materialized",
      } as const,
      repositoryIdentity: repositoryAuthority({
        repositoryId: REPOSITORY_ID,
        defaultBranch: "main",
      }),
      existingPullRequests: [],
      expected: MonitoredTargetDisposition.TargetNotMaterialized,
    },
  ])(
    "returns the exact disposition for a trusted candidate on a $name",
    async (testCase) => {
      const tx = {
        pullRequestDetail: {
          findMany: vi.fn().mockResolvedValue(testCase.existingPullRequests),
        },
      };
      const candidate = {
        target: testCase.target,
        event: EVENT,
        transportOnly: false,
      } satisfies MonitoredActivityCandidate;

      const dispositions = await classifyMonitoredActivityTargets(
        tx as never,
        [candidate],
        new Map(),
        {
          organizationId: ORGANIZATION_ID,
          repositoryIdentity: testCase.repositoryIdentity,
          pullRequestLaneDeferrals: NO_PR_LANE_DEFERRALS,
        }
      );

      expect(dispositions).toEqual(
        new Map([
          [monitoredActivityTargetKey(testCase.target), testCase.expected],
        ])
      );
      if (testCase.target.kind === ArtifactRefTargetKind.PullRequest) {
        // Pin the count first: a matching scoped call says nothing about a second,
        // unscoped fallback lookup being added beside it (whitlockk, #5654). The count
        // also keeps the per-call scope assertion below from passing vacuously.
        expect(tx.pullRequestDetail.findMany).toHaveBeenCalledTimes(1);
        expect(tx.pullRequestDetail.findMany).toHaveBeenCalledWith({
          where: {
            organizationId: ORGANIZATION_ID,
            OR: [
              {
                repositoryFullName: testCase.target.repositoryFullName,
                number: testCase.target.prNumber,
              },
            ],
          },
          select: { repositoryFullName: true, number: true },
        });
        for (const [{ where }] of tx.pullRequestDetail.findMany.mock.calls) {
          expect(where.organizationId).toBe(ORGANIZATION_ID);
        }
      } else {
        expect(tx.pullRequestDetail.findMany).not.toHaveBeenCalled();
      }
    }
  );

  it("classifies transport-only and trusted candidates by the same rule", async () => {
    const tx = {
      pullRequestDetail: { findMany: vi.fn().mockResolvedValue([]) },
    };
    // Distinct targets, so a classifier that still selected one kind of
    // candidate would leave the other's key out of the map entirely.
    const transportOnlyTarget = {
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: REPOSITORY,
      prNumber: PR_NUMBER,
    } as const;
    const trustedTarget = {
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: REPOSITORY,
      prNumber: PR_NUMBER + 1,
    } as const;

    const dispositions = await classifyMonitoredActivityTargets(
      tx as never,
      [
        { target: transportOnlyTarget, event: EVENT, transportOnly: true },
        { target: trustedTarget, event: EVENT, transportOnly: false },
      ],
      new Map(),
      {
        organizationId: ORGANIZATION_ID,
        repositoryIdentity: NO_REPOSITORY_AUTHORITY,
        pullRequestLaneDeferrals: NO_PR_LANE_DEFERRALS,
      }
    );

    expect(dispositions).toEqual(
      new Map([
        [
          monitoredActivityTargetKey(transportOnlyTarget),
          MonitoredTargetDisposition.RepositoryOutOfScope,
        ],
        [
          monitoredActivityTargetKey(trustedTarget),
          MonitoredTargetDisposition.RepositoryOutOfScope,
        ],
      ])
    );
  });

  /**
   * ISS-9181 code review: a missing `PullRequestDetail` row was read as the
   * provider denying the PR, but the probe only reads the server's own table.
   * The PR lane runs earlier in the SAME transaction and DEFERS on ordinary
   * paths, recording the ref for a later delivery without writing a row.
   * Acknowledging on that discards evidence the very next sync would land.
   */
  it("holds a pull request the PR lane deferred and has not written yet", async () => {
    const tx = {
      pullRequestDetail: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const target = {
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: REPOSITORY,
      prNumber: PR_NUMBER,
    } as const;

    const dispositions = await classifyMonitoredActivityTargets(
      tx as never,
      [{ target, event: EVENT, transportOnly: false }],
      new Map(),
      {
        organizationId: ORGANIZATION_ID,
        repositoryIdentity: AUTHORITATIVE_REPOSITORY,
        pullRequestLaneDeferrals: laneDeferrals({
          repositoryFullName: REPOSITORY,
          prNumber: PR_NUMBER,
          deferral: PullRequestLaneDeferral.AwaitingDesktopDelivery,
        }),
      }
    );

    expect(dispositions.get(monitoredActivityTargetKey(target))).toBe(
      MonitoredTargetDisposition.TargetNotMaterialized
    );
    // Nothing an existence row could settle, so the org-wide lookup that has no
    // covering index never runs inside the sync write transaction for it.
    expect(tx.pullRequestDetail.findMany).not.toHaveBeenCalled();
  });

  /**
   * PLN-2061 M1's load-bearing change, on ISS-10628's production shape:
   * `prisma/prisma-engines` resolves to a verified `github_observed_repository`
   * row and nothing else, so identity is `Held` while the organization has no
   * installation and no means of reading the repository. The PR lane claimed
   * that target anyway and the classifier returned `TargetNotMaterialized` — a
   * deferral premised on a later delivery landing the row, which no delivery
   * can do, so the Session's acknowledgement was held on an event nobody had
   * scheduled. A lane that cannot materialize a target must not claim it.
   *
   * Both repositories ride the SAME delivery, so the gate has to answer per
   * repository: a change that stopped the lane claiming anything at all would
   * take the installed target down with it and fail on the first assertion.
   *
   * Both targets come back `AwaitingRepositoryRead`, which is what makes this
   * the deferral the gate is about — the lane tried to materialize the branch
   * and could not. The self-converging shape is the case below, not this one.
   */
  it("claims a target the PR lane can materialize and drops the one it cannot", async () => {
    const tx = {
      pullRequestDetail: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const installedTarget = {
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: REPOSITORY,
      prNumber: PR_NUMBER,
    } as const;
    const observedOnlyTarget = {
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: OUT_OF_SCOPE_REPOSITORY,
      prNumber: 5860,
    } as const;

    const dispositions = await classifyMonitoredActivityTargets(
      tx as never,
      [
        { target: installedTarget, event: EVENT, transportOnly: false },
        { target: observedOnlyTarget, event: EVENT, transportOnly: false },
      ],
      new Map(),
      {
        organizationId: ORGANIZATION_ID,
        repositoryIdentity: observedOnlyAlongside(OUT_OF_SCOPE_REPOSITORY),
        // The lane ran over each identity and wrote neither row, having
        // attempted the head branch on both.
        pullRequestLaneDeferrals: laneDeferrals(
          ...[installedTarget, observedOnlyTarget].map((target) => ({
            repositoryFullName: target.repositoryFullName,
            prNumber: target.prNumber,
            deferral: PullRequestLaneDeferral.AwaitingRepositoryRead,
          }))
        ),
      }
    );

    expect(dispositions.get(monitoredActivityTargetKey(installedTarget))).toBe(
      MonitoredTargetDisposition.TargetNotMaterialized
    );
    expect(
      dispositions.get(monitoredActivityTargetKey(observedOnlyTarget))
    ).toBe(MonitoredTargetDisposition.RepositoryUnfetchable);

    // The existence read is where the gate becomes observable: a lane-owned
    // target is excluded from it, so before this change it ran for NEITHER
    // target and the observed-only one could only come back deferred.
    expect(tx.pullRequestDetail.findMany).toHaveBeenCalledTimes(1);
    expect(tx.pullRequestDetail.findMany.mock.calls[0][0].where.OR).toEqual([
      { repositoryFullName: OUT_OF_SCOPE_REPOSITORY, number: 5860 },
    ]);
  });

  /**
   * The counterfactual for the gate above, on the SAME unfetchable repository:
   * only the lane's deferral differs. A deferral the desktop converges by
   * itself — a ref with no head branch name, which the lane recorded before it
   * looked at repository authority at all — leaves the question to the next
   * delivery, so the lane still owns this target and acknowledging it would
   * discard evidence the desktop never resends.
   *
   * A gate that read the repository alone would answer `RepositoryUnfetchable`
   * here and leave the existence read to decide it, which is what both
   * assertions below refuse.
   */
  it("keeps claiming a self-converging deferral on a repository it cannot fetch", async () => {
    const tx = {
      pullRequestDetail: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const observedOnlyTarget = {
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: OUT_OF_SCOPE_REPOSITORY,
      prNumber: 5860,
    } as const;

    const dispositions = await classifyMonitoredActivityTargets(
      tx as never,
      [{ target: observedOnlyTarget, event: EVENT, transportOnly: false }],
      new Map(),
      {
        organizationId: ORGANIZATION_ID,
        repositoryIdentity: observedOnlyAlongside(OUT_OF_SCOPE_REPOSITORY),
        pullRequestLaneDeferrals: laneDeferrals({
          repositoryFullName: OUT_OF_SCOPE_REPOSITORY,
          prNumber: 5860,
          deferral: PullRequestLaneDeferral.AwaitingDesktopDelivery,
        }),
      }
    );

    expect(
      dispositions.get(monitoredActivityTargetKey(observedOnlyTarget))
    ).toBe(MonitoredTargetDisposition.TargetNotMaterialized);
    expect(tx.pullRequestDetail.findMany).not.toHaveBeenCalled();
  });

  /**
   * Two targets on ONE unfetchable repository whose LANE REPORTS DISAGREE.
   * The classifier decides per target and never per delivery, so 5860 goes to
   * the existence read while 5861 stays claimed and out of it.
   *
   * This is the per-target half of what used to be one case here spanning the
   * classifier AND the lane's ref aggregation. The aggregation is no longer
   * this function's to do, so its half now lives with the lane in
   * `pull-request-details.branches.test.ts`.
   */
  it("decides the fetch-authority gate per target, not per delivery", async () => {
    const tx = {
      pullRequestDetail: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const awaitingReadTarget = {
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: OUT_OF_SCOPE_REPOSITORY,
      prNumber: 5860,
    } as const;
    const selfConvergingTarget = {
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: OUT_OF_SCOPE_REPOSITORY,
      prNumber: 5861,
    } as const;

    const dispositions = await classifyMonitoredActivityTargets(
      tx as never,
      [
        { target: awaitingReadTarget, event: EVENT, transportOnly: false },
        { target: selfConvergingTarget, event: EVENT, transportOnly: false },
      ],
      new Map(),
      {
        organizationId: ORGANIZATION_ID,
        repositoryIdentity: observedOnlyAlongside(OUT_OF_SCOPE_REPOSITORY),
        pullRequestLaneDeferrals: laneDeferrals(
          {
            repositoryFullName: OUT_OF_SCOPE_REPOSITORY,
            prNumber: 5860,
            deferral: PullRequestLaneDeferral.AwaitingRepositoryRead,
          },
          {
            repositoryFullName: OUT_OF_SCOPE_REPOSITORY,
            prNumber: 5861,
            deferral: PullRequestLaneDeferral.AwaitingDesktopDelivery,
          }
        ),
      }
    );

    expect(
      dispositions.get(monitoredActivityTargetKey(awaitingReadTarget))
    ).toBe(MonitoredTargetDisposition.RepositoryUnfetchable);
    expect(
      dispositions.get(monitoredActivityTargetKey(selfConvergingTarget))
    ).toBe(MonitoredTargetDisposition.TargetNotMaterialized);
    expect(tx.pullRequestDetail.findMany).toHaveBeenCalledTimes(1);
    expect(tx.pullRequestDetail.findMany.mock.calls[0][0].where.OR).toEqual([
      { repositoryFullName: OUT_OF_SCOPE_REPOSITORY, number: 5860 },
    ]);
  });

  /**
   * The deferral the lane REPORTS, which this function takes as given rather
   * than re-deriving from the ref: `AwaitingDesktopDelivery` is the lane
   * declining a ref with no head branch name before it consulted repository
   * authority, so the question falls to a later delivery that carries one.
   * Dropping that key acknowledges the Session and discards monitored activity
   * the desktop never resends.
   *
   * Parameterized on the LANE'S REPORT because the deferral is the lane's to
   * decide and this function's only input about it. Which ref shapes produce
   * which deferral is pinned where the lane lives
   * (`pull-request-details.branches.test.ts`).
   *
   * Two keys, because a verdict given per DELIVERY rather than per target
   * would hold `vercel/next.js` on the self-converging row too. Every source
   * was read for that name and none had it, so it is terminal whichever
   * deferral the lane reports, and only the observed-only key's disposition
   * may move between the two rows.
   */
  it.each([
    {
      name: "a deferral the desktop converges by itself",
      deferral: PullRequestLaneDeferral.AwaitingDesktopDelivery,
      expectedObservedOnly: MonitoredTargetDisposition.TargetNotMaterialized,
      expectedExistenceRead: [],
    },
    {
      name: "a deferral waiting on a repository read",
      deferral: PullRequestLaneDeferral.AwaitingRepositoryRead,
      expectedObservedOnly: MonitoredTargetDisposition.RepositoryUnfetchable,
      expectedExistenceRead: [
        { repositoryFullName: OUT_OF_SCOPE_REPOSITORY, number: 5860 },
        { repositoryFullName: UNREACHABLE_REPOSITORY, number: 5862 },
      ],
    },
  ])("applies the fetch-authority gate only to $name", async (testCase) => {
    const tx = {
      pullRequestDetail: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const observedOnlyTarget = {
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: OUT_OF_SCOPE_REPOSITORY,
      prNumber: 5860,
    } as const;
    const unreachableTarget = {
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: UNREACHABLE_REPOSITORY,
      prNumber: 5862,
    } as const;

    const dispositions = await classifyMonitoredActivityTargets(
      tx as never,
      [
        { target: observedOnlyTarget, event: EVENT, transportOnly: false },
        { target: unreachableTarget, event: EVENT, transportOnly: false },
      ],
      new Map(),
      {
        organizationId: ORGANIZATION_ID,
        repositoryIdentity: observedOnlyBesideUnreachable(),
        pullRequestLaneDeferrals: laneDeferrals(
          ...[observedOnlyTarget, unreachableTarget].map((target) => ({
            repositoryFullName: target.repositoryFullName,
            prNumber: target.prNumber,
            deferral: testCase.deferral,
          }))
        ),
      }
    );

    expect(
      dispositions.get(monitoredActivityTargetKey(observedOnlyTarget))
    ).toBe(testCase.expectedObservedOnly);
    expect(
      dispositions.get(monitoredActivityTargetKey(unreachableTarget))
    ).toBe(MonitoredTargetDisposition.RepositoryOutOfScope);

    if (testCase.expectedExistenceRead.length === 0) {
      // Both keys stayed lane-owned, so nothing was left for the existence
      // read to answer and it never ran.
      expect(tx.pullRequestDetail.findMany).not.toHaveBeenCalled();
      return;
    }
    expect(tx.pullRequestDetail.findMany).toHaveBeenCalledTimes(1);
    expect(tx.pullRequestDetail.findMany.mock.calls[0][0].where.OR).toEqual(
      testCase.expectedExistenceRead
    );
  });

  it("holds a target on a repository no read covered", async () => {
    // "Every source was read and none had it" is what authorizes the ack. A
    // name nobody looked up is a different fact and must not borrow the answer.
    const tx = {
      pullRequestDetail: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const target = {
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: REPOSITORY,
      prNumber: PR_NUMBER,
    } as const;

    const dispositions = await classifyMonitoredActivityTargets(
      tx as never,
      [{ target, event: EVENT, transportOnly: false }],
      new Map(),
      {
        organizationId: ORGANIZATION_ID,
        repositoryIdentity: UNPROBED_REPOSITORY,
        pullRequestLaneDeferrals: NO_PR_LANE_DEFERRALS,
      }
    );

    expect(dispositions.get(monitoredActivityTargetKey(target))).toBe(
      MonitoredTargetDisposition.RepositoryIdentityUnknown
    );
  });

  it("classifies the reported upstream-OSS target as out of scope, not retry-owned", async () => {
    // ISS-9181's production shape: a PR on a repository the organization holds
    // no installation and no Repository row for. Held forever before this
    // change, which dead-lettered two already-persisted Sessions on repeat.
    const tx = {
      pullRequestDetail: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const target = {
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: OUT_OF_SCOPE_REPOSITORY,
      prNumber: 5860,
    } as const;

    const dispositions = await classifyMonitoredActivityTargets(
      tx as never,
      [{ target, event: EVENT, transportOnly: false }],
      new Map(),
      {
        organizationId: ORGANIZATION_ID,
        // The org's OWN fork resolves normally; the upstream repo was read for
        // and had no identity in any source.
        repositoryIdentity: probedAlongside(OUT_OF_SCOPE_REPOSITORY),
        pullRequestLaneDeferrals: NO_PR_LANE_DEFERRALS,
      }
    );

    expect(dispositions.get(monitoredActivityTargetKey(target))).toBe(
      MonitoredTargetDisposition.RepositoryOutOfScope
    );
  });

  it("issues one bounded statement for many unresolved pull-request targets", async () => {
    const tx = {
      pullRequestDetail: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const candidates = Array.from({ length: 25 }, (_, index) => ({
      target: {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: REPOSITORY,
        prNumber: PR_NUMBER + index,
      },
      event: EVENT,
      transportOnly: false,
    })) satisfies MonitoredActivityCandidate[];

    await classifyMonitoredActivityTargets(tx as never, candidates, new Map(), {
      organizationId: ORGANIZATION_ID,
      repositoryIdentity: AUTHORITATIVE_REPOSITORY,
      pullRequestLaneDeferrals: NO_PR_LANE_DEFERRALS,
    });

    // The widened set runs inside the sync write transaction, under a p95
    // latency budget: one statement over the whole set, never one per target.
    expect(tx.pullRequestDetail.findMany).toHaveBeenCalledTimes(1);
    expect(
      tx.pullRequestDetail.findMany.mock.calls[0][0].where.OR
    ).toHaveLength(25);
  });
});

describe("partitionUnresolvedMonitoredCandidates", () => {
  function candidateFor(prNumber: number): MonitoredActivityCandidate {
    return {
      target: {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: REPOSITORY,
        prNumber,
      },
      event: EVENT,
      transportOnly: false,
    };
  }

  // ISS-9182 gave every disposition its own outcome, the four held ones
  // included, so each row below drives one session through the partition and
  // names the field it must land in. Comparing the WHOLE record is the "and no
  // sibling's" half: a row fails if any other field moved. Before this the
  // four held rows shared one lump, and a case asserting only the total passed
  // whichever of them the classifier had actually returned.
  it.each([
    {
      disposition: MonitoredTargetDisposition.IntentionallyAbsent,
      retryOwnedCount: 0,
      outcome: MonitoredActivityOutcome.TargetIntentionallyAbsent,
    },
    {
      disposition: MonitoredTargetDisposition.RepositoryUnfetchable,
      retryOwnedCount: 0,
      outcome: MonitoredActivityOutcome.TargetRepositoryUnfetchable,
    },
    {
      disposition: MonitoredTargetDisposition.RepositoryOutOfScope,
      retryOwnedCount: 0,
      outcome: MonitoredActivityOutcome.TargetRepositoryOutOfScope,
    },
    {
      disposition: MonitoredTargetDisposition.RepositoryIdentityUnknown,
      retryOwnedCount: 1,
      outcome: MonitoredActivityOutcome.TargetRepositoryIdentityUnknown,
    },
    {
      disposition: MonitoredTargetDisposition.AuthorityConflict,
      retryOwnedCount: 1,
      outcome: MonitoredActivityOutcome.TargetAuthorityConflict,
    },
    {
      disposition: MonitoredTargetDisposition.ProviderIdentityAmbiguous,
      retryOwnedCount: 1,
      outcome: MonitoredActivityOutcome.TargetProviderIdentityAmbiguous,
    },
    {
      disposition: MonitoredTargetDisposition.TargetNotMaterialized,
      retryOwnedCount: 1,
      outcome: MonitoredActivityOutcome.TargetNotMaterialized,
    },
  ])(
    "counts $disposition under its own outcome and no other",
    ({ disposition, retryOwnedCount, outcome }) => {
      const candidate = candidateFor(PR_NUMBER);

      const partition = partitionUnresolvedMonitoredCandidates(
        [candidate],
        new Map([[monitoredActivityTargetKey(candidate.target), disposition]]),
        NO_EXPIRED_HOLDS,
        NO_EXPIRED_HOLDS
      );

      expect(partition.retryOwnedCount).toBe(retryOwnedCount);
      expect(partition.outcomeCounts).toEqual({
        ...emptyMonitoredActivityOutcomeCounts(),
        [outcome]: 1,
      });
    }
  );

  it("holds a candidate the classifier returned no disposition for", () => {
    // Acknowledging on an unanswered question is the evidence loss this
    // partition exists to prevent, so an absent disposition is not an ack.
    // It is also the one held shape with no outcome of its own, which is why
    // the four per-disposition counters can sum to less than the total.
    const partition = partitionUnresolvedMonitoredCandidates(
      [candidateFor(PR_NUMBER)],
      new Map(),
      NO_EXPIRED_HOLDS,
      NO_EXPIRED_HOLDS
    );

    expect(partition.retryOwnedCount).toBe(1);
    expect(partition.outcomeCounts).toEqual(
      emptyMonitoredActivityOutcomeCounts()
    );
  });

  it("counts new ceiling expiries apart from one an earlier delivery already settled", () => {
    // Two new and one previous, so dropping or inverting the guard both change
    // the count (3 and 1) rather than landing on the expected 2 by symmetry.
    const previous = candidateFor(PR_NUMBER);
    const fresh = [candidateFor(PR_NUMBER + 1), candidateFor(PR_NUMBER + 2)];
    const all = [previous, ...fresh];

    const partition = partitionUnresolvedMonitoredCandidates(
      all,
      new Map(
        all.map((candidate) => [
          monitoredActivityTargetKey(candidate.target),
          MonitoredTargetDisposition.TargetNotMaterialized,
        ])
      ),
      new Set(all.map(monitoredActivityCandidateIdentity)),
      new Set([monitoredActivityCandidateIdentity(previous)])
    );

    expect(partition.retryOwnedCount).toBe(0);
    expect(
      partition.outcomeCounts[MonitoredActivityOutcome.TargetHoldExpired]
    ).toBe(fresh.length);
    // #8737 review: the settled candidate stays in the candidate total.
    expect(
      partition.outcomeCounts[MonitoredActivityOutcome.TargetHoldSettled]
    ).toBe(1);
    expect(monitoredActivityCandidateCount(partition.outcomeCounts)).toBe(
      all.length
    );
  });

  it("tallies a mixed set per candidate rather than per target kind", () => {
    const acknowledged = candidateFor(PR_NUMBER);
    const held = candidateFor(PR_NUMBER + 1);

    const partition = partitionUnresolvedMonitoredCandidates(
      [acknowledged, held],
      new Map([
        [
          monitoredActivityTargetKey(acknowledged.target),
          MonitoredTargetDisposition.RepositoryOutOfScope,
        ],
        [
          monitoredActivityTargetKey(held.target),
          MonitoredTargetDisposition.TargetNotMaterialized,
        ],
      ]),
      NO_EXPIRED_HOLDS,
      NO_EXPIRED_HOLDS
    );

    expect(partition.retryOwnedCount).toBe(1);
    expect(partition.outcomeCounts).toEqual({
      ...emptyMonitoredActivityOutcomeCounts(),
      [MonitoredActivityOutcome.TargetRepositoryOutOfScope]: 1,
      [MonitoredActivityOutcome.TargetNotMaterialized]: 1,
    });
  });
});
