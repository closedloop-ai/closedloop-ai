import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import { MonitoredTargetDisposition } from "@repo/api/src/types/monitored-activity-target";
import {
  ArtifactRefMethod,
  PR_INT_MAX,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it } from "vitest";
import {
  AUTHORITATIVE_REPOSITORY,
  BRANCH_ARTIFACT_ID,
  branchRef,
  EVENT,
  laneDeferrals,
  NO_PR_DETAILS,
  NO_PR_LANE_DEFERRALS,
  NO_REPOSITORY_AUTHORITY,
  ORGANIZATION_ID,
  onlyOutcome,
  PR_NUMBER,
  PULL_REQUEST_ID,
  persistenceTx,
  pullRequestRef,
  REPOSITORY,
  REPOSITORY_ID,
  RESOLVED_PR_DETAILS,
  repositoryAuthority,
  SESSION_ARTIFACT_ID,
  UNPROBED_REPOSITORY,
  WITHIN_HOLD_CEILING,
} from "@/__tests__/support/agent-sessions/monitored-session-activity.test-fixtures";
import { RepositoryIdentitySource } from "./artifact-links/authority-source-queries";
import { PullRequestLaneDeferral } from "./artifact-links/pull-request-lane-deferral";
import { persistMonitoredSessionActivity } from "./monitored-session-activity";
import {
  emptyMonitoredActivityOutcomeCounts,
  MonitoredActivityOutcome,
} from "./monitored-session-activity-persistence";
import { bindParameterChunkSize } from "./write-chunking";

const MONITORED_SOURCE_EVENT_ID_PATTERN = /^monitored_session_v2:[0-9a-f]{64}$/;
/** The retired per-session cap (ISS-9860); a payload past it used to be cut. */
const RETIRED_PER_SESSION_CAP = 100;
/** The Branch target lookup's width: two binds per target beside the org bind. */
const BRANCH_TARGET_LOOKUP_CHUNK = bindParameterChunkSize(2, 1);
/** The residual PR lookup's width: up to four binds per target beside the org. */
const RESIDUAL_PULL_REQUEST_LOOKUP_CHUNK = bindParameterChunkSize(4, 1);

/**
 * What the PR lane reports for a bare `pullRequestRef()`: provider-verifiable
 * and carrying no head branch name, so the lane recorded it before consulting
 * repository authority and the next delivery writes the row. Stated, never
 * derived from `artifactRefs` — a fixture that re-derived the lane's verdict
 * could not catch the two disagreeing.
 */
const HEADLESS_PR_DEFERRALS = laneDeferrals({
  repositoryFullName: REPOSITORY,
  prNumber: PR_NUMBER,
  deferral: PullRequestLaneDeferral.AwaitingDesktopDelivery,
});

/**
 * A HELD candidate's counts. ISS-9182 gave each held disposition its own
 * outcome under an unchanged `TargetRetryRequired` total, so exactly two are
 * non-zero — and naming which disposition held is the thing that used to take
 * a production database query.
 */
function heldOutcome(
  outcome: MonitoredActivityOutcome,
  count: number
): Record<MonitoredActivityOutcome, number> {
  return {
    ...emptyMonitoredActivityOutcomeCounts(),
    [MonitoredActivityOutcome.TargetRetryRequired]: count,
    [outcome]: count,
  };
}

