import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./render-with-nav";

// FEA-3866: the Documents-tree card fallback. `DocumentRow` measures its own
// container via `useContainerWidth` (there is no `mode` prop — Documents uses
// the bespoke row, not GridTable), so the layout is forced here by mocking the
// hook's reported width: < 768 → the card, >= 768 → the grid. The runtime
// container measurement at 360px is covered by the Playwright spec.
const mockWidth = vi.fn<() => number>(() => 1024);

vi.mock("@repo/design-system/hooks/use-container-width", () => ({
  useContainerWidth: () => ({ ref: { current: null }, width: mockWidth() }),
}));

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

vi.mock("@repo/app/judges-analytics/hooks/use-judges", () => ({
  usePlanJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  usePrdJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  useFeatureJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  useCodeJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
}));

import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { DocumentRow } from "@repo/app/documents/components/table/document-row";
import { DocumentColumn as Col } from "@repo/app/shared/hooks/use-column-visibility";
// Import after mocks
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";

const ITEM: DocumentRowItem = {
  kind: "document",
  data: makeArtifact({ id: "artifact-1", title: "Responsive rollout PRD" }),
};

const VISIBLE_COLUMNS = [Col.Type, Col.Assignee, Col.Updated];

afterEach(() => {
  cleanup();
  mockWidth.mockReturnValue(1024);
});

describe("DocumentRow card fallback (FEA-3866)", () => {
  beforeEach(() => {
    mockWidth.mockReturnValue(360);
  });

  it("renders a card with the name in the header and the visible columns as a key/value body below md", () => {
    render(
      <DocumentRow item={ITEM} showCheckbox visibleColumns={VISIBLE_COLUMNS} />
    );

    // The title link (from the same NameCell the grid uses) is the card header.
    expect(
      screen.getByRole("link", { name: "Responsive rollout PRD" })
    ).toBeInTheDocument();

    // The body is a definition list — the tell that the card, not the grid, is
    // live. Each visible column is a `<dt>` label; the grid never renders `<dl>`.
    const typeLabel = screen.getByText("Type");
    expect(typeLabel.tagName).toBe("DT");
    const updatedLabel = screen.getByText("Updated");
    expect(updatedLabel.tagName).toBe("DT");
    expect(updatedLabel.nextElementSibling?.tagName).toBe("DD");

    // The overflow (more-menu) affordance stays reachable in the card header.
    expect(
      screen.getByRole("button", { name: "More actions" })
    ).toBeInTheDocument();
  });

  it("preserves the tree expand/collapse chevron in the card header", () => {
    render(
      <DocumentRow
        isExpanded={false}
        item={ITEM}
        onToggleExpand={() => {
          // toggle wiring is asserted by aria-expanded, not called here
        }}
        visibleColumns={VISIBLE_COLUMNS}
      />
    );

    // Grouping/tree affordance: the collapsible chevron carries aria-expanded,
    // so the card keeps the tree's expand/collapse control (not just the grid).
    const chevron = screen.getByRole("button", { name: "Expand" });
    expect(chevron).toHaveAttribute("aria-expanded", "false");
  });

  it("renders the grid, not a card, at desktop width (regression guard)", () => {
    mockWidth.mockReturnValue(1024);
    const { container } = render(
      <DocumentRow item={ITEM} visibleColumns={VISIBLE_COLUMNS} />
    );

    // No card definition list; the grid row is the top-level `grid` container.
    expect(container.querySelector("dl")).toBeNull();
    expect(container.querySelector(".grid")).not.toBeNull();
  });
});
