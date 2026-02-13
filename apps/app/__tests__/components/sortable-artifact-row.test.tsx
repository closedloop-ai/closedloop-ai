/**
 * Unit tests for SortableArtifactRow component.
 * Tests drag handle rendering and @dnd-kit integration.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Mock @dnd-kit/sortable
vi.mock("@dnd-kit/sortable", () => ({
  useSortable: vi.fn(() => ({
    attributes: {
      role: "button",
      tabIndex: 0,
      "aria-disabled": false,
      "aria-pressed": undefined,
      "aria-roledescription": "sortable",
      "aria-describedby": "DndContext-1",
    },
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  })),
}));

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  GripVertical: () => <div data-testid="grip-icon" />,
}));

// Import after mocks
import { useSortable } from "@dnd-kit/sortable";
import { SortableArtifactRow } from "@/app/(authenticated)/teams/[teamId]/projects/[projectId]/components/sortable-artifact-row";
import type { ProjectArtifact } from "@/types/teams";

describe("SortableArtifactRow", () => {
  const mockArtifact: ProjectArtifact = {
    id: "01TEST000000000000000000",
    name: "Test Project",
    subtype: "PRD",
    status: "NOT_STARTED",
    documentSlug: "test-artifact",
  };

  it("renders drag handle", () => {
    render(
      <table>
        <tbody>
          <SortableArtifactRow artifact={mockArtifact}>
            <td>Test Content</td>
          </SortableArtifactRow>
        </tbody>
      </table>
    );

    expect(screen.getByTestId("grip-icon")).toBeInTheDocument();
  });

  it("useSortable hook called with correct artifact.id", () => {
    render(
      <table>
        <tbody>
          <SortableArtifactRow artifact={mockArtifact}>
            <td>Test Content</td>
          </SortableArtifactRow>
        </tbody>
      </table>
    );

    expect(useSortable).toHaveBeenCalledWith({ id: mockArtifact.id });
  });

  it("visual feedback classes applied on drag", () => {
    // Mock isDragging state
    vi.mocked(useSortable).mockReturnValueOnce({
      attributes: {
        role: "button",
        tabIndex: 0,
        "aria-disabled": false,
        "aria-pressed": undefined,
        "aria-roledescription": "sortable",
        "aria-describedby": "DndContext-1",
      },
      listeners: {},
      setNodeRef: vi.fn(),
      transform: null,
      transition: undefined,
      isDragging: true,
    } as unknown as ReturnType<typeof useSortable>);

    const { container } = render(
      <table>
        <tbody>
          <SortableArtifactRow artifact={mockArtifact}>
            <td>Test Content</td>
          </SortableArtifactRow>
        </tbody>
      </table>
    );

    const row = container.querySelector("[data-state='dragging']");
    expect(row).toBeInTheDocument();
  });
});