describe("persistMonitoredSessionActivity", () => {
  it("drops out-of-range PR activity before residual target lookups", async () => {
    const { tx } = persistenceTx();

    const result = await persistMonitoredSessionActivity(tx as never, {
      receivedAt: WITHIN_HOLD_CEILING,
      pullRequestLane: {
        details: NO_PR_DETAILS,
        // Out of range, so the lane's own `isValidPullRequestNumber` filter
        // dropped the ref before it ran over anything.
        deferrals: NO_PR_LANE_DEFERRALS,
      },
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
      artifactRefs: [{ ...pullRequestRef(), prNumber: PR_INT_MAX + 1 }],
      repositoryIdentity: AUTHORITATIVE_REPOSITORY,
    });

    expect(result).toMatchObject({ persistedCount: 0, retryRequired: false });
    expect(tx.pullRequestDetail.findMany).not.toHaveBeenCalled();
    expect(tx.branchActivityAtom.createMany).not.toHaveBeenCalled();
  });

  it.each([
    {
      disposition: MonitoredTargetDisposition.IntentionallyAbsent,
      artifactRefs: [
        { ...pullRequestRef(), monitoredActivityOnly: true as const },
      ],
      repositoryIdentity: AUTHORITATIVE_REPOSITORY,
      retryRequired: false,
      outcomeCounts: onlyOutcome(
        MonitoredActivityOutcome.TransportTargetSkipped,
        1
      ),
    },
    {
      disposition: MonitoredTargetDisposition.RepositoryOutOfScope,
      artifactRefs: [
        { ...pullRequestRef(), monitoredActivityOnly: true as const },
      ],
      repositoryIdentity: NO_REPOSITORY_AUTHORITY,
      retryRequired: false,
      outcomeCounts: onlyOutcome(
        MonitoredActivityOutcome.TargetRepositoryOutOfScope,
        1
      ),
    },
    {
      disposition: MonitoredTargetDisposition.RepositoryIdentityUnknown,
      artifactRefs: [
        { ...pullRequestRef(), monitoredActivityOnly: true as const },
      ],
      repositoryIdentity: UNPROBED_REPOSITORY,
      retryRequired: true,
      outcomeCounts: heldOutcome(
        MonitoredActivityOutcome.TargetRepositoryIdentityUnknown,
        1
      ),
    },
    {
      disposition: MonitoredTargetDisposition.AuthorityConflict,
      artifactRefs: [
        { ...pullRequestRef(), monitoredActivityOnly: true as const },
      ],
      repositoryIdentity: repositoryAuthority({
        repositoryId: REPOSITORY_ID,
        identityConflict: true,
      }),
      retryRequired: true,
      outcomeCounts: heldOutcome(
        MonitoredActivityOutcome.TargetAuthorityConflict,
        1
      ),
    },
    {
      disposition: MonitoredTargetDisposition.ProviderIdentityAmbiguous,
      artifactRefs: [
        { ...pullRequestRef(), monitoredActivityOnly: true as const },
      ],
      repositoryIdentity: AUTHORITATIVE_REPOSITORY,
      retryRequired: true,
      outcomeCounts: heldOutcome(
        MonitoredActivityOutcome.TargetProviderIdentityAmbiguous,
        1
      ),
    },
    {
      disposition: MonitoredTargetDisposition.TargetNotMaterialized,
      artifactRefs: [
        {
          ...branchRef("feat/not-materialized", EVENT),
          monitoredActivityOnly: true as const,
        },
      ],
      repositoryIdentity: AUTHORITATIVE_REPOSITORY,
      retryRequired: true,
      outcomeCounts: heldOutcome(
        MonitoredActivityOutcome.TargetNotMaterialized,
        1
      ),
    },
  ])(
    "acknowledges only the dispositions that cannot converge, for $disposition",
    async (testCase) => {
      const { tx } = persistenceTx();
      tx.branchDetail.findMany.mockResolvedValue([]);
      tx.pullRequestDetail.findMany.mockImplementation(({ select }) =>
        testCase.disposition ===
          MonitoredTargetDisposition.ProviderIdentityAmbiguous &&
        !("id" in select)
          ? [{ repositoryFullName: REPOSITORY, number: PR_NUMBER }]
          : []
      );

      const result = await persistMonitoredSessionActivity(tx as never, {
        pullRequestLane: {
          details: NO_PR_DETAILS,
          deferrals: NO_PR_LANE_DEFERRALS,
        },
        organizationId: ORGANIZATION_ID,
        sessionArtifactId: SESSION_ARTIFACT_ID,
        artifactRefs: testCase.artifactRefs,
        repositoryIdentity: testCase.repositoryIdentity,
        receivedAt: WITHIN_HOLD_CEILING,
      });

      // The full count map, not just the row's own outcome: an acknowledged
      // skip landing under two counters at once is the double-count this
      // partition is required not to do, and a held one must land under its
      // OWN disposition rather than only the shared total (ISS-9182).
      expect(result).toMatchObject({
        retryRequired: testCase.retryRequired,
        persistedCount: 0,
        outcomeCounts: testCase.outcomeCounts,
      });
      expect(tx.branchActivityAtom.createMany).not.toHaveBeenCalled();
    }
  );

  it("acknowledges absent transport-only PR and Branch targets with typed skips", async () => {
    const { tx } = persistenceTx();
    tx.branchDetail.findMany.mockResolvedValueOnce([]);
    tx.pullRequestDetail.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await persistMonitoredSessionActivity(tx as never, {
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: NO_PR_LANE_DEFERRALS,
      },
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
      artifactRefs: [
        { ...pullRequestRef(), monitoredActivityOnly: true as const },
        {
          ...branchRef("main", EVENT),
          monitoredActivityOnly: true as const,
        },
      ],
      repositoryIdentity: AUTHORITATIVE_REPOSITORY,
      receivedAt: WITHIN_HOLD_CEILING,
    });

    expect(result).toMatchObject({ retryRequired: false, persistedCount: 0 });
    expect(
      result.outcomeCounts[MonitoredActivityOutcome.TransportTargetSkipped]
    ).toBe(2);
    expect(tx.branchActivityAtom.createMany).not.toHaveBeenCalled();
  });

  it("keeps quarantine identity stable when retry completeness changes", async () => {
    const { tx } = persistenceTx();
    const futureEvent = {
      ...EVENT,
      occurredAt: "2026-08-14T13:00:00.000Z",
    };
    const input = {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
      artifactRefs: [pullRequestRef(futureEvent)],
      pullRequestLane: {
        details: RESOLVED_PR_DETAILS,
        deferrals: NO_PR_LANE_DEFERRALS,
      },
      repositoryIdentity: NO_REPOSITORY_AUTHORITY,
      receivedAt: new Date("2026-08-12T12:00:00.000Z"),
    };

    const first = await persistMonitoredSessionActivity(tx as never, input);
    const second = await persistMonitoredSessionActivity(tx as never, {
      ...input,
      artifactRefs: [
        pullRequestRef(
          {
            ...futureEvent,
            completeness: BranchActivityEvidenceCompleteness.Partial,
          },
          BranchActivityEvidenceCompleteness.Partial
        ),
      ],
    });

    expect(first.retryRequired).toBe(true);
    expect(second.retryRequired).toBe(true);
    expect(
      second.outcomeCounts[MonitoredActivityOutcome.FutureRetryRequired]
    ).toBe(1);
    expect(
      tx.monitoredSessionActivityQuarantine.createMany
    ).toHaveBeenCalledTimes(1);
    expect(tx.branchActivityAtom.createMany).not.toHaveBeenCalled();
  });

  it("resolves PR attribution in-org and replays one canonical atom idempotently", async () => {
    const { tx, stored } = persistenceTx();
    const input = {
      receivedAt: WITHIN_HOLD_CEILING,
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
      artifactRefs: [pullRequestRef(), pullRequestRef()],
      pullRequestLane: {
        details: RESOLVED_PR_DETAILS,
        deferrals: NO_PR_LANE_DEFERRALS,
      },
      repositoryIdentity: NO_REPOSITORY_AUTHORITY,
    };

    await persistMonitoredSessionActivity(tx as never, input);
    await persistMonitoredSessionActivity(tx as never, input);

    // The PR lane already resolved this row, so attribution issues no lookup of
    // its own — least of all the unindexed org-wide one (ISS-6450).
    for (const [{ where }] of tx.pullRequestDetail.findMany.mock.calls) {
      expect(where).toHaveProperty("id");
    }
    expect(tx.branchActivityAtom.createMany).toHaveBeenCalledTimes(1);
    expect(stored()).toMatchObject({
      organizationId: ORGANIZATION_ID,
      branchArtifactId: BRANCH_ARTIFACT_ID,
      source: "monitored_session",
      occurredAt: new Date(EVENT.occurredAt),
      attributionKind: "pull_request",
      pullRequestDetailId: PULL_REQUEST_ID,
      completeness: BranchActivityEvidenceCompleteness.Complete,
    });
    expect(stored()?.sourceEventId).toMatch(MONITORED_SOURCE_EVENT_ID_PATTERN);
  });

  it("rejects conflicting reuse of a target-local source identity before writing", async () => {
    const { tx } = persistenceTx();
    const conflicting = {
      ...EVENT,
      occurredAt: "2026-08-12T13:00:00.000Z",
    };

    await expect(
      persistMonitoredSessionActivity(tx as never, {
        receivedAt: WITHIN_HOLD_CEILING,
        pullRequestLane: {
          details: RESOLVED_PR_DETAILS,
          deferrals: NO_PR_LANE_DEFERRALS,
        },
        organizationId: ORGANIZATION_ID,
        sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
        artifactRefs: [pullRequestRef(), pullRequestRef(conflicting)],
        repositoryIdentity: NO_REPOSITORY_AUTHORITY,
      })
    ).rejects.toThrow("conflicting monitored activity carrier identity");
    expect(tx.branchActivityAtom.createMany).not.toHaveBeenCalled();
  });

  it("resolves an App-adopted residual PR on the (repositoryId, number) key", async () => {
    const { tx, stored } = persistenceTx();
    tx.pullRequestDetail.findMany.mockImplementationOnce(() => [
      {
        id: PULL_REQUEST_ID,
        branchArtifactId: BRANCH_ARTIFACT_ID,
        repositoryId: REPOSITORY_ID,
        repositoryFullName: REPOSITORY,
        number: PR_NUMBER,
      },
    ]);

    await persistMonitoredSessionActivity(tx as never, {
      receivedAt: WITHIN_HOLD_CEILING,
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: HEADLESS_PR_DEFERRALS,
      },
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
      artifactRefs: [pullRequestRef()],
      repositoryIdentity: {
        authorities: new Map([
          [
            REPOSITORY,
            {
              repositoryId: REPOSITORY_ID,
              authorities: [],
              identitySources: new Set([RepositoryIdentitySource.Installation]),
            },
          ],
        ]),
        probedNames: new Set([REPOSITORY]),
      },
    });

    expect(tx.pullRequestDetail.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORGANIZATION_ID,
          OR: [
            { repositoryId: REPOSITORY_ID, number: PR_NUMBER },
            {
              repositoryFullName: REPOSITORY,
              number: PR_NUMBER,
              repositoryId: null,
            },
          ],
        },
      })
    );
    expect(stored()).toMatchObject({
      branchArtifactId: BRANCH_ARTIFACT_ID,
      attributionKind: "pull_request",
      pullRequestDetailId: PULL_REQUEST_ID,
    });
  });

  it("scopes a repo-less residual PR to the partial index, with no unscoped second pass", async () => {
    const { tx, stored } = persistenceTx();
    tx.pullRequestDetail.findMany.mockImplementationOnce(() => [
      {
        id: PULL_REQUEST_ID,
        branchArtifactId: BRANCH_ARTIFACT_ID,
        repositoryId: null,
        repositoryFullName: REPOSITORY,
        number: PR_NUMBER,
      },
    ]);

    await persistMonitoredSessionActivity(tx as never, {
      receivedAt: WITHIN_HOLD_CEILING,
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: HEADLESS_PR_DEFERRALS,
      },
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
      artifactRefs: [pullRequestRef()],
      repositoryIdentity: NO_REPOSITORY_AUTHORITY,
    });

    const residualCalls = tx.pullRequestDetail.findMany.mock.calls.filter(
      ([{ where, select }]) => "OR" in where && "id" in select
    );
    expect(residualCalls).toHaveLength(1);
    expect(residualCalls[0][0].where.OR).toEqual([
      { repositoryFullName: REPOSITORY, number: PR_NUMBER, repositoryId: null },
    ]);
    expect(stored()).toMatchObject({
      pullRequestDetailId: PULL_REQUEST_ID,
      attributionKind: "pull_request",
    });
  });

  it("falls back to the unscoped identity only for a still-unresolved residual", async () => {
    const { tx, stored } = persistenceTx();
    tx.pullRequestDetail.findMany
      .mockImplementationOnce(() => [])
      .mockImplementationOnce(() => [
        {
          id: PULL_REQUEST_ID,
          branchArtifactId: BRANCH_ARTIFACT_ID,
          // Adopted by an install that is no longer ACTIVE, so neither
          // index-served arm above can reach it.
          repositoryId: "019ff900-0000-7000-8000-000000000007",
          repositoryFullName: REPOSITORY,
          number: PR_NUMBER,
        },
      ]);

    await persistMonitoredSessionActivity(tx as never, {
      receivedAt: WITHIN_HOLD_CEILING,
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: HEADLESS_PR_DEFERRALS,
      },
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
      artifactRefs: [pullRequestRef()],
      repositoryIdentity: NO_REPOSITORY_AUTHORITY,
    });

    const residualCalls = tx.pullRequestDetail.findMany.mock.calls.filter(
      ([{ where, select }]) => "OR" in where && "id" in select
    );
    expect(residualCalls).toHaveLength(2);
    expect(residualCalls[1][0].where.OR).toEqual([
      { repositoryFullName: REPOSITORY, number: PR_NUMBER },
    ]);
    expect(stored()).toMatchObject({ pullRequestDetailId: PULL_REQUEST_ID });
  });

  it("treats a conflicted repository identity as unresolved rather than keying on the retained id", async () => {
    const { tx } = persistenceTx();
    tx.pullRequestDetail.findMany.mockImplementationOnce(() => []);

    await expect(
      persistMonitoredSessionActivity(tx as never, {
        receivedAt: WITHIN_HOLD_CEILING,
        pullRequestLane: {
          details: NO_PR_DETAILS,
          deferrals: HEADLESS_PR_DEFERRALS,
        },
        organizationId: ORGANIZATION_ID,
        sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
        artifactRefs: [pullRequestRef()],
        // The reconciler keeps one of the ids that disagreed. Which one is
        // arbitrary, so it must not become the residual lookup's key.
        repositoryIdentity: {
          authorities: new Map([
            [
              REPOSITORY,
              {
                repositoryId: REPOSITORY_ID,
                identityConflict: true,
                authorities: [],
                // Cleared by both reconcilers on a conflict: two sources
                // disagreeing is not a source answering.
                identitySources: new Set<RepositoryIdentitySource>(),
              },
            ],
          ]),
          probedNames: new Set([REPOSITORY]),
        },
      })
    ).resolves.toMatchObject({
      retryRequired: true,
      outcomeCounts: {
        [MonitoredActivityOutcome.TargetRetryRequired]: 1,
      },
    });

    const residualCalls = tx.pullRequestDetail.findMany.mock.calls.filter(
      ([{ where, select }]) => "OR" in where && "id" in select
    );
    expect(residualCalls[0][0].where.OR).toEqual([
      { repositoryFullName: REPOSITORY, number: PR_NUMBER, repositoryId: null },
    ]);
  });

  it("does not fall back to the unscoped identity when the active repository is known", async () => {
    const { tx } = persistenceTx();
    tx.pullRequestDetail.findMany.mockImplementationOnce(() => []);

    await expect(
      persistMonitoredSessionActivity(tx as never, {
        receivedAt: WITHIN_HOLD_CEILING,
        pullRequestLane: {
          details: NO_PR_DETAILS,
          deferrals: HEADLESS_PR_DEFERRALS,
        },
        organizationId: ORGANIZATION_ID,
        sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
        artifactRefs: [pullRequestRef()],
        repositoryIdentity: {
          authorities: new Map([
            [
              REPOSITORY,
              {
                repositoryId: REPOSITORY_ID,
                authorities: [],
                identitySources: new Set([
                  RepositoryIdentitySource.Installation,
                ]),
              },
            ],
          ]),
          probedNames: new Set([REPOSITORY]),
        },
      })
    ).resolves.toMatchObject({
      // ISS-9181 code review: this ref reached the PR lane, which declines to
      // materialize a row for a ref with no head branch name (an older parse).
      // No row is that deferral, not the provider denying the PR, so the target
      // is held for the next delivery rather than acknowledged.
      retryRequired: true,
      outcomeCounts: heldOutcome(
        MonitoredActivityOutcome.TargetNotMaterialized,
        1
      ),
    });

    // Both indexed arms missed. A same-name row under a different repository
    // would be a historical row, so the unscoped second pass must not run.
    const residualCalls = tx.pullRequestDetail.findMany.mock.calls.filter(
      ([{ where, select }]) => "OR" in where && "id" in select
    );
    expect(residualCalls).toHaveLength(1);
  });

  it("acknowledges an absent PR the PR lane never owned", async () => {
    // The counterpart of the case above: a prose-derived PR ref is not
    // provider-verifiable, so `persistSessionPullRequestDetails` never runs over
    // it, nothing deferred it, and no later delivery of THIS payload writes the
    // row. The trusted half of the widening, and what keeps it from collapsing
    // back into the transport-only lane.
    const { tx } = persistenceTx();
    tx.pullRequestDetail.findMany.mockImplementationOnce(() => []);

    await expect(
      persistMonitoredSessionActivity(tx as never, {
        receivedAt: WITHIN_HOLD_CEILING,
        pullRequestLane: {
          details: NO_PR_DETAILS,
          // Prose-derived, so the lane never ran over this identity.
          deferrals: NO_PR_LANE_DEFERRALS,
        },
        organizationId: ORGANIZATION_ID,
        sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
        artifactRefs: [
          { ...pullRequestRef(), method: ArtifactRefMethod.PrMentionInProse },
        ],
        repositoryIdentity: {
          authorities: new Map([
            [
              REPOSITORY,
              {
                repositoryId: REPOSITORY_ID,
                authorities: [],
                identitySources: new Set([
                  RepositoryIdentitySource.Installation,
                ]),
              },
            ],
          ]),
          probedNames: new Set([REPOSITORY]),
        },
      })
    ).resolves.toMatchObject({
      retryRequired: false,
      outcomeCounts: onlyOutcome(
        MonitoredActivityOutcome.TargetIntentionallyAbsent,
        1
      ),
    });
  });

  it("leaves a residual PR unresolved when several adopted rows share its identity", async () => {
    const { tx } = persistenceTx();
    tx.pullRequestDetail.findMany
      .mockImplementationOnce(() => [])
      .mockImplementationOnce(() => [
        {
          id: PULL_REQUEST_ID,
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "019ff900-0000-7000-8000-000000000007",
          repositoryFullName: REPOSITORY,
          number: PR_NUMBER,
        },
        {
          id: "019ff900-0000-7000-8000-000000000008",
          branchArtifactId: "019ff900-0000-7000-8000-000000000009",
          repositoryId: "019ff900-0000-7000-8000-00000000000a",
          repositoryFullName: REPOSITORY,
          number: PR_NUMBER,
        },
      ])
      // Same rows through the classifier's existence read, which is what makes
      // the ambiguity retry-owned rather than a provider-authoritative absence.
      .mockImplementationOnce(() => [
        { repositoryFullName: REPOSITORY, number: PR_NUMBER },
      ]);

    // An unordered pick between the two would put this source event on a
    // different branch from one retry to the next.
    await expect(
      persistMonitoredSessionActivity(tx as never, {
        receivedAt: WITHIN_HOLD_CEILING,
        pullRequestLane: {
          details: NO_PR_DETAILS,
          deferrals: HEADLESS_PR_DEFERRALS,
        },
        organizationId: ORGANIZATION_ID,
        sessionArtifactId: SESSION_ARTIFACT_ID,
        artifactRefs: [pullRequestRef()],
        // No `repositoryId`, so the adopted-row fallback above still runs; the
        // provider id is what keeps the repository in scope, so the hold is the
        // PR lane's deferral rather than an absent identity. Which of the two
        // was only assertable once ISS-9182 split the counter per disposition.
        repositoryIdentity: repositoryAuthority({
          providerRepositoryId: "provider-repository-1",
        }),
      })
    ).resolves.toMatchObject({
      retryRequired: true,
      outcomeCounts: heldOutcome(
        MonitoredActivityOutcome.TargetNotMaterialized,
        1
      ),
    });
    expect(tx.branchActivityAtom.createMany).not.toHaveBeenCalled();
  });

  /**
   * ISS-9181's regression guard: resolvability is a property of SERVER STATE at
   * delivery time, not of the payload, so a RETRY-OWNED target's hold is what
   * lets an identical re-send land the evidence once that state moves. Dropping
   * the hold wholesale would have traded a permanent dead-letter loop for
   * silent evidence loss on a path that works.
   */
  it("holds an identity-conflicted target, then persists it when a later delivery resolves", async () => {
    const { tx, allStored } = persistenceTx();
    // A contested repository identity: the server knows this repo twice, which
    // is unresolvable NOW and resolvable once the conflict settles.
    const contested = repositoryAuthority({
      repositoryId: REPOSITORY_ID,
      identityConflict: true,
    });

    await expect(
      persistMonitoredSessionActivity(tx as never, {
        receivedAt: WITHIN_HOLD_CEILING,
        pullRequestLane: {
          details: NO_PR_DETAILS,
          deferrals: HEADLESS_PR_DEFERRALS,
        },
        organizationId: ORGANIZATION_ID,
        sessionArtifactId: SESSION_ARTIFACT_ID,
        artifactRefs: [pullRequestRef()],
        repositoryIdentity: contested,
      })
    ).resolves.toMatchObject({
      retryRequired: true,
      outcomeCounts: heldOutcome(
        MonitoredActivityOutcome.TargetAuthorityConflict,
        1
      ),
    });

    expect(tx.branchActivityAtom.createMany).not.toHaveBeenCalled();
    expect(tx.branchDetail.updateMany).not.toHaveBeenCalled();

    await expect(
      persistMonitoredSessionActivity(tx as never, {
        receivedAt: WITHIN_HOLD_CEILING,
        pullRequestLane: {
          details: RESOLVED_PR_DETAILS,
          deferrals: NO_PR_LANE_DEFERRALS,
        },
        organizationId: ORGANIZATION_ID,
        sessionArtifactId: SESSION_ARTIFACT_ID,
        artifactRefs: [pullRequestRef()],
        repositoryIdentity: contested,
      })
    ).resolves.toMatchObject({ retryRequired: false, persistedCount: 1 });
    expect(allStored()).toHaveLength(1);
  });

  it("propagates partial carrier coverage to the canonical atom", async () => {
    const { tx, stored } = persistenceTx();

    await persistMonitoredSessionActivity(tx as never, {
      receivedAt: WITHIN_HOLD_CEILING,
      pullRequestLane: {
        details: RESOLVED_PR_DETAILS,
        deferrals: NO_PR_LANE_DEFERRALS,
      },
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
      artifactRefs: [
        pullRequestRef(EVENT, BranchActivityEvidenceCompleteness.Partial),
      ],
      repositoryIdentity: NO_REPOSITORY_AUTHORITY,
    });

    expect(stored()?.completeness).toBe(
      BranchActivityEvidenceCompleteness.Partial
    );
  });

  it("persists every candidate past the retired 100-per-session cap as Complete (ISS-9860)", async () => {
    const { tx, allStored } = persistenceTx();
    const targetCount = 3;
    const eventCount = 250;
    const events = Array.from({ length: eventCount }, (_, index) => ({
      ...EVENT,
      sourceEventId: `monitored_session_v1:event-${index}`,
      occurredAt: new Date(
        Date.parse(EVENT.occurredAt) + index * 1000
      ).toISOString(),
    }));
    const artifactRefs = Array.from({ length: targetCount }, (_, target) => ({
      ...branchRef(`feat/aggregate-${target}`, EVENT),
      monitoredSessionActivity: {
        completeness: BranchActivityEvidenceCompleteness.Complete,
        events: events.filter((_, index) => index % targetCount === target),
      },
    }));

    await persistMonitoredSessionActivity(tx as never, {
      receivedAt: WITHIN_HOLD_CEILING,
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: NO_PR_LANE_DEFERRALS,
      },
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      artifactRefs,
      repositoryIdentity: NO_REPOSITORY_AUTHORITY,
    });

    expect(eventCount).toBeGreaterThan(RETIRED_PER_SESSION_CAP);
    expect(allStored()).toHaveLength(eventCount);
    expect(
      allStored().every(
        (row) =>
          row.completeness === BranchActivityEvidenceCompleteness.Complete
      )
    ).toBe(true);
    expect(
      Math.min(...allStored().map((row) => row.occurredAt.getTime()))
    ).toBe(Date.parse(events[0].occurredAt));
    expect(new Set(allStored().map((row) => row.branchArtifactId)).size).toBe(
      targetCount
    );
  });

  it("splits the Branch target lookup at the bind budget for a Session naming more targets than one statement holds (ISS-9860)", async () => {
    const { tx, allStored } = persistenceTx();
    const targetCount = BRANCH_TARGET_LOOKUP_CHUNK + 1;
    const artifactRefs = Array.from({ length: targetCount }, (_, target) =>
      branchRef(`feat/wide-${target}`, {
        ...EVENT,
        sourceEventId: `monitored_session_v1:wide-${target}`,
      })
    );

    await persistMonitoredSessionActivity(tx as never, {
      receivedAt: WITHIN_HOLD_CEILING,
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: NO_PR_LANE_DEFERRALS,
      },
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      artifactRefs,
      repositoryIdentity: NO_REPOSITORY_AUTHORITY,
    });

    // The target lookup is the `OR`-shaped read; the atom batch's id-keyed
    // re-read on the same model is chunked by its own suite.
    const lookupCalls = tx.branchDetail.findMany.mock.calls.filter(
      ([{ where }]) => "OR" in where
    );
    expect(lookupCalls).toHaveLength(
      Math.ceil(targetCount / BRANCH_TARGET_LOOKUP_CHUNK)
    );
    for (const [{ where }] of lookupCalls) {
      expect(where.OR.length).toBeLessThanOrEqual(BRANCH_TARGET_LOOKUP_CHUNK);
    }
    expect(
      lookupCalls.reduce((sum, [{ where }]) => sum + where.OR.length, 0)
    ).toBe(targetCount);
    expect(allStored()).toHaveLength(targetCount);
    expect(new Set(allStored().map((row) => row.branchArtifactId)).size).toBe(
      targetCount
    );
  });

  it("splits the residual PR lookup at the bind budget for more residual targets than one statement holds (ISS-9860)", async () => {
    const { tx, allStored } = persistenceTx();
    const targetCount = RESIDUAL_PULL_REQUEST_LOOKUP_CHUNK + 1;
    const artifactRefs = Array.from({ length: targetCount }, (_, target) => ({
      ...pullRequestRef({
        ...EVENT,
        sourceEventId: `monitored_session_v1:residual-${target}`,
      }),
      prNumber: PR_NUMBER + target,
    }));
    // Every residual number resolves; the attribution lock double answers one
    // PR id, so they all share it and the atoms stay distinct by source event.
    tx.pullRequestDetail.findMany.mockImplementation(({ where }) =>
      "id" in where
        ? [{ id: PULL_REQUEST_ID, branchArtifactId: BRANCH_ARTIFACT_ID }]
        : where.OR.map((arm: { number: number }) => ({
            id: PULL_REQUEST_ID,
            branchArtifactId: BRANCH_ARTIFACT_ID,
            repositoryId: null,
            repositoryFullName: REPOSITORY,
            number: arm.number,
          }))
    );

    await persistMonitoredSessionActivity(tx as never, {
      receivedAt: WITHIN_HOLD_CEILING,
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: laneDeferrals(
          ...Array.from({ length: targetCount }, (_, target) => ({
            repositoryFullName: REPOSITORY,
            prNumber: PR_NUMBER + target,
            deferral: PullRequestLaneDeferral.AwaitingDesktopDelivery,
          }))
        ),
      },
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      artifactRefs,
      repositoryIdentity: NO_REPOSITORY_AUTHORITY,
    });

    const residualCalls = tx.pullRequestDetail.findMany.mock.calls.filter(
      ([{ where, select }]) => "OR" in where && "id" in select
    );
    expect(residualCalls).toHaveLength(
      Math.ceil(targetCount / RESIDUAL_PULL_REQUEST_LOOKUP_CHUNK)
    );
    for (const [{ where }] of residualCalls) {
      expect(where.OR.length).toBeLessThanOrEqual(
        RESIDUAL_PULL_REQUEST_LOOKUP_CHUNK
      );
    }
    expect(
      residualCalls.reduce((sum, [{ where }]) => sum + where.OR.length, 0)
    ).toBe(targetCount);
    expect(allStored()).toHaveLength(targetCount);
    expect(
      allStored().every((row) => row.pullRequestDetailId === PULL_REQUEST_ID)
    ).toBe(true);
  });

  it("scopes canonical source identity to the persisted Session artifact", async () => {
    const { tx, allStored } = persistenceTx();

    await persistMonitoredSessionActivity(tx as never, {
      receivedAt: WITHIN_HOLD_CEILING,
      pullRequestLane: {
        details: RESOLVED_PR_DETAILS,
        deferrals: NO_PR_LANE_DEFERRALS,
      },
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
      artifactRefs: [pullRequestRef()],
      repositoryIdentity: NO_REPOSITORY_AUTHORITY,
    });
    await persistMonitoredSessionActivity(tx as never, {
      receivedAt: WITHIN_HOLD_CEILING,
      pullRequestLane: {
        details: RESOLVED_PR_DETAILS,
        deferrals: NO_PR_LANE_DEFERRALS,
      },
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: "019ff900-0000-7000-8000-000000000005",
      artifactRefs: [pullRequestRef()],
      repositoryIdentity: NO_REPOSITORY_AUTHORITY,
    });

    expect(allStored()).toHaveLength(2);
    expect(new Set(allStored().map((row) => row.sourceEventId)).size).toBe(2);
  });

  it("claims v1 before rollback and converges new-old-new replay", async () => {
    const { tx, allRows } = persistenceTx();
    const input = {
      receivedAt: WITHIN_HOLD_CEILING,
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
      artifactRefs: [pullRequestRef()],
      pullRequestLane: {
        details: RESOLVED_PR_DETAILS,
        deferrals: NO_PR_LANE_DEFERRALS,
      },
      repositoryIdentity: NO_REPOSITORY_AUTHORITY,
    };

    await expect(
      persistMonitoredSessionActivity(tx as never, input)
    ).resolves.toMatchObject({ persistedCount: 1, retryRequired: false });
    expect(allRows()).toHaveLength(2);
    const alias = allRows().find(
      (row) => row.compatibilityAliasForSourceEventId != null
    );
    expect(alias).toBeDefined();

    const rollbackInsert = await tx.branchActivityAtom.createMany({
      data: [{ ...alias, compatibilityAliasForSourceEventId: undefined }],
      skipDuplicates: true,
    });
    expect(rollbackInsert.count).toBe(0);
    await expect(
      persistMonitoredSessionActivity(tx as never, input)
    ).resolves.toMatchObject({ persistedCount: 1, retryRequired: false });
    expect(allRows()).toHaveLength(2);
  });
});
