import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import {
  MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS_PER_SESSION,
  MonitoredSessionActivityEventKind,
  type SyncedMonitoredSessionActivityEvent,
} from "@repo/api/src/types/session-monitored-activity";
import { describe, expect, it, vi } from "vitest";
import {
  type SessionPullRequestDetailMap,
  sessionPullRequestDetailKey,
} from "./artifact-links/pull-request-details";
import type { SessionBranchRepositoryAuthorityMap } from "./artifact-links/shared";
import { persistMonitoredSessionActivity } from "./monitored-session-activity";

const ORGANIZATION_ID = "019ff900-0000-7000-8000-000000000001";
const BRANCH_ARTIFACT_ID = "019ff900-0000-7000-8000-000000000002";
const PULL_REQUEST_ID = "019ff900-0000-7000-8000-000000000003";
const REPOSITORY = "closedloop-ai/symphony-alpha";
const REPOSITORY_ID = "019ff900-0000-7000-8000-000000000006";
const PR_NUMBER = 6060;
const MONITORED_SOURCE_EVENT_ID_PATTERN = /^monitored_session_v1:[0-9a-f]{64}$/;

/** The PR lane's output for the same refs — what attribution now reads. */
const RESOLVED_PR_DETAILS: SessionPullRequestDetailMap = new Map([
  [
    sessionPullRequestDetailKey(REPOSITORY, PR_NUMBER),
    { prDetailId: PULL_REQUEST_ID, branchArtifactId: BRANCH_ARTIFACT_ID },
  ],
]);
const NO_PR_DETAILS: SessionPullRequestDetailMap = new Map();
const NO_REPOSITORY_AUTHORITY: SessionBranchRepositoryAuthorityMap = new Map();

const EVENT = {
  kind: MonitoredSessionActivityEventKind.AgentRead,
  sourceEventId: "monitored_session_v1:desktop-source-event",
  occurredAt: "2026-08-12T12:00:00.000Z",
  completeness: BranchActivityEvidenceCompleteness.Complete,
} satisfies SyncedMonitoredSessionActivityEvent;

function pullRequestRef(
  event: SyncedMonitoredSessionActivityEvent = EVENT,
  carrierCompleteness:
    | typeof BranchActivityEvidenceCompleteness.Complete
    | typeof BranchActivityEvidenceCompleteness.Partial = BranchActivityEvidenceCompleteness.Complete
): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.PullRequest,
    repositoryFullName: REPOSITORY,
    prNumber: PR_NUMBER,
    method: ArtifactRefMethod.McpToolCall,
    relation: ArtifactRefRelation.Reviewed,
    monitoredSessionActivity: {
      completeness: carrierCompleteness,
      events: [event],
    },
  };
}

function branchRef(
  branchName: string,
  event: SyncedMonitoredSessionActivityEvent
): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.Branch,
    repositoryFullName: REPOSITORY,
    branchName,
    method: ArtifactRefMethod.McpToolCall,
    relation: ArtifactRefRelation.Reviewed,
    monitoredSessionActivity: {
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events: [event],
    },
  };
}

