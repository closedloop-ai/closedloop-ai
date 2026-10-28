import { DndContext } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import { fireEvent, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

import type { Artifact } from "@repo/api/src/types/artifact";
import { ArtifactType } from "@repo/api/src/types/artifact";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import type { DisplayGroup } from "@repo/app/documents/components/table/document-tree";
import { RankInteractionMode } from "@repo/app/documents/components/table/sort-keys";
import { documentTreeRoots } from "@repo/app/documents/lib/documents-grid-groups";
import { DocumentColumn as Col } from "@repo/app/shared/hooks/use-column-visibility";
import {
  makeArtifact,
  makePlanArtifact,
} from "@repo/app/shared/test-fixtures/documents";
import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import { formatGridCardSelectionLabel } from "@repo/design-system/lib/grid-table-aria";
import {
  DocumentsUngroupedTreeBody,
  REORDER_ROW_LABEL,
} from "../documents-ungrouped-tree-body";

/** The handle's accessible name, as the stack-rank surfaces have always spelled it. */

function makeRootItem(id: string): DocumentRowItem {
  return {
    kind: "document",
    data: makeArtifact({ id, slug: id, title: `Root ${id}` }),
  };
}

function makeChildItem(id: string): DocumentRowItem {
  return {
    kind: "document",
    data: makePlanArtifact({ id, slug: id, title: `Child ${id}` }),
  };
}

function renderTreeGroup(
  group: DisplayGroup,
  options: {
    isGroupExpanded?: (key: string) => boolean;
    toggleGroup?: (key: string) => void;
    renderMoreMenu?: (item: DocumentRowItem) => ReactNode;
    rankInteractionMode?: RankInteractionMode;
  } = {}
) {
  const isGroupExpanded = options.isGroupExpanded ?? (() => false);
  const toggleGroup = options.toggleGroup ?? vi.fn();
  const renderMoreMenu = options.renderMoreMenu;
  const result = render(
    <DocumentsUngroupedTreeBody
      isExpanded={isGroupExpanded}
      items={documentTreeRoots([group])}
      parentMap={new Map()}
      rankInteractionMode={options.rankInteractionMode}
      renderRowActions={renderMoreMenu}
      toggleRow={toggleGroup}
      visibleColumns={[Col.Type]}
    />
  );
  return { ...result, toggleGroup };
}

function findChevronButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>("button")
  ).filter((btn) => btn.querySelector("svg.lucide-chevron-right") !== null);
}

describe("DocumentsUngroupedTreeBody — root row chevron rendering", () => {
  it("renders an enabled chevron on the root when the group has children", () => {
    // Regression guard: previously the chevron's render condition was based on
    // `root.children?.length`, but `groupByProjectTree` never sets `.children`
    // on the root DocumentRowItem (children live on `group.children`). That
    // hid the chevron and left users with no way to expand subtrees.
    const root = makeRootItem("root-1");
    const child = makeChildItem("child-1");
    const group: DisplayGroup = {
      groupKey: root.data.id,
      root,
      children: [child],
    };

    const { container } = renderTreeGroup(group);

    const chevrons = findChevronButtons(container);
    expect(chevrons).toHaveLength(1);

    const rootChevron = chevrons[0];
    expect(rootChevron).toBeEnabled();
    expect(rootChevron.className).toContain("hover:bg-muted");
    expect(rootChevron.className).not.toContain("cursor-default");
  });

  it("invokes toggleGroup with the group key when the root chevron is clicked", () => {
    const root = makeRootItem("root-1");
    const child = makeChildItem("child-1");
    const group: DisplayGroup = {
      groupKey: root.data.id,
      root,
      children: [child],
    };
    const toggleGroup = vi.fn();

    const { container } = renderTreeGroup(group, { toggleGroup });

    const [rootChevron] = findChevronButtons(container);
    fireEvent.click(rootChevron);

    expect(toggleGroup).toHaveBeenCalledTimes(1);
    expect(toggleGroup).toHaveBeenCalledWith(group.groupKey);
  });

  it("rotates the root chevron when the group is expanded", () => {
    const root = makeRootItem("root-1");
    const child = makeChildItem("child-1");
    const group: DisplayGroup = {
      groupKey: root.data.id,
      root,
      children: [child],
    };

    const { container } = renderTreeGroup(group, {
      isGroupExpanded: (key) => key === group.groupKey,
    });

    const [rootChevron] = findChevronButtons(container);
    const icon = rootChevron.querySelector("svg.lucide-chevron-right");
    expect(icon?.getAttribute("class") ?? "").toContain("rotate-90");
  });

  it("renders no chevron on the root when the group has no children", () => {
    const root = makeRootItem("root-1");
    const group: DisplayGroup = {
      groupKey: root.data.id,
      root,
      children: [],
    };

    const { container } = renderTreeGroup(group);

    expect(findChevronButtons(container)).toHaveLength(0);
  });

  it("renders the root chevron regardless of `root.children` (driven by group.children)", () => {
    // toRowItem() never attaches `.children` to a root; this asserts the
    // component derives expandability from group.children, not item.children.
    const root = makeRootItem("root-1");
    expect(
      (root as DocumentRowItem & { children?: DocumentRowItem[] }).children
    ).toBeUndefined();

    const group: DisplayGroup = {
      groupKey: root.data.id,
      root,
      children: [makeChildItem("child-1")],
    };

    const { container } = renderTreeGroup(group);
    expect(findChevronButtons(container)).toHaveLength(1);
  });
});

