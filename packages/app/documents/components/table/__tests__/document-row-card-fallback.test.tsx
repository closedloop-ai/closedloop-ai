import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import {
  DocumentRow,
  getDocumentRowGridTemplateColumns,
} from "@repo/app/documents/components/table/document-row";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { DocumentColumn as Col } from "@repo/app/shared/hooks/use-column-visibility";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
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

  it("does not reserve a hidden slug slot in the narrow card header", () => {
    const { container } = render(
      <DocumentRow
        item={{
          kind: "document",
          data: makeArtifact({
            slug: "scaled-seed-document-21",
            title: "Scaled Seed Document",
          }),
        }}
        visibleColumns={VISIBLE_COLUMNS}
      />
    );

    expect(container.querySelector("dl")).not.toBeNull();
    expect(container.querySelector('span[class*="min-w-[7ch]"]')).toBeNull();
    expect(
      screen.getByRole("link", { name: "Scaled Seed Document" })
    ).toBeVisible();
  });

  it("keeps the typed slug slot in the narrow card header", () => {
    const { container } = render(
      <DocumentRow
        item={{
          kind: "document",
          data: makeArtifact({
            slug: "DOC-21",
            title: "Typed Document",
          }),
        }}
        visibleColumns={VISIBLE_COLUMNS}
      />
    );

    expect(container.querySelector("dl")).not.toBeNull();
    expect(
      container.querySelector('span[class*="min-w-[7ch]"]')
    ).toHaveTextContent("DOC-21");
    expect(screen.getByRole("link", { name: "Typed Document" })).toBeVisible();
  });

  it("gives a manual hierarchy card a full title line and its existing slug", () => {
    const { container } = render(
      <DocumentRow
        item={{
          kind: "document",
          data: makeArtifact({ slug: "PLN-1", title: "Test Plan" }),
        }}
        placementLayout="manual"
        showCheckbox
        visibleColumns={VISIBLE_COLUMNS}
      />
    );

    const title = screen.getByRole("link", { name: "Test Plan" });
    expect(title.parentElement).toHaveClass("w-full");
    expect(title.parentElement).toHaveClass("min-w-0");
    expect(screen.getByText("PLN-1")).toHaveClass("w-20");
    expect(container.querySelector("dl")).not.toBeNull();
  });

  it.each(["scaled-seed-document-21", "SES-8"])(
    "reserves a blank manual slug track for non-displayable %s",
    (slug) => {
      const { container } = render(
        <DocumentRow
          item={{
            kind: "document",
            data: makeArtifact({ slug, title: "Manual Document" }),
          }}
          placementLayout="manual"
          visibleColumns={VISIBLE_COLUMNS}
        />
      );

      expect(screen.queryByText(slug)).toBeNull();
      const slugTrack = container.querySelector("span.w-20");
      expect(slugTrack).toBeEmptyDOMElement();
      expect(slugTrack).toHaveAttribute("aria-hidden", "true");
      expect(
        screen.getByRole("link", { name: "Manual Document" })
      ).toBeVisible();
    }
  );

  it("keeps the typed slug track aligned in a manual grid row", () => {
    mockWidth.mockReturnValue(1024);
    const { container } = render(
      <DocumentRow
        item={{
          kind: "document",
          data: makeArtifact({ slug: "FEA-1", title: "Typed Issue" }),
        }}
        placementLayout="manual"
        visibleColumns={VISIBLE_COLUMNS}
      />
    );

    expect(container.querySelector("dl")).toBeNull();
    expect(screen.getByText("FEA-1")).toHaveClass("w-20");
    expect(screen.getByRole("link", { name: "Typed Issue" })).toBeVisible();
  });

  it("indents a child card's full title line one existing hierarchy slot", () => {
    render(
      <>
        <DocumentRow
          item={{
            kind: "document",
            data: makeArtifact({ slug: "PRD-1", title: "Parent Row" }),
          }}
          placementLayout="manual"
          visibleColumns={VISIBLE_COLUMNS}
        />
        <DocumentRow
          indentDepth={1}
          item={{
            kind: "document",
            data: makeArtifact({ slug: "PLN-1", title: "Child Row" }),
          }}
          placementLayout="manual"
          visibleColumns={VISIBLE_COLUMNS}
        />
      </>
    );

    const rootLine = screen.getByRole("link", {
      name: "Parent Row",
    }).parentElement;
    const childLine = screen.getByRole("link", {
      name: "Child Row",
    }).parentElement;
    expect(rootLine?.querySelector("[style='width: 28px;']")).toBeNull();
    expect(childLine?.firstElementChild).toHaveStyle({ width: "28px" });
    expect(childLine?.firstElementChild).toHaveAttribute("aria-hidden", "true");
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

  it("keeps the legacy card only in the rollout's default-off branch", () => {
    const { container } = render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
        })}
      >
        <DocumentRow item={ITEM} visibleColumns={VISIBLE_COLUMNS} />
      </FeatureFlagAdapterProvider>
    );

    expect(container.querySelector("dl")).toBeNull();
    expect(container.querySelector(".grid")).not.toBeNull();
  });
});

describe("DocumentRow desktop grid tracks", () => {
  it("lets metadata tracks shrink before the title track", () => {
    expect(getDocumentRowGridTemplateColumns(3)).toBe(
      "minmax(350px, 1fr) minmax(80px, 124px) minmax(80px, 124px) minmax(80px, 124px) 88px"
    );
  });
});