function persistenceTx() {
  const stored: Array<{
    version: number;
    organizationId: string;
    branchArtifactId: string;
    source: string;
    sourceEventId: string;
    occurredAt: Date;
    attributionKind: string;
    pullRequestDetailId: string | null;
    completeness: string;
  }> = [];
  const tx = {
    branchDetail: {
      findMany: vi.fn().mockImplementation(({ where }) => {
        if ("artifactId" in where) {
          return where.artifactId.in.map((artifactId: string) => ({
            artifactId,
          }));
        }
        return where.OR.map(
          (target: { repositoryFullName: string; branchName: string }) => ({
            artifactId: `artifact:${target.branchName}`,
            repositoryFullName: target.repositoryFullName,
            branchName: target.branchName,
          })
        );
      }),
      findUnique: vi.fn().mockResolvedValue({ artifactId: BRANCH_ARTIFACT_ID }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    pullRequestDetail: {
      // Attribution for a ref the PR lane handled is threaded, never re-derived
      // (ISS-6450), so the only read left on this path is the atom batch's
      // id-keyed one. Residual-target tests override this per case.
      findMany: vi
        .fn()
        .mockImplementation(({ where }) =>
          "id" in where
            ? [{ id: PULL_REQUEST_ID, branchArtifactId: BRANCH_ARTIFACT_ID }]
            : []
        ),
      findUnique: vi.fn().mockResolvedValue({
        id: PULL_REQUEST_ID,
        branchArtifactId: BRANCH_ARTIFACT_ID,
        organizationId: ORGANIZATION_ID,
      }),
    },
    branchActivityAtom: {
      createMany: vi
        .fn()
        .mockImplementation(({ data }: { data: typeof stored }) => {
          let count = 0;
          for (const row of data) {
            if (
              stored.some(
                (candidate) =>
                  candidate.branchArtifactId === row.branchArtifactId &&
                  candidate.source === row.source &&
                  candidate.sourceEventId === row.sourceEventId
              )
            ) {
              continue;
            }
            stored.push(row);
            count += 1;
          }
          return { count };
        }),
      findMany: vi.fn().mockImplementation(() => stored),
      findUnique: vi.fn().mockImplementation(() => stored[0]),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
  return { tx, stored: () => stored[0], allStored: () => stored };
}

describe("persistMonitoredSessionActivity", () => {
  it("resolves PR attribution in-org and replays one canonical atom idempotently", async () => {
    const { tx, stored } = persistenceTx();
    const input = {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
      artifactRefs: [pullRequestRef(), pullRequestRef()],
      pullRequestDetails: RESOLVED_PR_DETAILS,
      repositoryAuthorityByFullName: NO_REPOSITORY_AUTHORITY,
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
        organizationId: ORGANIZATION_ID,
        sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
        artifactRefs: [pullRequestRef(), pullRequestRef(conflicting)],
        pullRequestDetails: RESOLVED_PR_DETAILS,
        repositoryAuthorityByFullName: NO_REPOSITORY_AUTHORITY,
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
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
      artifactRefs: [pullRequestRef()],
      pullRequestDetails: NO_PR_DETAILS,
      repositoryAuthorityByFullName: new Map([
        [REPOSITORY, { repositoryId: REPOSITORY_ID, authorities: [] }],
      ]),
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
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
      artifactRefs: [pullRequestRef()],
      pullRequestDetails: NO_PR_DETAILS,
      repositoryAuthorityByFullName: NO_REPOSITORY_AUTHORITY,
    });

    const residualCalls = tx.pullRequestDetail.findMany.mock.calls.filter(
      ([{ where }]) => "OR" in where
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
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
      artifactRefs: [pullRequestRef()],
      pullRequestDetails: NO_PR_DETAILS,
      repositoryAuthorityByFullName: NO_REPOSITORY_AUTHORITY,
    });

    const residualCalls = tx.pullRequestDetail.findMany.mock.calls.filter(
      ([{ where }]) => "OR" in where
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
        organizationId: ORGANIZATION_ID,
        sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
        artifactRefs: [pullRequestRef()],
        pullRequestDetails: NO_PR_DETAILS,
        // The reconciler keeps one of the ids that disagreed. Which one is
        // arbitrary, so it must not become the residual lookup's key.
        repositoryAuthorityByFullName: new Map([
          [
            REPOSITORY,
            {
              repositoryId: REPOSITORY_ID,
              identityConflict: true,
              authorities: [],
            },
          ],
        ]),
      })
    ).rejects.toThrow();

    const residualCalls = tx.pullRequestDetail.findMany.mock.calls.filter(
      ([{ where }]) => "OR" in where
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
        organizationId: ORGANIZATION_ID,
        sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
        artifactRefs: [pullRequestRef()],
        pullRequestDetails: NO_PR_DETAILS,
        repositoryAuthorityByFullName: new Map([
          [REPOSITORY, { repositoryId: REPOSITORY_ID, authorities: [] }],
        ]),
      })
    ).rejects.toThrow();

    // Both indexed arms missed. A same-name row under a different repository
    // would be a historical row, so the unscoped second pass must not run.
    const residualCalls = tx.pullRequestDetail.findMany.mock.calls.filter(
      ([{ where }]) => "OR" in where
    );
    expect(residualCalls).toHaveLength(1);
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
      ]);

    // An unordered pick between the two would put this source event on a
    // different branch from one retry to the next.
    await expect(
      persistMonitoredSessionActivity(tx as never, {
        organizationId: ORGANIZATION_ID,
        sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
        artifactRefs: [pullRequestRef()],
        pullRequestDetails: NO_PR_DETAILS,
        repositoryAuthorityByFullName: NO_REPOSITORY_AUTHORITY,
      })
    ).rejects.toThrow();
    expect(tx.branchActivityAtom.createMany).not.toHaveBeenCalled();
  });

  it("rejects unresolved targets so the Session cursor cannot acknowledge loss", async () => {
    const { tx, allStored } = persistenceTx();

    await expect(
      persistMonitoredSessionActivity(tx as never, {
        organizationId: ORGANIZATION_ID,
        sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
        artifactRefs: [pullRequestRef()],
        pullRequestDetails: NO_PR_DETAILS,
        repositoryAuthorityByFullName: NO_REPOSITORY_AUTHORITY,
      })
    ).rejects.toThrow("monitored session activity target unresolved");

    expect(tx.branchActivityAtom.createMany).not.toHaveBeenCalled();
    expect(tx.branchDetail.updateMany).not.toHaveBeenCalled();

    await expect(
      persistMonitoredSessionActivity(tx as never, {
        organizationId: ORGANIZATION_ID,
        sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
        artifactRefs: [pullRequestRef()],
        pullRequestDetails: RESOLVED_PR_DETAILS,
        repositoryAuthorityByFullName: NO_REPOSITORY_AUTHORITY,
      })
    ).resolves.toBeUndefined();
    expect(allStored()).toHaveLength(1);
  });

  it("propagates partial carrier coverage to the canonical atom", async () => {
    const { tx, stored } = persistenceTx();

    await persistMonitoredSessionActivity(tx as never, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
      artifactRefs: [
        pullRequestRef(EVENT, BranchActivityEvidenceCompleteness.Partial),
      ],
      pullRequestDetails: RESOLVED_PR_DETAILS,
      repositoryAuthorityByFullName: NO_REPOSITORY_AUTHORITY,
    });

    expect(stored()?.completeness).toBe(
      BranchActivityEvidenceCompleteness.Partial
    );
  });

  it("caps aggregate Session atoms latest-first and marks retained rows partial", async () => {
    const { tx, allStored } = persistenceTx();
    const eventCount =
      MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS_PER_SESSION + 1;
    const events = Array.from({ length: eventCount }, (_, index) => ({
      ...EVENT,
      sourceEventId: `monitored_session_v1:event-${index}`,
      occurredAt: new Date(
        Date.parse(EVENT.occurredAt) + index * 1000
      ).toISOString(),
    }));

    await persistMonitoredSessionActivity(tx as never, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
      artifactRefs: events.map((event, index) =>
        branchRef(`feat/aggregate-${index}`, event)
      ),
      pullRequestDetails: NO_PR_DETAILS,
      repositoryAuthorityByFullName: NO_REPOSITORY_AUTHORITY,
    });

    expect(allStored()).toHaveLength(
      MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS_PER_SESSION
    );
    expect(
      allStored().every(
        (row) => row.completeness === BranchActivityEvidenceCompleteness.Partial
      )
    ).toBe(true);
    expect(
      Math.min(...allStored().map((row) => row.occurredAt.getTime()))
    ).toBe(Date.parse(events[1].occurredAt));
  });

  it("scopes canonical source identity to the persisted Session artifact", async () => {
    const { tx, allStored } = persistenceTx();

    await persistMonitoredSessionActivity(tx as never, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: "019ff900-0000-7000-8000-000000000004",
      artifactRefs: [pullRequestRef()],
      pullRequestDetails: RESOLVED_PR_DETAILS,
      repositoryAuthorityByFullName: NO_REPOSITORY_AUTHORITY,
    });
    await persistMonitoredSessionActivity(tx as never, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: "019ff900-0000-7000-8000-000000000005",
      artifactRefs: [pullRequestRef()],
      pullRequestDetails: RESOLVED_PR_DETAILS,
      repositoryAuthorityByFullName: NO_REPOSITORY_AUTHORITY,
    });

    expect(allStored()).toHaveLength(2);
    expect(new Set(allStored().map((row) => row.sourceEventId)).size).toBe(2);
  });
});
