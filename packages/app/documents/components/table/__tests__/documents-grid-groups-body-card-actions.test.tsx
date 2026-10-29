import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { RankInteractionMode } from "@repo/app/documents/components/table/sort-keys";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/design-system/hooks/use-container-width", () => ({
  useContainerWidth: () => ({
    measured: true,
    ref: vi.fn(),
    width: 375,
  }),
}));
vi.mock("@repo/app/documents/components/favorite-button", () => ({
  FavoriteButton: () => null,
}));
vi.mock("@repo/app/documents/components/table/cells/name-cell", () => ({
  NameCell: ({ item }: { item: DocumentRowItem }) => (
    <span>{item.data.id}</span>
  ),
}));
vi.mock(
  "@repo/app/documents/components/table/document-row",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/app/documents/components/table/document-row")
    >()),
    useDocumentRowHref: () => () => null,
  })
);

import { DocumentsGridGroupsBody } from "@repo/app/documents/components/table/documents-grid-groups-body";

describe("DocumentsGridGroupsBody narrow-card actions", () => {
  it("renders and activates the same keyboard-operable row action on cards", () => {
    const onMove = vi.fn();
    const item: DocumentRowItem = {
      data: makeArtifact({ id: "card-row", title: "Card row" }),
      kind: "document",
    };

    render(
      <DocumentsGridGroupsBody
        allSelected={false}
        groupCollapse={{ isCollapsed: () => false, setCollapsed: vi.fn() }}
        isNested={false}
        items={[item]}
        leadingSortOptions={[]}
        onClearSort={vi.fn()}
        onSelectAll={vi.fn()}
        onSelectionChange={vi.fn()}
        onSort={vi.fn()}
        parentMap={new Map()}
        rankInteractionMode={RankInteractionMode.DisabledGrouped}
        renderRowActions={() => (
          <button onClick={onMove} type="button">
            Open row action
          </button>
        )}
        rowExpansion={{ isExpanded: () => true, setExpanded: vi.fn() }}
        selectedIds={new Set()}
        selectMode={false}
        showCheckbox={false}
        someSelected={false}
        sortBy={null}
        sortDir="asc"
        visibleColumns={[DocumentColumn.Type]}
      />
    );

    expect(screen.queryByRole("treegrid")).toBeNull();
    const action = screen.getByRole("button", { name: "Open row action" });
    fireEvent.click(action);
    expect(onMove).toHaveBeenCalledTimes(1);
  });
});
