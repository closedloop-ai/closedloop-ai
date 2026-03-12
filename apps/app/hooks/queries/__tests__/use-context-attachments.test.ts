import type {
  CreateContextAttachmentResponse,
  ImportGDriveContextResponse,
} from "@repo/api/src/types/context-attachment";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  CreateContextAttachmentInput,
  ImportGDriveContextInput,
} from "../use-context-attachments";
import {
  useCreateContextAttachment,
  useImportGDriveContext,
} from "../use-context-attachments";
import { createTestQueryClient, createWrapperWithClient } from "./test-utils";

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function buildCreateInput(
  overrides: Partial<CreateContextAttachmentInput> = {}
): CreateContextAttachmentInput {
  return {
    filename: "spec.pdf",
    mimeType: "application/pdf",
    sizeBytes: 4096,
    ...overrides,
  };
}

function buildCreateResponse(
  overrides: Partial<CreateContextAttachmentResponse> = {}
): CreateContextAttachmentResponse {
  return {
    uploadUrl: "https://storage.example.com/upload/abc",
    artifactId: "artifact-1",
    attachmentId: "attachment-1",
    ...overrides,
  };
}

function buildImportInput(
  overrides: Partial<ImportGDriveContextInput> = {}
): ImportGDriveContextInput {
  return {
    docIds: ["doc-aaa", "doc-bbb"],
    projectId: "550e8400-e29b-41d4-a716-446655440000",
    ...overrides,
  };
}

function buildImportResponse(
  overrides: Partial<ImportGDriveContextResponse> = {}
): ImportGDriveContextResponse {
  return {
    results: [
      { docId: "doc-aaa", artifactId: "artifact-2" },
      { docId: "doc-bbb", artifactId: "artifact-3" },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useCreateContextAttachment", () => {
  test("posts to the correct issue context-attachments URL", async () => {
    const mockResponse = buildCreateResponse();
    mockApiClient.post.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(
      () => useCreateContextAttachment("issue-123"),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    result.current.mutate(buildCreateInput());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/issues/issue-123/context-attachments",
      buildCreateInput()
    );
    expect(result.current.data).toEqual(mockResponse);
  });

  test("forwards optional projectId in the request body", async () => {
    const input = buildCreateInput({
      projectId: "550e8400-e29b-41d4-a716-446655440000",
    });
    mockApiClient.post.mockResolvedValueOnce(buildCreateResponse());

    const { result } = renderHook(
      () => useCreateContextAttachment("issue-999"),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    result.current.mutate(input);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/issues/issue-999/context-attachments",
      input
    );
  });

  test("invalidates entity-link list queries on success", async () => {
    mockApiClient.post.mockResolvedValueOnce(buildCreateResponse());

    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(
      () => useCreateContextAttachment("issue-123"),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    result.current.mutate(buildCreateInput());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["entity-links", "list"],
      })
    );
  });

  test("returns error state when the API call fails", async () => {
    mockApiClient.post.mockRejectedValueOnce(
      new Error("Upload initiation failed")
    );

    const { result } = renderHook(
      () => useCreateContextAttachment("issue-123"),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    result.current.mutate(buildCreateInput());

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("Upload initiation failed");
  });

  test("calls caller-supplied onSuccess callback with the response data", async () => {
    const mockResponse = buildCreateResponse();
    mockApiClient.post.mockResolvedValueOnce(mockResponse);

    const onSuccess = vi.fn();

    const { result } = renderHook(
      () => useCreateContextAttachment("issue-123", { onSuccess }),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    result.current.mutate(buildCreateInput());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(onSuccess).toHaveBeenCalledWith(
      mockResponse,
      expect.objectContaining({ filename: "spec.pdf" }),
      undefined,
      expect.objectContaining({ client: expect.anything() })
    );
  });
});

describe("useImportGDriveContext", () => {
  test("posts to the correct issue gdrive URL", async () => {
    const input = buildImportInput();
    const mockResponse = buildImportResponse();
    mockApiClient.post.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useImportGDriveContext("issue-456"), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    result.current.mutate(input);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/issues/issue-456/context-attachments/gdrive",
      input
    );
    expect(result.current.data).toEqual(mockResponse);
  });

  test("includes per-document results in the response", async () => {
    const mockResponse = buildImportResponse({
      results: [
        { docId: "doc-aaa", artifactId: "artifact-10" },
        { docId: "doc-bbb", error: "Document not accessible" },
      ],
    });
    mockApiClient.post.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useImportGDriveContext("issue-456"), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    result.current.mutate(buildImportInput());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.results).toHaveLength(2);
    expect(result.current.data?.results[0]).toEqual({
      docId: "doc-aaa",
      artifactId: "artifact-10",
    });
    expect(result.current.data?.results[1]).toEqual({
      docId: "doc-bbb",
      error: "Document not accessible",
    });
  });

  test("invalidates entity-link list queries on success", async () => {
    mockApiClient.post.mockResolvedValueOnce(buildImportResponse());

    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useImportGDriveContext("issue-456"), {
      wrapper: createWrapperWithClient(queryClient),
    });

    result.current.mutate(buildImportInput());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["entity-links", "list"],
      })
    );
  });

  test("returns error state when the API call fails", async () => {
    mockApiClient.post.mockRejectedValueOnce(
      new Error("Google Drive not connected")
    );

    const { result } = renderHook(() => useImportGDriveContext("issue-456"), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    result.current.mutate(buildImportInput());

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("Google Drive not connected");
  });
});
