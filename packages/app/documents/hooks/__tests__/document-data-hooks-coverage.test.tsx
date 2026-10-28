import {
  type ArtifactLinkWithEndpoints,
  ArtifactType,
  LinkDirection,
  LinkQueryMode,
  LinkType,
} from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import {
  type DocumentDetail,
  DocumentStatus,
  IssueStatus,
} from "@repo/api/src/types/document";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import {
  artifactLinkKeys,
  useCreateArtifactLink,
  useDeleteArtifactLink,
  useLinkedPlanId,
  useResolvedArtifactLinks,
} from "@repo/app/documents/hooks/use-artifact-links";
import { useDocumentContent } from "@repo/app/documents/hooks/use-document-content";
import {
  useCreateDocumentVersion,
  useDocument,
  useDocumentBySlug,
  useDocuments,
  useDocumentsPage,
  useEnsureDocumentBySlug,
} from "@repo/app/documents/hooks/use-documents";
import { useDocumentsViewState } from "@repo/app/documents/hooks/use-documents-view-state";
import { useInlineEditMode } from "@repo/app/documents/hooks/use-inline-edit-mode";
import { useTableViewPagination } from "@repo/app/documents/hooks/use-table-view-pagination";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { projectTreeKeys } from "@repo/app/projects/hooks/project-tree-keys";
import {
  createMockDocument,
  makeArtifact,
} from "@repo/app/shared/test-fixtures/documents";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import type { TiptapEditor } from "@repo/rich-text";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  stackRankEnabled: false,
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mocks.apiClient,
}));

vi.mock(
  "@repo/app/shared/feature-flags/use-feature-flag-enabled",
  async (orig) => ({
    // Partial: `useTableViewPagination` also resolves the ISS-9437 ordering keys
    // through this module (`useFeatureFlagGateOptional`), and a total factory
    // drops every export it does not name.
    ...(await orig<Record<string, unknown>>()),
    useFeatureFlagEnabled: () => mocks.stackRankEnabled,
  })
);

