import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  type CloudBranchProjectionInput,
  type CloudPullRequestProjectionInput,
  observedPrStateForSelectedCloudPullRequest,
  projectCloudBranchAssociatedPullRequests,
  projectCloudOwnedBranchAssociatedPullRequests,
  statusForSelectedCloudPullRequest,
} from "./branch-associated-pull-request-projection";

const NOW = new Date("2026-08-03T00:00:00.000Z");

describe("cloud associated pull-request projection", () => {
  it("retains repository-qualified linked history and selects the active PR", () => {
    const row = cloudRow([
      pullRequest({
        id: "historical",
        number: 10,
        prState: GitHubPRState.Closed,
        closedAt: new Date("2026-08-01T00:00:00.000Z"),
        lastVerifiedAt: new Date("2026-08-01T00:01:00.000Z"),
      }),
      pullRequest({
        id: "active",
        number: 12,
        isDraft: true,
        lastVerifiedAt: NOW,
      }),
      pullRequest({
        id: "foreign",
        repositoryId: "foreign-repo",
        repositoryFullName: "other/repo",
        repository: { fullName: "other/repo" },
        number: 90,
        prState: GitHubPRState.Closed,
        closedAt: new Date("2026-07-31T00:00:00.000Z"),
      }),
    ]);

    const result = projectCloudBranchAssociatedPullRequests(row);

    expect(result.collection.items.map(({ number }) => number)).toEqual([
      10, 12, 90,
    ]);
    expect(result.collection.selectionReason).toBe(
      BranchAssociatedPullRequestSelectionReason.Active
    );
    expect(result.collection.completeness.state).toBe(
      BranchAssociatedPullRequestCompletenessState.Complete
    );
    expect(result.selected?.source.id).toBe("active");
  });

  it("fails closed when neither the Branch nor its linked PR has repository identity", () => {
    const row = cloudRow([
      pullRequest({
        repositoryId: null,
        repositoryFullName: null,
        repository: null,
      }),
    ]);
    row.branch = null;

    const result = projectCloudBranchAssociatedPullRequests(row);

    expect(result.collection.items).toEqual([]);
    expect(result.collection.completeness.state).toBe(
      BranchAssociatedPullRequestCompletenessState.Unavailable
    );
  });

  it("keeps foreign linked history without selecting it as the Branch default", () => {
    const row = cloudRow([
      pullRequest({
        id: "foreign",
        repositoryId: "foreign-repo",
        repositoryFullName: "other/repo",
        repository: { fullName: "other/repo" },
        number: 90,
      }),
    ]);

    const foreign = projectCloudOwnedBranchAssociatedPullRequests(row);
    expect(foreign.collection.items.map(({ number }) => number)).toEqual([90]);
    expect(foreign.collection.selectedId).toBeNull();
    expect(foreign.selected).toBeNull();

    const owned = projectCloudOwnedBranchAssociatedPullRequests(
      cloudRow([
        pullRequest({
          id: "owned",
          number: 91,
          repositoryFullName: "stale/repository-name",
          repository: {
            fullName: "stale/repository-name",
            githubRepoId: "gh-repo-1",
          },
        }),
      ])
    );
    expect(owned.collection.selectedId).toBe("stale/repository-name#91");
    expect(owned.selected?.source.id).toBe("owned");
  });

  it("follows the provider repository id across rename and reinstall rows", () => {
    const row = cloudRow([
      pullRequest({
        id: "renamed-reinstall",
        repositoryId: "repo-reinstalled",
        repositoryFullName: "closedloop-ai/symphony-renamed",
        repository: {
          fullName: "closedloop-ai/symphony-renamed",
          githubRepoId: "gh-repo-1",
        },
      }),
    ]);

    const result = projectCloudOwnedBranchAssociatedPullRequests(row);

    expect(result.selected?.source.id).toBe("renamed-reinstall");
  });

  it("rejects matching names when provider repository ids conflict", () => {
    const row = cloudRow([
      pullRequest({
        id: "provider-conflict",
        repository: {
          fullName: "closedloop-ai/closedloop-ai",
          githubRepoId: "gh-repo-2",
        },
      }),
    ]);

    const result = projectCloudOwnedBranchAssociatedPullRequests(row);

    expect(result.selected).toBeNull();
  });

  it("falls back to normalized repository names when an installation id is absent", () => {
    const matching = projectCloudOwnedBranchAssociatedPullRequests(
      cloudRow([
        pullRequest({
          id: "repo-less",
          repositoryId: null,
          repositoryFullName: "ClosedLoop-AI/ClosedLoop-AI.git",
          repository: null,
        }),
      ])
    );
    expect(matching.selected?.source.id).toBe("repo-less");

    const foreign = projectCloudOwnedBranchAssociatedPullRequests(
      cloudRow([
        pullRequest({
          id: "repo-less-foreign",
          repositoryId: null,
          repositoryFullName: "other/repo",
          repository: null,
        }),
      ])
    );
    expect(foreign.selected).toBeNull();
  });

  it("does not select a default without Branch repository identity", () => {
    const missingBranch = cloudRow([pullRequest({ id: "candidate" })]);
    missingBranch.branch = null;
    expect(
      projectCloudOwnedBranchAssociatedPullRequests(missingBranch).selected
    ).toBeNull();

    const missingBranchName = cloudRow([
      pullRequest({
        id: "repo-less-candidate",
        repositoryId: null,
        repositoryFullName: "other/repo",
        repository: null,
      }),
    ]);
    if (!missingBranchName.branch) {
      throw new Error("Expected the fixture to include Branch identity");
    }
    missingBranchName.branch.repositoryId = null;
    missingBranchName.branch.repositoryFullName = null;
    missingBranchName.branch.repository = null;
    expect(
      projectCloudOwnedBranchAssociatedPullRequests(missingBranchName).selected
    ).toBeNull();
  });

  /**
   * The candidate this projection builds and the collection item the selector
   * derives from it describe ONE pull request, so they may not report two
   * different repositories for it. Building the four-source chain here by hand
   * left the candidate carrying whatever was persisted while only the item was
   * normalized; routing it through the shared owner keeps both answers the
   * same, and keeps a later precedence change in that owner from reaching three
   * lanes and missing this one.
   */
  it("reports one repository identity for the selected PR on both the candidate and its item", () => {
    const row = cloudRow([
      pullRequest({
        id: "active",
        number: 12,
        repositoryFullName: "ClosedLoop-AI/ClosedLoop-AI.git",
        repository: null,
      }),
    ]);

    const result = projectCloudBranchAssociatedPullRequests(row);

    const selectedItem = result.collection.items.find(
      ({ id }) => id === result.collection.selectedId
    );
    expect(selectedItem?.repositoryFullName).toBe(
      "closedloop-ai/closedloop-ai"
    );
    expect(result.selected?.repositoryFullName).toBe(
      selectedItem?.repositoryFullName
    );
  });

  it("keeps an earlier snapshot's evidence when a factless re-sync of the same PR arrives", () => {
    // ONE pull request, two snapshots. The newer carries nothing; the older
    // carries LOC, so the PR was observed. Selection already resolves that
    // across snapshots — re-deriving observation from the newest RAW row made
    // the row report no state for a PR selection had accepted as observed
    // (davetho on #6313).
    const row = cloudRow([
      pullRequest({
        id: "observed-snapshot",
        number: 12,
        title: null,
        additions: 120,
        deletions: 4,
        githubCreatedAt: null,
        lastVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
      }),
      pullRequest({
        id: "factless-resync",
        number: 12,
        title: null,
        githubCreatedAt: null,
        lastVerifiedAt: NOW,
      }),
    ]);

    const result = projectCloudOwnedBranchAssociatedPullRequests(row);

    expect(result.selected?.source.id).toBe("factless-resync");
    expect(result.selected?.lifecycleObserved).toBe(true);
    expect(statusForSelectedCloudPullRequest("OPEN", result.selected)).toBe(
      BranchStatus.Open
    );
    expect(
      observedPrStateForSelectedCloudPullRequest(result.selected ?? null)
    ).toBe(GitHubPRState.Open);
  });

  it("reads a draft flag and a changed-file count as observations", () => {
    // Both columns can only hold these values because a producer wrote them:
    // `is_draft` defaults to false, and `changed_files` is nullable. Excluding
    // either made the row unwitnessed to the projection while the Draft filter
    // still selected on `is_draft = TRUE` (davetho on #6313).
    const draftOnly = projectCloudOwnedBranchAssociatedPullRequests(
      cloudRow([
        pullRequest({
          id: "draft-only",
          isDraft: true,
          title: null,
          githubCreatedAt: null,
        }),
      ])
    );
    expect(draftOnly.selected?.lifecycleObserved).toBe(true);
    expect(statusForSelectedCloudPullRequest("OPEN", draftOnly.selected)).toBe(
      BranchStatus.Draft
    );

    const changedFilesOnly = projectCloudOwnedBranchAssociatedPullRequests(
      cloudRow([
        pullRequest({
          id: "changed-files-only",
          changedFiles: 3,
          title: null,
          githubCreatedAt: null,
        }),
      ])
    );
    expect(changedFilesOnly.selected?.lifecycleObserved).toBe(true);
    expect(
      observedPrStateForSelectedCloudPullRequest(
        changedFilesOnly.selected ?? null
      )
    ).toBe(GitHubPRState.Open);

    const factless = projectCloudOwnedBranchAssociatedPullRequests(
      cloudRow([
        pullRequest({ id: "factless", title: null, githubCreatedAt: null }),
      ])
    );
    expect(factless.selected?.lifecycleObserved).toBe(false);
    expect(
      observedPrStateForSelectedCloudPullRequest(factless.selected ?? null)
    ).toBeNull();
  });

  it("preserves detail-only review evidence on a historical selection", () => {
    const row = cloudRow([
      pullRequest({
        id: "merged",
        number: 7,
        prState: GitHubPRState.Merged,
        mergedAt: new Date("2026-08-02T00:00:00.000Z"),
        reviews: [
          {
            githubReviewId: "review-1",
            authorLogin: "reviewer",
            authorAvatarUrl: null,
            state: ReviewDecision.Approved,
            htmlUrl: null,
            submittedAt: NOW,
          },
        ],
      }),
    ]);

    const result = projectCloudOwnedBranchAssociatedPullRequests(row);

    expect(result.collection.selectedId).toBe("closedloop-ai/closedloop-ai#7");
    expect(result.selected?.source.reviews).toHaveLength(1);
  });
});

