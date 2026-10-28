import { ArtifactType } from "@repo/api/src/types/artifact";
import { DocumentStatus } from "@repo/api/src/types/document";
import {
  HierarchyAvailability,
  type ProjectTreeResponse,
} from "@repo/api/src/types/project-tree";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { NAME_SORT_OPTIONS } from "@repo/app/shared/lib/sort-comparators";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";
import { stubResponsiveNarrowViewport } from "@repo/app/test/mocks/responsive-narrow-viewport";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-9335 — the project board's grouped body, rendered through the shared
 * grid's bands instead of its own section renderer.
 *
 * The count cases are DELIBERATELY the same four ISS-4704 pinned for the
 * bespoke header (`documents-view-section-counts.test.tsx`), asked of the new
 * renderer: a migration that quietly stopped honouring the caller's population
 * would be a header confidently publishing this page's slice as the status's
 * size, which is the defect that suite exists to prevent. The ungrouped case
 * preserves the separate rankable row body.
 */
const mocks = vi.hoisted(() => ({
  toggleGroup: vi.fn(),
  toggleTreeGroup: vi.fn(),
  useProjectTree: vi.fn(),
  useProjectTreeExpansionBatch: vi.fn(),
  useFeatureFlagEnabled: vi.fn(),
  useFeatureFlagEnabledOptional: vi.fn(),
  useSortParams: vi.fn(),
  useGroupExpansion: vi.fn(),
  useMergeDocuments: vi.fn(),
  useStackRanking: vi.fn(),
  useContextGroupExpansion: vi.fn(),
}));

let restoreViewport: (() => void) | undefined;

vi.mock("@repo/app/projects/hooks/use-project-tree", () => ({
  useProjectTree: mocks.useProjectTree,
  useProjectTreeExpansionBatch: mocks.useProjectTreeExpansionBatch,
}));
vi.mock(
  "@repo/app/shared/feature-flags/use-feature-flag-enabled",
  async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    useFeatureFlagEnabled: mocks.useFeatureFlagEnabled,
    useFeatureFlagEnabledOptional: mocks.useFeatureFlagEnabledOptional,
  })
);
vi.mock("@repo/app/shared/hooks/use-sort-params", () => ({
  useSortParams: mocks.useSortParams,
}));
vi.mock("@repo/app/shared/hooks/use-group-expansion", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useGroupExpansion: mocks.useGroupExpansion,
}));
vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useMergeDocuments: mocks.useMergeDocuments,
}));
// The floating bulk bar mounts as soon as a selection exists and pulls in the
// batch mutation, auth and the api client. The subject here is whether the
// header control reaches the ROWS, which the rows themselves report, so the
// bar is stubbed like every other provider-hungry child in this suite.
vi.mock("@repo/app/documents/components/table/documents-bulk-actions", () => ({
  DocumentsBulkActions: () => null,
}));
vi.mock("@repo/app/documents/hooks/use-stack-ranking", () => ({
  useStackRanking: mocks.useStackRanking,
}));
vi.mock("@repo/app/documents/hooks/use-context-group-expansion", () => ({
  useContextGroupExpansion: mocks.useContextGroupExpansion,
}));
vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => `/acme${path}`,
}));
// The subject is the band, not the row inside it. These three pull in the auth,
// api-client and navigation providers an app root supplies; stub them so both
// bodies mount, and leave the grouping pipeline, the grid and the header real.
vi.mock("@repo/app/documents/components/favorite-button", () => ({
  FavoriteButton: () => <button aria-label="Favorite" type="button" />,
}));
vi.mock("@repo/app/documents/components/table/cells/name-cell", () => ({
  NameCell: ({
    isSelected,
    item,
    onSelectionChange,
  }: {
    isSelected?: boolean;
    item: { data: { id: string } };
    onSelectionChange?: (
      id: string,
      checked: boolean,
      modifiers?: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }
    ) => void;
  }) => (
    <button
      data-testid="grid-lead"
      onClick={(event) => onSelectionChange?.(item.data.id, !isSelected, event)}
      type="button"
    >
      {item.data.id}
    </button>
  ),
}));
vi.mock(
  "@repo/app/documents/components/table/document-row",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@repo/app/documents/components/table/document-row")
      >();
    return {
      ...actual,
      DocumentRow: ({ item }: { item: { data: { id: string } } }) => (
        <div data-testid="document-row">{item.data.id}</div>
      ),
      useDocumentRowHref: () => () => null,
    };
  }
);

