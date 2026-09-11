import {
  BranchSelectedPullRequestCompletenessUnavailableReason,
  BranchSelectedPullRequestFileCompleteness,
  BranchSelectedPullRequestFilePartialReason,
  type BranchSelectedPullRequestFilesResponse,
  BranchSelectedPullRequestGrossTotalAvailability,
  BranchSelectedPullRequestReadAvailability,
} from "@repo/api/src/types/branch-selected-pull-request-files";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { SelectedPullRequestFileStatus } from "@repo/api/src/types/selected-pull-request-evidence";
import type { Meta, StoryObj } from "@storybook/react";
import { fn, userEvent, within } from "storybook/test";
import { makeBranchDetail } from "../../__tests__/branch-fixtures";
import { BranchFilesChangedPanel } from "./branch-files-changed-panel";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const FILE_ROW_NAME = /src\/index\.ts/i;

const diffRoutes = [
  {
    method: "GET",
    path: "/branches/branch-1/selected-pull-request/diff",
    respond: () => ({
      status: BranchSelectedPullRequestReadAvailability.Available,
      value: {
        identity: {
          githubId: "PR_kwDOtest",
          repositoryFullName: "octo/repo",
          number: 42,
          url: "https://github.com/octo/repo/pull/42",
        },
        revision: { baseSha: BASE_SHA, headSha: HEAD_SHA },
        diff: {
          path: "src/index.ts",
          oldContent: "export const truthful = false;\n",
          newContent: "export const truthful = true;\n",
          isNew: false,
          isDeleted: false,
          isBinary: false,
        },
      },
    }),
  },
];

// Selected-PR file evidence matrix. These stories keep loading, failure,
// known-zero, incomplete, and unavailable states visually distinct and make
// the immutable inline-diff interaction reviewable without a live API.
/**
 * The 'Files changed' list on a branch's detail page, scoped to the pull
 * request currently selected on that branch. Each row is a file path with
 * its added and deleted line counts, and clicking a row expands an inline
 * diff pulled from GitHub, one file at a time. Use it when you need to
 * review exactly what a pull request touched without leaving the branch
 * page, rather than relying on the summary counts alone. If GitHub only
 * returned part of the file list, the header marks the totals with an
 * asterisk and explains why, and if the read fails outright it shows a Retry
 * button instead of a file list.
 */
const meta = {
  title: "Composites/Branches/Branch Files Changed Panel",
  component: BranchFilesChangedPanel,
  tags: ["autodocs"],
  parameters: { appCore: { apiRoutes: diffRoutes } },
  decorators: [
    (Story) => (
      <div className="w-[720px] p-4">
        <Story />
      </div>
    ),
  ],
  argTypes: {
    branchId: {
      control: "text",
      description: "Branch the diff query reads. Falls back to `detail.id`.",
    },
    detail: { control: "object" },
    filesError: { control: "boolean" },
    filesLoading: { control: "boolean" },
    filesResponse: {
      control: "object",
      description:
        "Bounded file evidence. `coverage.completeness` and `grossTotals` drive the disclosures, not the row count.",
    },
    onRetry: {
      control: false,
      description:
        "Omit to render the unavailable state without a Retry button.",
      table: { category: "Events" },
    },
    queryIdentity: { control: "object" },
  },
  args: {
    branchId: "branch-1",
    detail: selectedDetail(),
    filesError: false,
    filesLoading: false,
  },
} satisfies Meta<typeof BranchFilesChangedPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const LoadedCollapsed: Story = {
  args: { filesResponse: filesResponse() },
};

export const LoadedWithExpandedDiff: Story = {
  args: { filesResponse: filesResponse() },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: FILE_ROW_NAME })
    );
  },
};

export const Loading: Story = {
  args: { filesLoading: true },
};

export const ErrorWithRetry: Story = {
  args: { filesError: true, onRetry: fn() },
};