type TestPullRequest = CloudPullRequestProjectionInput & {
  id: string;
  reviews: {
    githubReviewId: string;
    authorLogin: string;
    authorAvatarUrl: string | null;
    state: ReviewDecision;
    htmlUrl: string | null;
    submittedAt: Date;
  }[];
};

function cloudRow<Detail extends CloudPullRequestProjectionInput>(
  pullRequestDetails: readonly Detail[]
): CloudBranchProjectionInput<Detail> {
  return {
    id: "branch-1",
    branch: {
      repositoryId: "repo-1",
      repositoryFullName: "closedloop-ai/closedloop-ai",
      repository: {
        fullName: "closedloop-ai/closedloop-ai",
        githubRepoId: "gh-repo-1",
      },
    },
    pullRequestDetails,
  };
}

function pullRequest(
  overrides: Partial<TestPullRequest> = {}
): TestPullRequest {
  return {
    id: "pr-1",
    branchArtifactId: "branch-1",
    repositoryId: "repo-1",
    repositoryFullName: "closedloop-ai/closedloop-ai",
    repository: {
      fullName: "closedloop-ai/closedloop-ai",
      githubRepoId: "gh-repo-1",
    },
    number: 1,
    title: "Pull request",
    htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/1",
    prState: GitHubPRState.Open,
    isDraft: false,
    reviewDecision: null,
    githubCreatedAt: NOW,
    closedAt: null,
    mergedAt: null,
    lastVerifiedAt: NOW,
    additions: null,
    deletions: null,
    changedFiles: null,
    reviews: [],
    ...overrides,
  };
}
