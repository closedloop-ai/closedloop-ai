import type { Artifact } from "@repo/api/src/types/artifact";
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { DocumentStatus } from "@repo/api/src/types/document";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { RankInteractionMode } from "@repo/app/documents/components/table/sort-keys";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import {
  makeArtifact,
  makeRawArtifact,
} from "@repo/app/shared/test-fixtures/documents";
import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import type { GridSelectionModifiers } from "@repo/design-system/lib/grid-table-v2-selection";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Branch-coverage sweep for documents-view.tsx (ISS-9714). Each test drives a
// real user interaction or a real prop through the production component and
// asserts an observable outcome that would flip if the covered branch were
// inverted or removed. Heavy leaf dialogs/rows are replaced with small stubs
// that still carry the REAL callbacks the view wired to them (same pattern as
// the sibling stack-rank-wiring / section-counts suites), so clicking a stub
// control still runs production code (handleRequestMove, handleConfirmDelete,
// the merge onConfirm closure, etc).

const mocks = vi.hoisted(() => ({
  useProjectTree: vi.fn(),
  useSortParams: vi.fn(),
  useGroupExpansion: vi.fn(),
  useMergeDocuments: vi.fn(),
  useStackRanking: vi.fn(),
  useContextGroupExpansion: vi.fn(),
  manualOrderingEnabled: false,
  mergeMutateAsync: vi.fn(),
}));

vi.mock("@repo/app/projects/hooks/use-project-tree", () => ({
  useProjectTree: mocks.useProjectTree,
  useProjectTreeExpansionBatch: vi.fn(() => []),
}));
vi.mock("@repo/app/shared/hooks/use-sort-params", () => ({
  useSortParams: mocks.useSortParams,
}));
vi.mock("@repo/app/shared/hooks/use-group-expansion", async (orig) => ({
  // Partial, not total: the surface under test reaches through MORE of this
  // module than the keys overridden below (ISS-9726), and a total factory drops
  // every export it does not name.
  ...(await orig<Record<string, unknown>>()),
  useGroupExpansion: mocks.useGroupExpansion,
}));
vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useMergeDocuments: mocks.useMergeDocuments,
}));
vi.mock("@repo/app/documents/hooks/use-stack-ranking", () => ({
  useStackRanking: mocks.useStackRanking,
}));
vi.mock("@repo/app/documents/hooks/use-context-group-expansion", () => ({
  useContextGroupExpansion: mocks.useContextGroupExpansion,
}));
vi.mock("@repo/app/shared/feature-flags/use-manual-artifact-ordering", () => ({
  useManualArtifactOrderingEnabled: () => mocks.manualOrderingEnabled,
}));
vi.mock("@repo/app/projects/hooks/use-artifact-placement", () => ({
  useArtifactPlacement: () => ({ mutate: vi.fn() }),
}));
vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => `/acme${path}`,
}));

// The one stub that matters for selection/menu coverage: it keeps
// `getDocumentTableColumnCount` real (spread from `importOriginal`) and
// renders `moreMenuContent` — the REAL `DocumentRowActions` instance the view
// built for this row — so a click on "More actions" still runs production
// menu wiring (onMove/onDelete → handleRequestMove/actions.requestDelete).
vi.mock(
  "@repo/app/documents/components/table/document-row",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@repo/app/documents/components/table/document-row")
      >();
    return {
      ...actual,
      DocumentRow: ({
        item,
        isSelected,
        showCheckbox,
        onSelectionChange,
        moreMenuContent,
      }: {
        item: { data: { id: string } };
        isSelected?: boolean;
        showCheckbox?: boolean;
        onSelectionChange?: (
          id: string,
          checked: boolean,
          modifiers?: GridSelectionModifiers
        ) => void;
        moreMenuContent?: ReactNode;
      }) => (
        <div data-testid={`row-${item.data.id}`}>
          <span data-testid={`row-${item.data.id}-selected`}>
            {String(Boolean(isSelected))}
          </span>
          {showCheckbox && (
            <button
              onClick={(event) =>
                onSelectionChange?.(item.data.id, !isSelected, event)
              }
              type="button"
            >
              {`toggle-${item.data.id}`}
            </button>
          )}
          {moreMenuContent}
        </div>
      ),
    };
  }
);

