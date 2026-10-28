import type { CreateContextAttachmentResponse } from "@repo/api/src/types/context-attachment";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CreateContextAttachmentInput } from "../use-context-attachments";
import { useCreateContextAttachment } from "../use-context-attachments";

// Mock

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

// Factories

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

// Tests

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useCreateContextAttachment", () => {
  test("posts to the correct feature context-attachments URL", async () => {
    const mockResponse = buildCreateResponse();
    mockApiClient.post.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(
      () => useCreateContextAttachment("feature-123"),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    result.current.mutate(buildCreateInput());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/documents/feature-123/context-attachments",
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
      () => useCreateContextAttachment("feature-999"),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    result.current.mutate(input);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/documents/feature-999/context-attachments",
      input
    );
  });

  test("invalidates artifact-link list queries on success", async () => {
    mockApiClient.post.mockResolvedValueOnce(buildCreateResponse());

    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(
      () => useCreateContextAttachment("feature-123"),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    result.current.mutate(buildCreateInput());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["artifact-links", "list"],
      })
    );
  });

  test("returns error state when the API call fails", async () => {
    mockApiClient.post.mockRejectedValueOnce(
      new Error("Upload initiation failed")
    );

    const { result } = renderHook(
      () => useCreateContextAttachment("feature-123"),
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
      () => useCreateContextAttachment("feature-123", { onSuccess }),
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