describe("DocumentsUngroupedTreeBody — Plan collapse (regression)", () => {
  // Regression guard: Plans with children were force-expanded and their chevron
  // was hidden (`showChevron = itemHasChildren && !itemIsPlan`), so users could
  // never collapse them — unlike PRDs and Features. Plans must now behave like
  // any other collapsible group in every position: a Plan with nested items
  // renders a chevron and honors its stored expansion state whether it is a
  // root or a child.
  function makePlanRootGroup(): DisplayGroup {
    const root: DocumentRowItem = {
      kind: "document",
      data: makePlanArtifact({ id: "plan-root-1", slug: "PLN-1" }),
    };
    return {
      groupKey: root.data.id,
      root,
      children: [makeBranchItem("branch-1")],
    };
  }

  it("renders an enabled chevron on a root-level Plan that has children", () => {
    const { container } = renderTreeGroup(makePlanRootGroup());

    const chevrons = findChevronButtons(container);
    expect(chevrons).toHaveLength(1);
    expect(chevrons[0]).toBeEnabled();
    expect(chevrons[0]?.className).toContain("hover:bg-muted");
  });

  it("toggles the group when the root Plan chevron is clicked", () => {
    const toggleGroup = vi.fn();
    const group = makePlanRootGroup();

    const { container } = renderTreeGroup(group, { toggleGroup });

    const [chevron] = findChevronButtons(container);
    fireEvent.click(chevron);

    expect(toggleGroup).toHaveBeenCalledTimes(1);
    expect(toggleGroup).toHaveBeenCalledWith(group.groupKey);
  });

  it("hides children when the root Plan group is collapsed", () => {
    // Collapsed by default (isGroupExpanded → false): only the root row shows,
    // proving the Plan is no longer force-expanded.
    const { container } = renderTreeGroup(makePlanRootGroup(), {
      isGroupExpanded: () => false,
    });

    expect(getRows(container)).toHaveLength(1);
  });

  it("shows children when the root Plan group is expanded", () => {
    const { container } = renderTreeGroup(makePlanRootGroup(), {
      isGroupExpanded: () => true,
    });

    expect(getRows(container)).toHaveLength(2);
  });

  function makeNestedPlanGroup(): {
    group: DisplayGroup;
    childPlanId: string;
  } {
    const prdRoot = makeRootItem("prd-1");
    const childPlan: DocumentRowItem = {
      kind: "document",
      data: makePlanArtifact({ id: "child-plan-1", slug: "PLN-2" }),
      children: [makeBranchItem("plan-branch-1")],
    };
    return {
      group: {
        groupKey: prdRoot.data.id,
        root: prdRoot,
        children: [childPlan],
      },
      childPlanId: childPlan.data.id,
    };
  }

  it("renders a chevron on a child Plan that has nested items", () => {
    const { group } = makeNestedPlanGroup();

    // Expand everything: both the PRD root and the nested Plan render a chevron.
    const { container } = renderTreeGroup(group, {
      isGroupExpanded: () => true,
    });

    expect(findChevronButtons(container)).toHaveLength(2);
    // Root PRD + child Plan + grandchild branch = 3 rows.
    expect(getRows(container)).toHaveLength(3);
  });

  it("collapses a child Plan independently of its parent", () => {
    const { group, childPlanId } = makeNestedPlanGroup();

    // Root stays open, only the nested Plan is collapsed: its branch disappears,
    // proving the child Plan is independently collapsible.
    const { container } = renderTreeGroup(group, {
      isGroupExpanded: (key) => key !== childPlanId,
    });

    // Root PRD + child Plan (branch hidden) = 2 rows.
    expect(getRows(container)).toHaveLength(2);
  });

  it("toggles a child Plan with its own id when its chevron is clicked", () => {
    const { group, childPlanId } = makeNestedPlanGroup();
    const toggleGroup = vi.fn();

    const { container } = renderTreeGroup(group, {
      isGroupExpanded: () => true,
      toggleGroup,
    });

    // Second chevron belongs to the nested Plan (first is the PRD root).
    const [, childChevron] = findChevronButtons(container);
    fireEvent.click(childChevron);

    expect(toggleGroup).toHaveBeenCalledWith(childPlanId);
  });
});

