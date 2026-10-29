import {
  ArtifactPriorityMutationErrorCode,
  type BatchUpdateArtifactPriorityRequest,
  stalePriorityConflict,
} from "@repo/api/src/types/artifact-priority-mutation";
import {
  BatchItemFailureCode,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import { Priority } from "@repo/api/src/types/common";
import type {
  DocumentDetail,
  DocumentWithProject,
  UpdateDocumentInput,
} from "@repo/api/src/types/document";
import { DocumentStatus } from "@repo/api/src/types/document";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import {
  useBatchUpdatePriority,
  useUpdateDocument,
} from "@repo/app/documents/hooks/use-documents";
import { ApiError } from "@repo/app/shared/api/api-error";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-9440 — the priority precondition has to be REACHED, not merely
 * implemented.
 *
 * `apps/api` owns the compare-and-set itself, and its own suites pin it. What
 * those suites cannot see is whether any shipped caller ever sends the field:
 * a guard no client transmits leaves every real priority edit last-write-wins
 * and makes the 409 dead code the moment it merges.
 *
 * So these cases do not assert that a key appears in a payload. They stand a
 * model server in front of the hooks that honours the DOCUMENTED contract —
 * an absent expectation is unguarded, a present one must equal the persisted
 * value — and then assert the OUTCOME: the concurrent value survives and the
 * caller is told `stale_priority`. Drop the guard from either hook's body and
 * the stale write lands instead, which is the whole difference the feature
 * consists of.
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

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useUpdateDocument: the priority precondition reaches the server", () => {
  it("refuses a stale single-artifact priority edit and leaves the concurrent value standing", async () => {
    const queryClient = makeQueryClient();
    // What the user saw when they opened the menu.
    queryClient.setQueryData(
      documentKeys.detail(ARTIFACT_ID),
      priorityArtifact(Priority.Low)
    );
    // What somebody else committed in the meantime.
    const server = modelServer({ [ARTIFACT_ID]: Priority.High });
    mockApiClient.put.mockImplementation(server.put);

    const { result } = renderHook(() => useUpdateDocument(), {
      wrapper: wrapperFor(queryClient),
    });

    result.current.mutate({ id: ARTIFACT_ID, priority: Priority.Urgent });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const error = expectApiError(result.current.error);
    expect(error.status).toBe(409);
    expect(error.code).toBe(ArtifactPriorityMutationErrorCode.StalePriority);
    expect(server.persisted(ARTIFACT_ID)).toBe(Priority.High);
  });

  it("refuses a stale edit the caller believed was unset", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(
      documentKeys.detail(ARTIFACT_ID),
      priorityArtifact(null)
    );
    const server = modelServer({ [ARTIFACT_ID]: Priority.Medium });
    mockApiClient.put.mockImplementation(server.put);

    const { result } = renderHook(() => useUpdateDocument(), {
      wrapper: wrapperFor(queryClient),
    });

    result.current.mutate({ id: ARTIFACT_ID, priority: Priority.Urgent });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(server.persisted(ARTIFACT_ID)).toBe(Priority.Medium);
  });

  it("commits the edit when nothing moved under it", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(
      documentKeys.detail(ARTIFACT_ID),
      priorityArtifact(Priority.Low)
    );
    const server = modelServer({ [ARTIFACT_ID]: Priority.Low });
    mockApiClient.put.mockImplementation(server.put);

    const { result } = renderHook(() => useUpdateDocument(), {
      wrapper: wrapperFor(queryClient),
    });

    result.current.mutate({ id: ARTIFACT_ID, priority: Priority.Urgent });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(server.persisted(ARTIFACT_ID)).toBe(Priority.Urgent);
  });

  it("leaves the write unguarded against a legacy row that advertises no capability", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(
      documentKeys.detail(ARTIFACT_ID),
      createMockDocument({ id: ARTIFACT_ID, priority: Priority.Low })
    );
    const server = modelServer({ [ARTIFACT_ID]: Priority.High });
    mockApiClient.put.mockImplementation(server.put);

    const { result } = renderHook(() => useUpdateDocument(), {
      wrapper: wrapperFor(queryClient),
    });

    result.current.mutate({ id: ARTIFACT_ID, priority: Priority.Urgent });

    // Version skew degrades to the legacy behaviour rather than to a wrong
    // assertion: an old server sends no capability, so nothing is guarded.
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(server.persisted(ARTIFACT_ID)).toBe(Priority.Urgent);
  });

  it("does not guard a write that is not setting a priority", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(
      documentKeys.detail(ARTIFACT_ID),
      priorityArtifact(Priority.Low)
    );
    const server = modelServer({ [ARTIFACT_ID]: Priority.High });
    mockApiClient.put.mockImplementation(server.put);

    const { result } = renderHook(() => useUpdateDocument(), {
      wrapper: wrapperFor(queryClient),
    });

    result.current.mutate({ id: ARTIFACT_ID, title: "Renamed" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(server.lastPutBody()).not.toHaveProperty("expectedPriority");
    expect(server.persisted(ARTIFACT_ID)).toBe(Priority.High);
  });
});

