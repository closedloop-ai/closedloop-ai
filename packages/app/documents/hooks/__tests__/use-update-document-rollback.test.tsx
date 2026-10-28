import { batchItemApplied } from "@repo/api/src/types/batch-mutation-result";
import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import { Priority } from "@repo/api/src/types/common";
import type {
  DocumentDetail,
  DocumentWithProject,
} from "@repo/api/src/types/document";
import { DocumentStatus } from "@repo/api/src/types/document";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import { useDocumentMetadata } from "@repo/app/documents/hooks/use-document-metadata";
import {
  useBatchUpdateStatus,
  useUpdateDocument,
} from "@repo/app/documents/hooks/use-documents";
import { projectTreeKeys } from "@repo/app/projects/hooks/project-tree-keys";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-9667 — a refused status write must not leave the new value on screen.
 *
 * `useDocumentMetadata` renders the picked status immediately, and
 * `useUpdateDocument` used to invalidate only `onSuccess`. A rejected write
 * therefore changed nothing: no cache entry was re-read, the artifact's cached
 * status stayed put, and the effect that re-syncs local state from it never
 * re-ran — so the panel kept showing a status the server had rejected, for as
 * long as the page stayed open.
 *
 * These run against the PRODUCTION query client (`makeQueryClient`), not the
 * isolated test client, because the failure message comes from that client's
 * default `mutations.onError`. An isolated client has no such default, so a
 * test built on one would report a surfaced error the shipped app never shows.
 */
