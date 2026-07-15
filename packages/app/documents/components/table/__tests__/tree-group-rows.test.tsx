import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { render } from "./render-with-nav";

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

import type { Artifact } from "@repo/api/src/types/artifact";
import { ArtifactType } from "@repo/api/src/types/artifact";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import type { DisplayGroup } from "@repo/app/documents/components/table/document-tree";
import { RankInteractionMode } from "@repo/app/documents/components/table/sort-keys";
import { DocumentColumn as Col } from "@repo/app/shared/hooks/use-column-visibility";
import {
  makeArtifact,
  makePlanArtifact,
} from "@repo/app/shared/test-fixtures/documents";
import { TreeGroupRows } from "../tree-group-rows";

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
    handleMoreMenu?: (item: DocumentRowItem, anchor: HTMLElement) => void;
    rankInteractionMode?: RankInteractionMode;
  } = {}
) {
  const isGroupExpanded = options.isGroupExpanded ?? (() => false);
  const toggleGroup = options.toggleGroup ?? vi.fn();
  const handleMoreMenu = options.handleMoreMenu;
  const result = render(
    <TreeGroupRows
      group={group}
      handleMoreMenu={handleMoreMenu}
      isGroupExpanded={isGroupExpanded}
      parentMap={new Map()}
      rankInteractionMode={options.rankInteractionMode}
      toggleGroup={toggleGroup}
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

describe("TreeGroupRows — root row chevron rendering", () => {
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

describe("TreeGroupRows — Plan collapse (regression)", () => {
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

function findEllipsisButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>("button")
  ).filter((btn) => btn.querySelector("svg.lucide-ellipsis") !== null);
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

describe("TreeGroupRows — depth indentation and rank-slot alignment", () => {
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
});

describe("TreeGroupRows — group-internal borders", () => {
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

describe("TreeGroupRows — branch row more menu", () => {
  it("opens the shared more menu for a branch row (delete entry point in the tree)", () => {
    // Regression guard (PR #1385 follow-up): branch rows used to get
    // `onMoreMenu: undefined`, leaving the row ellipsis inert — the tree
    // view's only path to deleting a branch artifact was unreachable.
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
    const handleMoreMenu = vi.fn();

    const { container } = renderTreeGroup(group, {
      handleMoreMenu,
      isGroupExpanded: () => true,
    });

    const ellipsisButtons = findEllipsisButtons(container);
    expect(ellipsisButtons).toHaveLength(2);

    const [, branchEllipsis] = ellipsisButtons;
    fireEvent.click(branchEllipsis);

    expect(handleMoreMenu).toHaveBeenCalledTimes(1);
    expect(handleMoreMenu).toHaveBeenCalledWith(branch, branchEllipsis);
  });
});
