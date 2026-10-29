import { BranchProvenance } from "@repo/api/src/types/branch";
import { ChecksStatus } from "@repo/api/src/types/branch-checks";
import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
} from "@repo/api/src/types/branch-metrics";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  makeBranchAnalytics,
  makeBranchListMetrics,
} from "@repo/app/branches/components/branch-analytics-fixtures";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "../../../shared/lib/feature-flags";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { BranchRowStatus, RENDER_UNATTRIBUTED } from "../../lib/branch-row";
import {
  BranchesListSurfaceV2Preview,
  BranchesListSurfaceV2PreviewStatus,
  createBranchesListSurfaceV2PreviewRow,
  createDefaultBranchesListSurfaceV2PreviewState,
  resolvePreviewDateScopedRows,
} from "../branches-list-surface-v2-demo";
import {
  PreviewSummaryState,
  previewSummaryPresentation,
} from "../branches-list-surface-v2-demo-summary";

const LINKED_SESSIONS_HEADER_PATTERN = /Linked sessions/;
const PREVIEW_BRANCH_NAME_PATTERN = /agent\/preview-adapter-/;
const PREVIEW_NOW = new Date("2026-07-29T00:00:00.000Z");
const BRANCHES_ROLLOUT_FLAGS = [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY] as const;

describe("BranchesListSurfaceV2Preview", () => {
  it("projects mock rows into the canonical Branch row contract", () => {
    const row = createBranchesListSurfaceV2PreviewRow({
      additions: 42,
      baseBranch: "main",
      branchName: "agent/preview-adapter",
      checksPassed: 3,
      checksTotal: 4,
      collaborators: ["Dana Reyes"],
      commentCount: 2,
      deletions: 7,
      id: "branch-preview",
      lastActivityAt: "2026-07-28T12:00:00.000Z",
      lastActivityLabel: "12h ago",
      owner: null,
      prNumber: 729,
      prState: GitHubPRState.Open,
      prTitle: "Branches preview adapter",
      prUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/729",
      provenance: BranchProvenance.Agent,
      repo: "closedloop-ai/closedloop-ai",
      sessionCount: 2,
      status: BranchesListSurfaceV2PreviewStatus.Canceled,
      tags: ["branches"],
    });

    expect(row).toMatchObject({
      checksStatus: ChecksStatus.Failing,
      owner: RENDER_UNATTRIBUTED,
      prRepo: "closedloop-ai/closedloop-ai",
      prState: GitHubPRState.Open,
      rawStatus: "canceled",
      status: BranchRowStatus.Closed,
    });
    expect(row.collaborators).toEqual([
      { key: "preview:dana-reyes", name: "Dana Reyes" },
    ]);
    expect(row.tags?.[0]).toMatchObject({
      id: "preview-tag:branches",
      name: "branches",
    });
  });

  it("renders the production surface and delegates its branch lead", () => {
    const row = createPreviewRow();
    const onOpen = vi.fn();

    render(
      <AppCoreStoryProviders enabledFlags={BRANCHES_ROLLOUT_FLAGS}>
        <BranchesListSurfaceV2Preview
          now={PREVIEW_NOW}
          rows={[row]}
          surfaceProps={{
            renderBranchLink: ({ children, className, item }) => (
              <button
                className={className}
                onClick={() => onOpen(item.id)}
                type="button"
              >
                {children}
              </button>
            ),
          }}
        />
      </AppCoreStoryProviders>
    );

    fireEvent.click(screen.getByRole("button", { name: row.branchName }));
    expect(onOpen).toHaveBeenCalledWith(row.id);
    expect(
      screen.getByRole("columnheader", { name: LINKED_SESSIONS_HEADER_PATTERN })
    ).toBeVisible();
  });

  it("retains interacted route-owned list state across detail replacement", async () => {
    const user = userEvent.setup();
    const rows = Array.from({ length: 26 }, (_, index) => ({
      ...createPreviewRow(),
      branchName: `agent/preview-adapter-${index}`,
      id: `branch-preview-${index}`,
    }));
    const initialState = createDefaultBranchesListSurfaceV2PreviewState();
    render(
      <AppCoreStoryProviders enabledFlags={BRANCHES_ROLLOUT_FLAGS}>
        <PreviewRouteHarness initialState={initialState} rows={rows} />
      </AppCoreStoryProviders>
    );

    await user.click(screen.getByLabelText("Go to next page"));
    expect(await screen.findByText("26–26 of 26")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Repository" })
    );
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("columnheader", { name: "Repository" })
    ).toBeNull();

    const [branch] = screen.getAllByRole("button", {
      name: PREVIEW_BRANCH_NAME_PATTERN,
    });
    if (!branch) {
      throw new Error("expected a preview branch row");
    }
    await user.click(branch);
    await user.click(screen.getByRole("button", { name: "Back to branches" }));

    expect(screen.getByText("26–26 of 26")).toBeVisible();
    expect(
      screen.queryByRole("columnheader", { name: "Repository" })
    ).toBeNull();
  });

  it("keeps metric-specific disclosures in the forced partial state", () => {
    const completeMetric = {
      current: { state: BranchMetricAvailability.Complete, value: 12 },
    } as const;
    const cards = makeBranchAnalytics({
      canonicalMetrics: makeBranchListMetrics({
        activeBranches: completeMetric,
        aiSpendUsd: completeMetric,
        canonicalLocPerDollar: completeMetric,
        locPerDollar: completeMetric,
        medianPrSize: completeMetric,
        mergeRatePct: completeMetric,
        totalLocPushed: completeMetric,
      }),
    });

    const partial = previewSummaryPresentation(
      cards,
      PreviewSummaryState.Partial
    ).cards?.canonicalMetrics;

    expect(metricDisclosure(partial?.activeBranches.current)).toBe(
      BranchMetricDisclosure.DefaultIncomplete
    );
    expect(metricDisclosure(partial?.aiSpendUsd.current)).toBe(
      BranchMetricDisclosure.CostIncomplete
    );
    expect(metricDisclosure(partial?.canonicalLocPerDollar?.current)).toBe(
      BranchMetricDisclosure.LocIncomplete
    );
    expect(metricDisclosure(partial?.medianPrSize.current)).toBe(
      BranchMetricDisclosure.PrIncomplete
    );
    expect(metricDisclosure(partial?.mergeRatePct.current)).toBe(
      BranchMetricDisclosure.PrCoverageIncomplete
    );
    expect(metricDisclosure(partial?.totalLocPushed?.current)).toBe(
      BranchMetricDisclosure.PushedLocIncomplete
    );
  });

  it("derives preview facet population from the selected date window", () => {
    const state = createDefaultBranchesListSurfaceV2PreviewState();
    const recent = createPreviewRow();
    const old = {
      ...createPreviewRow(),
      id: "old",
      lastActivityAt: "2026-05-01T00:00:00.000Z",
      status: BranchRowStatus.Merged,
    };

    expect(
      resolvePreviewDateScopedRows([recent, old], state, PREVIEW_NOW)
    ).toEqual([recent]);
  });
});

