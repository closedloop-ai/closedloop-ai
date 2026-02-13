/**
 * Unit tests for DroppableProjectItem component.
 * Tests @dnd-kit droppable integration and visual feedback.
 */
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Mock @dnd-kit/core
vi.mock("@dnd-kit/core", () => ({
  useDroppable: vi.fn(() => ({
    active: null,
    rect: { current: null },
    isOver: false,
    node: { current: null },
    over: null,
    setNodeRef: vi.fn(),
  })),
}));

// Import after mocks
import { useDroppable } from "@dnd-kit/core";
import { DroppableProjectItem } from "@/app/(authenticated)/components/droppable-project-item";

describe("DroppableProjectItem", () => {
  const projectId = "01PROJECT000000000000000";

  it("useDroppable hook called with projectId", () => {
    render(
      <DroppableProjectItem projectId={projectId}>
        <div>Test Content</div>
      </DroppableProjectItem>
    );

    expect(useDroppable).toHaveBeenCalledWith({
      id: projectId,
      data: { type: "project", projectId },
    });
  });

  it("visual feedback on hover", () => {
    // Mock isOver state
    vi.mocked(useDroppable).mockReturnValueOnce({
      active: null,
      rect: { current: null },
      isOver: true,
      node: { current: null },
      over: null,
      setNodeRef: vi.fn(),
    });

    const { container } = render(
      <DroppableProjectItem projectId={projectId}>
        <div>Test Content</div>
      </DroppableProjectItem>
    );

    const wrapper = container.querySelector(".bg-accent");
    expect(wrapper).toBeInTheDocument();

    const border = container.querySelector(".border-l-2");
    expect(border).toBeInTheDocument();
  });

  it("no visual feedback when not hovering", () => {
    const { container } = render(
      <DroppableProjectItem projectId={projectId}>
        <div>Test Content</div>
      </DroppableProjectItem>
    );

    const wrapper = container.querySelector(".bg-accent");
    expect(wrapper).not.toBeInTheDocument();
  });
});
