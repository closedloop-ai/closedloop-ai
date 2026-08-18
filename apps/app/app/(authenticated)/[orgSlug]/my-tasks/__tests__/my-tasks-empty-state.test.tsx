import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The modals this state can open reach for host-app route context; the branch
// under test is which STATE renders, not the modals' guts.
vi.mock(
  "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/[projectId]/components/create-document-modal",
  () => ({ CreateDocumentModal: () => null })
);
vi.mock(
  "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/[projectId]/components/create-issue-modal",
  () => ({ CreateIssueModal: () => null })
);
vi.mock("@/app/(authenticated)/[orgSlug]/teams/components/team-modal", () => ({
  TeamModal: () => null,
}));

import {
  MY_TASKS_RECENCY_EMPTY_TITLE,
  MY_TASKS_RECENCY_SHOW_ALL_LABEL,
} from "@repo/app/my-tasks/lib/my-tasks-recency-window";
import { MyTasksEmptyState } from "../components/my-tasks-empty-state";

const QUEUE_CLEAR_TITLE = "Your queue is clear";

const projects = [
  { id: "project-1", teams: [{ id: "team-1" }] },
] as unknown as ProjectWithDetails[];

// FEA-1626 (closedloop-ai-stage): "there is nothing assigned to you" and
// "everything assigned to you fell outside the window" are two different facts.
// Someone back from three months of leave has all their work still here, and a
// screen that answers them with "Your queue is clear" plus two cards asking them
// to write a PRD is lying about their data.
describe("MyTasksEmptyState recency disclosure (FEA-1626)", () => {
  it("says the queue is clear when no window is in force", () => {
    render(<MyTasksEmptyState projects={projects} recencyWindow={null} />);

    expect(screen.getByText(QUEUE_CLEAR_TITLE)).toBeInTheDocument();
    expect(
      screen.queryByText(MY_TASKS_RECENCY_EMPTY_TITLE)
    ).not.toBeInTheDocument();
  });

  it("says the work aged out — NOT that the queue is clear — under a window", () => {
    render(
      <MyTasksEmptyState
        projects={projects}
        recencyWindow={{ onShowAll: vi.fn() }}
      />
    );

    expect(screen.getByText(MY_TASKS_RECENCY_EMPTY_TITLE)).toBeInTheDocument();
    expect(screen.queryByText(QUEUE_CLEAR_TITLE)).not.toBeInTheDocument();
  });

  it("offers a way back to the full history, and invokes it", () => {
    const onShowAll = vi.fn();
    render(
      <MyTasksEmptyState projects={projects} recencyWindow={{ onShowAll }} />
    );

    fireEvent.click(
      screen.getByRole("button", { name: MY_TASKS_RECENCY_SHOW_ALL_LABEL })
    );

    expect(onShowAll).toHaveBeenCalledTimes(1);
  });

  it("keeps the default state when the prop is omitted entirely", () => {
    render(<MyTasksEmptyState projects={projects} />);

    expect(screen.getByText(QUEUE_CLEAR_TITLE)).toBeInTheDocument();
  });
});
