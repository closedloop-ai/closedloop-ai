import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  makeBranchDetail,
  makeBranchSession,
} from "../../__tests__/branch-fixtures";
import { BranchDetailPage } from "../branch-detail-page";

vi.mock("../branch-properties-panel", () => ({
  BranchPropertiesPanel: () => <div>Properties</div>,
}));

vi.mock("../detail/branch-selected-pull-request-workspace", () => ({
  BranchSelectedPullRequestWorkspace: () => <div>Branch workspace</div>,
}));

vi.mock("../detail/branch-sessions-timeline-tab", () => ({
  BranchSessionsTimelineTab: () => <div>Timeline workspace</div>,
}));

vi.mock("../comments/branch-comments-controller", () => ({
  BranchCommentsController: ({ open }: { open: boolean }) =>
    open ? <aside>Comments workspace</aside> : null,
}));

describe("BranchDetailPage navigation state", () => {
  it("resets tab and comments state when the same component navigates to another Branch", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<BranchDetailPage {...props("branch-a")} />);

    await user.click(screen.getByRole("tab", { name: "Sessions & timeline" }));
    await user.click(
      screen.getByRole("button", { name: "Show comments rail" })
    );
    expect(screen.getByText("Timeline workspace")).toBeInTheDocument();
    expect(screen.getByText("Comments workspace")).toBeInTheDocument();

    rerender(<BranchDetailPage {...props("branch-b")} />);

    expect(screen.getByRole("tab", { name: "Branch details" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByText("Branch workspace")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show comments rail" })
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Comments workspace")).not.toBeInTheDocument();
  });
});

function props(id: string) {
  return {
    analytics: undefined,
    backHref: "/branches",
    branchId: id,
    detail: makeBranchDetail({
      id,
      branchName: `feature/${id}`,
      sessionIds: [`session-${id}`],
      sessions: [makeBranchSession({ sessionId: `session-${id}` })],
    }),
    isError: false,
    isLoading: false,
  };
}
