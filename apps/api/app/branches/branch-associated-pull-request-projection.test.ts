import {
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  type CloudBranchProjectionInput,
  type CloudPullRequestProjectionInput,
  projectCloudBranchAssociatedPullRequests,
  projectCloudBranchDetailAssociatedPullRequests,
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

    const result = projectCloudBranchDetailAssociatedPullRequests(row);

    expect(result.collection.selectedId).toBe("closedloop-ai/symphony-alpha#7");
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
      repositoryFullName: "closedloop-ai/symphony-alpha",
      repository: { fullName: "closedloop-ai/symphony-alpha" },
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
    repositoryFullName: "closedloop-ai/symphony-alpha",
    repository: { fullName: "closedloop-ai/symphony-alpha" },
    number: 1,
    title: "Pull request",
    htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/1",
    prState: GitHubPRState.Open,
    isDraft: false,
    reviewDecision: null,
    githubCreatedAt: NOW,
    closedAt: null,
    mergedAt: null,
    lastVerifiedAt: NOW,
    reviews: [],
    ...overrides,
  };
}