function makeBranchItem(id: string): DocumentRowItem {
  const data: Artifact = {
    id,
    type: ArtifactType.Branch,
    subtype: null,
    name: `Branch ${id}`,
    slug: null,
    externalUrl: "https://github.com/org/repo/pull/42",
    organizationId: "org-1",
    projectId: "project-1",
    status: "ACTIVE",
    priority: null,
    assigneeId: null,
    assignee: null,
    createdById: "user-1",
    dueDate: null,
    sortOrder: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-02"),
  };
  return { kind: "branch", data };
}

function getRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("div.group\\/row"));
}

function getIndentWidths(container: HTMLElement): number[] {
  return getRows(container).map((row) => {
    const spacer = row.querySelector<HTMLElement>(
      'div[aria-hidden="true"].shrink-0[style]'
    );
    return spacer ? Number.parseInt(spacer.style.width, 10) : 0;
  });
}

describe("DocumentsUngroupedTreeBody — depth indentation and rank-slot alignment", () => {
  function makeNestedGroup(): DisplayGroup {
    const root = makeRootItem("root-1");
    const grandchild = makeChildItem("grandchild-1");
    const child: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ id: "child-1", slug: "child-1", title: "Child" }),
      children: [grandchild],
    };
    return { groupKey: root.data.id, root, children: [child] };
  }

  it("indents each tree level one slot width deeper than its parent", () => {
    const { container } = renderTreeGroup(makeNestedGroup(), {
      isGroupExpanded: () => true,
    });

    // Root, child, grandchild → 0px, 28px, 56px leading indent.
    expect(getIndentWidths(container)).toEqual([0, 28, 56]);
  });

  it("keeps the rank slot inline so the grid gains no extra leading column", () => {
    // The rank grip lives inside the name cell, not in a dedicated grid
    // column — a dedicated column offset the header from the page content and
    // (rendered on roots only) exactly cancelled one level of child indent.
    const { container } = renderTreeGroup(makeNestedGroup(), {
      isGroupExpanded: () => true,
      rankInteractionMode: RankInteractionMode.DisabledGrouped,
    });

    const rows = getRows(container);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.style.gridTemplateColumns.startsWith("28px")).toBe(false);
    }

    // Root renders the (disabled) grip inline; child rows reserve an empty
    // spacer of the same width, so relative indentation survives.
    const [rootRow, ...childRows] = rows;
    expect(rootRow?.querySelector("svg.lucide-grip-vertical")).not.toBeNull();
    for (const childRow of childRows) {
      expect(childRow.querySelector("svg.lucide-grip-vertical")).toBeNull();
      expect(
        childRow.querySelector('div[aria-hidden="true"].w-7.shrink-0')
      ).not.toBeNull();
    }
    expect(getIndentWidths(container)).toEqual([0, 28, 56]);
  });

  it("keeps the flag-off rank grip visible on row hover and keyboard focus", () => {
    const { container } = renderTreeGroup(makeNestedGroup(), {
      rankInteractionMode: RankInteractionMode.Enabled,
    });

    const handle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Reorder row"]'
    );
    expect(handle).not.toBeNull();
    expect(handle).toHaveAttribute("data-grid-contextual-action", "");
    expect(handle).toHaveClass(
      "opacity-0",
      "group-hover/row:opacity-100",
      "focus-visible:opacity-100",
      "touch:opacity-100"
    );
    expect(handle?.parentElement).not.toHaveAttribute(
      "data-grid-contextual-action"
    );
  });
});

