import {
  BranchLifecycleBoundaryKind,
  BranchLifecyclePhase,
  BranchParticipationKind,
} from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import {
  getSessionUsageByBranch,
  type SessionUsageClient,
} from "./session-usage-window";

describe("Branch session relationship dedupe", () => {
  it("merges reviewed-first evidence before deriving session outputs", async () => {
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
      await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
        includeReviewedParticipation: true,
      })
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
    ).toEqual([
      BranchLifecyclePhase.Build,
      BranchLifecyclePhase.Review,
      BranchLifecyclePhase.Rework,
    ]);
    expect(usage?.ownerCounts.get("user-1")).toBe(1);
    expect(usage?.lifecycleEventsBySession?.get("session-1")).toHaveLength(3);
  });
});

function makeLink(
  branchParticipation: BranchParticipationKind,
  branchLifecycleEvents: readonly {
    kind: BranchLifecycleBoundaryKind;
    observedAt: string;
    evidenceId: string;
  }[]
) {
  return {
    targetId: "branch-1",
    sourceId: "session-1",
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
      session: {
        artifactId: "session-1",
        externalSessionId: "external-1",
        harness: "claude",
        sessionStartedAt: new Date("2026-06-10T10:00:00.000Z"),
        sessionEndedAt: null,
        estimatedCost: 3,
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        userId: "user-1",
      },
    },
  };
}
