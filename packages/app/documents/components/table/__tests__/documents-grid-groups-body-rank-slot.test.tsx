import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { RankInteractionMode } from "@repo/app/documents/components/table/sort-keys";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { stubResponsiveNarrowViewport } from "@repo/app/test/mocks/responsive-narrow-viewport";
import type { GridTableV2Group } from "@repo/design-system/lib/grid-table-v2-types";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const EARLIER_GROUP_NAME_PATTERN = /Earlier/;

/**
 * ISS-12462 (PRD-720, DT-11/12/13/20): on the shared grid, the stack-rank slot
 * belongs to ROOT rows only. A grouped board renders the greyed handle on each
 * root and an empty spacer of the same track width on each descendant, so a
 * descendant never offers a handle for a drag it cannot take. The slot follows
 * the occurrence the grid actually PAINTS: an identity that is a child in an
 * earlier open band is painted there (as a child), and painted as a root in a
 * later band only once the earlier band is collapsed.
 */
vi.mock("@repo/app/documents/components/favorite-button", () => ({
  FavoriteButton: () => null,
}));
// The subject is the rank slot the body hands the name cell, not the cell's own
// title, link and checkbox (which need the app's auth and api providers).
vi.mock("@repo/app/documents/components/table/cells/name-cell", () => ({
  NameCell: ({
    item,
    rankSlot,
    showCheckbox,
  }: {
    item: { data: { id: string } };
    rankSlot: ReactNode;
    showCheckbox: boolean;
  }) => (
    <div
      data-row-id={item.data.id}
      data-show-checkbox={showCheckbox ? "true" : "false"}
      data-testid="name-cell"
    >
      {rankSlot}
    </div>
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

import { RANK_SLOT_WIDTH_CLASS } from "@repo/app/documents/components/table/cells/rank-slot";
import { DocumentsGridGroupsBody } from "@repo/app/documents/components/table/documents-grid-groups-body";

const GRIP_ICON_SELECTOR = "svg.lucide-grip-vertical";
const DRAG_HANDLE_PATTERN = /^Drag to reorder /;

function item(id: string, children?: DocumentRowItem[]): DocumentRowItem {
  return {
    kind: "document",
    data: makeArtifact({ id }),
    ...(children ? { children } : {}),
  };
}

function contextItem(kind: "branch" | "session", id: string): DocumentRowItem {
  return {
    kind,
    data: { ...makeArtifact({ id }), name: `${kind} ${id}` },
  } as unknown as DocumentRowItem;
}

const SHARED_ID = "shared";
const EARLIER_ROOT_ID = "earlier-root";
const LATER_SIBLING_ID = "later-sibling";

/**
 * Two bands. `shared` is a CHILD of `earlier-root` in the first band and a ROOT
 * of the second band, the shape a cross-status lineage produces.
 */
function bands(): GridTableV2Group<DocumentRowItem>[] {
  return [
    {
      count: null,
      items: [item(EARLIER_ROOT_ID, [item(SHARED_ID)])],
      key: "earlier",
      label: "Earlier",
    },
    {
      count: null,
      items: [item(SHARED_ID), item(LATER_SIBLING_ID)],
      key: "later",
      label: "Later",
    },
  ];
}

function renderBody(
  collapsedKeys: ReadonlySet<string>,
  responsiveNarrowEnabled = false
) {
  const body = (
    <DocumentsGridGroupsBody
      allSelected={false}
      groupCollapse={{
        isCollapsed: (key) => collapsedKeys.has(key),
        setCollapsed: vi.fn(),
      }}
      groups={bands()}
      isNested
      leadingSortOptions={[]}
      onClearSort={vi.fn()}
      onRenderedItemsChange={vi.fn()}
      onSelectAll={vi.fn()}
      onSelectionChange={vi.fn()}
      onSort={vi.fn()}
      parentMap={new Map()}
      rankInteractionMode={RankInteractionMode.DisabledGrouped}
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
  return render(
    responsiveNarrowEnabled ? (
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
        })}
      >
        {body}
      </FeatureFlagAdapterProvider>
    ) : (
      body
    )
  );
}

/** What each painted row's rank slot renders, keyed by row id. */
function slotKinds(): Map<string, "grip" | "spacer" | "none"> {
  const kinds = new Map<string, "grip" | "spacer" | "none">();
  for (const cell of screen.getAllByTestId("name-cell")) {
    const slot = cell.firstElementChild;
    const rowId = cell.getAttribute("data-row-id") ?? "";
    if (slot === null) {
      kinds.set(rowId, "none");
    } else if (slot.querySelector(GRIP_ICON_SELECTOR) === null) {
      kinds.set(rowId, "spacer");
    } else {
      kinds.set(rowId, "grip");
    }
  }
  return kinds;
}

function slotOf(rowId: string): Element {
  const cell = screen
    .getAllByTestId("name-cell")
    .find((candidate) => candidate.getAttribute("data-row-id") === rowId);
  const slot = cell?.firstElementChild;
  if (!slot) {
    throw new Error(`no rank slot painted for ${rowId}`);
  }
  return slot;
}

describe("DocumentsGridGroupsBody root-only rank slot (ISS-12462)", () => {
  it("adopts the product pointer contract only when its rollout key is enabled", () => {
    const renderProductionCaller = (enabledFlags: string[]) =>
      render(
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({
            enabledFlags,
          })}
        >
          <DocumentsGridGroupsBody
            allSelected={false}
            groupCollapse={{ isCollapsed: () => false, setCollapsed: vi.fn() }}
            groups={bands()}
            isNested
            leadingSortOptions={[]}
            onClearSort={vi.fn()}
            onRenderedItemsChange={vi.fn()}
            onSelectAll={vi.fn()}
            onSelectionChange={vi.fn()}
            onSort={vi.fn()}
            parentMap={new Map()}
            rankInteractionMode={RankInteractionMode.DisabledGrouped}
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
        </FeatureFlagAdapterProvider>
      );

    const disabled = renderProductionCaller([]);
    expect(
      disabled.container.querySelector(
        '[data-grid-interaction-contract="pointer-hover"]'
      )
    ).toBeNull();
    disabled.unmount();

    const enabled = renderProductionCaller([
      GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
    ]);
    expect(
      enabled.container.querySelector(
        '[data-grid-interaction-contract="pointer-hover"]'
      )
    ).not.toBeNull();
  });

  it("gives roots the greyed handle and descendants a spacer of the same width", () => {
    renderBody(new Set());

    const kinds = slotKinds();
    expect(kinds.get(EARLIER_ROOT_ID)).toBe("grip");
    expect(kinds.get(LATER_SIBLING_ID)).toBe("grip");
    // Painted under its earlier root, so it is a descendant here.
    expect(kinds.get(SHARED_ID)).toBe("spacer");

    expect(slotOf(SHARED_ID)).toHaveAttribute("aria-hidden", "true");
    expect(slotOf(SHARED_ID).classList.contains(RANK_SLOT_WIDTH_CLASS)).toBe(
      true
    );
    expect(
      slotOf(EARLIER_ROOT_ID).classList.contains(RANK_SLOT_WIDTH_CLASS)
    ).toBe(true);
  });

  it("paints the repeated identity once, as the earlier band's descendant, while that band is open", () => {
    renderBody(new Set());

    const sharedCells = screen
      .getAllByTestId("name-cell")
      .filter((cell) => cell.getAttribute("data-row-id") === SHARED_ID);
    expect(sharedCells).toHaveLength(1);
  });

  it("gives the repeated identity the root handle once the earlier band is collapsed", () => {
    renderBody(new Set(["earlier"]));

    const kinds = slotKinds();
    // The earlier band paints nothing, so its root is gone and `shared` is
    // painted as the later band's root.
    expect(kinds.has(EARLIER_ROOT_ID)).toBe(false);
    expect(kinds.get(SHARED_ID)).toBe("grip");
    expect(kinds.get(LATER_SIBLING_ID)).toBe("grip");
  });

  it("[DT-01][DT-07][DT-16] keeps document groups and hierarchy in the one-column narrow list", () => {
    const restoreWidth = stubResponsiveNarrowViewport(true).restore;
    try {
      renderBody(new Set(), true);

      expect(screen.getByRole("treegrid")).toHaveClass("min-w-0");
      expect(screen.getAllByRole("columnheader")).toHaveLength(1);
      expect(screen.getByRole("columnheader")).toHaveTextContent("Name");
      expect(
        screen.getByRole("button", { name: EARLIER_GROUP_NAME_PATTERN })
      ).toHaveAttribute("aria-expanded", "true");
      expect(screen.getAllByTestId("name-cell")).toHaveLength(3);
    } finally {
      restoreWidth();
    }
  });

  it("[DT-21] reserves a flexible narrow name track before intrinsic row actions", () => {
    const restoreWidth = stubResponsiveNarrowViewport(true).restore;
    try {
      renderBody(new Set(), true);

      const name = screen.getAllByTestId("name-cell")[0];
      // ISS-12959: one-line rows, so the actions never wrap below the name.
      expect(name?.parentElement).toHaveClass("min-w-0", "flex-1");
      expect(name?.parentElement?.parentElement).not.toHaveClass("flex-wrap");
      expect(name?.closest("[data-grid-row]")).toHaveClass("min-h-11");
    } finally {
      restoreWidth();
    }
  });

  it("keeps the captured-main grouped Document cards at compact content width while the rollout flag is off", () => {
    const restoreWidth = stubContainerWidthPx(390);
    try {
      renderBody(new Set());

      expect(screen.queryByRole("treegrid")).toBeNull();
      const cardWrappers = Array.from(
        document.querySelectorAll("[data-grid-card-id]")
      );
      const rootCards = cardWrappers.filter(
        (card) => !card.parentElement?.closest("[data-grid-card-id]")
      );
      expect(rootCards).toHaveLength(3);
      expect(cardWrappers).toHaveLength(6);
      for (const card of rootCards) {
        expect(card.querySelector("[data-grid-card-id]")).toHaveAttribute(
          "data-grid-card-id",
          card.getAttribute("data-grid-card-id")
        );
      }
      expect(
        screen.getByRole("button", { name: EARLIER_GROUP_NAME_PATTERN })
      ).toHaveAttribute("aria-expanded", "true");
    } finally {
      restoreWidth();
    }
  });
});

it("keeps a drag handle and keyboard placement on every manual hierarchy row", () => {
  const onKeyboardPlacement = vi.fn();
  render(
    <DocumentsGridGroupsBody
      allSelected={false}
      groupCollapse={{ isCollapsed: () => false, setCollapsed: vi.fn() }}
      isNested
      items={[item(EARLIER_ROOT_ID, [item(SHARED_ID)])]}
      leadingSortOptions={[]}
      onClearSort={vi.fn()}
      onKeyboardPlacement={onKeyboardPlacement}
      onRowDrop={vi.fn()}
      onSelectAll={vi.fn()}
      onSelectionChange={vi.fn()}
      onSort={vi.fn()}
      parentMap={new Map()}
      rankInteractionMode={RankInteractionMode.Enabled}
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

  const handles = screen.getAllByRole("button", {
    name: DRAG_HANDLE_PATTERN,
  });
  expect(handles).toHaveLength(2);
  fireEvent.keyDown(handles[1] as HTMLElement, {
    ctrlKey: true,
    key: "ArrowDown",
  });
  expect(onKeyboardPlacement).toHaveBeenCalledWith(SHARED_ID, "down");
});

it("omits placement handles and keyboard placement from branch and session context rows", () => {
  const branch = contextItem("branch", "branch-context");
  const session = contextItem("session", "session-context");
  const onKeyboardPlacement = vi.fn();
  render(
    <DocumentsGridGroupsBody
      allSelected={false}
      groupCollapse={{ isCollapsed: () => false, setCollapsed: vi.fn() }}
      isNested
      items={[item(EARLIER_ROOT_ID), branch, session]}
      leadingSortOptions={[]}
      onClearSort={vi.fn()}
      onKeyboardPlacement={onKeyboardPlacement}
      onRowDrop={vi.fn()}
      onSelectAll={vi.fn()}
      onSelectionChange={vi.fn()}
      onSort={vi.fn()}
      parentMap={new Map()}
      rankInteractionMode={RankInteractionMode.Enabled}
      renderRowActions={() => null}
      rowExpansion={{ isExpanded: () => true, setExpanded: vi.fn() }}
      selectedIds={new Set()}
      selectMode
      showCheckbox
      someSelected={false}
      sortBy={null}
      sortDir="asc"
      visibleColumns={[DocumentColumn.Type]}
    />
  );

  expect(slotOf(EARLIER_ROOT_ID).querySelector("button")).not.toBeNull();
  expect(
    screen.getAllByRole("button", { name: DRAG_HANDLE_PATTERN })
  ).toHaveLength(1);
  const checkboxStateById = new Map(
    screen
      .getAllByTestId("name-cell")
      .map((cell) => [cell.dataset.rowId, cell.dataset.showCheckbox])
  );
  // AC3 removes placement, not selection: the hook leaves these rows out of
  // a placement's sources, while bulk actions still select them.
  expect(checkboxStateById.get(EARLIER_ROOT_ID)).toBe("true");
  expect(checkboxStateById.get("branch-context")).toBe("true");
  expect(checkboxStateById.get("session-context")).toBe("true");
  for (const contextRowId of ["branch-context", "session-context"]) {
    expect(slotOf(contextRowId)).toHaveAttribute("aria-hidden", "true");
    expect(slotOf(contextRowId).classList.contains(RANK_SLOT_WIDTH_CLASS)).toBe(
      true
    );
  }
  expect(onKeyboardPlacement).not.toHaveBeenCalled();
});

import { HierarchyAvailability } from "@repo/api/src/types/project-tree";

describe("DocumentsGridGroupsBody hierarchy availability", () => {
  it.each([
    [HierarchyAvailability.Error, "error"],
    [HierarchyAvailability.Partial, "partial"],
    [HierarchyAvailability.PermissionHidden, "forbidden"],
    [HierarchyAvailability.Unavailable, "unavailable"],
  ])(
    "renders %s through the canonical table-cell state",
    (availability, state) => {
      const unavailableItem: DocumentRowItem = {
        ...item(`item-${availability}`),
        hierarchy: { availability, childCount: 1 },
      };
      render(
        <DocumentsGridGroupsBody
          allSelected={false}
          groupCollapse={{ isCollapsed: () => false, setCollapsed: vi.fn() }}
          isNested
          items={[unavailableItem]}
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

      expect(
        document.querySelector(`[data-cell-value-state="${state}"]`)
      ).toBeInTheDocument();
    }
  );
});