function PreviewRouteHarness({
  initialState,
  rows,
}: {
  initialState: ReturnType<
    typeof createDefaultBranchesListSurfaceV2PreviewState
  >;
  rows: ReturnType<typeof createPreviewRow>[];
}) {
  const [state, setState] = useState(initialState);
  const [detailOpen, setDetailOpen] = useState(false);
  if (detailOpen) {
    return (
      <button onClick={() => setDetailOpen(false)} type="button">
        Back to branches
      </button>
    );
  }
  return (
    <BranchesListSurfaceV2Preview
      now={PREVIEW_NOW}
      onStateChange={setState}
      rows={rows}
      state={state}
      surfaceProps={{
        renderBranchLink: ({ children, className }) => (
          <button
            className={className}
            onClick={() => setDetailOpen(true)}
            type="button"
          >
            {children}
          </button>
        ),
      }}
    />
  );
}

function createPreviewRow() {
  return createBranchesListSurfaceV2PreviewRow({
    additions: 42,
    baseBranch: "main",
    branchName: "agent/preview-adapter",
    checksPassed: 4,
    checksTotal: 4,
    commentCount: null,
    deletions: 7,
    id: "branch-preview",
    lastActivityAt: "2026-07-28T12:00:00.000Z",
    lastActivityLabel: "12h ago",
    owner: "Dana Reyes",
    prNumber: 729,
    prState: GitHubPRState.Open,
    prTitle: "Branches preview adapter",
    prUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/729",
    repo: "closedloop-ai/closedloop-ai",
    sessionCount: 2,
    status: BranchRowStatus.Review,
  });
}

function metricDisclosure(
  result:
    | ReturnType<typeof makeBranchListMetrics>["activeBranches"]["current"]
    | undefined
): BranchMetricDisclosure {
  if (result?.state !== BranchMetricAvailability.Partial) {
    throw new Error("expected a partial preview metric");
  }
  return result.disclosure;
}