export const NoSelectedPullRequest: Story = {
  args: {
    detail: makeBranchDetail({ selectedPullRequest: null }),
  },
};

export const CompleteKnownEmpty: Story = {
  args: {
    filesResponse: filesResponse(
      BranchSelectedPullRequestFileCompleteness.Complete,
      false,
      0
    ),
  },
};

export const IncompleteCoverage: Story = {
  args: {
    filesResponse: filesResponse(
      BranchSelectedPullRequestFileCompleteness.Incomplete,
      true,
      3
    ),
  },
};

export const IncompleteWithNoVerifiedRows: Story = {
  args: {
    filesResponse: filesResponse(
      BranchSelectedPullRequestFileCompleteness.Incomplete,
      false,
      3
    ),
  },
};

export const CompletenessUnavailableWithVerifiedRows: Story = {
  args: {
    filesResponse: filesResponse(
      BranchSelectedPullRequestFileCompleteness.Unavailable
    ),
  },
};

function selectedDetail() {
  return makeBranchDetail({
    selectedPullRequest: {
      id: "octo/repo#42",
      repositoryFullName: "octo/repo",
      number: 42,
      title: "Ship Branch details",
      url: "https://github.com/octo/repo/pull/42",
      state: GitHubPRState.Open,
      isDraft: false,
      reviewDecision: null,
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
  });
}

function filesResponse(
  completeness: BranchSelectedPullRequestFileCompleteness = BranchSelectedPullRequestFileCompleteness.Complete,
  includeRows = true,
  expected = 1
): BranchSelectedPullRequestFilesResponse {
  const files = includeRows
    ? [
        {
          path: "src/index.ts",
          providerStatus: "modified",
          status: SelectedPullRequestFileStatus.Modified,
          additions: 12,
          deletions: 4,
          changes: 16,
        },
      ]
    : [];
  const totalsAvailable =
    completeness !== BranchSelectedPullRequestFileCompleteness.Unavailable;
  return {
    status: BranchSelectedPullRequestReadAvailability.Available,
    value: {
      identity: {
        githubId: "PR_kwDOtest",
        repositoryFullName: "octo/repo",
        number: 42,
        url: "https://github.com/octo/repo/pull/42",
      },
      revision: { baseSha: BASE_SHA, headSha: HEAD_SHA },
      files,
      counts: {
        expected,
        loaded: files.length,
        providerExpected: expected,
        providerReturned: files.length,
      },
      coverage: coverageFor(completeness),
      grossTotals: {
        additions: totalsAvailable
          ? {
              availability:
                BranchSelectedPullRequestGrossTotalAvailability.Available,
              value: 12,
              completeness,
            }
          : {
              availability:
                BranchSelectedPullRequestGrossTotalAvailability.Unavailable,
            },
        deletions: totalsAvailable
          ? {
              availability:
                BranchSelectedPullRequestGrossTotalAvailability.Available,
              value: 4,
              completeness,
            }
          : {
              availability:
                BranchSelectedPullRequestGrossTotalAvailability.Unavailable,
            },
      },
      pagination: {
        pageSize: 100,
        pagesFetched: 1,
        providerMaximum: 500,
        reachedProviderMaximum: false,
      },
    },
  };
}

function coverageFor(
  completeness: (typeof BranchSelectedPullRequestFileCompleteness)[keyof typeof BranchSelectedPullRequestFileCompleteness]
) {
  if (completeness === BranchSelectedPullRequestFileCompleteness.Complete) {
    return { completeness, reasons: [] } as const;
  }
  if (completeness === BranchSelectedPullRequestFileCompleteness.Incomplete) {
    return {
      completeness,
      reasons: [
        BranchSelectedPullRequestFilePartialReason.PersistedExpectedCountMismatch,
      ],
    } as const;
  }
  return {
    completeness,
    reason:
      BranchSelectedPullRequestCompletenessUnavailableReason.MissingExpectedCount,
  } as const;
}
