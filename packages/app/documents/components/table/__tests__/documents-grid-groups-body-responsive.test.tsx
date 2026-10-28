import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";
import type { GridTableV2Group } from "@repo/design-system/lib/grid-table-v2-types";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const containerWidth = vi.hoisted(() => ({ value: 1024 }));

vi.mock("@repo/design-system/hooks/use-container-width", () => ({
  useContainerWidth: () => ({
    measured: true,
    ref: vi.fn(),
    width: containerWidth.value,
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

describe("DocumentsGridGroupsBody responsive hierarchy contract", () => {
  it("preserves the main table containment for grouped documents at 1024px", () => {
    containerWidth.value = 1024;
    renderBody({ groups: groupedRows(), isNested: true });

    const treegrid = screen.getByRole("treegrid");
    expect(treegrid).toHaveClass("min-w-fit");
    expect(treegrid.closest(".overflow-x-auto")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it.each([390, 412])(
    "keeps the canonical hierarchy as a sideways treegrid at %ipx",
    (width) => {
      containerWidth.value = width;
      renderBody({ items: hierarchyRows(), isNested: true });

      expect(screen.getByRole("treegrid")).toHaveClass("min-w-fit");
      expect(screen.queryByRole("list")).toBeNull();
      expect(document.querySelector('[data-slot="card"]')).toBeNull();
    }
  );
});

function renderBody({
  groups,
  isNested,
  items,
}: {
  groups?: GridTableV2Group<DocumentRowItem>[];
  isNested: boolean;
  items?: DocumentRowItem[];
}) {
  return render(
    <DocumentsGridGroupsBody
      allSelected={false}
      groupCollapse={{ isCollapsed: () => false, setCollapsed: vi.fn() }}
      groups={groups}
      isNested={isNested}
      items={items}
      leadingSortOptions={[]}
      onClearSort={vi.fn()}
      onSelectAll={vi.fn()}
      onSelectionChange={vi.fn()}
      onSort={vi.fn()}
      parentMap={new Map()}
      renderRowActions={() => null}
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
}

function groupedRows(): GridTableV2Group<DocumentRowItem>[] {
  return [
    {
      count: 1,
      items: [documentItem("grouped-root")],
      key: "group",
      label: "Group",
    },
  ];
}

function hierarchyRows(): DocumentRowItem[] {
  return [documentItem("hierarchy-root", [documentItem("hierarchy-child")])];
}

function documentItem(
  id: string,
  children?: DocumentRowItem[]
): DocumentRowItem {
  return {
    data: makeArtifact({ id, title: id }),
    kind: "document",
    ...(children ? { children } : {}),
  };
}
