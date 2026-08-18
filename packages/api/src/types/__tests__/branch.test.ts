import { describe, expect, expectTypeOf, it } from "vitest";
import type { BranchDetail as ArtifactBranchDetail } from "../artifact";
import {
  BranchBaselineScope,
  BranchDataState,
  BranchKpiState,
  BranchLifecycleBoundaryKind,
  BranchLifecyclePhase,
  type BranchLifecyclePhaseCostRollup,
  BranchMetricBasis,
  type BranchPageDetail,
  BranchParticipationKind,
  BranchPhase,
  type BranchPrState,
  BranchRefreshReason,
  BranchRefreshStatus,
  type BranchSession,
  BranchSessionRole,
  BranchStatus,
  BranchViewerScope,
  decodeBranchId,
  encodeBranchId,
} from "../branch";
import type { GitHubPRState } from "../github";

describe("branch enums", () => {
  it("exposes the documented BranchStatus value set", () => {
    expect(Object.values(BranchStatus).sort()).toEqual(
      ["blocked", "closed", "draft", "merged", "open", "review"].sort()
    );
  });

  it("exposes the documented BranchPhase value set", () => {
    expect(Object.values(BranchPhase).sort()).toEqual(
      ["implement", "plan", "review", "rework", "verify"].sort()
    );
  });

  it("pins the BranchSessionRole wire values", () => {
    expect(BranchSessionRole.Build).toBe("build");
    expect(BranchSessionRole.Review).toBe("review");
    expect(BranchSessionRole.Related).toBe("related");
  });

  it("pins the BranchParticipationKind wire values", () => {
    expect(BranchParticipationKind.Wrote).toBe("wrote");
    expect(BranchParticipationKind.Reviewed).toBe("reviewed");
  });

  it("pins the branch lifecycle phase segment contract values", () => {
    expect(Object.values(BranchLifecyclePhase).sort()).toEqual(
      ["build", "review", "rework", "unknown"].sort()
    );
    expect(BranchLifecycleBoundaryKind.PrRaised).toBe("pr_raised");
    expect(BranchLifecycleBoundaryKind.ReadOnlyReference).toBe(
      "read_only_reference"
    );
  });

  it("re-exports GitHubPRState as BranchPrState (no redefinition)", () => {
    // Compile-time: the two types are identical. A redefinition would diverge
    // here and fail typecheck.
    expectTypeOf<BranchPrState>().toEqualTypeOf<GitHubPRState>();
  });

  it("pins the BranchViewerScope wire values (drift guard)", () => {
    expect(BranchViewerScope.Organization).toBe("organization");
    expect(BranchViewerScope.Self).toBe("self");
  });

  it("pins the BranchKpiState wire values (drift guard)", () => {
    expect(BranchKpiState.Available).toBe("available");
    expect(BranchKpiState.Gated).toBe("gated");
    expect(BranchKpiState.Unavailable).toBe("unavailable");
  });

  it("pins the BranchBaselineScope wire values (drift guard)", () => {
    // ISS-4686: a consumer refuses to render a verdict when it doesn't
    // recognise the scope, so a silent rename here would stop every delta chip
    // rather than fail loudly.
    expect(BranchBaselineScope.Corpus).toBe("corpus");
    expect(BranchBaselineScope.Branch).toBe("branch");
  });

  it("pins the BranchMetricBasis wire values (drift guard)", () => {
    expect(BranchMetricBasis.ChurnPerDollar).toBe("churn_per_dollar");
    expect(BranchMetricBasis.FirstCommitToMerge).toBe("first_commit_to_merge");
    expect(BranchMetricBasis.FirstSessionToMerge).toBe(
      "first_session_to_merge"
    );
  });

  it("pins additive cloud Branches state and refresh values", () => {
    expect(BranchDataState.AwaitingSync).toBe("awaiting_sync");
    expect(BranchDataState.NoSessions).toBe("no_sessions");
    expect(BranchRefreshStatus.Retryable).toBe("retryable");
    expect(BranchRefreshReason.AlreadyRefreshing).toBe("already_refreshing");
    expect(BranchRefreshReason.GitHubIdentityRequired).toBe(
      "github_identity_required"
    );
    expect(BranchRefreshReason.GitHubIdentityExpired).toBe(
      "github_identity_expired"
    );
    expect(BranchRefreshReason.GitHubIdentityInsufficientScope).toBe(
      "github_identity_insufficient_scope"
    );
  });
});

