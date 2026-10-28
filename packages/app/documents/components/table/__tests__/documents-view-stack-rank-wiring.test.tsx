import { ArtifactType } from "@repo/api/src/types/artifact";
import { MovePosition } from "@repo/api/src/types/project-artifact-move";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { SortKey } from "@repo/app/documents/components/table/sort-keys";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The wiring between the project page and the stack-rank mutation, which no
 * suite covered when `stack-rank-project-page` was retired.
 *
 * `use-stack-ranking.test` drives the hook with hand-passed input, and
 * `documents-view-overflow-menu.test` drives `DocumentRowActions` with
 * `showRankActions` and `onMoveToTop` passed in directly. Both stay green if
 * `DocumentsView` stops computing that flag or stops routing that handler —
 * which is precisely the seam the retirement moved, since the flag used to be
 * threaded through it. So the real hook runs here and only the mutation is
 * stubbed: the boundary asserted is the POST `useMoveArtifact` would issue.
 *
 * The row's visual chrome is stubbed to keep this off navigation and DnD
 * providers, but `DocumentRowActions` itself is the production component,
 * mounted with the props `DocumentsView` actually computed for it.
 */

const mocks = vi.hoisted(() => ({
  useProjectTree: vi.fn(),
  useMoveArtifact: vi.fn(),
  moveMutate: vi.fn(),
  useFeatureFlagEnabled: vi.fn(),
  useFeatureFlagEnabledOptional: vi.fn(),
  useSortParams: vi.fn(),
  useGroupExpansion: vi.fn(),
  useMergeDocuments: vi.fn(),
  useContextGroupExpansion: vi.fn(),
  useHierarchyPlacement: vi.fn(),
  containerWidth: 1024,
}));

vi.mock("@repo/app/projects/hooks/use-project-tree", () => ({
  useProjectTree: mocks.useProjectTree,
  useMoveArtifact: mocks.useMoveArtifact,
  useProjectTreeExpansionBatch: vi.fn(() => []),
}));
vi.mock(
  "@repo/app/shared/feature-flags/use-feature-flag-enabled",
  async (orig) => ({
    // Partial: this module gained exports (ISS-9726) the surface under test now
    // reaches through, and a total mock silently drops them.
    ...(await orig<Record<string, unknown>>()),
    useFeatureFlagEnabled: mocks.useFeatureFlagEnabled,
    useFeatureFlagEnabledOptional: mocks.useFeatureFlagEnabledOptional,
  })
);
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
vi.mock("@repo/app/documents/hooks/use-context-group-expansion", () => ({
  useContextGroupExpansion: mocks.useContextGroupExpansion,
}));
vi.mock("@repo/app/documents/hooks/use-hierarchy-placement", () => ({
  useHierarchyPlacement: mocks.useHierarchyPlacement,
}));
vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => `/acme${path}`,
}));
vi.mock("@repo/design-system/hooks/use-container-width", () => ({
  useContainerWidth: () => ({
    ref: { current: null },
    width: mocks.containerWidth,
  }),
}));

vi.mock("@repo/app/documents/components/table/table-header", () => ({
  DocumentTableHeader: ({ className }: { className?: string }) => (
    <div className={className} data-testid="table-header" />
  ),
}));
// The one stub that matters: it renders the menu `DocumentsView` built for this
// group's root, so the assertions below run against the real
// `DocumentRowActions` and the real props the view computed.
vi.mock(
  "@repo/app/documents/components/table/documents-ungrouped-tree-body",
  () => ({
    DocumentsUngroupedTreeBody: ({
      items,
      manualPlacementEnabled,
      renderRowActions,
    }: {
      items: readonly DocumentRowItem[];
      manualPlacementEnabled?: boolean;
      renderRowActions?: (item: DocumentRowItem) => React.ReactNode;
    }) => (
      <div data-manual-placement={manualPlacementEnabled ? "on" : "off"}>
        {items.map((item) => (
          <div key={item.data.id}>{renderRowActions?.(item)}</div>
        ))}
      </div>
    ),
  })
);

import { DocumentsView } from "@repo/app/documents/components/table/documents-view";

const PROJECT_ID = "project-1";
const ROOT_DOCUMENT_ID = "doc-root-1";