describe("DocumentsUngroupedTreeBody — group-internal borders", () => {
  function getRowBorderFlags(container: HTMLElement): boolean[] {
    return getRows(container).map(
      (row) => row.querySelector("div.absolute.border-b") !== null
    );
  }

  it("draws the bottom border only on the group's last visible row", () => {
    const root = makeRootItem("root-1");
    const group: DisplayGroup = {
      groupKey: root.data.id,
      root,
      children: [makeChildItem("child-1"), makeChildItem("child-2")],
    };

    const { container } = renderTreeGroup(group, {
      isGroupExpanded: () => true,
    });

    // Root + two children: only the final row separates this group from the
    // next one.
    expect(getRowBorderFlags(container)).toEqual([false, false, true]);
  });

  it("draws the border on the root when the group is collapsed", () => {
    const root = makeRootItem("root-1");
    const group: DisplayGroup = {
      groupKey: root.data.id,
      root,
      children: [makeChildItem("child-1")],
    };

    const { container } = renderTreeGroup(group, {
      isGroupExpanded: () => false,
    });

    expect(getRowBorderFlags(container)).toEqual([true]);
  });
});

describe("DocumentsUngroupedTreeBody — per-row more menu", () => {
  it("renders each row's own overflow menu via renderMoreMenu (delete entry point in the tree)", () => {
    // Regression guard (PR #1385 follow-up, FEA-4242): every tree row — the
    // root plan and the nested branch — must render its OWN overflow menu, so
    // the tree view's path to deleting a branch artifact stays reachable. The
    // menu is now per-row (`renderMoreMenu`), not a shared view-level menu, so
    // `renderMoreMenu` is invoked once per rendered row item.
    const root: DocumentRowItem = {
      kind: "document",
      data: makePlanArtifact({ id: "plan-1", slug: "PLAN-1" }),
    };
    const branch = makeBranchItem("branch-1");
    const group: DisplayGroup = {
      groupKey: root.data.id,
      root,
      children: [branch],
    };
    const renderMoreMenu = vi.fn((item: DocumentRowItem) => (
      <button data-item-id={item.data.id} type="button">
        More actions
      </button>
    ));

    const { getAllByRole } = renderTreeGroup(group, {
      renderMoreMenu,
      isGroupExpanded: () => true,
    });

    // One menu trigger per row (root + branch child), each built from that
    // row's own item.
    const triggers = getAllByRole("button", { name: "More actions" });
    expect(triggers).toHaveLength(2);
    expect(renderMoreMenu).toHaveBeenCalledWith({
      ...root,
      children: [branch],
    });
    expect(renderMoreMenu).toHaveBeenCalledWith(branch);
    expect(
      triggers.some((t) => t.getAttribute("data-item-id") === branch.data.id)
    ).toBe(true);
  });
});

describe("DocumentsUngroupedTreeBody — stack-rank subtree handles (ISS-12462)", () => {
  const ROOT_WITH_CHILD_ID = "root-1";
  const LONE_ROOT_ID = "root-2";
  const CHILD_ID = "child-1";

  function renderRankable() {
    const items = documentTreeRoots([
      {
        children: [makeChildItem(CHILD_ID)],
        groupKey: ROOT_WITH_CHILD_ID,
        root: makeRootItem(ROOT_WITH_CHILD_ID),
      },
      {
        children: [],
        groupKey: LONE_ROOT_ID,
        root: makeRootItem(LONE_ROOT_ID),
      },
    ]);
    return render(
      <DndContext>
        <SortableContext
          items={[ROOT_WITH_CHILD_ID, LONE_ROOT_ID]}
          strategy={verticalListSortingStrategy}
        >
          <DocumentsUngroupedTreeBody
            isExpanded={() => true}
            items={items}
            parentMap={new Map()}
            rankInteractionMode={RankInteractionMode.Enabled}
            toggleRow={vi.fn()}
            visibleColumns={[Col.Type]}
          />
        </SortableContext>
      </DndContext>
    );
  }

  function rowTitled(container: HTMLElement, title: string): HTMLElement {
    const row = getRows(container).find((candidate) =>
      candidate.textContent?.includes(title)
    );
    if (!row) {
      throw new Error(`no row titled "${title}"`);
    }
    return row;
  }

  it("gives each root exactly one reorder handle and its descendants none", () => {
    const { container, getAllByRole } = renderRankable();

    const handles = getAllByRole("button", { name: REORDER_ROW_LABEL });
    expect(handles).toHaveLength(2);
    for (const rootTitle of [
      `Root ${ROOT_WITH_CHILD_ID}`,
      `Root ${LONE_ROOT_ID}`,
    ]) {
      const row = rowTitled(container, rootTitle);
      expect(handles.filter((handle) => row.contains(handle))).toHaveLength(1);
    }
    const childRow = rowTitled(container, `Child ${CHILD_ID}`);
    expect(handles.some((handle) => childRow.contains(handle))).toBe(false);
  });

  it("moves a root's visible descendants inside the same sortable node as the root", () => {
    const { container } = renderRankable();

    const rootRow = rowTitled(container, `Root ${ROOT_WITH_CHILD_ID}`);
    const childRow = rowTitled(container, `Child ${CHILD_ID}`);
    const loneRow = rowTitled(container, `Root ${LONE_ROOT_ID}`);
    const sortableNode = rootRow.closest<HTMLElement>(
      `[data-sortable-subtree-id="${ROOT_WITH_CHILD_ID}"]`
    );

    expect(sortableNode).not.toBeNull();
    expect(sortableNode?.contains(childRow)).toBe(true);
    expect(sortableNode?.contains(loneRow)).toBe(false);
  });
});