vi.mock("@repo/app/documents/components/favorite-button", () => ({
  FavoriteButton: () => null,
}));
vi.mock("@repo/app/documents/components/table/cells/name-cell", () => ({
  NameCell: ({ item }: { item: { data: { id: string } } }) => (
    <div data-testid={`row-${item.data.id}`} />
  ),
}));

vi.mock("@repo/app/documents/components/table/table-header", () => ({
  DocumentTableHeader: ({
    showSelectAll,
    allSelected,
    someSelected,
    onSelectAll,
  }: {
    showSelectAll?: boolean;
    allSelected?: boolean;
    someSelected?: boolean;
    onSelectAll?: (checked: boolean) => void;
  }) => (
    <div data-testid="table-header">
      {showSelectAll && (
        <>
          <span data-testid="all-selected">{String(Boolean(allSelected))}</span>
          <span data-testid="some-selected">
            {String(Boolean(someSelected))}
          </span>
          <button onClick={() => onSelectAll?.(true)} type="button">
            Select all
          </button>
          <button onClick={() => onSelectAll?.(false)} type="button">
            Deselect all
          </button>
        </>
      )}
    </div>
  ),
}));

vi.mock("@repo/app/documents/components/table/documents-bulk-actions", () => ({
  DocumentsBulkActions: () => <div data-testid="bulk-actions-stub" />,
}));

vi.mock("@repo/app/documents/components/move-entity-dialog", () => ({
  MoveEntityDialog: ({
    open,
    entity,
    entities,
    onOpenChange,
  }: {
    open: boolean;
    entity?: { id: string };
    entities?: { id: string }[];
    onOpenChange: (open: boolean) => void;
  }) => {
    if (!open) {
      return null;
    }
    return (
      <div data-testid={entities ? "bulk-move-dialog" : "move-dialog"}>
        <span data-testid="move-entity-ids">
          {entities ? entities.map((e) => e.id).join(",") : entity?.id}
        </span>
        <button onClick={() => onOpenChange(false)} type="button">
          Close move dialog
        </button>
        <button onClick={() => onOpenChange(true)} type="button">
          Reopen move dialog
        </button>
      </div>
    );
  },
}));

vi.mock("@repo/app/documents/components/table/merge-documents-dialog", () => ({
  MergeDocumentsDialog: ({
    open,
    error,
    artifacts,
    onConfirm,
  }: {
    open: boolean;
    error?: string | null;
    artifacts: [{ id: string }, { id: string }];
    onConfirm: (primaryId: string, secondaryId: string) => Promise<void>;
  }) => {
    if (!open) {
      return null;
    }
    return (
      <div data-testid="merge-dialog">
        {error && <div data-testid="merge-error">{error}</div>}
        <button
          onClick={() => onConfirm(artifacts[0].id, artifacts[1].id)}
          type="button"
        >
          Confirm merge
        </button>
      </div>
    );
  },
}));

vi.mock("@repo/app/shared/components/delete-confirmation-dialog", () => ({
  DeleteConfirmationDialog: ({
    open,
    title,
    itemName,
    description,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    itemName: string;
    description?: string;
    onConfirm: () => Promise<boolean>;
  }) => {
    const [result, setResult] = useState<string | null>(null);
    if (!open) {
      return null;
    }
    return (
      <div data-testid="delete-dialog">
        <div data-testid="delete-title">{title}</div>
        <div data-testid="delete-item-name">{itemName}</div>
        {description !== undefined && (
          <div data-testid="delete-description">{description}</div>
        )}
        <button
          onClick={() => {
            onConfirm().then((confirmed) => setResult(String(confirmed)));
          }}
          type="button"
        >
          Confirm delete
        </button>
        {result !== null && <div data-testid="delete-result">{result}</div>}
      </div>
    );
  },
}));

import {
  DocumentsView,
  type DocumentsViewProps,
} from "@repo/app/documents/components/table/documents-view";

// Radix DropdownMenu drives open via pointer-capture APIs jsdom lacks; shim
// them so the real click-to-open interaction works (matches the sibling
// overflow-menu / stack-rank-wiring suites).
const SHIMMED_ELEMENT_METHODS = [
  "hasPointerCapture",
  "setPointerCapture",
  "releasePointerCapture",
  "scrollIntoView",
] as const;