const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const toastError = vi.fn();
vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useUpdateDocument: a refused write rolls the cache back", () => {
  it("sends the cached current status as the default stale-write guard when the server advertises support", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(
      documentKeys.detail("artifact-123"),
      draftArtifact()
    );
    mockApiClient.put.mockResolvedValueOnce({
      id: "artifact-123",
      slug: "PRD-1",
    });

    const { result } = renderHook(() => useUpdateDocument(), {
      wrapper: wrapperFor(queryClient),
    });

    result.current.mutate({
      id: "artifact-123",
      status: DocumentStatus.Approved,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.put).toHaveBeenCalledWith("/documents/artifact-123", {
      expectedStatus: DocumentStatus.Draft,
      status: DocumentStatus.Approved,
    });
  });

  it("omits the default stale-write guard against a legacy detail response", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(
      documentKeys.detail("artifact-123"),
      legacyDraftArtifact()
    );
    mockApiClient.put.mockResolvedValueOnce({
      id: "artifact-123",
      slug: "PRD-1",
    });

    const { result } = renderHook(() => useUpdateDocument(), {
      wrapper: wrapperFor(queryClient),
    });

    result.current.mutate({
      id: "artifact-123",
      status: DocumentStatus.Approved,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.put).toHaveBeenCalledWith("/documents/artifact-123", {
      status: DocumentStatus.Approved,
    });
  });

  it("preserves an explicit stale-write guard supplied by the caller", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(
      documentKeys.detail("artifact-123"),
      draftArtifact()
    );
    mockApiClient.put.mockResolvedValueOnce({
      id: "artifact-123",
      slug: "PRD-1",
    });

    const { result } = renderHook(() => useUpdateDocument(), {
      wrapper: wrapperFor(queryClient),
    });

    result.current.mutate({
      expectedStatus: DocumentStatus.InReview,
      id: "artifact-123",
      status: DocumentStatus.Approved,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.put).toHaveBeenCalledWith("/documents/artifact-123", {
      expectedStatus: DocumentStatus.InReview,
      status: DocumentStatus.Approved,
    });
  });

  it("re-reads server state on failure and surfaces the error through the shared toast", async () => {
    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const rejection = new Error("server refused");
    mockApiClient.put.mockRejectedValueOnce(rejection);

    const { result } = renderHook(() => useUpdateDocument(), {
      wrapper: wrapperFor(queryClient),
    });

    result.current.mutate({
      id: "artifact-123",
      status: DocumentStatus.Approved,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    // Rollback: the detail entry is re-read, so the surface returns to server
    // state instead of keeping the refused value.
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: documentKeys.detail("artifact-123"),
    });
    // Surfaced, not swallowed — through the existing path, not a new one.
    expect(result.current.error).toBe(rejection);
    expect(toastError).toHaveBeenCalled();
  });

  it("toasts nothing for a refusal whose field still owns its feedback", async () => {
    const queryClient = makeQueryClient();
    mockApiClient.put.mockRejectedValueOnce(new Error("server refused"));
    const { result } = renderHook(() => useUpdateDocument(), {
      wrapper: wrapperFor(queryClient),
    });

    result.current.mutate({
      id: "artifact-123",
      title: "Plan v2",
      recoverableErrorOwner: () => true,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("restores the shared toast when the adjacent document owner departs", async () => {
    const queryClient = makeQueryClient();
    mockApiClient.put.mockRejectedValueOnce(new Error("server refused"));
    const { result } = renderHook(() => useUpdateDocument(), {
      wrapper: wrapperFor(queryClient),
    });

    result.current.mutate({
      id: "artifact-123",
      title: "Plan v2",
      recoverableErrorOwner: () => false,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toastError).toHaveBeenCalledOnce();
  });

  // ISS-11198: every document detail page reads its document by slug, so a
  // refused write must re-read that entry or a stale guard is re-sent forever.
  it("re-reads every by-slug entry when the write is refused", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(documentKeys.bySlug("PRD-1"), draftArtifact());
    mockApiClient.put.mockRejectedValueOnce(new Error("stale_title"));

    const { result } = renderHook(() => useUpdateDocument(), {
      wrapper: wrapperFor(queryClient),
    });

    result.current.mutate({
      id: "artifact-123",
      title: "Plan v2",
      expectedTitle: "Plan",
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    // The entry a detail page reads, matched by prefix, not the call's key.
    expect(
      queryClient.getQueryState(documentKeys.bySlug("PRD-1"))?.isInvalidated
    ).toBe(true);
  });

  it("still invalidates the by-slug entry on a write that succeeds", async () => {
    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    mockApiClient.put.mockResolvedValueOnce({
      id: "artifact-123",
      slug: "PRD-1",
    });

    const { result } = renderHook(() => useUpdateDocument(), {
      wrapper: wrapperFor(queryClient),
    });

    result.current.mutate({
      id: "artifact-123",
      status: DocumentStatus.Approved,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: documentKeys.bySlug("PRD-1"),
    });
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("useBatchUpdateStatus: stale-write guards", () => {
  it("adds expected statuses from cached detail rows when server capability is available", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(
      documentKeys.detail("artifact-123"),
      draftArtifact()
    );
    queryClient.setQueryData(
      documentKeys.detail("artifact-456"),
      statusMutationArtifact({
        id: "artifact-456",
        status: DocumentStatus.InReview,
      })
    );
    mockApiClient.post.mockResolvedValueOnce(
      successfulBatchResponse(["artifact-123", "artifact-456"])
    );

    const { result } = renderHook(() => useBatchUpdateStatus(), {
      wrapper: wrapperFor(queryClient),
    });

    result.current.mutate({
      documentIds: ["artifact-123", "artifact-456"],
      status: DocumentStatus.Approved,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      `${BatchMutationRoute.DocumentsUpdateStatus}/v2`,
      {
        documentIds: ["artifact-123", "artifact-456"],
        expectedStatusById: {
          "artifact-123": DocumentStatus.Draft,
          "artifact-456": DocumentStatus.InReview,
        },
        status: DocumentStatus.Approved,
      }
    );
  });

  it("adds expected statuses from cached list rows when server capability is available", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(documentKeys.list({ projectId: "project-1" }), [
      statusMutationArtifact({
        id: "artifact-123",
        status: DocumentStatus.Draft,
      }),
      statusMutationArtifact({
        id: "artifact-456",
        status: DocumentStatus.InReview,
      }),
    ]);
    mockApiClient.post.mockResolvedValueOnce(
      successfulBatchResponse(["artifact-123", "artifact-456"])
    );

    const { result } = renderHook(() => useBatchUpdateStatus(), {
      wrapper: wrapperFor(queryClient),
    });

    result.current.mutate({
      documentIds: ["artifact-123", "artifact-456"],
      status: DocumentStatus.Approved,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      `${BatchMutationRoute.DocumentsUpdateStatus}/v2`,
      {
        documentIds: ["artifact-123", "artifact-456"],
        expectedStatusById: {
          "artifact-123": DocumentStatus.Draft,
          "artifact-456": DocumentStatus.InReview,
        },
        status: DocumentStatus.Approved,
      }
    );
  });

  it("adds expected statuses from cached detailed project tree rows", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(projectTreeKeys.withDetails("project-1"), {
      externalParents: [],
      nodes: [
        {
          children: [],
          root: statusMutationArtifact({
            id: "artifact-123",
            status: DocumentStatus.Draft,
          }),
        },
        {
          children: [],
          root: statusMutationArtifact({
            id: "artifact-456",
            status: DocumentStatus.InReview,
          }),
        },
      ],
    });
    mockApiClient.post.mockResolvedValueOnce(
      successfulBatchResponse(["artifact-123", "artifact-456"])
    );

    const { result } = renderHook(() => useBatchUpdateStatus(), {
      wrapper: wrapperFor(queryClient),
    });

    result.current.mutate({
      documentIds: ["artifact-123", "artifact-456"],
      status: DocumentStatus.Approved,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      `${BatchMutationRoute.DocumentsUpdateStatus}/v2`,
      {
        documentIds: ["artifact-123", "artifact-456"],
        expectedStatusById: {
          "artifact-123": DocumentStatus.Draft,
          "artifact-456": DocumentStatus.InReview,
        },
        status: DocumentStatus.Approved,
      }
    );
  });

  it("uses the freshest cached list row when building batch stale-write guards", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(
      documentKeys.list({ projectId: "stale-project" }),
      [
        statusMutationArtifact({
          id: "artifact-123",
          status: DocumentStatus.Draft,
        }),
      ],
      { updatedAt: 100 }
    );
    queryClient.setQueryData(
      documentKeys.list({ projectId: "project-1" }),
      [
        statusMutationArtifact({
          id: "artifact-123",
          status: DocumentStatus.InReview,
        }),
      ],
      { updatedAt: 200 }
    );
    mockApiClient.post.mockResolvedValueOnce(
      successfulBatchResponse(["artifact-123"])
    );

    const { result } = renderHook(() => useBatchUpdateStatus(), {
      wrapper: wrapperFor(queryClient),
    });

    result.current.mutate({
      documentIds: ["artifact-123"],
      status: DocumentStatus.Approved,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      `${BatchMutationRoute.DocumentsUpdateStatus}/v2`,
      {
        documentIds: ["artifact-123"],
        expectedStatusById: {
          "artifact-123": DocumentStatus.InReview,
        },
        status: DocumentStatus.Approved,
      }
    );
  });

  it("does not add expected statuses from legacy cached list rows", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(documentKeys.list({ projectId: "project-1" }), [
      legacyDraftArtifact(),
      createMockDocument({
        id: "artifact-456",
        status: DocumentStatus.InReview,
      }),
    ]);
    mockApiClient.post.mockResolvedValueOnce(
      successfulBatchResponse(["artifact-123", "artifact-456"])
    );

    const { result } = renderHook(() => useBatchUpdateStatus(), {
      wrapper: wrapperFor(queryClient),
    });

    result.current.mutate({
      documentIds: ["artifact-123", "artifact-456"],
      status: DocumentStatus.Approved,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      `${BatchMutationRoute.DocumentsUpdateStatus}/v2`,
      {
        documentIds: ["artifact-123", "artifact-456"],
        status: DocumentStatus.Approved,
      }
    );
  });
});

describe("useDocumentMetadata: a refused status write reverts the picker", () => {
  it("shows the picked status while the write is still in flight", () => {
    // A write that never settles: this pins the OPTIMISTIC half, which is the
    // reason a rollback is owed at all. Without it the rollback test could pass
    // on a hook that never showed the new value in the first place.
    mockApiClient.put.mockImplementationOnce(
      () => new Promise(() => undefined)
    );

    const { result } = renderHook(
      () => useDocumentMetadata({ artifact: draftArtifact() }),
      { wrapper: wrapperFor(makeQueryClient()) }
    );

    act(() => {
      result.current.handleStatusChange(DocumentStatus.Approved);
    });

    expect(result.current.status).toBe("APPROVED");
  });

  it("puts the server's status back on screen when the write is rejected", async () => {
    mockApiClient.put.mockRejectedValueOnce(new Error("server refused"));

    const { result } = renderHook(
      () => useDocumentMetadata({ artifact: draftArtifact() }),
      { wrapper: wrapperFor(makeQueryClient()) }
    );

    act(() => {
      result.current.handleStatusChange(DocumentStatus.Approved);
    });

    // Pinned to a literal, not to `artifact.status`, so a rollback that read
    // the wrong field still fails.
    await waitFor(() => expect(result.current.status).toBe("DRAFT"));
    expect(toastError).toHaveBeenCalled();
  });

  it("rolls back ONLY the field it wrote, leaving a sibling edit alone", async () => {
    // The rollback restores from `artifact` — server state — which lags a
    // sibling write that has already succeeded but not yet refetched. Rolling
    // back all three fields on any failure therefore reverted the sibling to a
    // value the server no longer holds: the same lie the rollback exists to
    // prevent, just on a different field.
    mockApiClient.put
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockRejectedValueOnce(new Error("server refused"));

    const { result } = renderHook(
      () => useDocumentMetadata({ artifact: draftArtifact() }),
      { wrapper: wrapperFor(makeQueryClient()) }
    );

    act(() => {
      result.current.handlePriorityChange(Priority.High);
    });
    act(() => {
      result.current.handleStatusChange(DocumentStatus.Approved);
    });

    // Wait for the status rollback to actually land — asserting priority before
    // the rejection settles would pass without the fix.
    await waitFor(() => expect(result.current.status).toBe("DRAFT"));
    // The status write is the one that failed; the priority edit must survive.
    expect(result.current.priority).toBe("HIGH");
  });

  it("keeps a status the server ACCEPTED when a later priority write is refused", async () => {
    // The reviewer's case, and the one the sibling test above cannot make: there
    // the surviving field was still in flight, so a rollback could be excused as
    // racing an unsettled write. Here A genuinely SUCCEEDED — the server holds
    // APPROVED — and only then does B fail. A rollback keyed on the whole
    // artifact restores `artifact.status`, which is last-FETCHED state and still
    // reads DRAFT because A's refetch has not landed, so an unrelated priority
    // failure silently un-does a status change the server accepted. The reader
    // sees their successful edit revert with no explanation, which is the UI
    // lying about data the server holds.
    mockApiClient.put
      .mockResolvedValueOnce({ id: "artifact-123", slug: "PRD-1" })
      .mockRejectedValueOnce(new Error("server refused"));

    const { result } = renderHook(
      () => useDocumentMetadata({ artifact: draftArtifact() }),
      { wrapper: wrapperFor(makeQueryClient()) }
    );

    act(() => {
      result.current.handleStatusChange(DocumentStatus.Approved);
    });
    // The positive case FIRST: A has to actually land, or the assertion below
    // would hold on a hook that never applied the status at all.
    await waitFor(() => expect(result.current.isUpdating).toBe(false));
    expect(result.current.status).toBe("APPROVED");

    act(() => {
      result.current.handlePriorityChange(Priority.High);
    });

    // B is refused, so B's OWN field returns to server state...
    await waitFor(() => expect(result.current.priority).toBe("MEDIUM"));
    // ...and the accepted status is still on screen. Pinned to a literal rather
    // than `artifact.status` so a rollback that reverted this field still fails.
    expect(result.current.status).toBe("APPROVED");
    expect(toastError).toHaveBeenCalled();
  });
});

function draftArtifact(): DocumentWithProject &
  Pick<DocumentDetail, "statusMutation"> {
  return statusMutationArtifact({
    id: "artifact-123",
    status: DocumentStatus.Draft,
  });
}

function statusMutationArtifact(
  overrides: Parameters<typeof createMockDocument>[0]
): DocumentWithProject & Pick<DocumentDetail, "statusMutation"> {
  return {
    ...createMockDocument(overrides),
    statusMutation: DOCUMENT_STATUS_MUTATION_CAPABILITY,
  };
}

function legacyDraftArtifact(): DocumentWithProject {
  return createMockDocument({
    id: "artifact-123",
    status: DocumentStatus.Draft,
  });
}

const DOCUMENT_STATUS_MUTATION_CAPABILITY: NonNullable<
  DocumentDetail["statusMutation"]
> = {
  allowedStatuses: [
    DocumentStatus.Draft,
    DocumentStatus.InReview,
    DocumentStatus.Approved,
    DocumentStatus.ChangesRequested,
    DocumentStatus.Executed,
    DocumentStatus.Obsolete,
  ],
  expectedStatusField: "expectedStatus",
  expectedStatusByIdField: "expectedStatusById",
};

function wrapperFor(queryClient: ReturnType<typeof makeQueryClient>) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function successfulBatchResponse(ids: readonly string[]) {
  return { results: ids.map(batchItemApplied) };
}
