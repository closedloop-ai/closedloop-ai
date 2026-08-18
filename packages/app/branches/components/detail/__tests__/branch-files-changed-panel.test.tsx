import {
  BranchSelectedPullRequestFileCompleteness,
  type BranchSelectedPullRequestFilesResponse,
  BranchSelectedPullRequestGrossTotalAvailability,
  BranchSelectedPullRequestReadAvailability,
} from "@repo/api/src/types/branch-selected-pull-request-files";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeBranchDetail } from "../../../__tests__/branch-fixtures";
import { BranchFilesChangedPanel } from "../branch-files-changed-panel";

vi.mock("../../../hooks/use-branch-selected-pull-request-files", () => ({
  useBranchSelectedPullRequestDiff: () => ({
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
  }),
}));

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const COVERAGE_RE = /only the verified rows shown here/i;
const FILE_NAME_RE = /src\/index\.ts/i;
const UNAVAILABLE_TOTALS_RE = /completeness and totals are unavailable/i;
const NO_CHANGED_FILES_RE = /has no changed files/i;

describe("BranchFilesChangedPanel", () => {
  it("renders exact incomplete counts, truthful totals, and a coverage explanation", () => {
    render(
      <BranchFilesChangedPanel
        branchId="branch-1"
        detail={selectedDetail()}
        filesResponse={filesResponse(
          BranchSelectedPullRequestFileCompleteness.Incomplete
        )}
      />
    );

    expect(screen.getByText("1 of 3 files shown*")).toBeInTheDocument();
    expect(screen.getByText("+5*")).toBeInTheDocument();
    expect(screen.getByText("−2*")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("Files changed")).toBeInTheDocument();
    expect(screen.getByText(COVERAGE_RE)).toBeInTheDocument();
    const fileRow = screen.getByRole("button", { name: FILE_NAME_RE });
    expect(fileRow).toHaveClass("bq-file", "bq-file-button");
    expect(fileRow).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(fileRow);

    expect(fileRow).toHaveAttribute("aria-expanded", "true");
    expect(fileRow).toHaveAttribute("aria-controls");
  });

  it("retains verified rows while stating totals and completeness are unavailable", () => {
    const response = filesResponse(
      BranchSelectedPullRequestFileCompleteness.Unavailable
    );
    render(
      <BranchFilesChangedPanel
        detail={selectedDetail()}
        filesResponse={response}
      />
    );

    expect(
      screen.getByRole("button", { name: FILE_NAME_RE })
    ).toBeInTheDocument();
    expect(screen.getByText(UNAVAILABLE_TOTALS_RE)).toBeInTheDocument();
    expect(screen.getByText("+5")).toBeInTheDocument();
  });

  it("pluralizes each file label by the count its noun describes", () => {
    const completeResponse = filesResponse(
      BranchSelectedPullRequestFileCompleteness.Complete
    );
    const { rerender } = render(
      <BranchFilesChangedPanel
        detail={selectedDetail()}
        filesResponse={completeResponse}
      />
    );

    expect(screen.getByText("1 file")).toBeInTheDocument();

    const unavailableCompletenessResponse = filesResponse(
      BranchSelectedPullRequestFileCompleteness.Unavailable
    );
    rerender(
      <BranchFilesChangedPanel
        detail={selectedDetail()}
        filesResponse={unavailableCompletenessResponse}
      />
    );
    expect(screen.getByText("1 verified file")).toBeInTheDocument();

    const unknownExpectedResponse = filesResponse(
      BranchSelectedPullRequestFileCompleteness.Incomplete
    );
    if (
      unknownExpectedResponse.status ===
      BranchSelectedPullRequestReadAvailability.Available
    ) {
      unknownExpectedResponse.value.counts.expected = null;
    }
    rerender(
      <BranchFilesChangedPanel
        detail={selectedDetail()}
        filesResponse={unknownExpectedResponse}
      />
    );
    expect(screen.getByText("1 file shown*")).toBeInTheDocument();

    if (
      unknownExpectedResponse.status ===
      BranchSelectedPullRequestReadAvailability.Available
    ) {
      unknownExpectedResponse.value.counts.expected = 1;
    }
    rerender(
      <BranchFilesChangedPanel
        detail={selectedDetail()}
        filesResponse={unknownExpectedResponse}
      />
    );
    expect(screen.getByText("1 of 1 file shown*")).toBeInTheDocument();

    const pluralCompleteResponse = filesResponse(
      BranchSelectedPullRequestFileCompleteness.Complete,
      2
    );
    rerender(
      <BranchFilesChangedPanel
        detail={selectedDetail()}
        filesResponse={pluralCompleteResponse}
      />
    );
    expect(screen.getByText("2 files")).toBeInTheDocument();

    const pluralUnavailableResponse = filesResponse(
      BranchSelectedPullRequestFileCompleteness.Unavailable,
      2
    );
    rerender(
      <BranchFilesChangedPanel
        detail={selectedDetail()}
        filesResponse={pluralUnavailableResponse}
      />
    );
    expect(screen.getByText("2 verified files")).toBeInTheDocument();
  });

  it("distinguishes a complete known-empty file set from unavailability", () => {
    const response = filesResponse(
      BranchSelectedPullRequestFileCompleteness.Complete
    );
    if (
      response.status === BranchSelectedPullRequestReadAvailability.Available
    ) {
      response.value.files = [];
      response.value.counts.loaded = 0;
      response.value.counts.expected = 0;
    }
    render(
      <BranchFilesChangedPanel
        detail={selectedDetail()}
        filesResponse={response}
      />
    );

    expect(screen.getByText("0 files")).toBeInTheDocument();
    expect(screen.getByText(NO_CHANGED_FILES_RE)).toBeInTheDocument();
  });

  it("does not claim an incomplete empty projection has no changed files", () => {
    const response = filesResponse(
      BranchSelectedPullRequestFileCompleteness.Incomplete
    );
    if (
      response.status === BranchSelectedPullRequestReadAvailability.Available
    ) {
      response.value.files = [];
      response.value.counts.loaded = 0;
      response.value.counts.expected = 3;
    }
    render(
      <BranchFilesChangedPanel
        detail={selectedDetail()}
        filesResponse={response}
      />
    );

    expect(screen.queryByText(NO_CHANGED_FILES_RE)).not.toBeInTheDocument();
    expect(screen.getByText("0 of 3 files shown*")).toBeInTheDocument();
    expect(
      screen.getByText("No verified file rows are available.")
    ).toBeInTheDocument();
    expect(screen.getByText(COVERAGE_RE)).toBeInTheDocument();
  });

  it("offers retry when selected-PR file evidence is unavailable", () => {
    const onRetry = vi.fn();
    render(
      <BranchFilesChangedPanel
        detail={selectedDetail()}
        filesError
        onRetry={onRetry}
      />
    );

    screen.getByRole("button", { name: "Retry" }).click();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("region", {
        name: "Files changed",
      })
    ).toBeInTheDocument();
  });
});