const originalElementDescriptors = new Map<
  string,
  PropertyDescriptor | undefined
>();

beforeAll(() => {
  for (const method of SHIMMED_ELEMENT_METHODS) {
    originalElementDescriptors.set(
      method,
      Object.getOwnPropertyDescriptor(Element.prototype, method)
    );
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {
      // no-op
    };
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {
      // no-op
    };
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {
      // no-op
    };
  }
});

// The shims above are installed on a shared prototype, so later tests in this
// worker would inherit a different DOM if they were left in place.
afterAll(() => {
  for (const [method, descriptor] of originalElementDescriptors) {
    if (descriptor) {
      Object.defineProperty(Element.prototype, method, descriptor);
    } else {
      Reflect.deleteProperty(Element.prototype, method);
    }
  }
  originalElementDescriptors.clear();
});

function emptyTree(): ProjectTreeResponse {
  return { nodes: [], externalParents: [] };
}

function treeWithBranches(branches: Artifact[]): ProjectTreeResponse {
  return {
    nodes: branches.map((branch) => ({ root: branch, children: [] })),
    externalParents: [],
  };
}

function renderDocumentsView(overrides: Partial<DocumentsViewProps> = {}) {
  return render(
    <DocumentsView
      documents={[]}
      filterCategory="documents"
      filterText=""
      storageKey="test"
      treeData={emptyTree()}
      visibleColumns={[DocumentColumn.Type]}
      {...overrides}
    />
  );
}

async function openRowMenu(
  user: ReturnType<typeof userEvent.setup>,
  id: string
) {
  await user.click(
    within(screen.getByTestId(`row-${id}`)).getByRole("button", {
      name: "More actions",
    })
  );
}

const DOC_A = makeArtifact({ id: "doc-a", title: "Alpha doc" });
const DOC_B = makeArtifact({ id: "doc-b", title: "Beta doc" });
const MERGE_BUTTON_NAME = "Merge";

