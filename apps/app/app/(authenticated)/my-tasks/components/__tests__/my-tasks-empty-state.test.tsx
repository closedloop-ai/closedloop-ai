import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock(
  "@/app/(authenticated)/teams/[teamId]/projects/[projectId]/components/create-document-modal",
  () => ({
    CreateDocumentModal: () => <div data-testid="create-document-modal" />,
  })
);

vi.mock(
  "@/app/(authenticated)/teams/[teamId]/projects/[projectId]/components/create-feature-modal",
  () => ({
    CreateFeatureModal: () => <div data-testid="create-feature-modal" />,
  })
);

// Import after mocks
import { makeProject } from "@/__tests__/fixtures/project";
import { MyTasksEmptyState } from "../my-tasks-empty-state";

describe("MyTasksEmptyState — Link navigation", () => {
  it("renders a Link with href='/teams' when no project context exists", () => {
    const { container } = render(<MyTasksEmptyState projects={[]} />);

    const anchor = container.querySelector("a");
    expect(anchor).toBeInTheDocument();
    expect(anchor).toHaveAttribute("href", "/teams");
    expect(screen.getByText("Go to Teams")).toBeInTheDocument();
  });

  it("renders the 'Go to Teams' link as an <a> element (middle-click friendly)", () => {
    const { container } = render(<MyTasksEmptyState projects={[]} />);

    const anchor = container.querySelector("a");
    expect(anchor?.tagName).toBe("A");
  });

  it("does not render the 'Go to Teams' link when project context exists", () => {
    render(<MyTasksEmptyState projects={[makeProject()]} />);

    expect(screen.queryByText("Go to Teams")).not.toBeInTheDocument();
  });

  it("renders action cards instead of link when project context exists", () => {
    render(<MyTasksEmptyState projects={[makeProject()]} />);

    expect(screen.getByText("Write a Requirements Doc")).toBeInTheDocument();
    expect(screen.getByText("Create a Feature")).toBeInTheDocument();
  });
});
