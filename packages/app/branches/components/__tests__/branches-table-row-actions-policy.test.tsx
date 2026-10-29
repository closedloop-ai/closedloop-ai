import {
  BranchDataState,
  BranchTagAvailability,
} from "@repo/api/src/types/branch";
import { ChecksStatus } from "@repo/api/src/types/branch-checks";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { BranchesDataSource } from "../../data-source/branches-data-source";
import { BranchesDataSourceProvider } from "../../data-source/provider";
import { type BranchRow, BranchRowStatus } from "../../lib/branch-row";
import { APPROVED_BRANCH_COLUMN_SPECS } from "../approved-branches-grid-adapter";
import { BranchesGridV2WithRowActions } from "../branches-grid-v2";
import { BranchesTable } from "../branches-table";

vi.mock("@repo/design-system/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
  }: {
    children: ReactNode;
    asChild?: boolean;
    disabled?: boolean;
    onSelect?: () => void;
  }) =>
    isValidElement(children) && !onSelect ? (
      children
    ) : (
      <button disabled={disabled} onClick={() => onSelect?.()} type="button">
        {children}
      </button>
    ),
}));

const VIEW_LINKED_SESSIONS_RE = /view linked sessions/i;
const VISIBLE_COLUMNS = new Set(
  APPROVED_BRANCH_COLUMN_SPECS.map((column) => column.id)
);

afterEach(() => {
  vi.restoreAllMocks();
});

const row: BranchRow = {
  id: "11111111-1111-4111-8111-111111111111",
  branchName: "feature",
  baseBranch: "main",
  repo: "owner/web",
  owner: "Alex Rivera",
  status: BranchRowStatus.Open,
  dataState: BranchDataState.Ready,
  prNumber: 42,
  prTitle: "Add feature",
  prUrl: "https://github.com/owner/web/pull/42",
  prState: "OPEN",
  checksPassed: 12,
  checksTotal: 12,
  checksStatus: ChecksStatus.Passing,
  behind: 1,
  ahead: 2,
  additions: 10,
  deletions: 5,
  sessionCount: 3,
  commentCount: null,
  lastActivityLabel: "2h ago",
};

describe("BranchesTable retained row actions", () => {
  it("preserves the shipped row actions from production row and host facts", () => {
    render(
      <BranchesTable
        getSessionsHref={(item) => `/branches/${item.id}/sessions`}
        items={[row]}
        onOpenDetail={vi.fn()}
      />,
      { wrapper: AppCoreStoryProviders }
    );

    fireEvent.click(screen.getByRole("button", { name: "Branch actions" }));
    expect(screen.getByText("Open detail")).toBeInTheDocument();
    expect(screen.getByText("Open PR").closest("button")).toBeEnabled();
    expect(
      screen.getByRole("link", { name: VIEW_LINKED_SESSIONS_RE })
    ).toHaveAttribute(
      "href",
      "/branches/11111111-1111-4111-8111-111111111111/sessions"
    );
  });

  it("does not expose rollout-only Sync or Edit tags actions", () => {
    render(
      <BranchesTable
        getSessionsHref={(item) => `/branches/${item.id}/sessions`}
        items={[
          {
            ...row,
            artifactId: "artifact-1",
            dataState: BranchDataState.AwaitingSync,
            tagAvailability: BranchTagAvailability.Available,
            tagPermissions: { canApply: true, canRemove: true },
          },
        ]}
        onOpenDetail={vi.fn()}
      />,
      { wrapper: AppCoreStoryProviders }
    );

    fireEvent.click(screen.getByRole("button", { name: "Branch actions" }));
    expect(screen.queryByText("Sync")).not.toBeInTheDocument();
    expect(screen.queryByText("Edit tags")).not.toBeInTheDocument();
  });
});

