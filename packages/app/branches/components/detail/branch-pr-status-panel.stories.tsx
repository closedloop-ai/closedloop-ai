import { BranchStatus } from "@repo/api/src/types/branch";
import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import {
  branchSelectedPullRequestChecksEvidenceUnavailable,
  projectBranchSelectedPullRequestChecks,
} from "@repo/api/src/types/branch-selected-pull-request-checks";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  SelectedPullRequestCheckCategory,
  type SelectedPullRequestCheckCategory as SelectedPullRequestCheckCategoryType,
  SelectedPullRequestCheckSourceKind,
  SelectedPullRequestChecksCompleteness,
  SelectedPullRequestChecksHistoryMode,
  SelectedPullRequestChecksPartialReason,
} from "@repo/api/src/types/selected-pull-request-checks-evidence";
import {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import type { Meta, StoryObj } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import { makeBranchDetail } from "../../__tests__/branch-fixtures";
import { BranchPrStatusPanel } from "./branch-pr-status-panel";

const HEAD_SHA = "b".repeat(40);
const CHECKS_BUTTON_NAME = /checks/i;

// Truthfulness matrix for selected-PR lifecycle, review, and check evidence.
// The expanded partial story makes the required `*` disclosure and external
// check-link geometry visible rather than leaving it to unit assertions.
/**
 * The Checks and Review panel on a branch's detail page, showing a pull
 * request's lifecycle, review decision, and CI status without opening
 * GitHub.
 */
const meta = {
  title: "Composites/Branches/Branch PR Status Panel",
  component: BranchPrStatusPanel,
  tags: ["autodocs"],
  argTypes: {
    detail: {
      control: "object",
      description:
        "Branch projection. The panel renders nothing without `selectedPullRequest`, and `selectedPullRequestChecks` carries the check evidence and its coverage.",
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[420px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BranchPrStatusPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Passing: Story = {
  args: {
    detail: selectedDetail([
      SelectedPullRequestCheckCategory.Successful,
      SelectedPullRequestCheckCategory.Successful,
    ]),
  },
};

export const Failing: Story = {
  args: {
    detail: selectedDetail([
      SelectedPullRequestCheckCategory.Successful,
      SelectedPullRequestCheckCategory.Failing,
    ]),
  },
};

export const Pending: Story = {
  args: {
    detail: selectedDetail([
      SelectedPullRequestCheckCategory.Successful,
      SelectedPullRequestCheckCategory.Pending,
    ]),
  },
};

export const ExpandedIncompleteCoverage: Story = {
  args: {
    detail: selectedDetail(
      [SelectedPullRequestCheckCategory.Successful],
      SelectedPullRequestChecksCompleteness.Partial
    ),
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: CHECKS_BUTTON_NAME })
    );
  },
};

export const Unavailable: Story = {
  args: {
    detail: selectedDetail([], undefined, true),
  },
};

export const NoSelectedPullRequest: Story = {
  args: {
    detail: makeBranchDetail({ selectedPullRequest: null }),
  },
};

function selectedDetail(
  categories: SelectedPullRequestCheckCategoryType[],
  completeness: SelectedPullRequestChecksCompleteness = SelectedPullRequestChecksCompleteness.Complete,
  unavailable = false
) {
  const selectedPullRequestChecks = unavailable
    ? branchSelectedPullRequestChecksEvidenceUnavailable({
        status: SelectedPullRequestEvidenceAvailability.Unavailable,
        reason: SelectedPullRequestEvidenceUnavailableReason.ProviderFailure,
      }).response
    : projectBranchSelectedPullRequestChecks(
        checksEvidence(categories, completeness)
      ).response;
  return makeBranchDetail({
    status: BranchStatus.Open,
    selectedPullRequest: {
      id: "octo/repo#42",
      repositoryFullName: "octo/repo",
      number: 42,
      title: "Ship Branch details",
      url: "https://github.com/octo/repo/pull/42",
      state: GitHubPRState.Open,
      isDraft: false,
      reviewDecision: ReviewDecision.Approved,
      openedAt: "2026-08-01T00:00:00.000Z",
      closedAt: null,
      mergedAt: null,
      body: "Description",
      headRefOid: HEAD_SHA,
      mergeCommitSha: null,
      changedFiles: 3,
      additions: 18,
      deletions: 4,
    },
    selectedPullRequestChecks,
  });
}

function checksEvidence(
  categories: SelectedPullRequestCheckCategoryType[],
  completeness:
    | typeof SelectedPullRequestChecksCompleteness.Complete
    | typeof SelectedPullRequestChecksCompleteness.Partial
) {
  const expected =
    categories.length +
    (completeness === SelectedPullRequestChecksCompleteness.Partial ? 1 : 0);
  return {
    identity: {
      githubId: "PR_kwDOtest",
      repositoryFullName: "octo/repo",
      number: 42,
      url: "https://github.com/octo/repo/pull/42",
    },
    revision: { headSha: HEAD_SHA },
    checks: categories.map((category, index) => ({
      providerId: `check-${index + 1}`,
      sourceIdentity: `check-${index + 1}`,
      sourceKind: SelectedPullRequestCheckSourceKind.CheckRun,
      sourceApp: null,
      name: checkName(category),
      providerStatus:
        category === SelectedPullRequestCheckCategory.Pending
          ? "in_progress"
          : "completed",
      providerConclusion: providerConclusion(category),
      category,
      createdAt: null,
      startedAt: null,
      completedAt: null,
      targetUrl: `https://github.com/octo/repo/actions/runs/${index + 1}`,
    })),
    counts: {
      providerExpected: expected,
      providerReturned: categories.length,
      normalizedAttempts: categories.length,
      emitted: categories.length,
      total: expected,
      successful: countCategory(
        categories,
        SelectedPullRequestCheckCategory.Successful
      ),
      failing: countCategory(
        categories,
        SelectedPullRequestCheckCategory.Failing
      ),
      pending: countCategory(
        categories,
        SelectedPullRequestCheckCategory.Pending
      ),
      neutral: countCategory(
        categories,
        SelectedPullRequestCheckCategory.Neutral
      ),
    },
    pagination: {
      pageSize: 100,
      pagesFetched: 1,
      acquisitionMaximum: 500,
      reachedAcquisitionMaximum: false,
    },
    history: {
      mode: SelectedPullRequestChecksHistoryMode.LatestPerSourceFromProviderRollup,
      providerLimit: null,
      rawAttempts: categories.length,
      emittedSources: categories.length,
    },
    coverage: {
      completeness,
      reasons:
        completeness === SelectedPullRequestChecksCompleteness.Partial
          ? [SelectedPullRequestChecksPartialReason.CountMismatch]
          : [],
    },
  };
}

function countCategory(
  categories: SelectedPullRequestCheckCategoryType[],
  category: SelectedPullRequestCheckCategoryType
) {
  return categories.filter((value) => value === category).length;
}

function checkName(category: SelectedPullRequestCheckCategoryType) {
  switch (category) {
    case SelectedPullRequestCheckCategory.Failing:
      return "Unit tests";
    case SelectedPullRequestCheckCategory.Pending:
      return "Desktop E2E";
    case SelectedPullRequestCheckCategory.Successful:
      return "Build";
    case SelectedPullRequestCheckCategory.Neutral:
      return "Advisory scan";
    default:
      return assertNever(category);
  }
}

function providerConclusion(category: SelectedPullRequestCheckCategoryType) {
  switch (category) {
    case SelectedPullRequestCheckCategory.Failing:
      return "failure";
    case SelectedPullRequestCheckCategory.Pending:
      return null;
    case SelectedPullRequestCheckCategory.Successful:
      return "success";
    case SelectedPullRequestCheckCategory.Neutral:
      return "neutral";
    default:
      return assertNever(category);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled selected pull request check category: ${value}`);
}
