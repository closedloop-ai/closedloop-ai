import { ArtifactType } from "@repo/api/src/types/artifact";
import { BranchPhaseAttributionCompletenessReason } from "@repo/api/src/types/branch-phase-attribution";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  SessionArtifactLinkKind,
  sessionPrIdentityKey,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import { sessionLinkedPullRequestLinkWhere } from "@/lib/pull-request-population";
import { sessionBranchPrPopulationLinkWhere } from "@/lib/session-pr-links";
import { getGlobalBranchMetricDivisorCandidates } from "../branch-candidate-read";
import { getSessionBranchCounts } from "../session-branch-divisor";
import {
  createGlobalDivisorCandidateMemo,
  loadCanonicalDetailDivisor,
  loadGlobalDivisorCandidates,
  loadOrgMergedPullRequestAdmissionForRows,
} from "./canonical-metric-populations";

vi.mock("../session-branch-divisor", () => ({
  getSessionBranchCounts: vi.fn(),
}));

vi.mock("../branch-candidate-read", () => ({
  getGlobalBranchMetricDivisorCandidates: vi.fn(),
}));

describe("loadGlobalDivisorCandidates", () => {
  it("memoizes global divisor reads inside one read scope", async () => {
    vi.clearAllMocks();
    const getGlobalCandidates = vi.mocked(
      getGlobalBranchMetricDivisorCandidates
    );
    getGlobalCandidates.mockResolvedValue({
      ids: ["global-a"],
      coverageComplete: true,
    });
    const db = mockCanonicalMetricClient();
    const memo = createGlobalDivisorCandidateMemo();
    const first = await loadGlobalDivisorCandidates(
      db,
      "org-1",
      { limit: 50, offset: 0, startDate: new Date("2026-08-01T00:00:00.000Z") },
      memo
    );
    const second = await loadGlobalDivisorCandidates(
      db,
      "org-1",
      { limit: 50, offset: 0, endDate: new Date("2026-08-08T00:00:00.000Z") },
      memo
    );

    expect(first).toBe(second);
    expect(getGlobalCandidates).toHaveBeenCalledOnce();
    expect(getGlobalCandidates).toHaveBeenCalledWith(db, "org-1", {
      limit: 50,
      offset: 0,
      startDate: new Date("2026-08-01T00:00:00.000Z"),
    });
  });
});

describe("loadCanonicalDetailDivisor", () => {
  it("fails closed with no branch counts when global divisor authority is capped", async () => {
    vi.clearAllMocks();
    vi.mocked(getGlobalBranchMetricDivisorCandidates).mockResolvedValueOnce({
      ids: ["visible-a"],
      coverageComplete: false,
    });
    const db = mockCanonicalMetricClient();

    const result = await loadCanonicalDetailDivisor(
      db,
      "org-1",
      ["session-1"],
      { limit: 50, offset: 0 }
    );

    expect(result).toEqual({
      branchCounts: new Map(),
      coverageReasons: [
        BranchPhaseAttributionCompletenessReason.CoverageCapped,
      ],
    });
    expect(getSessionBranchCounts).not.toHaveBeenCalled();
  });

  it("reads session branch counts scoped to the eligible ids when global authority is complete", async () => {
    vi.clearAllMocks();
    vi.mocked(getGlobalBranchMetricDivisorCandidates).mockResolvedValueOnce({
      ids: ["visible-a", "visible-b"],
      coverageComplete: true,
    });
    vi.mocked(getSessionBranchCounts).mockResolvedValueOnce(
      new Map([["visible-a", 3]])
    );
    const db = mockCanonicalMetricClient();

    const result = await loadCanonicalDetailDivisor(
      db,
      "org-1",
      ["session-1", "session-2"],
      { limit: 50, offset: 0 }
    );

    expect(getSessionBranchCounts).toHaveBeenCalledWith(
      db,
      "org-1",
      ["session-1", "session-2"],
      ["visible-a", "visible-b"]
    );
    expect(result).toEqual({
      branchCounts: new Map([["visible-a", 3]]),
      coverageReasons: [],
    });
  });
});

describe("loadOrgMergedPullRequestAdmissionForRows", () => {
  it("uses the shared org merged-PR link predicate for hydrated Branch metric rows", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        targetId: "branch-a",
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          prRefs: [
            {
              repositoryFullName: "closedloop-ai/closedloop-ai",
              prNumber: 17,
              relationTypes: [],
            },
          ],
        },
      },
    ]);
    const db = { artifactLink: { findMany } } as unknown as Parameters<
      typeof loadCanonicalDetailDivisor
    >[0];
    const rows = [
      {
        id: "branch-a",
        _count: { pullRequestDetails: 3 },
        pullRequestDetails: [
          {
            id: "pr-1",
            prState: GitHubPRState.Merged,
            lastVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
          },
          { id: "pr-2" },
        ],
      },
      {
        id: "branch-without-prs",
        _count: { pullRequestDetails: 0 },
        pullRequestDetails: [],
      },
    ] as unknown as Parameters<
      typeof loadOrgMergedPullRequestAdmissionForRows
    >[2];

    const admission = await loadOrgMergedPullRequestAdmissionForRows(
      db,
      "org-1",
      rows
    );

    expect(findMany).toHaveBeenCalledWith({
      where: {
        targetId: { in: ["branch-a"] },
        OR: [
          sessionLinkedPullRequestLinkWhere("org-1"),
          {
            organizationId: "org-1",
            ...sessionBranchPrPopulationLinkWhere(),
            source: {
              type: ArtifactType.Session,
              organizationId: "org-1",
            },
          },
        ],
      },
      select: { targetId: true, metadata: true, branchParticipation: true },
    });
    expect(admission.get("branch-a")?.pullRequestCount).toBe(3);
    expect(
      admission
        .get("branch-a")
        ?.exactIdentities.has(
          sessionPrIdentityKey("closedloop-ai/closedloop-ai", 17)
        )
    ).toBe(true);
    expect(admission.has("branch-without-prs")).toBe(false);
  });

  it("admits a branch to the read whose only verified pull request is Closed rather than Merged", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { artifactLink: { findMany } } as unknown as Parameters<
      typeof loadCanonicalDetailDivisor
    >[0];
    const rows = [
      {
        id: "branch-closed-pr",
        _count: { pullRequestDetails: 1 },
        pullRequestDetails: [
          {
            id: "pr-1",
            prState: GitHubPRState.Closed,
            lastVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
          },
        ],
      },
    ] as unknown as Parameters<
      typeof loadOrgMergedPullRequestAdmissionForRows
    >[2];

    await loadOrgMergedPullRequestAdmissionForRows(db, "org-1", rows);

    // A verified Closed (never-merged) PR still qualifies the branch for the
    // link scan — the candidate check does not require Merged specifically.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          targetId: { in: ["branch-closed-pr"] },
        }),
      })
    );
  });
});

function mockCanonicalMetricClient(): Parameters<
  typeof loadCanonicalDetailDivisor
>[0] {
  return {
    $queryRaw: vi.fn(),
    artifactLink: { findMany: vi.fn() },
  } as unknown as Parameters<typeof loadCanonicalDetailDivisor>[0];
}
