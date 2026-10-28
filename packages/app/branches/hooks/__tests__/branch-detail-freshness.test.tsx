import type { BranchSelectedPullRequestIdentity } from "@repo/api/src/types/branch-associated-pull-request";
import { selectBranchPullRequestDetail } from "@repo/api/src/types/branch-selected-pull-request-detail";
import { focusManager } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { makeBranchDetail } from "../../__tests__/branch-fixtures";
import { createHttpBranchesDataSource } from "../../data-source/branches-data-source";
import { BranchesDataSourceProvider } from "../../data-source/provider";
import { useBranchSelectedPullRequestDetail } from "../use-branch-selected-pull-request-detail";
import { useBranchDetail } from "../use-branches";

afterEach(() => {
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

describe("Branch detail request budget", () => {
  it("HTTP reads once through idle and focus; only the visible five-minute fallback reads again", async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    const get = vi.fn().mockResolvedValue(makeBranchDetail());
    const source = createHttpBranchesDataSource({ get });
    render(
      <AppCoreStoryProviders>
        <BranchesDataSourceProvider dataSource={source}>
          <Detail />
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );
    await advance(1);
    expect(get).toHaveBeenCalledTimes(1);
    await advance(120_000);
    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
    await advance(1);
    expect(get).toHaveBeenCalledTimes(1);
    await advance(180_000);
    expect(get).toHaveBeenCalledTimes(2);
    act(() => focusManager.setFocused(false));
    await advance(600_000);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("retains one branch cache while switching and revisiting selected PRs", async () => {
    vi.useFakeTimers();
    const base = makeBranchDetail({ prNumber: 1, prTitle: "Default PR" });
    const source = createHttpBranchesDataSource({ get: vi.fn() });
    const detail = vi.spyOn(source, "detail").mockResolvedValue(base);
    const selected = vi
      .spyOn(source, "selectedPullRequestDetail")
      .mockImplementation(async (_id, selection) =>
        selectBranchPullRequestDetail(
          makeBranchDetail({
            prNumber: selection.pullRequestNumber,
            prTitle: `PR ${selection.pullRequestNumber}`,
          })
        )
      );
    const wrapper = ({
      selection,
    }: {
      selection: BranchSelectedPullRequestIdentity;
    }) => (
      <AppCoreStoryProviders>
        <BranchesDataSourceProvider dataSource={source}>
          <Selection selection={selection} />
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );
    const first = { repositoryFullName: "owner/repo", pullRequestNumber: 2 };
    const second = { repositoryFullName: "owner/repo", pullRequestNumber: 3 };
    const view = render(wrapper({ selection: first }));
    await advance(10);
    expect(screen.getByText("PR 2")).toBeInTheDocument();
    view.rerender(wrapper({ selection: second }));
    await advance(10);
    expect(screen.getByText("PR 3")).toBeInTheDocument();
    view.rerender(wrapper({ selection: first }));
    await advance(10);
    expect(screen.getByText("PR 2")).toBeInTheDocument();
    expect(detail).toHaveBeenCalledTimes(1);
    expect(selected).toHaveBeenCalledTimes(2);
  });
});

function Detail() {
  const query = useBranchDetail("branch-1");
  return <div>{query.data?.branchName}</div>;
}

function Selection({
  selection,
}: {
  selection: BranchSelectedPullRequestIdentity;
}) {
  const query = useBranchDetail("branch-1");
  return query.data ? (
    <Selected branch={query.data} selection={selection} />
  ) : null;
}

function Selected({
  branch,
  selection,
}: {
  branch: ReturnType<typeof makeBranchDetail>;
  selection: BranchSelectedPullRequestIdentity;
}) {
  const query = useBranchSelectedPullRequestDetail(
    "branch-1",
    branch,
    selection
  );
  return <div>{query.data?.prTitle}</div>;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
