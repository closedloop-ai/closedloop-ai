import { ArtifactSectionOrdering } from "@repo/api/src/types/artifact-group-by-mode";
import { IssueStatus } from "@repo/api/src/types/document";
import { ProjectArtifactBoardSort } from "@repo/api/src/types/project-artifact-board-page";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ evaluate: vi.fn(), ordering: vi.fn() }));

vi.mock("@/lib/feature-flag-identity", () => ({
  evaluateFeatureFlagForAnyIdentity: mocks.evaluate,
}));
vi.mock("../assigned-tree-section-ordering", () => ({
  resolveAssignedTreeSectionOrdering: mocks.ordering,
}));

import { BoardStatusEvidence } from "../project-artifact-board-roots";
import {
  resolveBoardStatusEvidence,
  resolveBoardStatusOrdering,
} from "../project-artifact-board-status-evidence";

const IDENTITY = { clerkUserId: "user_clerk", userId: "user-1" };

describe("ISS-12929 724-F5 board status evidence", () => {
  beforeEach(() => {
    mocks.evaluate.mockReset();
    mocks.ordering.mockReset();
  });

  it("resolves the browser's status order only for a status sort", async () => {
    mocks.ordering.mockResolvedValue(ArtifactSectionOrdering.RootFirst);
    expect(
      await resolveBoardStatusOrdering(
        IDENTITY,
        ProjectArtifactBoardSort.Status
      )
    ).toBe(ArtifactSectionOrdering.RootFirst);
    expect(mocks.ordering).toHaveBeenCalledWith(IDENTITY);
    mocks.ordering.mockClear();
    expect(
      await resolveBoardStatusOrdering(IDENTITY, ProjectArtifactBoardSort.Title)
    ).toBe(ArtifactSectionOrdering.Vocabulary);
    expect(mocks.ordering).not.toHaveBeenCalled();
  });

  it("follows the universal status flag when a status filter is set", async () => {
    mocks.evaluate.mockResolvedValue(true);
    expect(
      await resolveBoardStatusEvidence(IDENTITY, {
        statuses: [IssueStatus.Todo],
      })
    ).toBe(BoardStatusEvidence.Projected);
    mocks.evaluate.mockResolvedValue(false);
    expect(
      await resolveBoardStatusEvidence(IDENTITY, {
        statuses: [IssueStatus.Todo],
      })
    ).toBe(BoardStatusEvidence.Stored);
  });

  it("treats an unevaluable flag as off", async () => {
    mocks.evaluate.mockResolvedValue(null);
    expect(
      await resolveBoardStatusEvidence(IDENTITY, {
        statuses: [IssueStatus.Todo],
      })
    ).toBe(BoardStatusEvidence.Stored);
  });

  it("skips the flag read when no status filter is set", async () => {
    expect(await resolveBoardStatusEvidence(IDENTITY, { search: "x" })).toBe(
      BoardStatusEvidence.Stored
    );
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
});