describe("DocumentsUngroupedTreeBody — manual hierarchy handles", () => {
  it("uses the row title when an artifact has an empty slug", () => {
    const root = makeRootItem("root-1");
    root.data.slug = "";
    const { getByRole } = render(
      <DndContext>
        <SortableContext
          items={[root.data.id]}
          strategy={verticalListSortingStrategy}
        >
          <DocumentsUngroupedTreeBody
            isExpanded={() => true}
            items={[root]}
            manualPlacementEnabled
            parentMap={new Map()}
            rankInteractionMode={RankInteractionMode.Enabled}
            toggleRow={vi.fn()}
            visibleColumns={[Col.Type]}
          />
        </SortableContext>
      </DndContext>
    );

    expect(
      getByRole("button", { name: "Drag to reorder Root root-1" })
    ).toBeInTheDocument();
  });

  it("keeps document drag and selection affordances but excludes branch rows", () => {
    const root = makeRootItem("root-1");
    const childDocument = makeChildItem("child-1");
    const child = makeBranchItem("branch-1");
    root.children = [childDocument, child];
    const { getByRole, container } = render(
      <DndContext>
        <SortableContext
          items={[root.data.id, childDocument.data.id, child.data.id]}
          strategy={verticalListSortingStrategy}
        >
          <DocumentsUngroupedTreeBody
            isExpanded={() => true}
            items={[root]}
            manualPlacementEnabled
            parentMap={new Map()}
            rankInteractionMode={RankInteractionMode.Enabled}
            showCheckbox
            toggleRow={vi.fn()}
            visibleColumns={[Col.Type]}
          />
        </SortableContext>
      </DndContext>
    );
    const rootHandle = getByRole("button", { name: "Drag to reorder root-1" });
    const childHandle = getByRole("button", {
      name: "Drag to reorder child-1",
    });
    for (const handle of [rootHandle, childHandle]) {
      expect(handle).toHaveClass("touch-none");
      for (const focusClass of CHIP_FOCUS_RING_CLASS.split(" ")) {
        expect(handle).toHaveClass(focusClass);
      }
      expect(handle).toHaveClass("focus-visible:ring-offset-2");
      expect(handle).toHaveClass("focus-visible:ring-offset-background");
    }
    const branchRow = getRows(container).find((row) =>
      row.textContent?.includes("Branch branch-1")
    );
    expect(
      screen.queryByRole("button", { name: "Drag to reorder Branch branch-1" })
    ).not.toBeInTheDocument();
    expect(branchRow?.querySelector("[role='checkbox']")).toBeNull();
    expect(branchRow?.querySelector("[style='width: 28px;']")).not.toBeNull();
    expect(getByRole("link", { name: "Root root-1" })).toHaveAttribute(
      "draggable",
      "false"
    );
    expect(
      container.querySelector('[data-sortable-subtree-id="root-1"] span.w-20')
    ).toBeEmptyDOMElement();
    const checkbox = getByRole("checkbox", {
      name: formatGridCardSelectionLabel("Child child-1", false),
    });
    checkbox.focus();
    expect(checkbox).toHaveFocus();
    expect(checkbox.parentElement).toHaveClass("focus-within:opacity-100");
  });
});