describe("useBatchUpdatePriority: the batch precondition reaches the server", () => {
  it("commits the eligible row and reports the stale sibling per item", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(documentKeys.list({ projectId: "project-1" }), [
      priorityArtifact(Priority.Low),
      priorityArtifact(null, OTHER_ARTIFACT_ID),
    ]);
    const server = modelServer({
      [ARTIFACT_ID]: Priority.Low,
      [OTHER_ARTIFACT_ID]: Priority.Medium,
    });
    mockApiClient.post.mockImplementation(server.post);

    const { result } = renderHook(() => useBatchUpdatePriority(), {
      wrapper: wrapperFor(queryClient),
    });

    result.current.mutate({
      documentIds: [ARTIFACT_ID, OTHER_ARTIFACT_ID],
      priority: Priority.Urgent,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.results).toEqual([
      batchItemApplied(ARTIFACT_ID),
      batchItemFailed(OTHER_ARTIFACT_ID, BatchItemFailureCode.StalePriority, {
        documentId: OTHER_ARTIFACT_ID,
        currentPriority: Priority.Medium,
        expectedPriority: null,
      }),
    ]);
    expect(server.persisted(ARTIFACT_ID)).toBe(Priority.Urgent);
    expect(server.persisted(OTHER_ARTIFACT_ID)).toBe(Priority.Medium);
  });

  it("commits the batch when every selected row is still where the table said", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(documentKeys.list({ projectId: "project-1" }), [
      priorityArtifact(Priority.Low),
      priorityArtifact(null, OTHER_ARTIFACT_ID),
    ]);
    const server = modelServer({
      [ARTIFACT_ID]: Priority.Low,
      [OTHER_ARTIFACT_ID]: null,
    });
    mockApiClient.post.mockImplementation(server.post);

    const { result } = renderHook(() => useBatchUpdatePriority(), {
      wrapper: wrapperFor(queryClient),
    });

    result.current.mutate({
      documentIds: [ARTIFACT_ID, OTHER_ARTIFACT_ID],
      priority: Priority.Urgent,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(server.lastPostPath()).toBe(
      `${BatchMutationRoute.DocumentsUpdatePriority}/v2`
    );
    expect(server.persisted(ARTIFACT_ID)).toBe(Priority.Urgent);
    // The unset row is guarded by an explicit `null`, not by omission — the
    // whole point of the ISS-9665 unset state being a real value.
    expect(server.persisted(OTHER_ARTIFACT_ID)).toBe(Priority.Urgent);
  });

  it("preserves an explicit guard the caller supplied", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(documentKeys.list({ projectId: "project-1" }), [
      priorityArtifact(Priority.Low),
    ]);
    const server = modelServer({ [ARTIFACT_ID]: Priority.Low });
    mockApiClient.post.mockImplementation(server.post);

    const { result } = renderHook(() => useBatchUpdatePriority(), {
      wrapper: wrapperFor(queryClient),
    });

    result.current.mutate({
      documentIds: [ARTIFACT_ID],
      expectedPriorityById: { [ARTIFACT_ID]: Priority.Urgent },
      priority: Priority.High,
    });

    // The caller's own belief is wrong, and v2 reports that row without
    // converting the valid request into an envelope error.
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.results).toEqual([
      batchItemFailed(ARTIFACT_ID, BatchItemFailureCode.StalePriority, {
        documentId: ARTIFACT_ID,
        currentPriority: Priority.Low,
        expectedPriority: Priority.Urgent,
      }),
    ]);
    expect(server.persisted(ARTIFACT_ID)).toBe(Priority.Low);
  });
});

