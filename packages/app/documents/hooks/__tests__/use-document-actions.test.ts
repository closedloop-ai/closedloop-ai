/**
 * Unit tests for useDocumentActions hook.
 *
 * Covers:
 * - handleDelete calls mutate with correct args and onSuccess callback
 * - handleDelete onSuccess shows toast and redirects
 */

import { Priority } from "@repo/api/src/types/common";
import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { createWrapperWithClient } from "@repo/app/shared/test-utils";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useDocumentActions } from "../use-document-actions";

// Module mocks

const mockDeleteMutate = vi.fn();

vi.mock("../use-documents", () => ({
  useDeleteDocument: () => ({
    mutate: mockDeleteMutate,
    isPending: false,
  }),
}));

const mockNavigate = vi.fn();

// The hook redirects through the `@repo/navigation` port, not `next/navigation`.
// In the apps/app lane a global shim in vitest.setup.ts bridged the port back
// onto a `next/navigation` mock; @repo/app has no such shim, so this suite
// mocks the port directly, as its packages/app siblings do.
vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    replace: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@repo/app/shared/lib/clipboard-utils", () => ({
  copyToClipboard: vi.fn(),
}));

vi.mock("@repo/app/shared/lib/download-utils", () => ({
  downloadAsMarkdown: vi.fn(),
}));

// Fixtures

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

// Tests

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

      expect(mockNavigate).toHaveBeenCalledWith("/prds");
    });
  });
});