import { DocumentsView } from "@repo/app/documents/components/table/documents-view";

/** One page of a larger board: 1 Draft row, 2 In Review rows. */
const PAGE_DOCUMENTS = [
  makeArtifact({ id: "draft-a", status: DocumentStatus.Draft }),
  makeArtifact({ id: "review-a", status: DocumentStatus.InReview }),
  makeArtifact({ id: "review-b", status: DocumentStatus.InReview }),
];
const DRAFT_TOTAL = 4;
const IN_REVIEW_TOTAL = 7;
const SECTION_TOTALS: ReadonlyMap<string, number> = new Map([
  [DocumentStatus.Draft, DRAFT_TOTAL],
  [DocumentStatus.InReview, IN_REVIEW_TOTAL],
]);

/** The collapse axes a grouping stores its closed bands under. */
const STATUS_AXIS = `${GroupByMode.Status}|`;
const PRIORITY_AXIS = `${GroupByMode.Priority}|`;

const DIGITS_ONLY = /^\d+$/;
const CONTINUED_MARKER = "(continued)";
/** The lead header control, whose accessible name is the column label. */
const LEAD_LABEL_PATTERN = /Name/;
const MORE_ACTIONS_PATTERN = /More actions/;

const BASE_PROPS = {
  documents: PAGE_DOCUMENTS,
  filterCategory: "all" as const,
  filterText: "",
  groupBy: GroupByMode.Status,
  storageKey: "test",
  visibleColumns: [DocumentColumn.Type],
};

/** The columns the QA repro had on: one of each cell family. */
const GROUPED_DATA_COLUMNS = [
  DocumentColumn.Type,
  DocumentColumn.Assignee,
  DocumentColumn.Parent,
  DocumentColumn.Priority,
];

/** How many column dividers a row draws: every `border-l` box inside it. */
function columnDividers(row: HTMLElement): number {
  return [row, ...row.querySelectorAll<HTMLElement>("*")].filter((element) =>
    element.classList.contains("border-l")
  ).length;
}

/** A flat category tab, which is where the board offers row selection. */
const FLAT_CATEGORY_PROPS = {
  ...BASE_PROPS,
  filterCategory: "documents" as const,
};

/** The identity `columnheader`, which owns both restored controls. */
function leadHeader(): HTMLElement {
  const lead = screen
    .getAllByRole("columnheader")
    .find((cell) => cell.getAttribute("data-column-id") === "__leading__");
  if (!lead) {
    throw new Error("no leading column header rendered");
  }
  return lead;
}

function emptyTree(): ProjectTreeResponse {
  return { externalParents: [], nodes: [] };
}

const NESTED_CHILD = makeArtifact({
  id: "review-a-child",
  status: DocumentStatus.Draft,
});

/**
 * One root with one child, which is what the disclosure needs to exist at all:
 * a row whose `getChildren` returns nothing paints a reserved track and no
 * button, so a suite built on `emptyTree()` could never press one.
 */
function treeWithNestedChild(): ProjectTreeResponse {
  return {
    externalParents: [],
    nodes: [
      {
        children: [
          {
            depth: 1,
            id: NESTED_CHILD.id,
            parentId: "review-a",
            type: ArtifactType.Document,
          },
        ],
        root: { id: "review-a", type: ArtifactType.Document },
      },
    ],
  } as unknown as ProjectTreeResponse;
}