/**
 * `POST /documents/batch-update-priority/v2` and `PUT /documents/{id}` reduced to
 * the one behaviour under test: a persisted priority per id, and the
 * compare-and-set the routes perform against it.
 *
 * The three request states are the contract's, not this file's invention — an
 * ABSENT key is unguarded, `null` asserts the row holds no priority, and a
 * member asserts that member — so a caller that omits the field gets the
 * legacy last-write-wins here exactly as it does in production.
 */
function modelServer(initial: Record<string, Priority | null>) {
  const rows = new Map<string, Priority | null>(Object.entries(initial));
  let lastPutBody: Omit<UpdateDocumentInput, "id"> = {};
  let lastPostPath: string | undefined;

  function conflict(stale: { documentId: string; expected: Priority | null }) {
    const error = stalePriorityConflict([
      {
        documentId: stale.documentId,
        currentPriority: rows.get(stale.documentId) ?? null,
        expectedPriority: stale.expected,
      },
    ]);
    return new ApiError(error.message, error.status, {
      code: error.code,
      details: error.details,
    });
  }

  return {
    persisted: (id: string) => rows.get(id),
    lastPutBody: () => lastPutBody,
    lastPostPath: () => lastPostPath,
    put(path: string, body: Omit<UpdateDocumentInput, "id">) {
      lastPutBody = body;
      const id = path.slice(path.lastIndexOf("/") + 1);
      const { expectedPriority, priority } = body;
      if (
        Object.hasOwn(body, "expectedPriority") &&
        rows.get(id) !== expectedPriority
      ) {
        return Promise.reject(
          conflict({ documentId: id, expected: expectedPriority ?? null })
        );
      }
      if (priority !== undefined) {
        rows.set(id, priority);
      }
      return Promise.resolve({ id, slug: "PRD-1" });
    },
    post(path: string, body: BatchUpdateArtifactPriorityRequest) {
      lastPostPath = path;
      const expectedById = body.expectedPriorityById;
      const results = body.documentIds.map((id) => {
        if (
          expectedById &&
          Object.hasOwn(expectedById, id) &&
          rows.get(id) !== expectedById[id]
        ) {
          return batchItemFailed(id, BatchItemFailureCode.StalePriority, {
            documentId: id,
            currentPriority: rows.get(id) ?? null,
            expectedPriority: expectedById[id] ?? null,
          });
        }
        rows.set(id, body.priority);
        return batchItemApplied(id);
      });
      return Promise.resolve({
        results,
        transactionId: "00000000-0000-4000-8000-000000000001",
      });
    },
  };
}

function priorityArtifact(
  priority: Priority | null,
  id: string = ARTIFACT_ID
): DocumentWithProject & Pick<DocumentDetail, "statusMutation"> {
  return {
    ...createMockDocument({ id, priority }),
    statusMutation: DOCUMENT_STATUS_MUTATION_CAPABILITY,
  };
}

function wrapperFor(queryClient: ReturnType<typeof makeQueryClient>) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

/** Narrowed rather than cast, so a non-ApiError rejection fails loudly here. */
function expectApiError(error: unknown): ApiError {
  if (!(error instanceof ApiError)) {
    throw new Error(`expected an ApiError, received ${String(error)}`);
  }
  return error;
}

const ARTIFACT_ID = "artifact-123";
const OTHER_ARTIFACT_ID = "artifact-456";

const DOCUMENT_STATUS_MUTATION_CAPABILITY: NonNullable<
  DocumentDetail["statusMutation"]
> = {
  allowedStatuses: [DocumentStatus.Draft, DocumentStatus.Approved],
  expectedStatusField: "expectedStatus",
  expectedStatusByIdField: "expectedStatusById",
};
