import type { BranchPageDetail } from "@repo/api/src/types/branch";
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchViewCheckKind,
  BranchViewChecksProviderState,
} from "@repo/api/src/types/branch-check-projection";
import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import { BRANCH_DETAIL_MEASURED_CHECKS_FLAG_KEY } from "@repo/api/src/types/branch-detail-measured-checks-flag";
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
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import type { Meta, StoryObj } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import { makeBranchDetail } from "../../__tests__/branch-fixtures";
import { BranchPrStatusPanel } from "./branch-pr-status-panel";

const HEAD_SHA = "b".repeat(40);
const CHECKS_BUTTON_NAME = /checks/i;

/**
 * Truthfulness matrix for selected-PR lifecycle, review, and check evidence.
 * The expanded partial story makes the required `*` disclosure and external
 * check-link geometry visible rather than leaving it to unit assertions.
 */
const meta = {
  title: "Composites v1.0/Branches/Branch PR Status Panel",
  component: BranchPrStatusPanel,
  tags: ["deprecated", "autodocs"],
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

/**
 * ISS-8241 Half A, flag ON. The five states this box must keep apart: the four
 * non-answers, each in its own words, plus the measured population itself with
 * the rows and tally behind it — and, on that last one, the recorded-population
 * line that has to appear the moment the list in hand is short of its own count.
 * Every story below mounts the flag adapter; the stories above deliberately do
 * not, so they keep covering the flag-OFF live render that ships today.
 */
export const MeasuredConclusion: Story = {
  args: { detail: measuredDetail(ChecksStatus.Failing, measuredProjection()) },
  decorators: [withMeasuredChecksFlag],
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: CHECKS_BUTTON_NAME })
    );
  },
};

export const MeasuredNothingReported: Story = {
  args: { detail: measuredDetail(null, undefined) },
  decorators: [withMeasuredChecksFlag],
};

/**
 * The fourth non-answer: the read succeeded and counted a population, and none
 * of its rows arrived. Nothing renders beneath the line, because the rows that
 * count promised are the very thing missing.
 */
export const MeasuredRowsMissing: Story = {
  args: {
    detail: measuredDetail(ChecksStatus.Passing, {
      ...measuredProjection(),
      items: [],
    }),
  },
  decorators: [withMeasuredChecksFlag],
};

/** A population the producer capped: the tally must not read as the whole list. */
export const MeasuredTruncatedPopulation: Story = {
  args: {
    detail: measuredDetail(ChecksStatus.Failing, {
      ...measuredProjection(),
      truncated: true,
      totalCount: 40,
    }),
  },
  decorators: [withMeasuredChecksFlag],
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: CHECKS_BUTTON_NAME })
    );
  },
};

/**
 * ISS-8629, the state the ruling turns on: every row in hand passed, and the
 * population is not all here. The summary keeps its tally and its recorded-
 * population line and gives up only the GREEN, because "passing" is a claim
 * about checks nobody has fetched — Kaito, 2026-08-31. The wire says UNKNOWN
 * over this same population, and now so does the tone.
 */
export const MeasuredIncompletePassing: Story = {
  args: {
    detail: measuredDetail(ChecksStatus.Unknown, {
      ...measuredProjection(),
      totalCount: 9,
      items: measuredProjection().items.slice(0, 1),
    }),
  },
  decorators: [withMeasuredChecksFlag],
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: CHECKS_BUTTON_NAME })
    );
  },
};

/**
 * ISS-8629, the capped population: the producer stopped counting, so every row
 * it counted is in hand and its total is still a floor. "1 of 1 recorded checks"
 * would tell the reader everything is here under a tone withheld because it is
 * not, so this state says so in its own words instead.
 */
export const MeasuredCappedPopulation: Story = {
  args: {
    detail: measuredDetail(ChecksStatus.Unknown, {
      ...measuredProjection(),
      totalCount: 1,
      truncated: true,
      items: measuredProjection().items.slice(0, 1),
    }),
  },
  decorators: [withMeasuredChecksFlag],
};

export const MeasuredEmptyPopulation: Story = {
  args: {
    detail: measuredDetail(ChecksStatus.Unknown, {
      ...measuredProjection(),
      providerState: BranchViewChecksProviderState.NoChecks,
      totalCount: 0,
      items: [],
    }),
  },
  decorators: [withMeasuredChecksFlag],
};

export const MeasuredProviderReadFailed: Story = {
  args: {
    detail: measuredDetail(ChecksStatus.Passing, {
      ...measuredProjection(),
      providerState: BranchViewChecksProviderState.ProviderUnavailable,
      totalCount: 0,
      items: [],
    }),
  },
  decorators: [withMeasuredChecksFlag],
};

function withMeasuredChecksFlag(Story: () => React.JSX.Element) {
  return (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [BRANCH_DETAIL_MEASURED_CHECKS_FLAG_KEY],
      })}
    >
      <Story />
    </FeatureFlagAdapterProvider>
  );
}

function measuredDetail(
  checksStatus: ChecksStatus | null,
  selectedPullRequestChecksProjection: BranchPageDetail["selectedPullRequestChecksProjection"]
): BranchPageDetail {
  return {
    ...selectedDetail([SelectedPullRequestCheckCategory.Successful]),
    checksStatus,
    checksPassed: null,
    checksTotal: selectedPullRequestChecksProjection?.totalCount ?? null,
    ...(selectedPullRequestChecksProjection
      ? { selectedPullRequestChecksProjection }
      : {}),
  };
}

function measuredProjection() {
  return {
    headSha: HEAD_SHA,
    providerState: BranchViewChecksProviderState.Available,
    unavailableReason: null,
    totalCount: 3,
    truncated: false,
    items: [
      {
        id: "build",
        kind: BranchViewCheckKind.CheckRun,
        name: "Build",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        targetUrl: "https://ci.example.test/build",
      },
      {
        id: "unit",
        kind: BranchViewCheckKind.CheckRun,
        name: "Unit tests",
        status: "COMPLETED",
        conclusion: "FAILURE",
        targetUrl: null,
      },
      {
        id: "e2e",
        kind: BranchViewCheckKind.CheckRun,
        name: "Desktop E2E",
        status: "IN_PROGRESS",
        conclusion: null,
        targetUrl: null,
      },
    ],
  };
}

function selectedDetail(
  categories: SelectedPullRequestCheckCategoryType[],
  completeness: SelectedPullRequestChecksCompleteness = SelectedPullRequestChecksCompleteness.Complete,
  unavailable = false
) {
  const selectedPullRequestChecks = unavailable
    ? branchSelectedPullRequestChecksEvidenceUnavailable({
        status: SelectedPullRequestEvidenceAvailability.Unavailable,
        reason: SelectedPullRequestEvidenceUnavailableReason.ProviderFailure,
      })
    : projectBranchSelectedPullRequestChecks(
        checksEvidence(categories, completeness)
      );
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
      baseRefName: "main",
      authorLogin: "octocat",
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