vi.mock("@repo/app/shared/hooks/use-sort-params", () => ({
  useSortParams: (options: { defaultColumn: string | null }) => ({
    sortBy: options.defaultColumn,
    sortDir: "asc",
  }),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stackRankEnabled = false;
  mocks.apiClient.get.mockResolvedValue([]);
  mocks.apiClient.post.mockResolvedValue({});
  mocks.apiClient.put.mockResolvedValue({});
  mocks.apiClient.delete.mockResolvedValue({ deleted: true });
});

describe("document query hooks", () => {
  test("serializes defined list filters and normalizes legacy page responses", async () => {
    const document = createMockDocument({ id: "doc-1" });
    mocks.apiClient.get
      .mockResolvedValueOnce([document])
      .mockResolvedValueOnce([document]);
    const queryClient = createTestQueryClient();
    const wrapper = createWrapperWithClient(queryClient);

    const list = renderHook(
      () =>
        useDocuments({
          projectId: "project-1",
          limit: 10,
          offset: undefined,
        }),
      { wrapper }
    );
    await waitFor(() => expect(list.result.current.data).toEqual([document]));
    expect(mocks.apiClient.get).toHaveBeenNthCalledWith(
      1,
      "/documents?projectId=project-1&limit=10"
    );

    const page = renderHook(
      () => useDocumentsPage({ projectId: "project-1", limit: 10 }),
      { wrapper }
    );
    await waitFor(() =>
      expect(page.result.current.data).toMatchObject({
        items: [document],
        total: 1,
        hasMore: false,
      })
    );
    expect(mocks.apiClient.get).toHaveBeenNthCalledWith(
      2,
      "/documents?projectId=project-1&limit=10&includeTotal=true"
    );
  });

  test("emits a repeated status occurrence per value, and none for an empty set (ISS-6778)", async () => {
    // `Array.prototype.toString()` would comma-join these, which the route
    // rejects as one unknown status — so the array branch is what makes the
    // filter reach the server at all, and a passthrough to the scalar branch
    // fails here rather than in production (tamsinb review).
    const document = createMockDocument({ id: "doc-1" });
    mocks.apiClient.get.mockResolvedValue([document]);
    const wrapper = createWrapperWithClient(createTestQueryClient());

    const selected = renderHook(
      () =>
        useDocuments({
          status: [IssueStatus.Todo, IssueStatus.InProgress],
        }),
      { wrapper }
    );
    await waitFor(() =>
      expect(selected.result.current.data).toEqual([document])
    );
    expect(mocks.apiClient.get).toHaveBeenNthCalledWith(
      1,
      `/documents?status=${IssueStatus.Todo}&status=${IssueStatus.InProgress}`
    );

    // Nothing selected is NOT a blank `?status=`, which the boundary rejects as
    // malformed. It is no occurrence at all, and the unnarrowed list.
    const none = renderHook(() => useDocuments({ status: [] }), { wrapper });
    await waitFor(() => expect(none.result.current.data).toEqual([document]));
    expect(mocks.apiClient.get).toHaveBeenNthCalledWith(2, "/documents?");
  });

  test("uses latest and historical URLs while empty identifiers stay disabled", async () => {
    const detail = makeDocumentDetail("saved");
    mocks.apiClient.get.mockResolvedValue(detail);
    const wrapper = createWrapperWithClient(createTestQueryClient());

    const latest = renderHook(() => useDocument("doc-1"), { wrapper });
    const historical = renderHook(() => useDocument("doc-2", 3), { wrapper });
    const slug = renderHook(() => useDocumentBySlug("PRD-1", 2), { wrapper });
    renderHook(() => useDocument(null), { wrapper });
    renderHook(() => useDocumentBySlug(""), { wrapper });

    await waitFor(() => expect(latest.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(historical.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(slug.result.current.isSuccess).toBe(true));
    expect(mocks.apiClient.get).toHaveBeenCalledWith("/documents/doc-1");
    expect(mocks.apiClient.get).toHaveBeenCalledWith(
      "/documents/doc-2?version=3"
    );
    expect(mocks.apiClient.get).toHaveBeenCalledWith(
      "/documents/by-slug/PRD-1?version=2"
    );
    expect(mocks.apiClient.get).toHaveBeenCalledTimes(3);
  });

  test("ensures a by-slug version into the slug hook's cache, fetching only when missing", async () => {
    const detail = makeDocumentDetail("saved");
    mocks.apiClient.get.mockResolvedValue(detail);
    const wrapper = createWrapperWithClient(createTestQueryClient());
    const ensure = renderHook(() => useEnsureDocumentBySlug(), { wrapper });

    await expect(ensure.result.current("PRD-1", 2)).resolves.toBe(detail);
    const slug = renderHook(
      () => useDocumentBySlug("PRD-1", 2, { enabled: false }),
      { wrapper }
    );
    expect(slug.result.current.data).toBe(detail);
    await expect(ensure.result.current("PRD-1", 2)).resolves.toBe(detail);

    expect(mocks.apiClient.get.mock.calls).toEqual([
      ["/documents/by-slug/PRD-1?version=2"],
    ]);
  });

  test("creates versions with and without the optional room reset", async () => {
    const detail = makeDocumentDetail("published");
    mocks.apiClient.post.mockResolvedValue(detail);
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useCreateDocumentVersion("doc-1"), {
      wrapper: createWrapperWithClient(queryClient),
    });

    await act(() => result.current.mutateAsync({ content: "first" }));
    await act(() =>
      result.current.mutateAsync({ content: "second", resetRoom: true })
    );
    expect(mocks.apiClient.post).toHaveBeenNthCalledWith(
      1,
      "/documents/doc-1/versions?",
      { content: "first" }
    );
    expect(mocks.apiClient.post).toHaveBeenNthCalledWith(
      2,
      "/documents/doc-1/versions?reset-room=true",
      { content: "second" }
    );
    const expectedInvalidations = [
      { queryKey: documentKeys.detail("doc-1") },
      { queryKey: documentKeys.bySlug(detail.slug) },
      { queryKey: documentKeys.versions("doc-1") },
      { queryKey: documentKeys.lists() },
      // ISS-8936: saving a version bumps `latestVersion` and `updatedAt`, two of
      // the four operands the Documents summary band counts, so the band is
      // invalidated with the lists. `summaries()` is a SIBLING of `lists()` and
      // does not come along for free — this row is the behavior change, not a
      // widened expectation.
      { queryKey: documentKeys.summaries() },
      { queryKey: projectTreeKeys.all },
    ];
    expect(invalidate.mock.calls.map(([options]) => options)).toEqual([
      ...expectedInvalidations,
      ...expectedInvalidations,
    ]);
  });
});

describe("artifact link hooks", () => {
  test("uses default and explicit resolved-link query parameters", async () => {
    mocks.apiClient.get.mockResolvedValue([]);
    const wrapper = createWrapperWithClient(createTestQueryClient());
    const defaults = renderHook(() => useResolvedArtifactLinks("feature-1"), {
      wrapper,
    });
    const explicit = renderHook(
      () =>
        useResolvedArtifactLinks("feature-2", {
          direction: LinkDirection.Source,
          linkType: LinkType.Blocks,
          mode: LinkQueryMode.Tree,
          maxDepth: 0,
        }),
      { wrapper }
    );
    renderHook(() => useResolvedArtifactLinks(""), { wrapper });

    await waitFor(() => expect(defaults.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(explicit.result.current.isSuccess).toBe(true));
    expect(mocks.apiClient.get).toHaveBeenCalledWith(
      "/artifact-links/resolved?artifactId=feature-1&direction=both&paginated=true"
    );
    expect(mocks.apiClient.get).toHaveBeenCalledWith(
      "/artifact-links/resolved?artifactId=feature-2&direction=source&linkType=BLOCKS&mode=tree&maxDepth=0&paginated=true"
    );
    expect(mocks.apiClient.get).toHaveBeenCalledTimes(2);
  });

  test("selects only a document target produced by the requested feature", async () => {
    const links = [
      makeResolvedLink({ sourceId: "other", targetId: "doc-other" }),
      makeResolvedLink({ sourceId: "feature-1", targetId: "doc-1" }),
    ];
    mocks.apiClient.get.mockResolvedValue(links);
    const { result } = renderHook(() => useLinkedPlanId("feature-1"), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    await waitFor(() => expect(result.current.resolvedLinks).toEqual(links));
    expect(result.current.linkedPlanLink).toBe(links[1]);
    expect(result.current.linkedPlanId).toBe("doc-1");
  });

  /**
   * Batch move left this case with ISS-9578: it stopped carrying its own
   * four-key list and now drives the shared registry from `movedArtifacts`, so
   * an exact call sequence is the wrong shape for it. `bulk-invalidation-
   * agreement.test.tsx` covers it against real cache state instead.
   */
  test("invalidates link and tree caches after create and delete", async () => {
    mocks.apiClient.post.mockResolvedValue({ id: "link-1" });
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = createWrapperWithClient(queryClient);
    const create = renderHook(() => useCreateArtifactLink(), { wrapper });
    const remove = renderHook(() => useDeleteArtifactLink(), { wrapper });

    await act(() =>
      create.result.current.mutateAsync({
        sourceId: "feature-1",
        targetId: "doc-1",
        linkType: LinkType.Produces,
      })
    );
    await act(() => remove.result.current.mutateAsync("link-1"));

    expect(mocks.apiClient.delete).toHaveBeenCalledWith(
      "/artifact-links/link-1"
    );
    expect(invalidate.mock.calls.map(([options]) => options)).toEqual([
      { queryKey: artifactLinkKeys.lists() },
      { queryKey: projectTreeKeys.all },
      { queryKey: artifactLinkKeys.all },
      { queryKey: projectTreeKeys.all },
    ]);
  });
});

describe("document editing hooks", () => {
  test("does not publish unchanged content and publishes edits with callbacks", async () => {
    const initial = makeDocumentDetail("saved");
    const published = makeDocumentDetail("published");
    mocks.apiClient.post.mockResolvedValue(published);
    const setEditorContent = vi.fn();
    const onVersionCreated = vi.fn();
    const onSuccess = vi.fn();
    const { result } = renderHook(
      () =>
        useDocumentContent({
          artifact: initial,
          isLatestVersion: true,
          setEditorContent,
          onVersionCreated,
        }),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    act(() => result.current.saveContent());
    expect(mocks.toastInfo).toHaveBeenCalledWith("No changes to publish");
    expect(mocks.apiClient.post).not.toHaveBeenCalled();

    act(() => result.current.updateContent("edited"));
    expect(result.current.hasUnsavedChanges).toBe(true);
    act(() => result.current.saveContent(undefined, false, onSuccess));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    expect(mocks.apiClient.post).toHaveBeenCalledWith(
      "/documents/artifact-123/versions?reset-room=false",
      { content: "edited" }
    );
    expect(setEditorContent).toHaveBeenCalledWith("published");
    expect(onVersionCreated).toHaveBeenCalledWith(published);
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  test("restores latest content locally and historical content as a new version", async () => {
    const artifact = makeDocumentDetail(null);
    mocks.apiClient.post.mockResolvedValue(artifact);
    const latestEditor = vi.fn();
    const latest = renderHook(
      () =>
        useDocumentContent({
          artifact,
          isLatestVersion: true,
          setEditorContent: latestEditor,
        }),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );
    act(() => latest.result.current.restoreVersion());
    expect(latestEditor).toHaveBeenCalledWith("");
    expect(mocks.apiClient.post).not.toHaveBeenCalled();

    const historicalEditor = vi.fn();
    const historical = renderHook(
      () =>
        useDocumentContent({
          artifact,
          isLatestVersion: false,
          setEditorContent: historicalEditor,
        }),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );
    act(() => historical.result.current.restoreVersion());
    await waitFor(() => expect(mocks.apiClient.post).toHaveBeenCalled());
    expect(historicalEditor).toHaveBeenCalledWith("");
    expect(mocks.apiClient.post).toHaveBeenCalledWith(
      "/documents/artifact-123/versions?reset-room=true",
      { content: "" }
    );
  });

  test("focuses inline editing at click coordinates or the document end", () => {
    const editor = makeEditor(7);
    const { result } = renderHook(() =>
      useInlineEditMode({ readOnly: false, editor, isEditorReady: true })
    );

    act(() =>
      result.current.enterEditMode({ clientX: 10, clientY: 20 } as MouseEvent)
    );
    expect(result.current.isEditing).toBe(true);
    expect(editor.view.posAtCoords).toHaveBeenCalledWith({ left: 10, top: 20 });
    expect(editor.commands.focus).toHaveBeenCalledWith(7);

    act(() => result.current.exitEditMode());
    expect(result.current.isEditing).toBe(false);
    act(() => result.current.enterEditMode());
    expect(editor.commands.focus).toHaveBeenLastCalledWith("end");
  });

  test("read-only and destroyed editors cannot enter or read coordinates", () => {
    const destroyed = makeEditor(null, true);
    const readOnly = renderHook(() =>
      useInlineEditMode({
        readOnly: true,
        editor: destroyed,
        isEditorReady: true,
        initialEditing: true,
      })
    );
    act(() =>
      readOnly.result.current.enterEditMode({
        clientX: 1,
        clientY: 2,
      } as MouseEvent)
    );
    expect(readOnly.result.current.isEditing).toBe(false);
    expect(destroyed.view.posAtCoords).not.toHaveBeenCalled();

    const editable = renderHook(
      ({ editor }: { editor: TiptapEditor }) =>
        useInlineEditMode({ readOnly: false, editor, isEditorReady: true }),
      { initialProps: { editor: destroyed } }
    );
    act(() =>
      editable.result.current.enterEditMode({
        clientX: 1,
        clientY: 2,
      } as MouseEvent)
    );
    expect(editable.result.current.isEditing).toBe(true);
    expect(destroyed.commands.focus).not.toHaveBeenCalled();

    const replacement = makeEditor(null);
    editable.rerender({ editor: replacement });
    expect(replacement.commands.focus).toHaveBeenCalledWith("end");
  });

  // The scaffold keeps the body `invisible` until the editor is ready, and the
  // browser refuses focus there; a re-render in that window (the version-signal
  // resync refetch) must not spend the one-time focus (ISS-4382).
  test("initial edit mode waits for the editor body to be ready before focusing", () => {
    const editor = makeEditor(null);
    const { rerender } = renderHook(
      ({ isEditorReady }: { isEditorReady: boolean }) =>
        useInlineEditMode({
          readOnly: false,
          editor,
          isEditorReady,
          initialEditing: true,
        }),
      { initialProps: { isEditorReady: false } }
    );
    rerender({ isEditorReady: false });
    expect(editor.commands.focus).not.toHaveBeenCalled();

    rerender({ isEditorReady: true });
    expect(editor.commands.focus).toHaveBeenCalledExactlyOnceWith("end");
  });
});

describe("documents view state and pagination", () => {
  test("no-op selection and merge transitions preserve state references", () => {
    const { result } = renderHook(() => useDocumentsViewState());
    const initial = result.current.state;
    act(() => result.current.actions.clearSelection());
    expect(result.current.state).toBe(initial);
    act(() => result.current.actions.pruneSelection(new Set(["missing"])));
    expect(result.current.state).toBe(initial);
    act(() => result.current.actions.clearMergeError());
    expect(result.current.state).toBe(initial);
    act(() => result.current.actions.requestBulkMove([]));
    expect(result.current.state).toBe(initial);
  });

  test("covers unchecked selection, explicit dialog state, and move cleanup", () => {
    const { result } = renderHook(() => useDocumentsViewState());
    act(() => {
      result.current.actions.changeSelection("a", true);
      result.current.actions.changeSelection("a", false);
      result.current.actions.setDeleteDialogOpen(true);
      result.current.actions.setDeletePending(true);
      result.current.actions.setMergeDialogOpen(true);
      result.current.actions.requestMove({ kind: "none" });
      result.current.actions.requestBulkMove([{ id: "doc-1" }]);
    });
    expect(result.current.state).toMatchObject({
      deleteDialogOpen: true,
      deletePending: true,
      mergeDialogOpen: true,
      moveEntity: null,
    });
    expect(result.current.state.selectedIds.size).toBe(0);
    expect(result.current.state.moveEntities).toEqual([{ id: "doc-1" }]);

    act(() => result.current.actions.closeBulkMoveDialog());
    expect(result.current.state.moveEntities).toEqual([]);
  });

  test("disabled pagination returns the original inputs without a false count", () => {
    const documents = [
      makeArtifact({ id: "one" }),
      makeArtifact({ id: "two" }),
    ];
    const { result } = renderHook(() =>
      useTableViewPagination({
        documents,
        treeData: undefined,
        filterCategory: "documents",
        filterText: "",
        isFilterActive: false,
        groupBy: GroupByMode.None,
        sortPersistenceKey: "coverage",
        enabled: false,
        pageSize: 0,
      })
    );

    expect(result.current).toMatchObject({
      page: 0,
      total: 0,
      totalPages: 1,
      from: 0,
      to: 0,
      pagedDocuments: documents,
      pagedTreeData: undefined,
    });
  });

  test("enabled pagination clamps a shrinking corpus and resets for filters", () => {
    mocks.stackRankEnabled = true;
    const documents = [
      makeArtifact({ id: "one", sortOrder: 1 }),
      makeArtifact({ id: "two", sortOrder: 2, title: "Two" }),
      makeArtifact({ id: "three", sortOrder: 3 }),
    ];
    const base = {
      treeData: undefined,
      filterCategory: "documents" as const,
      isFilterActive: false,
      groupBy: GroupByMode.None,
      sortPersistenceKey: "coverage",
      pageSize: 1,
    };
    const { result, rerender } = renderHook(
      ({ rows, filterText }) =>
        useTableViewPagination({ ...base, documents: rows, filterText }),
      { initialProps: { rows: documents, filterText: "" } }
    );
    expect(result.current).toMatchObject({
      page: 0,
      total: 3,
      totalPages: 3,
      from: 1,
      to: 1,
    });

    act(() => result.current.setPage(2));
    expect(result.current.page).toBe(2);
    rerender({ rows: documents.slice(0, 1), filterText: "" });
    expect(result.current.page).toBe(0);
    rerender({ rows: documents, filterText: "two" });
    expect(result.current.page).toBe(0);
    expect(result.current.total).toBe(1);
  });
});

function makeDocumentDetail(content: string | null): DocumentDetail {
  return {
    ...createMockDocument({ id: "artifact-123", slug: "PRD-1" }),
    version: {
      id: "version-1",
      documentId: "artifact-123",
      version: 1,
      content,
      createdById: "user-1",
      createdAt: new Date("2026-08-20T00:00:00Z"),
    },
    latestVersionContent: content,
  };
}

function makeResolvedLink({
  sourceId,
  targetId,
}: {
  sourceId: string;
  targetId: string;
}): ArtifactLinkWithEndpoints {
  const now = new Date("2026-08-20T00:00:00Z");
  const endpoint = {
    id: targetId,
    organizationId: "org-1",
    projectId: "project-1",
    type: ArtifactType.Document,
    subtype: null,
    name: "Plan",
    slug: "PLN-1",
    externalUrl: null,
    status: DocumentStatus.Draft,
    priority: Priority.Medium,
    assigneeId: null,
    assignee: null,
    createdById: "user-1",
    dueDate: null,
    sortOrder: null,
    createdAt: now,
    updatedAt: now,
  };
  return {
    id: `link-${targetId}`,
    organizationId: "org-1",
    sourceId,
    targetId,
    linkType: LinkType.Produces,
    metadata: null,
    createdAt: now,
    source: { ...endpoint, id: sourceId, type: ArtifactType.Document },
    target: endpoint,
  };
}

function makeEditor(
  position: number | null,
  isDestroyed = false
): TiptapEditor {
  return {
    isDestroyed,
    view: {
      posAtCoords: vi.fn(() => (position === null ? null : { pos: position })),
    },
    commands: { focus: vi.fn() },
  } as unknown as TiptapEditor;
}