function hierarchyTreeWithNestedChild(): ProjectTreeResponse {
  return {
    ...treeWithNestedChild(),
    hierarchy: {
      capabilities: {
        childPaging: true,
        exactPlacement: true,
        maxVisibleLevels: 4,
        mutationVersion: "version-1",
        rootPaging: true,
      },
      contractVersion: 1,
      diagnostics: [],
      diagnosticsComplete: true,
    },
  };
}

function columnHeader(columnId: DocumentColumn): HTMLElement | undefined {
  return screen
    .getAllByRole("columnheader")
    .find((header) => header.getAttribute("data-column-id") === columnId);
}

/** The band header, located by its label rather than its doubled ARIA name. */
function bandHeader(label: string): HTMLElement {
  const header = screen
    .getAllByRole("button")
    .find(
      (button) =>
        button.getAttribute("aria-expanded") !== null &&
        button.textContent?.includes(label) === true
    );
  if (!header) {
    throw new Error(`No band header rendered for "${label}"`);
  }
  return header;
}

describe("DocumentsView grouped body on the shared grid (ISS-9335)", () => {
  afterEach(() => {
    restoreViewport?.();
    restoreViewport = undefined;
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useProjectTree.mockReturnValue({ data: undefined, isLoading: false });
    mocks.useProjectTreeExpansionBatch.mockReturnValue([]);
    // Keep unrelated flags shut so they cannot satisfy a grouping assertion.
    mocks.useFeatureFlagEnabled.mockReturnValue(false);
    mocks.useFeatureFlagEnabledOptional.mockReturnValue(false);
    mocks.useSortParams.mockReturnValue({
      clearPersistedSort: vi.fn(),
      clearSort: vi.fn(),
      setSort: vi.fn(),
      sortBy: null,
      sortDir: "asc",
    });
    mocks.useGroupExpansion.mockReturnValue({
      isExpanded: () => true,
      toggleGroup: mocks.toggleGroup,
    });
    mocks.useMergeDocuments.mockReturnValue({ mutateAsync: vi.fn() });
    mocks.useStackRanking.mockReturnValue({
      handleDragEnd: vi.fn(),
      isDndEnabled: false,
      isRankableMenuItem: () => false,
      moveToBottom: vi.fn(),
      moveToTop: vi.fn(),
      rankItemIds: [],
      rankInteractionMode: "disabledGrouped",
    });
    mocks.useContextGroupExpansion.mockReturnValue({
      isTreeGroupExpanded: () => true,
      toggleTreeGroup: mocks.toggleTreeGroup,
    });
  });

  it("renders the board's bands through the grid, not its own section rows", () => {
    render(<DocumentsView {...BASE_PROPS} treeData={emptyTree()} />);

    // A `treegrid`, not a `table`: the artifact tree is now the grid's own
    // lineage, so the rows carry `aria-level` and the disclosure is the grid's.
    expect(screen.getByRole("treegrid")).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryAllByTestId("document-row")).toHaveLength(0);
    expect(screen.getAllByTestId("grid-lead")).toHaveLength(
      PAGE_DOCUMENTS.length
    );
  });

  it("renders children supplied by the expansion-page production hook", () => {
    const baseTree = treeWithNestedChild();
    const root = baseTree.nodes[0];
    if (!root) {
      throw new Error("partial hierarchy fixture requires its root");
    }
    root.children = [];
    root.hierarchy = {
      availability: HierarchyAvailability.Partial,
      childCount: 1,
      hierarchyPath: [root.root.id],
    };
    baseTree.hierarchy = {
      capabilities: {
        childPaging: true,
        exactPlacement: true,
        maxVisibleLevels: 4,
        mutationVersion: "version-1",
        rootPaging: true,
      },
      contractVersion: 1,
      diagnostics: [],
      diagnosticsComplete: true,
    };
    const page = treeWithNestedChild();
    page.nodes = [
      {
        children: [],
        root: page.nodes[0]?.children[0] ?? NESTED_CHILD,
      },
    ] as ProjectTreeResponse["nodes"];
    page.hierarchy = {
      ...baseTree.hierarchy,
      childCount: 1,
      parentArtifactId: root.root.id,
    };
    mocks.useProjectTreeExpansionBatch.mockReturnValue([{ data: [page] }]);

    render(
      <DocumentsView
        {...BASE_PROPS}
        documents={[...PAGE_DOCUMENTS, NESTED_CHILD]}
        projectId="project-1"
        treeData={baseTree}
      />
    );

    expect(screen.getByText(NESTED_CHILD.id)).toBeVisible();
    expect(mocks.useProjectTreeExpansionBatch).toHaveBeenCalledWith(
      "project-1",
      [root.root.id]
    );
  });

  it("states the band's full population, not the rows this page holds", () => {
    render(
      <DocumentsView
        {...BASE_PROPS}
        sectionTotalsByKey={SECTION_TOTALS}
        treeData={emptyTree()}
      />
    );

    expect(
      within(bandHeader("In Review")).getByText(String(IN_REVIEW_TOTAL))
    ).toBeVisible();
    expect(
      within(bandHeader("Draft")).getByText(String(DRAFT_TOTAL))
    ).toBeVisible();
    // 2 and 1 are the page-local counts a migration would silently fall back to.
    expect(within(bandHeader("In Review")).queryByText("2")).toBeNull();
    expect(within(bandHeader("Draft")).queryByText("1")).toBeNull();
  });

  it("falls back to the page-local count for an unpaged caller", () => {
    render(<DocumentsView {...BASE_PROPS} treeData={emptyTree()} />);

    expect(within(bandHeader("In Review")).getByText("2")).toBeVisible();
    expect(within(bandHeader("Draft")).getByText("1")).toBeVisible();
  });

  it("renders no number for a band the supplied totals do not cover", () => {
    render(
      <DocumentsView
        {...BASE_PROPS}
        sectionTotalsByKey={new Map([[DocumentStatus.Draft, DRAFT_TOTAL]])}
        treeData={emptyTree()}
      />
    );

    expect(
      within(bandHeader("Draft")).getByText(String(DRAFT_TOTAL))
    ).toBeVisible();
    expect(within(bandHeader("In Review")).queryByText(DIGITS_ONLY)).toBeNull();
  });

  it("marks a band whose rows began on an earlier page, and only that one", () => {
    render(
      <DocumentsView
        {...BASE_PROPS}
        continuedSectionKeys={new Set([DocumentStatus.InReview])}
        sectionTotalsByKey={SECTION_TOTALS}
        treeData={emptyTree()}
      />
    );

    expect(
      within(bandHeader("In Review")).getByText(CONTINUED_MARKER)
    ).toBeVisible();
    expect(
      within(bandHeader("Draft")).queryByText(CONTINUED_MARKER)
    ).toBeNull();
  });

  it("reports a band collapse to the view's own expansion store", () => {
    // The write half of the `groupCollapse` port. The bands render open (the
    // store answers expanded), so the grid asks for `collapsed: true` and the
    // adapter must turn that into a toggle of THAT section's key — invert its
    // guard and every band header on the flag-on board goes inert.
    render(<DocumentsView {...BASE_PROPS} treeData={emptyTree()} />);

    fireEvent.click(bandHeader("In Review"));

    expect(mocks.toggleGroup).toHaveBeenCalledWith(DocumentStatus.InReview);
  });

  it("renders the owner's per-axis collapse and reports a band toggle to it (PRD-720 AC3)", () => {
    const onCollapsedGroupsChange = vi.fn();
    render(
      <DocumentsView
        {...BASE_PROPS}
        collapsedGroups={{
          [STATUS_AXIS]: [DocumentStatus.Draft],
          // The same key under another axis must not close the Status band.
          [PRIORITY_AXIS]: [DocumentStatus.InReview],
        }}
        onCollapsedGroupsChange={onCollapsedGroupsChange}
        treeData={emptyTree()}
      />
    );

    expect(bandHeader("Draft")).toHaveAttribute("aria-expanded", "false");
    expect(bandHeader("In Review")).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(bandHeader("In Review"));

    expect(onCollapsedGroupsChange).toHaveBeenCalledWith({
      [PRIORITY_AXIS]: [DocumentStatus.InReview],
      [STATUS_AXIS]: [DocumentStatus.Draft, DocumentStatus.InReview],
    });
    // The view's own remembered store is not the owner of this collapse.
    expect(mocks.toggleGroup).not.toHaveBeenCalled();
  });

  it("reports a row disclosure to the view's own tree-expansion store", () => {
    // The write half of the `rowExpansion` port, and the reason this case needs
    // a real subtree: without one the grid paints no disclosure to press.
    render(
      <DocumentsView
        {...BASE_PROPS}
        // The child's own document row: a tree node whose artifact is absent
        // from this list yields no row item, so the root paints with no subtree.
        documents={[...PAGE_DOCUMENTS, NESTED_CHILD]}
        treeData={treeWithNestedChild()}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Hide nested artifacts" })
    );

    expect(mocks.toggleTreeGroup).toHaveBeenCalledWith("review-a");
    expect(screen.queryAllByRole("row", { selected: true })).toHaveLength(0);
  });

  it("does not move a collapsed child selection to its parent", () => {
    render(
      <DocumentsView
        {...BASE_PROPS}
        documents={[...PAGE_DOCUMENTS, NESTED_CHILD]}
        treeData={hierarchyTreeWithNestedChild()}
      />
    );
    const childRow = document.querySelector<HTMLElement>(
      `[data-grid-row-id="${NESTED_CHILD.id}"]`
    );
    const parentRow = document.querySelector<HTMLElement>(
      '[data-grid-row-id="review-a"]'
    );
    if (!(childRow && parentRow)) {
      throw new Error(
        "hierarchy selection fixture requires parent and child rows"
      );
    }

    fireEvent.click(childRow);
    expect(childRow).toHaveAttribute("aria-selected", "true");
    fireEvent.click(
      within(parentRow).getByRole("button", {
        name: "Hide nested artifacts",
      })
    );

    expect(parentRow).toHaveAttribute("aria-selected", "false");
  });

  it("removes the redundant Parent column only from the canonical hierarchy", () => {
    const { rerender } = render(
      <DocumentsView
        {...BASE_PROPS}
        documents={[...PAGE_DOCUMENTS, NESTED_CHILD]}
        treeData={hierarchyTreeWithNestedChild()}
        visibleColumns={[DocumentColumn.Type, DocumentColumn.Parent]}
      />
    );

    expect(columnHeader(DocumentColumn.Parent)).toBeUndefined();

    rerender(
      <DocumentsView
        {...BASE_PROPS}
        documents={[...PAGE_DOCUMENTS, NESTED_CHILD]}
        treeData={treeWithNestedChild()}
        visibleColumns={[DocumentColumn.Type, DocumentColumn.Parent]}
      />
    );
    expect(columnHeader(DocumentColumn.Parent)).toBeVisible();
  });

  it("keeps select-all in the lead header, adding no track to do it", () => {
    // A flat category: the board only offers row checkboxes off the tree view
    // (`showCheckbox` is false on "all"), so this is where select-all exists at
    // all — in both arms.
    render(<DocumentsView {...FLAT_CATEGORY_PROPS} treeData={emptyTree()} />);

    expect(within(leadHeader()).getByRole("checkbox")).toBeVisible();
    // Unmoved: lead + Type + the actions track, the same run of three the
    // bespoke header declares. A utility track would have made it four.
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
  });

  it("selects every rendered row from the header checkbox", () => {
    render(<DocumentsView {...FLAT_CATEGORY_PROPS} treeData={emptyTree()} />);
    const rowCount = screen.getAllByTestId("grid-lead").length;
    expect(rowCount).toBeGreaterThan(0);

    // Nothing is selected before the press, so the count below cannot pass on
    // a selection that was already there.
    expect(screen.queryAllByRole("row", { selected: true })).toHaveLength(0);

    fireEvent.click(within(leadHeader()).getByRole("checkbox"));

    // Read off the ROWS, not the floating bulk bar: the bar mounts the batch
    // mutation, which needs providers this suite deliberately does not stand up.
    expect(screen.getAllByRole("row", { selected: true })).toHaveLength(
      rowCount
    );
  });

  it("PRD-718 AC4 extends a Shift range from the name cell's checkbox in painted order", () => {
    render(<DocumentsView {...FLAT_CATEGORY_PROPS} treeData={emptyTree()} />);
    const leads = screen.getAllByTestId("grid-lead");
    expect(leads.length).toBeGreaterThanOrEqual(3);

    fireEvent.click(leads[0]);
    fireEvent.click(leads[2], { shiftKey: true });

    expect(
      screen
        .getAllByRole("row", { selected: true })
        .map((row) => row.getAttribute("data-grid-row-id"))
    ).toEqual(leads.slice(0, 3).map((lead) => lead.textContent));
  });

  it("leaves rows in a collapsed band out of the header checkbox's select-all", () => {
    // ISS-12640 AC-3 (operator ruling 2026-10-20, Asana precedent): select-all
    // takes only painted rows, so reopening the band shows draft-a unselected.
    const { rerender } = render(
      <DocumentsView
        {...FLAT_CATEGORY_PROPS}
        collapsedGroups={{ [STATUS_AXIS]: [DocumentStatus.Draft] }}
        onCollapsedGroupsChange={vi.fn()}
        treeData={emptyTree()}
      />
    );
    expect(bandHeader("Draft")).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(within(leadHeader()).getByRole("checkbox"));
    rerender(
      <DocumentsView
        {...FLAT_CATEGORY_PROPS}
        collapsedGroups={{}}
        onCollapsedGroupsChange={vi.fn()}
        treeData={emptyTree()}
      />
    );

    expect(
      screen
        .getAllByRole("row", { selected: true })
        .map((row) => row.getAttribute("data-grid-row-id"))
        .sort()
    ).toEqual(["review-a", "review-b"]);
  });

  it("offers the board's own three sort keys, not a single toggle", () => {
    render(<DocumentsView {...BASE_PROPS} treeData={emptyTree()} />);

    fireEvent.pointerDown(
      within(leadHeader()).getByRole("button", { name: LEAD_LABEL_PATTERN }),
      { button: 0, ctrlKey: false }
    );

    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual(NAME_SORT_OPTIONS.map((option) => option.label));
  });

  it("renders a My Tasks mount's grouped tree on the grid", () => {
    // PRD-720 retired the project-board-only gate, so the mount shape My Tasks
    // passes (its own storage key, paged totals, loading label, no board
    // identity) reaches the same grid bands.
    render(
      <DocumentsView
        {...BASE_PROPS}
        loadingLabel="Loading tasks…"
        sectionTotalsByKey={SECTION_TOTALS}
        storageKey="my-tasks"
        treeData={emptyTree()}
      />
    );

    expect(screen.getByRole("treegrid")).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryAllByTestId("document-row")).toHaveLength(0);
    expect(bandHeader("In Review")).toBeVisible();
    expect(bandHeader("Draft")).toBeVisible();
  });

  it("renders a documents-index mount's grouped flat category on the grid", () => {
    // The index bodies pass a flat category and no project tree. A flat list
    // carries no lineage, so it is a `grid` rather than a `treegrid`, and its
    // bands still come from the shared grid.
    render(<DocumentsView {...FLAT_CATEGORY_PROPS} treeData={null} />);

    expect(screen.getByRole("grid")).toBeVisible();
    expect(screen.queryByRole("treegrid")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryAllByTestId("document-row")).toHaveLength(0);
    expect(screen.getAllByTestId("grid-lead")).toHaveLength(
      PAGE_DOCUMENTS.length
    );
    expect(bandHeader("In Review")).toBeVisible();
  });

  it("draws one column divider per header track in every grouped data row", () => {
    // Manual QA, PR #8885: each data column painted the grid's own cell box AND
    // the board cell's fixed-width bordered box inside it, so every value sat a
    // padding's width right of its header with a second divider. jsdom has no
    // layout, so the tracks are compared by the dividers that draw them.
    render(
      <DocumentsView
        {...BASE_PROPS}
        treeData={emptyTree()}
        visibleColumns={GROUPED_DATA_COLUMNS}
      />
    );

    const headerRow = leadHeader().closest('[role="row"]');
    if (!(headerRow instanceof HTMLElement)) {
      throw new Error("no header row rendered");
    }
    const headerDividers = columnDividers(headerRow);
    const dataRows = screen
      .getAllByTestId("grid-lead")
      .map((lead) => lead.closest('[role="row"]'))
      .filter((row): row is HTMLElement => row instanceof HTMLElement);

    expect(dataRows).toHaveLength(PAGE_DOCUMENTS.length);
    for (const row of dataRows) {
      expect(columnDividers(row)).toBe(headerDividers);
    }
  });

  it("keeps the ungrouped board on the ungrouped body", () => {
    // Ungrouped boards retain their rankable row body instead of the grouped grid.
    render(
      <DocumentsView
        {...BASE_PROPS}
        groupBy={GroupByMode.None}
        treeData={emptyTree()}
      />
    );

    expect(screen.queryByRole("treegrid")).toBeNull();
    expect(screen.getAllByTestId("document-row").length).toBeGreaterThan(0);
  });

  it("keeps the flag-off ungrouped path equal to the mainline row body", () => {
    stubNarrowViewport();

    render(
      <DocumentsView
        {...BASE_PROPS}
        groupBy={GroupByMode.None}
        treeData={emptyTree()}
      />
    );

    expect(screen.queryByRole("treegrid")).toBeNull();
    expect(screen.getAllByTestId("document-row").length).toBeGreaterThan(0);
  });

  it("projects the ungrouped project tree through the narrow shared list", () => {
    enableResponsiveNarrowGridview();
    stubNarrowViewport();

    render(
      <DocumentsView
        {...BASE_PROPS}
        groupBy={GroupByMode.None}
        treeData={emptyTree()}
      />
    );

    expect(screen.getByRole("treegrid")).toBeVisible();
    expect(screen.queryAllByTestId("document-row")).toHaveLength(0);
    expect(screen.getAllByRole("columnheader")).toHaveLength(1);
    expect(
      screen.getByRole("columnheader", { name: LEAD_LABEL_PATTERN })
    ).toBeVisible();
  });

  it("projects flat document rows with favorite, select-all, and More actions reachable", () => {
    enableResponsiveNarrowGridview();
    stubNarrowViewport();

    render(
      <DocumentsView
        {...FLAT_CATEGORY_PROPS}
        groupBy={GroupByMode.None}
        treeData={emptyTree()}
      />
    );

    expect(screen.getByRole("grid")).toBeVisible();
    expect(screen.queryAllByTestId("document-row")).toHaveLength(0);
    expect(screen.getAllByRole("columnheader")).toHaveLength(1);
    expect(within(leadHeader()).getByRole("checkbox")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Favorite" })).toHaveLength(
      PAGE_DOCUMENTS.length
    );
    expect(
      screen.getAllByRole("button", { name: MORE_ACTIONS_PATTERN })
    ).toHaveLength(PAGE_DOCUMENTS.length);
  });
});

function enableResponsiveNarrowGridview() {
  mocks.useFeatureFlagEnabledOptional.mockImplementation(
    (key: string) => key === GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY
  );
}

function stubNarrowViewport() {
  restoreViewport = stubResponsiveNarrowViewport(true).restore;
}
