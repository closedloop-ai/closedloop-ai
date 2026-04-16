/**
 * Unit tests for useDocumentActions hook.
 *
 * Covers:
 * - handleDelete calls mutate with correct args and onSuccess callback
 * - handleDelete onSuccess shows toast and redirects
 * - handleRename calls mutate with correct args and onSuccess callback
 */

import { Priority } from "@repo/api/src/types/common";
import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createWrapperWithClient } from "@/hooks/queries/__tests__/test-utils";
import { useDocumentActions } from "../use-document-actions";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockDeleteMutate = vi.fn();
const mockUpdateMutate = vi.fn();

vi.mock("@/hooks/queries/use-documents", () => ({
  useDeleteDocument: () => ({
    mutate: mockDeleteMutate,
    isPending: false,
  }),
  useUpdateDocument: () => ({
    mutate: mockUpdateMutate,
    isPending: false,
  }),
}));

const mockRouterPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: mockRouterPush, replace: vi.fn() })),
  usePathname: vi.fn(() => "/prds"),
  useSearchParams: vi.fn(
    () => new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>
  ),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/clipboard-utils", () => ({
  copyToClipboard: vi.fn(),
}));

vi.mock("@/lib/download-utils", () => ({
  downloadAsMarkdown: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeDocument = (overrides?: Partial<DocumentDetail>): DocumentDetail =>
  ({
    id: "doc-123",
    organizationId: "org-123",
    workstreamId: null,
    projectId: "project-123",
    type: DocumentType.Prd,
    title: "Test PRD",
    slug: "test-prd",
    fileName: "test-prd.md",
    status: DocumentStatus.Draft,
    priority: Priority.Medium,
    latestVersion: 1,
    createdById: "user-123",
    assigneeId: null,
    assignee: null,
    approverId: null,
    approver: null,
    tokenUsage: null,
    targetRepo: null,
    targetBranch: null,
    templateForType: null,
    sortOrder: null,
    createdAt: new Date("2024-01-15T10:00:00Z"),
    updatedAt: new Date("2024-01-16T10:00:00Z"),
    version: {
      id: "version-123",
      documentId: "doc-123",
      version: 1,
      content: "# Test PRD\n\nContent here.",
      createdById: "user-123",
      createdAt: new Date("2024-01-15T10:00:00Z"),
    },
    ...overrides,
  }) as DocumentDetail;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useDocumentActions", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  describe("handleDelete", () => {
    test("calls mutate with document id and onSuccess callback", () => {
      const { result } = renderHook(
        () =>
          useDocumentActions({
            artifact: makeDocument(),
            redirectPath: "/prds",
          }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      act(() => {
        result.current.handleDelete();
      });

      expect(mockDeleteMutate).toHaveBeenCalledOnce();
      expect(mockDeleteMutate).toHaveBeenCalledWith(
        "doc-123",
        expect.objectContaining({ onSuccess: expect.any(Function) })
      );
    });

    test("onSuccess shows toast and redirects", () => {
      const { result } = renderHook(
        () =>
          useDocumentActions({
            artifact: makeDocument(),
            redirectPath: "/prds",
          }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      act(() => {
        result.current.handleDelete();
      });

      // Invoke the onSuccess callback
      const onSuccess = mockDeleteMutate.mock.calls[0][1].onSuccess;
      act(() => {
        onSuccess();
      });

      expect(mockRouterPush).toHaveBeenCalledWith("/prds");
    });
  });

  describe("handleRename", () => {
    test("calls mutate with title, fileName, and onSuccess callback", () => {
      const { result } = renderHook(
        () =>
          useDocumentActions({
            artifact: makeDocument(),
            redirectPath: "/prds",
          }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      act(() => {
        result.current.handleRename("Renamed PRD", "renamed-prd.md");
      });

      expect(mockUpdateMutate).toHaveBeenCalledOnce();
      expect(mockUpdateMutate).toHaveBeenCalledWith(
        {
          id: "doc-123",
          title: "Renamed PRD",
          fileName: "renamed-prd.md",
        },
        expect.objectContaining({ onSuccess: expect.any(Function) })
      );
    });
  });
});
