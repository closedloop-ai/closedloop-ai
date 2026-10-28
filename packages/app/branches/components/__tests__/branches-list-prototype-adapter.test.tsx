import {
  BranchesListSurfaceV2PreviewAdapter,
  BranchesListSurfaceV2PreviewPullRequestState,
  type BranchesListSurfaceV2PreviewRowInput,
  BranchesListSurfaceV2PreviewStatus,
  createBranchesListSurfaceV2PreviewRow,
  createDefaultBranchesListSurfaceV2PreviewState,
} from "@repo/app/branches/components/branches-list-surface-v2-demo";
import { BranchRowStatus } from "@repo/app/branches/lib/branch-row";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";

const PREVIEW_NOW = new Date("2026-07-29T00:00:00.000Z");
const BRANCHES_ROLLOUT_FLAGS = [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY] as const;

describe("Branches prototype list adapter", () => {
  it("projects source rows, preserves canceled copy, and opens the source row", async () => {
    const user = userEvent.setup();
    const source = canceledSourceRow();
    const onOpenDetail = vi.fn();

    render(
      <AppCoreStoryProviders enabledFlags={BRANCHES_ROLLOUT_FLAGS}>
        <BranchesListSurfaceV2PreviewAdapter
          now={PREVIEW_NOW}
          onOpenDetail={onOpenDetail}
          onStateChange={vi.fn()}
          projectRow={createBranchesListSurfaceV2PreviewRow}
          rows={[source]}
          state={createDefaultBranchesListSurfaceV2PreviewState()}
        />
      </AppCoreStoryProviders>
    );

    expect(screen.getByText("Canceled")).toBeVisible();
    expect(createBranchesListSurfaceV2PreviewRow(source)).toMatchObject({
      rawStatus: BranchesListSurfaceV2PreviewStatus.Canceled,
      status: BranchRowStatus.Closed,
    });
    const branchButton = screen.getByText(source.branchName).closest("button");
    if (!branchButton) {
      throw new Error("expected the branch name to render inside a button");
    }
    await user.click(branchButton);
    expect(onOpenDetail).toHaveBeenCalledWith(source);
    expect(source.status).toBe(BranchesListSurfaceV2PreviewStatus.Canceled);
  });

  it("applies route-owned range and pagination interactions", async () => {
    const user = userEvent.setup();
    const rows = Array.from({ length: 49 }, (_, index) => ({
      ...canceledSourceRow(),
      branchName: `agent/prototype-${index}`,
      id: `prototype-${index}`,
    }));

    render(
      <AppCoreStoryProviders enabledFlags={BRANCHES_ROLLOUT_FLAGS}>
        <PrototypeRouteHarness rows={rows} />
      </AppCoreStoryProviders>
    );

    const thirtyDays = screen.getByRole("radio", { name: "Last 30 days" });
    const sevenDays = screen.getByRole("radio", { name: "Last 7 days" });
    expect(thirtyDays).toBeChecked();

    await user.click(sevenDays);
    expect(sevenDays).toBeChecked();
    expect(thirtyDays).not.toBeChecked();

    await user.click(screen.getByLabelText("Go to next page"));
    expect(await screen.findByText("26–49 of 49")).toBeVisible();
  });
});

function PrototypeRouteHarness({
  rows,
}: {
  rows: BranchesListSurfaceV2PreviewRowInput[];
}) {
  const [state, setState] = useState(() =>
    createDefaultBranchesListSurfaceV2PreviewState()
  );
  return (
    <BranchesListSurfaceV2PreviewAdapter
      now={PREVIEW_NOW}
      onOpenDetail={() => undefined}
      onStateChange={setState}
      projectRow={createBranchesListSurfaceV2PreviewRow}
      rows={rows}
      state={state}
    />
  );
}

function canceledSourceRow(): BranchesListSurfaceV2PreviewRowInput {
  return {
    additions: 18,
    baseBranch: "main",
    branchName: "agent/prototype-canceled",
    checksPassed: 2,
    checksTotal: 2,
    commentCount: 1,
    deletions: 4,
    id: "prototype-canceled",
    lastActivityAt: "2026-07-28T12:00:00.000Z",
    lastActivityLabel: "12h ago",
    owner: "Dana Reyes",
    prNumber: 8947,
    prState: BranchesListSurfaceV2PreviewPullRequestState.Closed,
    prTitle: "Branches list adapter",
    prUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/8947",
    repo: "closedloop-ai/closedloop-ai",
    sessionCount: 1,
    status: BranchesListSurfaceV2PreviewStatus.Canceled,
  };
}
