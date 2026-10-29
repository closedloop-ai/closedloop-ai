import { GitHubPRState } from "@repo/api/src/types/github";
import { PR_INT_MAX } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it } from "vitest";
import { selectDesktopDetailPullRequest } from "../src/main/branch/branch-detail-selected-pull-request.js";
import type { BranchPrRow } from "../src/main/database/branch-reads.js";

const REPOSITORY = "acme/web";

function localRow(
  number: number,
  overrides: Partial<BranchPrRow> = {}
): BranchPrRow {
  return {
    repoFullName: REPOSITORY,
    branchName: "feature/one",
    prNumber: number,
    prUrl: `https://github.com/acme/web/pull/${number}`,
    title: `Local PR ${number}`,
    state: GitHubPRState.Open,
    isDraft: false,
    mergedAt: null,
    closedAt: null,
    openedAt: "2026-08-10T10:00:00.000Z",
    observedAt: "2026-08-11T10:00:00.000Z",
    linesAdded: number,
    linesRemoved: 1,
    filesChanged: 2,
    ...overrides,
  };
}

describe("selectDesktopDetailPullRequest over local rows", () => {
  it("fails closed with no PR evidence when an explicit identity matches nothing", () => {
    expect(
      selectDesktopDetailPullRequest([], {
        repositoryFullName: REPOSITORY,
        pullRequestNumber: 404,
      })
    ).toBeNull();
  });

  it("finds the explicit match once a same-number row with no repoFullName is filtered out", () => {
    const result = selectDesktopDetailPullRequest(
      [localRow(9), { ...localRow(9), repoFullName: null, title: "Orphan" }],
      { repositoryFullName: REPOSITORY, pullRequestNumber: 9 }
    );

    expect(result?.associatedPullRequests.selected?.title).toBe("Local PR 9");
    expect(result?.associatedPullRequests.collection.items).toHaveLength(1);
  });

  it("keeps a local row with no stored lifecycle unobserved", () => {
    const result = selectDesktopDetailPullRequest(
      [localRow(7, { state: null })],
      {}
    );

    const item = result?.associatedPullRequests.collection.items[0];
    expect(item?.number).toBe(7);
    expect(item?.lifecycleObserved).toBe(false);
    expect(result?.selectedRowFields.prState).toBeNull();
  });

  it("projects a complete local LOC triple onto the selected row", () => {
    const result = selectDesktopDetailPullRequest([localRow(7)], {});

    expect(result?.selectedRowFields).toMatchObject({
      additions: 7,
      deletions: 1,
      filesChanged: 2,
    });
  });

  it("withholds the whole triple when any count is partial or out of range, but keeps zero", () => {
    for (const loc of [
      { linesAdded: null },
      { linesRemoved: -1 },
      { filesChanged: 1.5 },
      { linesAdded: PR_INT_MAX + 1 },
    ]) {
      const result = selectDesktopDetailPullRequest([localRow(7, loc)], {});
      expect(result?.selectedRowFields.additions).toBeNull();
      expect(result?.selectedRowFields.deletions).toBeNull();
      expect(result?.selectedRowFields.filesChanged).toBeNull();
    }

    const zero = selectDesktopDetailPullRequest(
      [localRow(7, { linesAdded: 0, linesRemoved: 0, filesChanged: 0 })],
      {}
    );
    expect(zero?.selectedRowFields).toMatchObject({
      additions: 0,
      deletions: 0,
      filesChanged: 0,
    });
  });
});
