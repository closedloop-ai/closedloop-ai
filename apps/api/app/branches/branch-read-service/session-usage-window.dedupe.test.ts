import {
  BranchLifecycleBoundaryKind,
  BranchLifecyclePhase,
  BranchParticipationKind,
} from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import { sessionBranchUsageLinkKindWhere } from "./session-usage-link-read";
import {
  getSessionUsageByBranch,
  type SessionBranchIdentityEvidence,
  type SessionUsageClient,
} from "./session-usage-window";

describe("Branch session link-kind selector", () => {
  it("includes canonical multi-PR membership without dropping legacy kinds", () => {
    expect(sessionBranchUsageLinkKindWhere()).toEqual([
      {
        OR: [
          {
            metadata: {
              path: ["linkKind"],
              equals: SessionArtifactLinkKind.SessionPr,
            },
          },
          {
            metadata: {
              path: ["linkKinds"],
              array_contains: [SessionArtifactLinkKind.SessionPrSet],
            },
          },
        ],
      },
      {
        metadata: {
          path: ["linkKind"],
          equals: SessionArtifactLinkKind.SessionBranch,
        },
      },
    ]);
  });
});

describe("Branch session relationship dedupe", () => {
  it("ignores reviewed duplicate evidence before deriving Wrote outputs", async () => {
    const artifactLinkFindMany = vi.fn().mockResolvedValue([
      makeLink(BranchParticipationKind.Reviewed, [
        {
          kind: BranchLifecycleBoundaryKind.ReviewFeedback,
          observedAt: "2026-06-10T10:03:00.000Z",
          evidenceId: "review",
        },
      ]),
      makeLink(BranchParticipationKind.Wrote, [
        {
          kind: BranchLifecycleBoundaryKind.PrRaised,
          observedAt: "2026-06-10T10:01:00.000Z",
          evidenceId: "pr",
        },
        {
          kind: BranchLifecycleBoundaryKind.BranchWrite,
          observedAt: "2026-06-10T10:04:00.000Z",
          evidenceId: "write",
        },
      ]),
    ]);
    const db = {
      artifactLink: { findMany: artifactLinkFindMany },
      agentSessionTokenEvent: { findMany: vi.fn(), groupBy: vi.fn() },
      $queryRaw: vi.fn(),
    } as unknown as SessionUsageClient;

    const usage = (
      await getSessionUsageByBranch(db, "org-1", ["branch-1"])
    ).get("branch-1");

    expect(usage).toMatchObject({
      sessionIds: ["session-1"],
      inputTokens: 1,
      estimatedCostUsd: 3,
    });
    expect(usage?.sessions).toHaveLength(1);
    expect(usage?.sessions[0]).toMatchObject({
      participation: BranchParticipationKind.Wrote,
    });
    expect(
      usage?.sessions[0]?.phaseSegments?.map(({ phase }) => phase)
    ).toEqual([BranchLifecyclePhase.Build, BranchLifecyclePhase.Rework]);
    expect(usage?.lifecycleEventsBySession?.get("session-1")).toHaveLength(2);
  });

  it("collects Reviewed identity evidence without admitting it to usage", async () => {
    const db = {
      artifactLink: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            makeLink(BranchParticipationKind.Reviewed, [], "session-reviewed"),
            makeLink(BranchParticipationKind.Wrote, [], "session-wrote"),
          ]),
      },
      agentSessionTokenEvent: { findMany: vi.fn(), groupBy: vi.fn() },
      $queryRaw: vi.fn(),
    } as unknown as SessionUsageClient;
    const identityEvidence: SessionBranchIdentityEvidence[] = [];

    const usage = (
      await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
        identityEvidenceOut: identityEvidence,
      })
    ).get("branch-1");

    expect(usage?.sessionIds).toEqual(["session-wrote"]);
    expect(usage?.sessions.map((session) => session.sessionId)).toEqual([
      "session-wrote",
    ]);
    expect(identityEvidence.map((evidence) => evidence.sourceId)).toEqual([
      "session-reviewed",
      "session-wrote",
    ]);
    expect(db.artifactLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            {
              OR: expect.arrayContaining([
                { branchParticipation: BranchParticipationKind.Reviewed },
              ]),
            },
          ]),
        }),
      })
    );
  });

  it("can retain lifecycle events without deriving session phase segments", async () => {
    const db = {
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([
          makeLink(BranchParticipationKind.Reviewed, [
            {
              kind: BranchLifecycleBoundaryKind.ReviewFeedback,
              observedAt: "2026-06-10T10:03:00.000Z",
              evidenceId: "review",
            },
          ]),
          makeLink(BranchParticipationKind.Wrote, [
            {
              kind: BranchLifecycleBoundaryKind.PrRaised,
              observedAt: "2026-06-10T10:01:00.000Z",
              evidenceId: "pr",
            },
          ]),
        ]),
      },
      agentSessionTokenEvent: { findMany: vi.fn(), groupBy: vi.fn() },
      $queryRaw: vi.fn(),
    } as unknown as SessionUsageClient;

    const usage = (
      await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
        includeLifecycleEvents: true,
        includeSessionPhaseSegments: false,
      })
    ).get("branch-1");

    expect(usage?.lifecycleEventsBySession?.get("session-1")).toHaveLength(1);
    expect(usage?.sessions[0]?.phaseSegments).toBeUndefined();
  });

  it("can skip lifecycle metadata for list-only usage", async () => {
    const db = {
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([
          makeLink(BranchParticipationKind.Wrote, [
            {
              kind: BranchLifecycleBoundaryKind.PrRaised,
              observedAt: "2026-06-10T10:01:00.000Z",
              evidenceId: "pr",
            },
          ]),
        ]),
      },
      agentSessionTokenEvent: { findMany: vi.fn(), groupBy: vi.fn() },
      $queryRaw: vi.fn(),
    } as unknown as SessionUsageClient;

    const usage = (
      await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
        includeLifecycleEvents: false,
        includeSessionPhaseSegments: false,
      })
    ).get("branch-1");

    expect(usage?.sessionIds).toEqual(["session-1"]);
    expect(usage?.lifecycleEventsBySession?.size).toBe(0);
    expect(usage?.sessions[0]?.phaseSegments).toBeUndefined();
  });
});

function makeLink(
  branchParticipation: BranchParticipationKind,
  branchLifecycleEvents: readonly {
    kind: BranchLifecycleBoundaryKind;
    observedAt: string;
    evidenceId: string;
  }[],
  sessionId = "session-1"
) {
  return {
    targetId: "branch-1",
    sourceId: sessionId,
    branchParticipation,
    branchParticipationMethod: null,
    branchParticipationObservedAt: null,
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionPr,
      branchLifecycleEvents,
    },
    source: {
      name: "Canonical session",
      slug: "canonical-session",
      // ISS-12251: the Prisma link read selects the session's owner off the
      // artifact's assignee.
      assigneeId: "user-1",
      session: {
        artifactId: sessionId,
        externalSessionId: "external-1",
        harness: "claude",
        sessionStartedAt: new Date("2026-06-10T10:00:00.000Z"),
        sessionEndedAt: null,
        estimatedCost: 3,
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
  };
}
