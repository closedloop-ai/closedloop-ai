import { InlineImageResolveSkipReason } from "@repo/api/src/types/attachment";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  useResolveInlineImages,
  useUploadInlineImage,
} from "../use-attachments";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useUploadInlineImage", () => {
  test("cleans up the created attachment row when the browser PUT rejects", async () => {
    mockApiClient.post.mockResolvedValueOnce({
      attachmentId: "attachment-1",
      uploadUrl: "https://storage.example.com/upload/attachment-1",
      key: "attachments/doc-1/object",
    });
    mockApiClient.delete.mockResolvedValueOnce({ deleted: true });
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("Network failed")
    );

    const { result } = renderHook(() => useUploadInlineImage("doc-1"), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    result.current.mutate(
      new File(["image"], "diagram.png", { type: "image/png" })
    );

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockApiClient.delete).toHaveBeenCalledWith(
      "/documents/doc-1/attachments/attachment-1"
    );
  });

  test("cleans up the created attachment row when the signed PUT is non-ok", async () => {
    mockApiClient.post.mockResolvedValueOnce({
      attachmentId: "attachment-1",
      uploadUrl: "https://storage.example.com/upload/attachment-1",
      key: "attachments/doc-1/object",
    });
    mockApiClient.delete.mockResolvedValueOnce({ deleted: true });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 403 })
    );

    const { result } = renderHook(() => useUploadInlineImage("doc-1"), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    result.current.mutate(
      new File(["image"], "diagram.png", { type: "image/png" })
    );

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockApiClient.delete).toHaveBeenCalledWith(
      "/documents/doc-1/attachments/attachment-1"
    );
  });

  test("surfaces the API upload failure without attempting a cleanup", async () => {
    mockApiClient.post.mockRejectedValueOnce(
      Object.assign(new Error("FILE_ATTACHMENTS_BUCKET is not configured"), {
        status: 500,
      })
    );

    const { result } = renderHook(() => useUploadInlineImage("doc-1"), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    result.current.mutate(
      new File(["image"], "diagram.png", { type: "image/png" })
    );

    await waitFor(() => expect(result.current.isError).toBe(true));

    // The attachment row was never created, so there is nothing to clean up.
    expect(mockApiClient.delete).not.toHaveBeenCalled();
  });

  test("reports the upload failure even when the cleanup delete itself fails", async () => {
    mockApiClient.post.mockResolvedValueOnce({
      attachmentId: "attachment-1",
      uploadUrl: "https://storage.example.com/upload/attachment-1",
      key: "attachments/doc-1/object",
    });
    mockApiClient.delete.mockRejectedValueOnce(new Error("delete failed"));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 403 })
    );

    const { result } = renderHook(() => useUploadInlineImage("doc-1"), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    result.current.mutate(
      new File(["image"], "diagram.png", { type: "image/png" })
    );

    await waitFor(() => expect(result.current.isError).toBe(true));

    // The upload failure is what the caller must see — a failed best-effort
    // cleanup must not replace it. The message is the toast text, so it is
    // asserted verbatim.
    expect(result.current.error).toEqual(
      new Error("Couldn't upload the image. Try again.")
    );
  });
});

describe("useResolveInlineImages", () => {
  test("returns the resolved images and the skipped entries", async () => {
    mockApiClient.post.mockResolvedValueOnce({
      images: [
        {
          attachmentId: "attachment-1",
          expiresAt: "2026-06-12T00:00:00.000Z",
          filename: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 5,
          url: "https://storage.example.com/download/attachment-1",
        },
      ],
      skipped: [
        {
          attachmentId: "attachment-2",
          reason: InlineImageResolveSkipReason.NotFound,
        },
      ],
    });

    const { result } = renderHook(() => useResolveInlineImages("doc-1"), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    result.current.mutate(["attachment-1", "attachment-2"]);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/documents/doc-1/attachments/resolve",
      { attachmentIds: ["attachment-1", "attachment-2"] }
    );
    expect(result.current.data?.images).toHaveLength(1);
    expect(result.current.data?.skipped).toEqual([
      {
        attachmentId: "attachment-2",
        reason: InlineImageResolveSkipReason.NotFound,
      },
    ]);
  });
});
