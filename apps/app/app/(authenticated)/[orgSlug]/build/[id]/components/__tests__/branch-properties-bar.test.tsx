import {
  BranchViewCheckKind,
  BranchViewChecksProviderState,
  BranchViewSyncOutcomeSource,
  BranchViewSyncPresentationState,
  BranchViewSyncThrottleReason,
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-view";
import {
  GitHubPRState,
  StatusCheckRollupFailureReason,
} from "@repo/api/src/types/github";
import type { BranchViewSyncControl } from "@repo/app/documents/hooks/use-branch-view";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchViewData } from "../../types";
import { BranchPropertiesBar } from "../branch-properties-bar";

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: () => ({ data: null }),
}));

const SYNCED_LABEL_REGEX = /^Synced /;
const REFRESH_PR_BUTTON_NAME = "Refresh PR status and comments from GitHub";
const UNIT_TESTS_MENUITEM_NAME_REGEX = /Unit testsFailure/i;
const DEPLOYMENT_GATE_MENUITEM_NAME_REGEX = /Deployment gatePending/i;

function branchViewData(
  overrides: Partial<BranchViewData> = {}
): BranchViewData {
  const prState = overrides.prState ?? GitHubPRState.Open;
  const isDraft = overrides.isDraft ?? false;

  return {
    authorLogin: null,
    baseBranch: "main",
    branch: null,
    canCreateConversationComment: false,
    canCreateInlineComment: false,
    checksStatus: null,
    comments: [],
    committedFiles: [],
    currentPullRequest: {
      baseBranch: "main",
      checksStatus: null,
      githubId: "1001",
      headBranch: "feat/test",
      headSha: null,
      htmlUrl: "https://github.com/acme/repo/pull/1",
      id: "pr-detail-1",
      isDraft,
      number: 1,
      reviewDecision: null,
      state: prState,
      title: "Test PR",
    },
    externalLinkId: "ext-1",
    externalUrl: "https://github.com/acme/repo/pull/1",
    featureSlug: null,
    featureTitle: null,
    headBranch: "feat/test",
    headSha: null,
    isAuthor: false,
    isDraft,
    prHtmlUrl: "https://github.com/acme/repo/pull/1",
    prNumber: 1,
    prState,
    prTitle: "Test PR",
    producedByPlanSlug: null,
    producedByPlanTitle: null,
    projectId: null,
    projectName: null,
    repoFullName: "acme/repo",
    reviewDecision: null,
    reviews: [],
    teamId: null,
    teamName: null,
    ...overrides,
  };
}

function syncControl(): BranchViewSyncControl {
  return {
    syncRetryState: null,
    isBranchSyncPending: false,
    isCommentsSyncPending: false,
    refreshBranch: vi.fn(),
    refreshComments: vi.fn(),
  };
}

function checksProjection(
  overrides: Partial<NonNullable<BranchViewData["checks"]>> = {}
): NonNullable<BranchViewData["checks"]> {
  return {
    headSha: "a".repeat(40),
    items: [
      {
        conclusion: "FAILURE",
        id: "node:failure",
        kind: BranchViewCheckKind.CheckRun,
        name: "Unit tests",
        status: "COMPLETED",
        targetUrl: "https://github.com/acme/repo/actions/runs/1",
      },
      {
        conclusion: null,
        id: "context:deploy:0",
        kind: BranchViewCheckKind.StatusContext,
        name: "Deployment gate",
        status: "PENDING",
        targetUrl: null,
      },
    ],
    providerState: BranchViewChecksProviderState.Available,
    totalCount: 2,
    truncated: false,
    unavailableReason: null,
    ...overrides,
  };
}