function selectedDetail() {
  return makeBranchDetail({
    selectedPullRequest: {
      id: "octo/repo#42",
      repositoryFullName: "octo/repo",
      number: 42,
      title: "Selected PR",
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
      additions: 5,
      deletions: 2,
    },
  });
}

function filesResponse(
  completeness: (typeof BranchSelectedPullRequestFileCompleteness)[keyof typeof BranchSelectedPullRequestFileCompleteness],
  loaded = 1
): BranchSelectedPullRequestFilesResponse {
  const coverage = coverageFor(completeness);
  const additions = loaded * 5;
  const deletions = loaded * 2;
  const totalsAvailable =
    completeness !== BranchSelectedPullRequestFileCompleteness.Unavailable;
  const expected =
    completeness === BranchSelectedPullRequestFileCompleteness.Incomplete
      ? 3
      : loaded;
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
      files: Array.from({ length: loaded }, (_, index) => ({
        path: index === 0 ? "src/index.ts" : `src/other-${index}.ts`,
        providerStatus: "modified",
        status: "modified",
        additions: 5,
        deletions: 2,
        changes: 7,
      })),
      counts: {
        expected,
        loaded,
        providerExpected: expected,
        providerReturned: loaded,
      },
      coverage,
      grossTotals: {
        additions: totalsAvailable
          ? {
              availability:
                BranchSelectedPullRequestGrossTotalAvailability.Available,
              value: additions,
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
              value: deletions,
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
      reasons: ["persisted_expected_count_mismatch"],
    } as const;
  }
  return { completeness, reason: "missing_expected_count" } as const;
}
