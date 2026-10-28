import type {
  DocumentDetail,
  DocumentWithProject,
} from "@repo/api/src/types/document";
import { DocumentStatus } from "@repo/api/src/types/document";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import { useUpdateDocument } from "@repo/app/documents/hooks/use-documents";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-11198 (marisolashgrove and tamsinb review, PR #7924): the assignee guard is
 * attached where the status and priority guards are, inside
 * `useUpdateDocument`, so every caller that writes `assigneeId` — the grid
 * cells, My Tasks, the project page, the detail panel — carries it without
 * passing it, and a caller cannot drop it by writing a two-argument callback.
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
  mockApiClient.put.mockResolvedValue({ id: ARTIFACT_ID, slug: "ISS-1" });
});

describe("useUpdateDocument assignee guard", () => {
  it("expects the assignee the cache last showed", async () => {
    const { path, body } = await putFor(
      guardedArtifact(OTHER_USER_ID),
      NEW_USER_ID
    );

    expect(path).toBe(PUT_PATH);
    expect(body).toEqual({
      assigneeId: NEW_USER_ID,
      expectedAssigneeId: OTHER_USER_ID,
    });
  });

  it("asserts an unassigned document as null, not by omission", async () => {
    const { path, body } = await putFor(guardedArtifact(null), NEW_USER_ID);

    expect(path).toBe(PUT_PATH);
    expect(body).toEqual({
      assigneeId: NEW_USER_ID,
      expectedAssigneeId: null,
    });
  });

  it("keeps the guard a caller supplied", async () => {
    const { path, body } = await putFor(
      guardedArtifact(OTHER_USER_ID),
      NEW_USER_ID,
      {
        expectedAssigneeId: CALLER_USER_ID,
      }
    );

    expect(path).toBe(PUT_PATH);
    expect(body).toEqual({
      assigneeId: NEW_USER_ID,
      expectedAssigneeId: CALLER_USER_ID,
    });
  });

  it("leaves the write unguarded against a row that advertises no capability", async () => {
    const { path, body } = await putFor(
      createMockDocument({ id: ARTIFACT_ID, assigneeId: OTHER_USER_ID }),
      NEW_USER_ID
    );

    expect(path).toBe(PUT_PATH);
    expect(body).toEqual({ assigneeId: NEW_USER_ID });
  });
});

async function putFor(
  cached: unknown,
  assigneeId: string,
  extra: { expectedAssigneeId?: string | null } = {}
) {
  const queryClient = makeQueryClient();
  queryClient.setQueryData(documentKeys.detail(ARTIFACT_ID), cached);
  const { result } = renderHook(() => useUpdateDocument(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });

  result.current.mutate({ id: ARTIFACT_ID, assigneeId, ...extra });

  await waitFor(() => {
    if (!result.current.isSuccess) {
      throw new Error("the write has not settled yet");
    }
  });
  const [path, body] = mockApiClient.put.mock.calls[0] ?? [];
  return { path, body };
}

function guardedArtifact(
  assigneeId: string | null
): DocumentWithProject & Pick<DocumentDetail, "statusMutation"> {
  return {
    ...createMockDocument({ id: ARTIFACT_ID, assigneeId }),
    statusMutation: DOCUMENT_STATUS_MUTATION_CAPABILITY,
  };
}

const ARTIFACT_ID = "artifact-123";
const PUT_PATH = `/documents/${ARTIFACT_ID}`;
const OTHER_USER_ID = "user-other";
const NEW_USER_ID = "user-new";
const CALLER_USER_ID = "user-caller";

const DOCUMENT_STATUS_MUTATION_CAPABILITY: NonNullable<
  DocumentDetail["statusMutation"]
> = {
  allowedStatuses: [DocumentStatus.Draft, DocumentStatus.Approved],
  expectedStatusField: "expectedStatus",
  expectedStatusByIdField: "expectedStatusById",
};