describe("BranchesGridV2 production row-action policy", () => {
  it("mounts the pointer contract around the enhanced grid without another flag read", () => {
    const { container } = renderEnhancedGrid({
      item: row,
      source: sourceWithCapabilities(),
    });

    const contract = container.querySelector(
      '[data-grid-interaction-contract="pointer-hover"]'
    );
    expect(contract).not.toBeNull();
    expect(contract).toContainElement(
      screen.getByRole("button", { name: "Branch actions" })
    );
  });

  it("keeps and executes shipped actions without tag or move items on the enhanced grid", async () => {
    const user = userEvent.setup();
    const openPr = vi.spyOn(globalThis, "open").mockImplementation(() => null);
    const actionableRow: BranchRow = {
      ...row,
      artifactId: "22222222-2222-4222-8222-222222222222",
      tagAvailability: BranchTagAvailability.Available,
      tagPermissions: { canApply: true, canRemove: true },
      tags: [],
    };
    const local = renderEnhancedGrid({
      item: actionableRow,
      source: sourceWithCapabilities(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Branch actions" }));
    expect(screen.queryByRole("button", { name: "Edit tags" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Move to Project" })
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Copy branch name" })
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Open PR" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "Open detail" })).toHaveAttribute(
      "href",
      "/branches/11111111-1111-4111-8111-111111111111"
    );
    expect(
      screen.getByRole("link", { name: VIEW_LINKED_SESSIONS_RE })
    ).toHaveAttribute(
      "href",
      "/branches/11111111-1111-4111-8111-111111111111?tab=sessions-timeline"
    );
    await user.click(screen.getByRole("button", { name: "Copy branch name" }));
    expect(await globalThis.navigator.clipboard.readText()).toBe(
      actionableRow.branchName
    );
    await user.click(screen.getByRole("button", { name: "Open PR" }));
    expect(openPr).toHaveBeenCalledWith(
      actionableRow.prUrl,
      "_blank",
      "noopener,noreferrer"
    );
    local.unmount();

    renderEnhancedGrid({
      item: actionableRow,
      source: sourceWithCapabilities({ project: true, tags: true }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Branch actions" }));
    expect(screen.queryByRole("button", { name: "Edit tags" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Move to Project" })
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Copy branch name" })
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Open PR" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "Open detail" })).toHaveAttribute(
      "href",
      "/branches/11111111-1111-4111-8111-111111111111"
    );
    expect(
      screen.getByRole("link", { name: VIEW_LINKED_SESSIONS_RE })
    ).toHaveAttribute(
      "href",
      "/branches/11111111-1111-4111-8111-111111111111?tab=sessions-timeline"
    );
  });

  it("disables Open PR when the production row has no pull request", () => {
    renderEnhancedGrid({
      item: {
        ...row,
        prNumber: null,
        prUrl: null,
      },
      source: sourceWithCapabilities(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Branch actions" }));
    expect(screen.getByRole("button", { name: "Open PR" })).toBeDisabled();
  });
});

function renderEnhancedGrid({
  item,
  source,
}: {
  item: BranchRow;
  source: BranchesDataSource;
}) {
  return render(
    <BranchesDataSourceProvider dataSource={source}>
      <BranchesGridV2WithRowActions
        allRows={[item]}
        columnSpecs={APPROVED_BRANCH_COLUMN_SPECS}
        getBranchHref={(branch) => `/branches/${branch.id}`}
        getSessionsHref={(branch) =>
          `/branches/${branch.id}?tab=sessions-timeline`
        }
        items={[item]}
        onSort={vi.fn()}
        sortBy="lastActivity"
        sortDir="desc"
        tagsReadOnly={false}
        visibleColumns={VISIBLE_COLUMNS}
      />
    </BranchesDataSourceProvider>,
    { wrapper: AppCoreStoryProviders }
  );
}

function sourceWithCapabilities(
  capabilities: { project?: boolean; tags?: boolean } = {}
): BranchesDataSource {
  return {
    scope: "test",
    supportsProject: capabilities.project === true,
    supportsTags: capabilities.tags === true,
  } as BranchesDataSource;
}