// Radix DropdownMenu drives open via pointer-capture APIs jsdom lacks; shim them
// so the real click-to-open interaction works (the menu is never forced open).
beforeAll(() => {
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

function treeWithRootDocument(): ProjectTreeResponse {
  return {
    nodes: [
      {
        root: {
          id: ROOT_DOCUMENT_ID,
          type: ArtifactType.Document,
          title: "A root document",
        },
        children: [],
      },
    ],
    externalParents: [],
  } as unknown as ProjectTreeResponse;
}

function renderView(canReorderArtifacts = true) {
  return render(
    <DocumentsView
      canReorderArtifacts={canReorderArtifacts}
      // The root's own document row: `buildSortedGroups` composes each group
      // from the tree node AND this list, so a tree node with no matching
      // document yields no group and the view falls through to its empty state.
      documents={[
        makeArtifact({
          id: ROOT_DOCUMENT_ID,
          projectId: PROJECT_ID,
          title: "A root document",
        }),
      ]}
      filterCategory="all"
      filterText=""
      projectId={PROJECT_ID}
      treeData={treeWithRootDocument()}
      visibleColumns={[DocumentColumn.Type]}
    />
  );
}

describe("DocumentsView stack-rank wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useProjectTree.mockReturnValue({
      data: treeWithRootDocument(),
      isLoading: false,
    });
    mocks.useMoveArtifact.mockReturnValue({ mutate: mocks.moveMutate });
    mocks.useFeatureFlagEnabled.mockReturnValue(false);
    mocks.useFeatureFlagEnabledOptional.mockReturnValue(false);
    // Stack rank ASC — what the retired gate now makes unconditional, and what
    // `getRankInteractionMode` needs to report `Enabled`.
    mocks.useSortParams.mockReturnValue({
      sortBy: SortKey.StackRank,
      sortDir: "asc",
      setSort: vi.fn(),
      clearSort: vi.fn(),
      clearPersistedSort: vi.fn(),
    });
    mocks.useGroupExpansion.mockReturnValue({
      isExpanded: () => true,
      toggleGroup: vi.fn(),
    });
    mocks.useMergeDocuments.mockReturnValue({ mutateAsync: vi.fn() });
    mocks.useContextGroupExpansion.mockReturnValue({
      isTreeGroupExpanded: () => true,
      toggleTreeGroup: vi.fn(),
    });
    mocks.useHierarchyPlacement.mockReturnValue({
      announcement: "",
      enabled: false,
      handleDragCancel: vi.fn(),
      handleDragEnd: vi.fn(),
      handleDragOver: vi.fn(),
      handleKeyboardPlacement: vi.fn(),
      itemIds: [],
      preview: null,
    });
    mocks.containerWidth = 1024;
  });

  it("defaults the project page to stack rank with no flag consulted", () => {
    renderView();

    // The retirement's other half: the default is no longer a branch on a flag
    // read. Asserting the argument rather than the resulting order is
    // deliberate — the order is `useSortParams`' contract and has its own
    // tests; what this pins is that the view still ASKS for stack rank.
    expect(mocks.useSortParams).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultColumn: SortKey.StackRank,
        defaultDirection: "asc",
      })
    );
  });

  it("adopts the shared interaction contract only for the exact GridView key", () => {
    const legacy = renderView();

    expect(
      legacy.container.querySelector("[data-grid-interaction-contract]")
    ).toBeNull();
    expect(mocks.useFeatureFlagEnabledOptional).toHaveBeenCalledWith(
      GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY
    );

    legacy.unmount();
    mocks.useFeatureFlagEnabledOptional.mockReturnValue(true);
    const adopted = renderView();

    expect(
      adopted.container.querySelector(
        '[data-grid-interaction-contract="pointer-hover"]'
      )
    ).toBeInTheDocument();
  });

  it("offers the rank action on a root row of the all-artifacts view", async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole("button", { name: "More actions" }));

    expect(
      await screen.findByRole("menuitem", { name: "Move to top" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Move to bottom" })
    ).toBeInTheDocument();
  });

  it("reaches the move mutation when the rank action is chosen", async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Move to bottom" })
    );

    // The boundary: `useMoveArtifact` is what POSTs to
    // `/projects/:id/artifacts/move` and splices the tree cache, so a call
    // carrying this row's id and position is the whole of what the view owes
    // it. A disconnected handler leaves this at zero calls.
    await waitFor(() =>
      expect(mocks.moveMutate).toHaveBeenCalledWith({
        artifactId: ROOT_DOCUMENT_ID,
        position: MovePosition.Bottom,
      })
    );
  });

  it("shows no reorder action and sends no request without write authority", async () => {
    const user = userEvent.setup();
    renderView(false);

    await user.click(screen.getByRole("button", { name: "More actions" }));

    expect(
      screen.queryByRole("menuitem", { name: "Move to top" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Move to bottom" })
    ).not.toBeInTheDocument();
    expect(mocks.moveMutate).not.toHaveBeenCalled();
    expect(mocks.useHierarchyPlacement).toHaveBeenCalledWith(
      expect.objectContaining({ currentOrderingEnabled: false })
    );
  });

  it("scopes the move mutation to the project being viewed", () => {
    renderView();

    // `useMoveArtifact` builds the POST path from this id, so a wrong or empty
    // one would move artifacts in the wrong project while every assertion
    // above still passed.
    expect(mocks.useMoveArtifact).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("AC-006 lets the mastered hierarchy hook opt the production body into placement", () => {
    mocks.useHierarchyPlacement.mockReturnValue({
      announcement: "Moved",
      enabled: true,
      handleDragCancel: vi.fn(),
      handleDragEnd: vi.fn(),
      handleDragOver: vi.fn(),
      handleKeyboardPlacement: vi.fn(),
      itemIds: [ROOT_DOCUMENT_ID],
      preview: null,
    });

    renderView();

    expect(
      document.querySelector('[data-manual-placement="on"]')
    ).not.toBeNull();
    expect(screen.getByText("Moved")).toHaveAttribute("aria-live", "polite");
  });

  // Daveth, 2026-10-21 "prototype decides" (PRD-595 / ISS-6560): a narrow
  // project hierarchy keeps its labeled grid and scrolls sideways; the card
  // layout that hid this header is retired.
  it("keeps the header in a sideways-scrolling band at a narrow container width", () => {
    mocks.containerWidth = 448;
    mocks.useHierarchyPlacement.mockReturnValue({
      announcement: "",
      enabled: true,
      handleDragCancel: vi.fn(),
      handleDragEnd: vi.fn(),
      handleDragOver: vi.fn(),
      handleKeyboardPlacement: vi.fn(),
      itemIds: [ROOT_DOCUMENT_ID],
      preview: null,
    });

    renderView();

    const header = screen.getByTestId("table-header");
    expect(header).not.toHaveClass("hidden");
    expect(header.parentElement).toHaveClass("min-w-fit");
    expect(header.closest(".overflow-x-auto")).not.toBeNull();
    expect(header.parentElement).not.toHaveClass("overflow-x-hidden");
  });
});