describe("BranchPropertiesBar PR lifecycle badge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a closed PR as Closed instead of Draft when draft metadata is stale", () => {
    render(
      <BranchPropertiesBar
        data={branchViewData({
          checksStatus: ChecksStatus.Failing,
          isDraft: true,
          prState: GitHubPRState.Closed,
          reviewDecision: null,
        })}
        syncControl={syncControl()}
      />
    );

    expect(screen.getByText("Closed")).toBeInTheDocument();
    expect(screen.queryByText("Draft")).not.toBeInTheDocument();
    expect(screen.queryByText("Checks failing")).not.toBeInTheDocument();
  });

  it("shows secondary PR status while the lifecycle is Open or Draft", () => {
    const { rerender } = render(
      <BranchPropertiesBar
        data={branchViewData({
          checksStatus: ChecksStatus.Failing,
          prState: GitHubPRState.Open,
        })}
        syncControl={syncControl()}
      />
    );

    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("Checks failing")).toBeInTheDocument();

    rerender(
      <BranchPropertiesBar
        data={branchViewData({
          checksStatus: ChecksStatus.Failing,
          isDraft: true,
          prState: GitHubPRState.Open,
        })}
        syncControl={syncControl()}
      />
    );

    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("Checks failing")).toBeInTheDocument();

    rerender(
      <BranchPropertiesBar
        data={branchViewData({
          checksStatus: ChecksStatus.Failing,
          isDraft: true,
          prState: GitHubPRState.Closed,
        })}
        syncControl={syncControl()}
      />
    );

    expect(screen.getByText("Closed")).toBeInTheDocument();
    expect(screen.queryByText("Draft")).not.toBeInTheDocument();
    expect(screen.queryByText("Checks failing")).not.toBeInTheDocument();

    rerender(
      <BranchPropertiesBar
        data={branchViewData({
          isDraft: true,
          prState: GitHubPRState.Merged,
          reviewDecision: ReviewDecision.Approved,
        })}
        syncControl={syncControl()}
      />
    );

    expect(screen.getByText("Merged")).toBeInTheDocument();
    expect(screen.queryByText("Draft")).not.toBeInTheDocument();
    expect(screen.queryByText("Approved")).not.toBeInTheDocument();
  });

  it("keeps checks details visible for draft PRs and hides them for terminal lifecycles", () => {
    const { rerender } = render(
      <BranchPropertiesBar
        data={branchViewData({
          checks: checksProjection(),
          checksStatus: ChecksStatus.Failing,
          isDraft: true,
          prState: GitHubPRState.Open,
        })}
        syncControl={syncControl()}
      />
    );

    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Checks failing details" })
    ).toBeInTheDocument();

    rerender(
      <BranchPropertiesBar
        data={branchViewData({
          checks: checksProjection(),
          checksStatus: ChecksStatus.Failing,
          prState: GitHubPRState.Closed,
        })}
        syncControl={syncControl()}
      />
    );

    expect(screen.getByText("Closed")).toBeInTheDocument();
    expect(screen.queryByText("Checks failing")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Checks failing details" })
    ).not.toBeInTheDocument();

    rerender(
      <BranchPropertiesBar
        data={branchViewData({
          checks: checksProjection(),
          checksStatus: ChecksStatus.Failing,
          prState: GitHubPRState.Merged,
          reviewDecision: ReviewDecision.Approved,
        })}
        syncControl={syncControl()}
      />
    );

    expect(screen.getByText("Merged")).toBeInTheDocument();
    expect(screen.queryByText("Checks failing")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Checks failing details" })
    ).not.toBeInTheDocument();
  });

  it("uses lifecycle freshness when the aggregate state reflects file-cache failure", () => {
    render(
      <BranchPropertiesBar
        data={branchViewData({
          syncState: {
            backgroundRefreshAfterAt: "2026-05-27T17:05:00.000Z",
            branchLastAttemptedAt: "2026-05-27T17:00:00.000Z",
            branchLastSyncedAt: "2026-05-27T16:55:00.000Z",
            inProgress: false,
            lastOutcome: {
              code: "compare_failed",
              httpStatus: 500,
              message: "Could not refresh file changes from GitHub.",
              retryAfterSeconds: null,
              source: BranchViewSyncOutcomeSource.FileCache,
              synced: false,
            },
            lifecycleLastAttemptedAt: "2026-05-27T16:55:00.000Z",
            lifecycleLastSyncedAt: "2026-05-27T16:55:00.000Z",
            presentation: BranchViewSyncPresentationState.Failed,
          },
        })}
        syncControl={syncControl()}
      />
    );

    expect(screen.getByText(SYNCED_LABEL_REGEX)).toBeInTheDocument();
    expect(screen.queryByText("Refresh failed")).not.toBeInTheDocument();
  });

  it("preserves legacy badge-only rendering when optional syncState is omitted", () => {
    render(
      <BranchPropertiesBar
        data={branchViewData({
          checksStatus: ChecksStatus.Failing,
          prState: GitHubPRState.Open,
        })}
        syncControl={syncControl()}
      />
    );

    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("Checks failing")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Checks failing details" })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Sync status unknown")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: REFRESH_PR_BUTTON_NAME })
    ).not.toBeInTheDocument();
  });

  it("removes the local rate-limit overlay when it clears without server syncState", () => {
    const { rerender } = render(
      <BranchPropertiesBar
        data={branchViewData()}
        syncControl={{
          ...syncControl(),
          syncRetryState: {
            retryAfterSeconds: 2,
            throttleReason: BranchViewSyncThrottleReason.ProviderRateLimit,
          },
        }}
      />
    );

    expect(
      screen.getByRole("button", { name: REFRESH_PR_BUTTON_NAME })
    ).toBeDisabled();

    rerender(
      <BranchPropertiesBar
        data={branchViewData()}
        syncControl={syncControl()}
      />
    );

    expect(
      screen.queryByRole("button", { name: REFRESH_PR_BUTTON_NAME })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Sync status unknown")).not.toBeInTheDocument();
  });

  it.each([
    [BranchViewSyncThrottleReason.LocalDedupe, "Refresh available in 6s"],
    [
      BranchViewSyncThrottleReason.InFlight,
      "Refresh already running. Try again in 6s",
    ],
    [
      BranchViewSyncThrottleReason.ProviderRateLimit,
      "GitHub rate limited. Try again in 6s",
    ],
    ["future_reason", "Try again in 6s"],
  ])("renders the %s retry label in the freshness chip", (reason, label) => {
    render(
      <BranchPropertiesBar
        data={branchViewData()}
        syncControl={{
          ...syncControl(),
          syncRetryState: {
            retryAfterSeconds: 6,
            throttleReason: reason as BranchViewSyncThrottleReason,
          },
        }}
      />
    );

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: REFRESH_PR_BUTTON_NAME })
    ).toBeDisabled();
  });

  it("disables branch refresh while projected sync state is refreshing", () => {
    render(
      <BranchPropertiesBar
        data={branchViewData({
          syncState: {
            backgroundRefreshAfterAt: null,
            branchLastAttemptedAt: "2026-05-27T17:00:00.000Z",
            branchLastSyncedAt: "2026-05-27T16:55:00.000Z",
            inProgress: true,
            lastOutcome: {
              code: null,
              httpStatus: null,
              message: null,
              retryAfterSeconds: null,
              source: null,
              synced: null,
            },
            lifecycleLastAttemptedAt: "2026-05-27T16:55:00.000Z",
            lifecycleLastSyncedAt: "2026-05-27T16:55:00.000Z",
            presentation: BranchViewSyncPresentationState.Refreshing,
          },
        })}
        syncControl={syncControl()}
      />
    );

    expect(screen.getByText("Refreshing")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: REFRESH_PR_BUTTON_NAME })
    ).toBeDisabled();
  });

  it("shows refreshing instead of a stale synced label while coordinated comments sync is pending", () => {
    const { rerender } = render(
      <BranchPropertiesBar
        data={branchViewData({
          syncState: {
            backgroundRefreshAfterAt: "2026-05-27T17:05:00.000Z",
            branchLastAttemptedAt: "2026-05-27T17:00:00.000Z",
            branchLastSyncedAt: "2026-05-27T17:00:00.000Z",
            inProgress: false,
            lastOutcome: {
              code: null,
              httpStatus: null,
              message: null,
              retryAfterSeconds: null,
              source: BranchViewSyncOutcomeSource.BranchSync,
              synced: true,
            },
            lifecycleLastAttemptedAt: "2026-05-27T17:00:00.000Z",
            lifecycleLastSyncedAt: "2026-05-27T17:00:00.000Z",
            presentation: BranchViewSyncPresentationState.Fresh,
          },
        })}
        syncControl={{ ...syncControl(), isCommentsSyncPending: true }}
      />
    );

    expect(screen.getByText("Refreshing")).toBeInTheDocument();
    expect(screen.queryByText(SYNCED_LABEL_REGEX)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: REFRESH_PR_BUTTON_NAME })
    ).toBeDisabled();

    rerender(
      <BranchPropertiesBar
        data={branchViewData({
          syncState: {
            backgroundRefreshAfterAt: "2026-05-27T17:05:00.000Z",
            branchLastAttemptedAt: "2026-05-27T17:00:00.000Z",
            branchLastSyncedAt: "2026-05-27T17:00:00.000Z",
            inProgress: false,
            lastOutcome: {
              code: null,
              httpStatus: null,
              message: null,
              retryAfterSeconds: null,
              source: BranchViewSyncOutcomeSource.BranchSync,
              synced: true,
            },
            lifecycleLastAttemptedAt: "2026-05-27T17:00:00.000Z",
            lifecycleLastSyncedAt: "2026-05-27T17:00:00.000Z",
            presentation: BranchViewSyncPresentationState.Fresh,
          },
        })}
        syncControl={syncControl()}
      />
    );

    expect(screen.getByText(SYNCED_LABEL_REGEX)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: REFRESH_PR_BUTTON_NAME })
    ).toBeEnabled();
  });

  it("opens check details from a checks-owned status chip", async () => {
    const user = userEvent.setup();
    render(
      <BranchPropertiesBar
        data={branchViewData({
          checks: checksProjection({ totalCount: 4, truncated: true }),
          checksStatus: ChecksStatus.Failing,
          prState: GitHubPRState.Open,
        })}
        syncControl={syncControl()}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Checks failing details" })
    );

    expect(screen.getByText("Unit tests")).toBeInTheDocument();
    expect(screen.getByText("Deployment gate")).toBeInTheDocument();
    expect(screen.getByText("Showing 2 of 4 checks")).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: UNIT_TESTS_MENUITEM_NAME_REGEX })
    ).toHaveAttribute("href", "https://github.com/acme/repo/actions/runs/1");
    expect(
      screen.getByRole("menuitem", {
        name: DEPLOYMENT_GATE_MENUITEM_NAME_REGEX,
      })
    ).not.toHaveAttribute("href");
  });

  it("renders no-checks and provider-unavailable menu states", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <BranchPropertiesBar
        data={branchViewData({
          checks: checksProjection({
            items: [],
            providerState: BranchViewChecksProviderState.NoChecks,
            totalCount: 0,
          }),
          checksStatus: ChecksStatus.Unknown,
          prState: GitHubPRState.Open,
        })}
        syncControl={syncControl()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Checks details" }));
    expect(screen.getByText("No checks configured")).toBeInTheDocument();

    rerender(
      <BranchPropertiesBar
        data={branchViewData({
          checks: checksProjection({
            items: [],
            providerState: BranchViewChecksProviderState.ProviderUnavailable,
            totalCount: 0,
            unavailableReason: StatusCheckRollupFailureReason.RateLimited,
          }),
          checksStatus: ChecksStatus.Failing,
          prState: GitHubPRState.Open,
        })}
        syncControl={syncControl()}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Checks failing details" })
    );
    expect(screen.getByText("Check details unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Unit tests")).not.toBeInTheDocument();
  });

  it("renders checks details when no secondary PR status is selected", async () => {
    const user = userEvent.setup();
    render(
      <BranchPropertiesBar
        data={branchViewData({
          checks: checksProjection({
            providerState: BranchViewChecksProviderState.NoChecks,
            items: [],
            totalCount: 0,
          }),
          checksStatus: ChecksStatus.Unknown,
          prState: GitHubPRState.Open,
          reviewDecision: ReviewDecision.Dismissed,
        })}
        syncControl={syncControl()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Checks details" }));
    expect(screen.getByText("No checks configured")).toBeInTheDocument();
  });

  it("keeps review-owned chip text and renders a separate passing checks trigger", async () => {
    const user = userEvent.setup();
    render(
      <BranchPropertiesBar
        data={branchViewData({
          checks: checksProjection({
            items: [
              {
                conclusion: "SUCCESS",
                id: "node:success",
                kind: BranchViewCheckKind.CheckRun,
                name: "All checks",
                status: "COMPLETED",
                targetUrl: null,
              },
            ],
          }),
          checksStatus: ChecksStatus.Passing,
          prState: GitHubPRState.Open,
          reviewDecision: ReviewDecision.Approved,
        })}
        syncControl={syncControl()}
      />
    );

    expect(screen.getByText("Approved")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Checks passing details" })
    );
    expect(screen.getByText("All checks")).toBeInTheDocument();
  });
});
