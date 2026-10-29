import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentStatus } from "@repo/api/src/types/document";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import { useDocumentMetadata } from "@repo/app/documents/hooks/use-document-metadata";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-11198: the detail panel's assignee write is guarded like its status and
 * priority writes, from the cached document `useUpdateDocument` reads, not from
 * the panel's optimistic pick (marisolashgrove review, PR #7924). This pins that
 * the panel's write path reaches that guard.
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

const ADA = { id: "user-ada", name: "Ada Lovelace" };
const GRACE = { id: "user-grace", name: "Grace Hopper" };

beforeEach(() => {
  vi.clearAllMocks();
  mockApiClient.put.mockImplementation(() => new Promise(() => undefined));
});

describe("useDocumentMetadata assignee guard", () => {
  it("expects the assignee the cached document holds", async () => {
    const artifact = createMockDocument({
      id: "artifact-123",
      assigneeId: ADA.id,
    });
    const queryClient = makeQueryClient();
    queryClient.setQueryData(documentKeys.detail(artifact.id), {
      ...artifact,
      statusMutation: DOCUMENT_STATUS_MUTATION_CAPABILITY,
    });
    const { result } = renderHook(() => useDocumentMetadata({ artifact }), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });

    act(() => result.current.handleAssigneeChange(GRACE));

    await waitFor(() => expect(mockApiClient.put).toHaveBeenCalledTimes(1));
    expect(mockApiClient.put).toHaveBeenCalledWith("/documents/artifact-123", {
      assigneeId: GRACE.id,
      expectedAssigneeId: ADA.id,
      surface: ArtifactStatusEditSurface.Detail,
    });
  });

  it("attributes approver writes to the detail surface", async () => {
    const artifact = createMockDocument({ id: "artifact-123" });
    const queryClient = makeQueryClient();
    queryClient.setQueryData(documentKeys.detail(artifact.id), {
      ...artifact,
      statusMutation: DOCUMENT_STATUS_MUTATION_CAPABILITY,
    });
    const { result } = renderHook(() => useDocumentMetadata({ artifact }), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });

    act(() => result.current.handleApproverSelect(GRACE));

    await waitFor(() => expect(mockApiClient.put).toHaveBeenCalledTimes(1));
    expect(mockApiClient.put).toHaveBeenCalledWith("/documents/artifact-123", {
      approverId: GRACE.id,
      surface: ArtifactStatusEditSurface.Detail,
    });
  });

  it("attributes parent writes to the detail surface", async () => {
    const artifact = createMockDocument({ id: "artifact-123" });
    const queryClient = makeQueryClient();
    queryClient.setQueryData(documentKeys.detail(artifact.id), {
      ...artifact,
      statusMutation: DOCUMENT_STATUS_MUTATION_CAPABILITY,
    });
    const { result } = renderHook(() => useDocumentMetadata({ artifact }), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });

    act(() => result.current.handleParentChange("parent-2"));

    await waitFor(() => expect(mockApiClient.put).toHaveBeenCalledTimes(1));
    expect(mockApiClient.put).toHaveBeenCalledWith("/documents/artifact-123", {
      parentId: "parent-2",
      surface: ArtifactStatusEditSurface.Detail,
    });
  });
});

const DOCUMENT_STATUS_MUTATION_CAPABILITY: NonNullable<
  DocumentDetail["statusMutation"]
> = {
  allowedStatuses: [DocumentStatus.Draft, DocumentStatus.Approved],
  expectedStatusField: "expectedStatus",
  expectedStatusByIdField: "expectedStatusById",
};