describe("DocumentsView branch coverage (ISS-9714)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.manualOrderingEnabled = false;
    mocks.useProjectTree.mockReturnValue({ data: undefined, isLoading: false });
    mocks.useSortParams.mockReturnValue({
      sortBy: null,
      sortDir: "asc",
      setSort: vi.fn(),
      clearSort: vi.fn(),
      clearPersistedSort: vi.fn(),
    });
    mocks.useGroupExpansion.mockReturnValue({
      isExpanded: () => true,
      toggleGroup: vi.fn(),
    });
    mocks.mergeMutateAsync.mockResolvedValue(undefined);
    mocks.useMergeDocuments.mockReturnValue({
      mutateAsync: mocks.mergeMutateAsync,
      isPending: false,
    });
    mocks.useStackRanking.mockReturnValue({
      rankInteractionMode: RankInteractionMode.Hidden,
      isDndEnabled: false,
      rankItemIds: [],
      isRankableMenuItem: () => false,
      moveToTop: vi.fn(),
      moveToBottom: vi.fn(),
      handleDragEnd: vi.fn(),
    });
    mocks.useContextGroupExpansion.mockReturnValue({
      isTreeGroupExpanded: () => true,
      toggleTreeGroup: vi.fn(),
    });
  });

  function renderExpandedManualTree(includeBranch = false) {
    const parent = makeArtifact({
      id: "manual-parent",
      projectId: "project-1",
      title: "Parent document",
    });
    const child = makeArtifact({
      id: "manual-child",
      projectId: "project-1",
      title: "Child document",
    });
    mocks.manualOrderingEnabled = true;
    mocks.useStackRanking.mockReturnValue({
      rankInteractionMode: RankInteractionMode.Enabled,
      isDndEnabled: true,
      rankItemIds: [parent.id, child.id],
      isRankableMenuItem: () => true,
      moveToTop: vi.fn(),
      moveToBottom: vi.fn(),
      handleDragEnd: vi.fn(),
    });
    mocks.useContextGroupExpansion.mockImplementation(
      ({ defaultExpanded }: { defaultExpanded?: boolean }) => ({
        isTreeGroupExpanded: () => defaultExpanded === true,
        toggleTreeGroup: vi.fn(),
        expandTreeGroup: vi.fn(),
      })
    );
    renderDocumentsView({
      canReorderArtifacts: true,
      documents: [parent, child],
      filterCategory: "all",
      projectId: "project-1",
      treeData: {
        externalParents: [],
        nodes: [
          {
            root: makeRawArtifact(ArtifactType.Document, {
              id: parent.id,
              name: parent.title,
            }),
            children: [
              {
                ...makeRawArtifact(ArtifactType.Document, {
                  id: child.id,
                  name: child.title,
                }),
                depth: 1,
                linkType: LinkType.Produces,
                parentId: parent.id,
              },
              ...(includeBranch
                ? [
                    {
                      ...makeRawArtifact(ArtifactType.Branch, {
                        id: "manual-branch",
                        name: "Linked branch",
                      }),
                      depth: 1,
                      linkType: LinkType.Produces,
                      parentId: parent.id,
                    },
                  ]
                : []),
            ],
          },
        ],
        projectVersion: "rendered-version",
      },
    });
  }

  it("retains a selected child that the manual tree paints expanded", async () => {
    const user = userEvent.setup();
    renderExpandedManualTree();

    await user.click(
      screen.getByRole("button", { name: "toggle-manual-child" })
    );

    await waitFor(() =>
      expect(screen.getByTestId("row-manual-child-selected")).toHaveTextContent(
        "true"
      )
    );
  });

  it("includes expanded children in manual-tree select-all", async () => {
    const user = userEvent.setup();
    renderExpandedManualTree();

    await user.click(screen.getByRole("button", { name: "Select all" }));

    expect(screen.getByTestId("row-manual-parent-selected")).toHaveTextContent(
      "true"
    );
    expect(screen.getByTestId("row-manual-child-selected")).toHaveTextContent(
      "true"
    );
  });

  it("selects only document rows in a mixed manual hierarchy", async () => {
    const user = userEvent.setup();
    renderExpandedManualTree(true);

    await user.click(screen.getByRole("button", { name: "Select all" }));

    expect(screen.getByTestId("row-manual-parent-selected")).toHaveTextContent(
      "true"
    );
    expect(screen.getByTestId("row-manual-child-selected")).toHaveTextContent(
      "true"
    );
    expect(screen.getByTestId("row-manual-branch-selected")).toHaveTextContent(
      "false"
    );
    expect(screen.getByTestId("all-selected")).toHaveTextContent("true");
  });

  it("derives the project expansion key without changing the shared collapsed default", () => {
    renderDocumentsView({
      documents: [],
      projectId: "proj-77",
      storageKey: undefined,
    });

    // Without this fallback the key would be `undefined`; asserting the exact
    // derived string fails if the `storageKey ?? ...` branch is removed.
    expect(mocks.useGroupExpansion.mock.calls[0][0]).toBe(
      "table:expand:project-artifacts:proj-77"
    );
    expect(mocks.useGroupExpansion.mock.calls[0][1]).toBeUndefined();
  });

  it("falls back to the generic 'all' segment when storageKey and projectId are both omitted", () => {
    renderDocumentsView({
      documents: [],
      projectId: undefined,
      storageKey: undefined,
    });

    expect(mocks.useGroupExpansion.mock.calls[0][0]).toBe(
      "table:expand:project-artifacts:all"
    );
  });

  it("persists no group expansion when storageKey is null, even with a projectId", () => {
    // ISS-9726: `null` is the owner saying "my namespaced key has not resolved",
    // which is NOT the omitted case above. A `??` here would collapse the two
    // and write this reader's expansion into `project-artifacts:proj-77` — a
    // bucket every organization viewing that project shares. Both group-level
    // and section-level reads must carry the null through.
    renderDocumentsView({
      documents: [],
      projectId: "proj-77",
      storageKey: null,
    });

    expect(mocks.useGroupExpansion.mock.calls[0][0]).toBeNull();
    expect(mocks.useGroupExpansion.mock.calls[1][0]).toBeNull();
  });

  describe("branches tab", () => {
    it("shows a loading spinner and renders neither the table nor the empty state while the tree is loading", () => {
      renderDocumentsView({
        filterCategory: "branches",
        isTreeDataLoading: true,
        treeData: null,
      });

      expect(document.querySelector(".animate-spin")).toBeTruthy();
      expect(screen.queryByTestId("table-header")).toBeNull();
      expect(screen.queryByText("No branches")).toBeNull();
    });

    it("shows the branches-specific empty state (not the generic one) when the tree has no branch artifacts yet", () => {
      renderDocumentsView({ filterCategory: "branches", treeData: undefined });

      expect(screen.getByText("No branches")).toBeTruthy();
      expect(
        screen.getByText("No pull requests linked to this project yet.")
      ).toBeTruthy();
      expect(screen.queryByText("No artifacts yet")).toBeNull();
    });

    it("collects branch rows from the tree, filters them by title, and hides selection checkboxes", () => {
      // Ids are deliberately opaque: an id containing "fix" would keep this
      // green under a regression that filtered on the id instead of
      // getItemTitle(item).
      const branchFix = makeRawArtifact(ArtifactType.Branch, {
        id: "branch-a1",
        name: "Fix login bug",
      });
      const branchFeat = makeRawArtifact(ArtifactType.Branch, {
        id: "branch-b2",
        name: "Add dashboard feature",
      });
      renderDocumentsView({
        filterCategory: "branches",
        filterText: "fix",
        treeData: treeWithBranches([branchFix, branchFeat]),
      });

      expect(screen.getByTestId("row-branch-a1")).toBeTruthy();
      expect(screen.queryByTestId("row-branch-b2")).toBeNull();
      // Branches tab: no bulk operations, so no per-row checkbox.
      expect(
        screen.queryByRole("button", { name: "toggle-branch-a1" })
      ).toBeNull();
    });

    it("opens the branch delete dialog with the Closedloop-only removal copy, and leaves it open when the delete resolves false", async () => {
      const user = userEvent.setup();
      const branch = makeRawArtifact(ArtifactType.Branch, {
        id: "branch-1",
        name: "Fix login bug",
      });
      const onDelete = vi.fn().mockResolvedValue(false);
      renderDocumentsView({
        filterCategory: "branches",
        onDelete,
        treeData: treeWithBranches([branch]),
      });

      await openRowMenu(user, "branch-1");
      await user.click(await screen.findByRole("menuitem", { name: "Delete" }));

      expect(screen.getByTestId("delete-title")).toHaveTextContent(
        "Pull Request from Closedloop"
      );
      expect(screen.getByTestId("delete-description")).toHaveTextContent(
        'This removes "Fix login bug" from Closedloop only.'
      );

      await user.click(screen.getByRole("button", { name: "Confirm delete" }));

      await waitFor(() =>
        expect(screen.getByTestId("delete-result")).toHaveTextContent("false")
      );
      expect(screen.getByTestId("delete-dialog")).toBeTruthy();
    });
  });

  describe("selection, floating bar, and reorder banner (flat category)", () => {
    it("derives allSelected/someSelected from real selection state, and shows checkboxes on a flat category", async () => {
      const user = userEvent.setup();
      renderDocumentsView({ documents: [DOC_A, DOC_B] });

      // Checkboxes exist at all: showCheckbox is true off the non-grouped,
      // non-branches path (line 250's other outcome from the branches tab).
      expect(screen.getByRole("button", { name: "toggle-doc-a" })).toBeTruthy();
      expect(screen.getByTestId("all-selected")).toHaveTextContent("false");
      expect(screen.getByTestId("some-selected")).toHaveTextContent("false");

      await user.click(screen.getByRole("button", { name: "toggle-doc-a" }));
      expect(screen.getByTestId("all-selected")).toHaveTextContent("false");
      expect(screen.getByTestId("some-selected")).toHaveTextContent("true");

      await user.click(screen.getByRole("button", { name: "toggle-doc-b" }));
      expect(screen.getByTestId("all-selected")).toHaveTextContent("true");
      expect(screen.getByTestId("some-selected")).toHaveTextContent("false");
    });

    it("selects every rendered row when the header checkbox is checked, and clears them when unchecked", async () => {
      const user = userEvent.setup();
      renderDocumentsView({ documents: [DOC_A, DOC_B] });

      await user.click(screen.getByRole("button", { name: "Select all" }));
      expect(screen.getByTestId("row-doc-a-selected")).toHaveTextContent(
        "true"
      );
      expect(screen.getByTestId("row-doc-b-selected")).toHaveTextContent(
        "true"
      );
      expect(screen.getByText("2 items selected")).toBeTruthy();

      await user.click(screen.getByRole("button", { name: "Deselect all" }));
      expect(screen.getByTestId("row-doc-a-selected")).toHaveTextContent(
        "false"
      );
      expect(screen.getByTestId("row-doc-b-selected")).toHaveTextContent(
        "false"
      );
      expect(screen.queryByText("2 items selected")).toBeNull();
    });

    it("PRD-718 AC4 extends a Shift-click range and a Cmd-click toggle through the shared selection model", async () => {
      const user = userEvent.setup();
      const docC = makeArtifact({ id: "doc-c", title: "Gamma doc" });
      renderDocumentsView({ documents: [DOC_A, DOC_B, docC] });

      await user.click(screen.getByRole("button", { name: "toggle-doc-a" }));
      await user.keyboard("{Shift>}");
      await user.click(screen.getByRole("button", { name: "toggle-doc-c" }));
      await user.keyboard("{/Shift}");

      expect(screen.getByTestId("row-doc-a-selected")).toHaveTextContent(
        "true"
      );
      expect(screen.getByTestId("row-doc-b-selected")).toHaveTextContent(
        "true"
      );
      expect(screen.getByTestId("row-doc-c-selected")).toHaveTextContent(
        "true"
      );

      await user.keyboard("{Meta>}");
      await user.click(screen.getByRole("button", { name: "toggle-doc-b" }));
      await user.keyboard("{/Meta}");

      expect(screen.getByTestId("row-doc-a-selected")).toHaveTextContent(
        "true"
      );
      expect(screen.getByTestId("row-doc-b-selected")).toHaveTextContent(
        "false"
      );
      expect(screen.getByTestId("row-doc-c-selected")).toHaveTextContent(
        "true"
      );
    });

    it("shows singular wording when exactly one item is selected", async () => {
      const user = userEvent.setup();
      renderDocumentsView({ documents: [DOC_A, DOC_B] });

      await user.click(screen.getByRole("button", { name: "toggle-doc-a" }));

      expect(screen.getByText("1 item selected")).toBeTruthy();
      expect(screen.queryByText("1 items selected")).toBeNull();
    });

    it("offers Merge only when exactly two documents are selected", async () => {
      const user = userEvent.setup();
      renderDocumentsView({ documents: [DOC_A, DOC_B] });

      await user.click(screen.getByRole("button", { name: "toggle-doc-a" }));
      expect(
        screen.queryByRole("button", { name: MERGE_BUTTON_NAME })
      ).toBeNull();

      await user.click(screen.getByRole("button", { name: "toggle-doc-b" }));
      expect(
        screen.getByRole("button", { name: MERGE_BUTTON_NAME })
      ).toBeTruthy();
    });

    it("offers Move to Project for a bulk-movable category once items are selected", async () => {
      const user = userEvent.setup();
      renderDocumentsView({ documents: [DOC_A, DOC_B] });

      await user.click(screen.getByRole("button", { name: "Select all" }));

      expect(
        screen.getByRole("button", { name: "Move to Project" })
      ).toBeTruthy();
    });

    it("shows the reorder-scope banner only when filtering is active during an enabled stack rank", () => {
      mocks.useStackRanking.mockReturnValue({
        rankInteractionMode: RankInteractionMode.Enabled,
        isDndEnabled: false,
        rankItemIds: [],
        isRankableMenuItem: () => false,
        moveToTop: vi.fn(),
        moveToBottom: vi.fn(),
        handleDragEnd: vi.fn(),
      });

      renderDocumentsView({
        documents: [DOC_A],
        isFilterActive: true,
      });

      expect(
        screen.getByText(
          "Reordering applies to the whole project, not just the current filter."
        )
      ).toBeTruthy();
    });
  });

  describe("move dialogs", () => {
    it("opens the single-row move dialog from the row menu, tolerates onOpenChange(true), and closes on onOpenChange(false)", async () => {
      const user = userEvent.setup();
      renderDocumentsView({ documents: [DOC_A, DOC_B] });

      await openRowMenu(user, "doc-a");
      await user.click(
        await screen.findByRole("menuitem", { name: "Move to Project" })
      );

      expect(screen.getByTestId("move-dialog")).toBeTruthy();
      expect(screen.getByTestId("move-entity-ids")).toHaveTextContent("doc-a");

      await user.click(
        screen.getByRole("button", { name: "Reopen move dialog" })
      );
      expect(screen.getByTestId("move-dialog")).toBeTruthy();

      await user.click(
        screen.getByRole("button", { name: "Close move dialog" })
      );
      expect(screen.queryByTestId("move-dialog")).toBeNull();
    });

    it("bulk-moves the selected documents via the floating bar, and closes on onOpenChange(false)", async () => {
      const user = userEvent.setup();
      renderDocumentsView({ documents: [DOC_A, DOC_B] });

      await user.click(screen.getByRole("button", { name: "Select all" }));
      await user.click(screen.getByRole("button", { name: "Move to Project" }));

      expect(screen.getByTestId("bulk-move-dialog")).toBeTruthy();
      expect(screen.getByTestId("move-entity-ids")).toHaveTextContent(
        "doc-a,doc-b"
      );

      await user.click(
        screen.getByRole("button", { name: "Reopen move dialog" })
      );
      expect(screen.getByTestId("bulk-move-dialog")).toBeTruthy();

      await user.click(
        screen.getByRole("button", { name: "Close move dialog" })
      );
      expect(screen.queryByTestId("bulk-move-dialog")).toBeNull();
    });
  });

  describe("merge dialog and mutation outcomes", () => {
    async function selectBothAndOpenMerge(
      user: ReturnType<typeof userEvent.setup>
    ) {
      renderDocumentsView({ documents: [DOC_A, DOC_B] });
      await user.click(screen.getByRole("button", { name: "Select all" }));
      await user.click(screen.getByRole("button", { name: MERGE_BUTTON_NAME }));
    }

    it("calls the merge mutation with both selected ids and closes the dialog on success", async () => {
      const user = userEvent.setup();
      await selectBothAndOpenMerge(user);

      expect(screen.getByTestId("merge-dialog")).toBeTruthy();

      await user.click(screen.getByRole("button", { name: "Confirm merge" }));

      await waitFor(() =>
        expect(mocks.mergeMutateAsync).toHaveBeenCalledWith({
          primaryDocumentId: "doc-a",
          secondaryDocumentId: "doc-b",
        })
      );
      await waitFor(() =>
        expect(screen.queryByTestId("merge-dialog")).toBeNull()
      );
    });

    it("shows the mutation's Error message when the merge fails with an Error", async () => {
      const user = userEvent.setup();
      mocks.mergeMutateAsync.mockRejectedValueOnce(
        new Error("Duplicate title")
      );
      await selectBothAndOpenMerge(user);

      await user.click(screen.getByRole("button", { name: "Confirm merge" }));

      await waitFor(() =>
        expect(screen.getByTestId("merge-error")).toHaveTextContent(
          "Duplicate title"
        )
      );
      expect(screen.getByTestId("merge-dialog")).toBeTruthy();
    });

    it("falls back to a generic message when the merge fails with a non-Error value", async () => {
      const user = userEvent.setup();
      mocks.mergeMutateAsync.mockRejectedValueOnce("nope");
      await selectBothAndOpenMerge(user);

      await user.click(screen.getByRole("button", { name: "Confirm merge" }));

      await waitFor(() =>
        expect(screen.getByTestId("merge-error")).toHaveTextContent(
          "Failed to merge artifacts"
        )
      );
    });
  });

  describe("delete confirmation flows", () => {
    it("opens the single-delete dialog with the document's registry copy, calls onDelete, and closes on success", async () => {
      const user = userEvent.setup();
      const onDelete = vi.fn().mockResolvedValue(true);
      renderDocumentsView({ documents: [DOC_A, DOC_B], onDelete });

      await openRowMenu(user, "doc-a");
      await user.click(await screen.findByRole("menuitem", { name: "Delete" }));

      expect(screen.getByTestId("delete-title")).toHaveTextContent("Document");
      expect(screen.getByTestId("delete-item-name")).toHaveTextContent(
        "Alpha doc"
      );
      // Document rows have no bespoke delete-dialog body copy.
      expect(screen.queryByTestId("delete-description")).toBeNull();

      await user.click(screen.getByRole("button", { name: "Confirm delete" }));

      expect(onDelete).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ id: "doc-a" }),
        })
      );
      await waitFor(() =>
        expect(screen.queryByTestId("delete-dialog")).toBeNull()
      );
    });

    it("keeps the single-delete dialog open when the delete resolves false", async () => {
      const user = userEvent.setup();
      const onDelete = vi.fn().mockResolvedValue(false);
      renderDocumentsView({ documents: [DOC_A, DOC_B], onDelete });

      await openRowMenu(user, "doc-a");
      await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
      await user.click(screen.getByRole("button", { name: "Confirm delete" }));

      await waitFor(() =>
        expect(screen.getByTestId("delete-result")).toHaveTextContent("false")
      );
      expect(screen.getByTestId("delete-dialog")).toBeTruthy();
    });

    it("returns false without calling any handler when confirmed with no onDelete wired", async () => {
      const user = userEvent.setup();
      renderDocumentsView({ documents: [DOC_A, DOC_B] });

      await openRowMenu(user, "doc-a");
      await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
      await user.click(screen.getByRole("button", { name: "Confirm delete" }));

      await waitFor(() =>
        expect(screen.getByTestId("delete-result")).toHaveTextContent("false")
      );
      expect(screen.getByTestId("delete-dialog")).toBeTruthy();
    });

    it("bulk-deletes the selected documents and marks success only when every delete resolves true", async () => {
      const user = userEvent.setup();
      const onDelete = vi.fn().mockResolvedValue(true);
      renderDocumentsView({ documents: [DOC_A, DOC_B], onDelete });

      await user.click(screen.getByRole("button", { name: "Select all" }));
      await user.click(screen.getByRole("button", { name: "Delete" }));

      expect(screen.getByTestId("delete-title")).toHaveTextContent("Items");
      expect(screen.getByTestId("delete-item-name")).toHaveTextContent(
        "2 items"
      );

      await user.click(screen.getByRole("button", { name: "Confirm delete" }));

      expect(onDelete).toHaveBeenCalledTimes(2);
      await waitFor(() =>
        expect(screen.queryByTestId("delete-dialog")).toBeNull()
      );
    });

    it("keeps the bulk-delete dialog open when any selected item's delete resolves false", async () => {
      const user = userEvent.setup();
      const onDelete = vi
        .fn()
        .mockImplementation((item: { data: { id: string } }) =>
          Promise.resolve(item.data.id === "doc-a")
        );
      renderDocumentsView({ documents: [DOC_A, DOC_B], onDelete });

      await user.click(screen.getByRole("button", { name: "Select all" }));
      await user.click(screen.getByRole("button", { name: "Delete" }));
      await user.click(screen.getByRole("button", { name: "Confirm delete" }));

      await waitFor(() =>
        expect(screen.getByTestId("delete-result")).toHaveTextContent("false")
      );
      expect(screen.getByTestId("delete-dialog")).toBeTruthy();
    });

    it("shows singular wording when exactly one document is bulk-deleted", async () => {
      const user = userEvent.setup();
      renderDocumentsView({ documents: [DOC_A, DOC_B] });

      await user.click(screen.getByRole("button", { name: "toggle-doc-a" }));
      await user.click(screen.getByRole("button", { name: "Delete" }));

      expect(screen.getByTestId("delete-item-name")).toHaveTextContent(
        "1 item"
      );
      expect(screen.queryByTestId("delete-item-name")).not.toHaveTextContent(
        "1 items"
      );
    });
  });

  describe("grouped sections on a flat category", () => {
    it("renders plain rows (not tree groups) inside each status section", () => {
      renderDocumentsView({
        documents: [
          makeArtifact({ id: "doc-draft", status: DocumentStatus.Draft }),
          makeArtifact({ id: "doc-review", status: DocumentStatus.InReview }),
        ],
        groupBy: GroupByMode.Status,
      });

      // isGroupedView is false on a flat category, so a grouping mode must
      // retain flat rows inside the shared bands, not nested lineage.
      expect(screen.getByTestId("row-doc-draft")).toBeTruthy();
      expect(screen.getByTestId("row-doc-review")).toBeTruthy();
    });
  });
});
