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
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
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
    expect(warnSpy).toHaveBeenCalledWith(
      "[inline-document-images] signed upload PUT failed",
      expect.objectContaining({
        attachmentId: "attachment-1",
        documentId: "doc-1",
        mimeType: "image/png",
        purpose: "inline",
        reason: "put_exception",
        sizeBytes: 5,
      })
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("Network failed");
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(
      "storage.example.com"
    );
  });

  test("logs signed PUT non-ok status and cleanup outcome without storage details", async () => {
    const infoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
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

    expect(warnSpy).toHaveBeenCalledWith(
      "[inline-document-images] signed upload PUT failed",
      expect.objectContaining({
        attachmentId: "attachment-1",
        documentId: "doc-1",
        mimeType: "image/png",
        purpose: "inline",
        reason: "put_non_ok",
        sizeBytes: 5,
        statusCode: 403,
      })
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "[inline-document-images] cleanup attempted",
      expect.objectContaining({
        attachmentId: "attachment-1",
        documentId: "doc-1",
        purpose: "inline",
        reason: "put_non_ok",
      })
    );
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(
      "storage.example.com"
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(
      "attachments/doc-1/object"
    );
  });

  test("logs API upload failures with stable reason and status only", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
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

    expect(warnSpy).toHaveBeenCalledWith(
      "[inline-document-images] upload request failed",
      expect.objectContaining({
        documentId: "doc-1",
        mimeType: "image/png",
        purpose: "inline",
        reason: "api_request_failed",
        sizeBytes: 5,
        statusCode: 500,
      })
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(
      "FILE_ATTACHMENTS_BUCKET"
    );
  });
});

describe("useResolveInlineImages", () => {
  test("logs resolve result counts and skip reasons", async () => {
    const infoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
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

    expect(infoSpy).toHaveBeenCalledWith(
      "[inline-document-images] resolve request completed",
      expect.objectContaining({
        documentId: "doc-1",
        requestedCount: 2,
        resolvedCount: 1,
        skippedCount: 1,
        skipReasonCounts: { [InlineImageResolveSkipReason.NotFound]: 1 },
      })
    );
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(
      "storage.example.com"
    );
  });
});
