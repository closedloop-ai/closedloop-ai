import { DocumentType } from "@repo/api/src/types/document";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// FEA-4140: DocumentsIndexView lists project-less DOC artifacts at org scope,
// composing the shared DocumentsView + toolbar. The data hooks are mocked so
// this test asserts the container's contract — it requests project-less DOC
// documents and hands them to the shared table — without a query/DB provider.
const mocks = vi.hoisted(() => ({
  useDocuments: vi.fn(),
  useUpdateDocument: vi.fn(),
  useDeleteRowItem: vi.fn(),
  useOrgUsersAsPopoverUsers: vi.fn(),
  useColumnVisibility: vi.fn(),
  useScrollRestore: vi.fn(),
  useViewStatePersistence: vi.fn(),
  documentsViewProps: vi.fn(),
}));

vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocuments: mocks.useDocuments,
  useUpdateDocument: mocks.useUpdateDocument,
}));
vi.mock("@repo/app/documents/hooks/use-delete-row-item", () => ({
  useDeleteRowItem: mocks.useDeleteRowItem,
}));
vi.mock("@repo/app/users/hooks/use-org-users-as-popover-users", () => ({
  useOrgUsersAsPopoverUsers: mocks.useOrgUsersAsPopoverUsers,
}));
vi.mock("@repo/app/shared/hooks/use-column-visibility", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, useColumnVisibility: mocks.useColumnVisibility };
});
vi.mock("@repo/app/shared/hooks/use-scroll-restore", () => ({
  useScrollRestore: mocks.useScrollRestore,
}));
vi.mock("@repo/app/shared/hooks/use-view-state-persistence", () => ({
  useViewStatePersistence: mocks.useViewStatePersistence,
}));

// Leaf surfaces → markers so no navigation/DnD/query providers are needed.
vi.mock("@repo/app/documents/components/table/document-table-toolbar", () => ({
  DocumentTableToolbar: () => <div data-testid="toolbar" />,
}));
vi.mock(
  "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/[projectId]/components/documents-view",
  () => ({
    DocumentsView: (props: Record<string, unknown>) => {
      mocks.documentsViewProps(props);
      return <div data-testid="documents-view" />;
    },
  })
);

import { DocumentsIndexView } from "../documents-index-view";

const DOC = {
  id: "doc-1",
  type: DocumentType.Doc,
  title: "Runbook",
  projectId: null,
};

describe("DocumentsIndexView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useDocuments.mockReturnValue({
      data: [DOC],
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(),
    });
    mocks.useUpdateDocument.mockReturnValue({ mutate: vi.fn() });
    mocks.useDeleteRowItem.mockReturnValue(vi.fn());
    mocks.useOrgUsersAsPopoverUsers.mockReturnValue([]);
    mocks.useColumnVisibility.mockReturnValue({
      visibility: {},
      userVisibility: {},
      // The index pins DOCUMENTS_INDEX_COLUMNS (Assignee, Updated) — the Type
      // column is never in the set, mirroring the hook's real output for this
      // surface so the "Type column dropped" assertion is exercised, not skipped.
      visibleColumns: [DocumentColumn.Assignee, DocumentColumn.Updated],
      toggleColumn: vi.fn(),
      reorderColumns: vi.fn(),
    });
    mocks.useScrollRestore.mockReturnValue({ clearPosition: vi.fn() });
    mocks.useViewStatePersistence.mockReturnValue(["", vi.fn(), vi.fn()]);
  });

  it("requests project-less DOC documents at org scope", () => {
    render(<DocumentsIndexView />);

    expect(mocks.useDocuments).toHaveBeenCalledWith({
      type: DocumentType.Doc,
      unassignedProject: true,
    });
  });

  it("renders the shared document table with the fetched documents", () => {
    render(<DocumentsIndexView />);

    expect(screen.getByTestId("documents-view")).toBeInTheDocument();
    const props = mocks.documentsViewProps.mock.calls.at(-1)?.[0] as {
      documents: unknown[];
      filterCategory: string;
      treeData: unknown;
      visibleColumns: string[];
    };
    expect(props.documents).toEqual([DOC]);
    // Project-less docs have no project tree, so the org index runs the shared
    // pipeline's flat fallback (treeData null, "all" category).
    expect(props.treeData).toBeNull();
    expect(props.filterCategory).toBe("all");
    // The list is hard-filtered to a single type (Doc), so the Type column is
    // dropped — it would render a column of identical "Doc" values.
    expect(props.visibleColumns).not.toContain("type");
  });

  it("surfaces a retry affordance below the toolbar when the list read fails with no cached rows", () => {
    mocks.useDocuments.mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
      isError: true,
      refetch: vi.fn(),
    });
    render(<DocumentsIndexView />);

    expect(screen.getByText("Couldn't load documents")).toBeInTheDocument();
    expect(screen.queryByTestId("documents-view")).not.toBeInTheDocument();
    // The toolbar (search box, column menu) must stay in place — the error is a
    // sibling below it, not a full-page collapse.
    expect(screen.getByTestId("toolbar")).toBeInTheDocument();
  });

  it("keeps cached rows rendered when a background refetch fails", () => {
    // Initial read succeeded, a later refetch errored: TanStack Query retains
    // the last successful data while flagging isError. The populated table must
    // stay rendered instead of being replaced by the blocking error state.
    mocks.useDocuments.mockReturnValue({
      data: [DOC],
      isLoading: false,
      isFetching: false,
      isError: true,
      refetch: vi.fn(),
    });
    render(<DocumentsIndexView />);

    expect(screen.getByTestId("documents-view")).toBeInTheDocument();
    expect(
      screen.queryByText("Couldn't load documents")
    ).not.toBeInTheDocument();
  });

  it("shows a Documents-specific empty state (not the project table's copy) when settled and empty", () => {
    // Zero docs, settled, no active search: the container owns the empty state
    // so the surface reads as a Documents index instead of the shared table's
    // "Create a PRD, issue, or plan" project copy that would misdirect here.
    mocks.useDocuments.mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<DocumentsIndexView />);

    expect(screen.getByText("No documents yet")).toBeInTheDocument();
    expect(screen.queryByTestId("documents-view")).not.toBeInTheDocument();
  });
});
