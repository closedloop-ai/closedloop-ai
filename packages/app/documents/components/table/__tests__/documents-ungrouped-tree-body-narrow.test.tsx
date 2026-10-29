import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Forces a phone-width container: below 768px a flat DocumentRow falls back to
// the captured-main card, so this is the width where the hierarchy must differ.
vi.mock("@repo/design-system/hooks/use-container-width", () => ({
  useContainerWidth: () => ({ ref: { current: null }, width: 360 }),
}));

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { DocumentRow } from "@repo/app/documents/components/table/document-row";
import type { DisplayGroup } from "@repo/app/documents/components/table/document-tree";
import { documentTreeRoots } from "@repo/app/documents/lib/documents-grid-groups";
import { DocumentColumn as Col } from "@repo/app/shared/hooks/use-column-visibility";
import {
  makeArtifact,
  makePlanArtifact,
} from "@repo/app/shared/test-fixtures/documents";
import { DocumentsUngroupedTreeBody } from "../documents-ungrouped-tree-body";

const ROOT: DocumentRowItem = {
  kind: "document",
  data: makeArtifact({ id: "root-1", slug: "root-1", title: "Root root-1" }),
};
const CHILD: DocumentRowItem = {
  kind: "document",
  data: makePlanArtifact({
    id: "child-1",
    slug: "child-1",
    title: "Child child-1",
  }),
};
const GROUP: DisplayGroup = {
  groupKey: ROOT.data.id,
  root: ROOT,
  children: [CHILD],
};

/**
 * Daveth, 2026-10-21 "prototype decides" (PRD-595 / ISS-6560
 * `project-hierarchy-spec.ts`): a project hierarchy keeps its indented grid rows
 * at narrow widths and never becomes cards. Flat lists keep the card fallback.
 */
describe("DocumentsUngroupedTreeBody at phone width (ISS-9381)", () => {
  it("keeps hierarchy rows as grid rows instead of cards", () => {
    const { container } = render(
      <DocumentsUngroupedTreeBody
        isExpanded={() => true}
        items={documentTreeRoots([GROUP])}
        parentMap={new Map()}
        toggleRow={vi.fn()}
        visibleColumns={[Col.Type, Col.Updated]}
      />
    );

    expect(screen.getByText("Root root-1")).toBeInTheDocument();
    expect(screen.getByText("Child child-1")).toBeInTheDocument();
    expect(container.querySelector("dl")).toBeNull();
    expect(container.querySelectorAll(".grid").length).toBeGreaterThan(0);
  });

  it("still lets a flat row fall back to the card at the same width", () => {
    const { container } = render(
      <DocumentRow item={ROOT} visibleColumns={[Col.Type, Col.Updated]} />
    );

    expect(container.querySelector("dl")).not.toBeNull();
  });
});
