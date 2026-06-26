import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type BranchRow, BranchRowStatus } from "../../lib/branch-sample-data";
import { BranchRowActionsMenu } from "../branch-row-actions-menu";

const ACTIONS_RE = /branch actions/i;
const FORBIDDEN_RE = /issues|docs|agents/i;

const baseItem: BranchRow = {
  id: "id",
  branchName: "agent/x",
  baseBranch: "main",
  repo: "acme/web",
  owner: "Alex",
  status: BranchRowStatus.Open,
  prNumber: 42,
  prTitle: "t",
  prUrl: "https://github.com/acme/web/pull/42",
  prState: "OPEN",
  checksPassed: 12,
  checksTotal: 12,
  checksStatus: "PASSING",
  behind: 1,
  ahead: 2,
  additions: 10,
  deletions: 5,
  sessionCount: 3,
  commentCount: null,
  lastActivityLabel: "2h ago",
};

describe("BranchRowActionsMenu", () => {
  it("offers only branch-scoped actions; hides Open-detail/View-sessions without handlers", async () => {
    const user = userEvent.setup();
    render(<BranchRowActionsMenu item={baseItem} />);

    await user.click(screen.getByRole("button", { name: ACTIONS_RE }));

    expect(screen.getByText("Copy branch name")).toBeInTheDocument();
    expect(screen.getByText("Open PR")).toBeInTheDocument();
    expect(screen.queryByText("Open detail")).not.toBeInTheDocument();
    expect(screen.queryByText("View linked sessions")).not.toBeInTheDocument();
    expect(screen.queryByText(FORBIDDEN_RE)).not.toBeInTheDocument();
  });

  it("shows and fires Open-detail / View-sessions when handlers are provided", async () => {
    const user = userEvent.setup();
    const onOpenDetail = vi.fn();
    const onViewSessions = vi.fn();
    render(
      <BranchRowActionsMenu
        item={baseItem}
        onOpenDetail={onOpenDetail}
        onViewSessions={onViewSessions}
      />
    );

    await user.click(screen.getByRole("button", { name: ACTIONS_RE }));
    expect(screen.getByText("View linked sessions")).toBeInTheDocument();
    await user.click(screen.getByText("Open detail"));
    expect(onOpenDetail).toHaveBeenCalledWith(baseItem);
  });

  it("disables Open PR when the row has no PR", async () => {
    const user = userEvent.setup();
    render(
      <BranchRowActionsMenu
        item={{ ...baseItem, prNumber: null, prUrl: null }}
      />
    );

    await user.click(screen.getByRole("button", { name: ACTIONS_RE }));
    const openPr = screen.getByText("Open PR").closest('[role="menuitem"]');
    expect(openPr).toHaveAttribute("aria-disabled", "true");
  });

  it("disables Open PR for a non-canonical / unsafe PR URL", async () => {
    const user = userEvent.setup();
    render(
      <BranchRowActionsMenu
        item={{ ...baseItem, prUrl: "javascript:alert(1)" }}
      />
    );

    await user.click(screen.getByRole("button", { name: ACTIONS_RE }));
    const openPr = screen.getByText("Open PR").closest('[role="menuitem"]');
    expect(openPr).toHaveAttribute("aria-disabled", "true");
  });
});