describe("encodeBranchId / decodeBranchId", () => {
  it("round-trips a slash-bearing repoFullName and a slash-bearing branch name", () => {
    const parts = {
      repoFullName: "repo/owner",
      branchName: "branch-with/slash",
    };
    const id = encodeBranchId(parts);
    // The delimiter survives because each component is encodeURIComponent'd.
    expect(id).toBe("repo%2Fowner::branch-with%2Fslash");
    expect(decodeBranchId(id)).toEqual(parts);
  });

  it("round-trips a null repoFullName through the 'local' sentinel", () => {
    const id = encodeBranchId({ repoFullName: null, branchName: "main" });
    expect(id).toBe("local::main");
    expect(decodeBranchId(id)).toEqual({
      repoFullName: null,
      branchName: "main",
    });
  });

  it("round-trips a branch name that itself contains the delimiter", () => {
    const parts = { repoFullName: "a/b", branchName: "weird::name" };
    expect(decodeBranchId(encodeBranchId(parts))).toEqual(parts);
  });

  it("degrades a malformed (delimiter-less) id to a repo-less branch instead of throwing", () => {
    expect(decodeBranchId("just-a-branch")).toEqual({
      repoFullName: null,
      branchName: "just-a-branch",
    });
  });
});

describe("BranchPageDetail vs artifact.ts BranchDetail (collision guard)", () => {
  it("keeps the two same-package detail types distinct and unshadowed", () => {
    // The surface detail type carries list fields (id/status/branchName); the
    // artifact-table detail carries repositoryId/headShaSource. If branch.ts
    // had reused the name `BranchDetail`, the artifact consumers would shadow or
    // collide and this file would fail to typecheck.
    expectTypeOf<BranchPageDetail>().toHaveProperty("status");
    expectTypeOf<BranchPageDetail>().toHaveProperty("mergedTrace");
    expectTypeOf<ArtifactBranchDetail>().toHaveProperty("repositoryId");
    expectTypeOf<ArtifactBranchDetail>().not.toHaveProperty("mergedTrace");
  });
});

describe("BranchSession lifecycle compatibility", () => {
  it("allows legacy sessions to omit lifecycle phase segments", () => {
    const legacySession: BranchSession = {
      sessionId: "session-1",
      slug: "SES-1",
      name: "Legacy session",
      harness: "codex",
      startedAt: "2026-07-22T12:00:00.000Z",
      endedAt: null,
      isPrimary: true,
      estimatedCostUsd: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      ownerUserName: null,
    };

    expect(legacySession.phaseSegments).toBeUndefined();
    expect(legacySession.participation).toBeUndefined();
  });

  it("carries ordered lifecycle segments with explicit sequence", () => {
    const session: BranchSession = {
      sessionId: "session-2",
      slug: "SES-2",
      name: "Segmented session",
      harness: "codex",
      participation: BranchParticipationKind.Wrote,
      phaseSegments: [
        {
          sequence: 0,
          phase: BranchLifecyclePhase.Build,
          startedAt: "2026-07-22T12:00:00.000Z",
          endedAt: "2026-07-22T12:10:00.000Z",
          startBoundary: {
            kind: BranchLifecycleBoundaryKind.SessionStart,
            observedAt: "2026-07-22T12:00:00.000Z",
          },
          endBoundary: {
            kind: BranchLifecycleBoundaryKind.PrRaised,
            observedAt: "2026-07-22T12:10:00.000Z",
          },
        },
      ],
      startedAt: "2026-07-22T12:00:00.000Z",
      endedAt: "2026-07-22T12:30:00.000Z",
      isPrimary: true,
      estimatedCostUsd: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      ownerUserName: null,
    };

    expect(session.phaseSegments?.[0]?.sequence).toBe(0);
    expect(session.participation).toBe(BranchParticipationKind.Wrote);
  });
});

describe("BranchPageDetail lifecycle rollup compatibility", () => {
  it("allows legacy branch details to omit lifecycle phase stacks", () => {
    const legacyDetail: Pick<BranchPageDetail, "lifecyclePhaseStacks"> = {};

    expect(legacyDetail.lifecyclePhaseStacks).toBeUndefined();
  });

  it("carries lifecycle phase cost stacks keyed by lifecycle phase", () => {
    const rollup: BranchLifecyclePhaseCostRollup = {
      phase: BranchLifecyclePhase.Rework,
      estimatedCostUsd: 1.25,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
      sessionCount: 1,
    };

    expect(rollup.phase).toBe(BranchLifecyclePhase.Rework);
  });
});
