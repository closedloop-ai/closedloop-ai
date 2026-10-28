import {
  AttachmentPurpose,
  AttachmentPurposeSelector,
  type FileAttachment,
  InlineImageResolveSkipReason,
  MAX_INLINE_IMAGE_RESOLVE_BATCH_SIZE,
} from "@repo/api/src/types/attachment";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  attachmentKeys,
  attachmentsListQueryOptions,
  useDocumentAttachments,
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

  test("sends a single request when the ref count is exactly the API cap", async () => {
    mockApiClient.post.mockResolvedValue({ images: [], skipped: [] });
    const ids = buildAttachmentIds(MAX_INLINE_IMAGE_RESOLVE_BATCH_SIZE);

    const { result } = renderHook(() => useResolveInlineImages("doc-1"), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    result.current.mutate(ids);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledTimes(1);
    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/documents/doc-1/attachments/resolve",
      { attachmentIds: ids }
    );
  });

  test("splits one past the cap into two requests and merges both", async () => {
    const ids = buildAttachmentIds(MAX_INLINE_IMAGE_RESOLVE_BATCH_SIZE + 1);
    mockApiClient.post
      .mockResolvedValueOnce({ images: [resolvedImage(ids[0])], skipped: [] })
      .mockResolvedValueOnce({
        images: [],
        skipped: [
          {
            attachmentId: ids.at(-1),
            reason: InlineImageResolveSkipReason.NotFound,
          },
        ],
      });

    const { result } = renderHook(() => useResolveInlineImages("doc-1"), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    result.current.mutate(ids);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledTimes(2);
    expect(mockApiClient.post).toHaveBeenNthCalledWith(
      1,
      "/documents/doc-1/attachments/resolve",
      { attachmentIds: ids.slice(0, MAX_INLINE_IMAGE_RESOLVE_BATCH_SIZE) }
    );
    expect(mockApiClient.post).toHaveBeenNthCalledWith(
      2,
      "/documents/doc-1/attachments/resolve",
      { attachmentIds: [ids.at(-1)] }
    );
    // Every request stays inside the cap the endpoint validates against, so no
    // chunk can come back a 400 that takes the whole document's images down.
    for (const [, body] of mockApiClient.post.mock.calls) {
      expect(
        (body as { attachmentIds: string[] }).attachmentIds.length
      ).toBeLessThanOrEqual(MAX_INLINE_IMAGE_RESOLVE_BATCH_SIZE);
    }
    expect(result.current.data?.images).toEqual([resolvedImage(ids[0])]);
    expect(result.current.data?.skipped).toEqual([
      {
        attachmentId: ids.at(-1),
        reason: InlineImageResolveSkipReason.NotFound,
      },
    ]);
  });

  test("keeps the surviving chunk's images when a sibling chunk fails", async () => {
    const ids = buildAttachmentIds(MAX_INLINE_IMAGE_RESOLVE_BATCH_SIZE + 1);
    mockApiClient.post
      .mockResolvedValueOnce({ images: [resolvedImage(ids[0])], skipped: [] })
      .mockRejectedValueOnce(new Error("resolve chunk failed"));

    const { result } = renderHook(() => useResolveInlineImages("doc-1"), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    result.current.mutate(ids);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.images).toEqual([resolvedImage(ids[0])]);
    // The failed chunk contributes no entry at all, which is what makes its
    // refs read as unavailable rather than as a permanent load.
    expect(result.current.data?.skipped).toEqual([]);
  });

  test("rejects when every chunk fails", async () => {
    const ids = buildAttachmentIds(MAX_INLINE_IMAGE_RESOLVE_BATCH_SIZE + 1);
    mockApiClient.post
      .mockRejectedValueOnce(new Error("resolve chunk failed"))
      .mockRejectedValueOnce(new Error("second chunk failed"));

    const { result } = renderHook(() => useResolveInlineImages("doc-1"), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    result.current.mutate(ids);

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toEqual(new Error("resolve chunk failed"));
  });
});

describe("useDocumentAttachments", () => {
  const DOCUMENT_ID = "doc-1";

  test("hidden Details retains its attachment cache without refetching until shown", async () => {
    const client = createTestQueryClient();
    mockApiClient.get.mockResolvedValue([]);
    const { result, rerender } = renderHook(
      ({ enabled }) => useDocumentAttachments(DOCUMENT_ID, { enabled }),
      {
        initialProps: { enabled: false },
        wrapper: createWrapperWithClient(client),
      }
    );
    expect(mockApiClient.get).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(mockApiClient.get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.isPending).toBe(false));
    rerender({ enabled: false });
    await act(async () => {
      await client.invalidateQueries({
        queryKey: attachmentKeys.list(DOCUMENT_ID),
      });
    });
    expect(mockApiClient.get).toHaveBeenCalledTimes(2);
    expect(result.current.data).toEqual([]);
    rerender({ enabled: true });
    await waitFor(() => expect(mockApiClient.get).toHaveBeenCalledTimes(4));
  });

  function contextRow(overrides: Partial<FileAttachment> = {}): FileAttachment {
    return {
      id: "ctx-1",
      artifactId: DOCUMENT_ID,
      createdAt: "2026-08-02T00:00:00.000Z",
      createdById: "user-1",
      filename: "spec.pdf",
      mimeType: "application/pdf",
      purpose: AttachmentPurpose.Context,
      sizeBytes: 10,
      ...overrides,
    };
  }

  function inlineRow(overrides: Partial<FileAttachment> = {}): FileAttachment {
    return contextRow({
      id: "inl-1",
      createdAt: "2026-08-01T00:00:00.000Z",
      filename: "shot.png",
      mimeType: "image/png",
      purpose: AttachmentPurpose.Inline,
      ...overrides,
    });
  }

  function renderComposite() {
    return renderHook(() => useDocumentAttachments(DOCUMENT_ID), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });
  }

  function respondByPurpose(
    rows: Partial<Record<AttachmentPurposeSelector, FileAttachment[]>>
  ) {
    mockApiClient.get.mockImplementation((url: string) => {
      const purpose = new URL(url, "https://example.test").searchParams.get(
        "purpose"
      ) as AttachmentPurposeSelector;
      return Promise.resolve(rows[purpose] ?? []);
    });
  }

  test("requests each purpose as an explicit query param", async () => {
    respondByPurpose({});

    const { result } = renderComposite();
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(mockApiClient.get).toHaveBeenCalledWith(
      `/documents/${DOCUMENT_ID}/attachments?purpose=context`
    );
    expect(mockApiClient.get).toHaveBeenCalledWith(
      `/documents/${DOCUMENT_ID}/attachments?purpose=inline`
    );
  });

  test("keys the two purposes separately so neither serves the other's cache", () => {
    // Sharing one entry is how a `context`-only response gets handed back for an
    // `inline` read: the URL differs but the cache lookup would not.
    expect(
      attachmentsListQueryOptions(
        mockApiClient as never,
        DOCUMENT_ID,
        AttachmentPurposeSelector.Context
      ).queryKey
    ).not.toEqual(
      attachmentsListQueryOptions(
        mockApiClient as never,
        DOCUMENT_ID,
        AttachmentPurposeSelector.Inline
      ).queryKey
    );
  });

  test("keeps every list key under the prefix the invalidations use", () => {
    // All four `invalidateQueries({ queryKey: attachmentKeys.list(id) })` call
    // sites rely on prefix matching; a sibling key would silently stop being
    // invalidated after an upload or delete.
    expect(
      attachmentsListQueryOptions(
        mockApiClient as never,
        DOCUMENT_ID,
        AttachmentPurposeSelector.Inline
      ).queryKey.slice(0, 3)
    ).toEqual(attachmentKeys.list(DOCUMENT_ID));
  });

  test("merges both legs newest first, breaking createdAt ties on id", async () => {
    const sameInstant = "2026-08-03T00:00:00.000Z";
    respondByPurpose({
      [AttachmentPurposeSelector.Context]: [
        contextRow({ id: "b-tie", createdAt: sameInstant }),
        contextRow({ id: "older", createdAt: "2026-08-01T00:00:00.000Z" }),
      ],
      [AttachmentPurposeSelector.Inline]: [
        inlineRow({ id: "a-tie", createdAt: sameInstant }),
      ],
    });

    const { result } = renderComposite();
    await waitFor(() => expect(result.current.data).toHaveLength(3));

    // The service orders on createdAt alone, so without the id tie-break the two
    // same-instant rows could come back in either order.
    expect(result.current.data.map((row) => row.id)).toEqual([
      "a-tie",
      "b-tie",
      "older",
    ]);
  });

  test("keeps the context rows when only the inline leg fails", async () => {
    mockApiClient.get.mockImplementation((url: string) =>
      url.endsWith("purpose=inline")
        ? Promise.reject(new Error("boom"))
        : Promise.resolve([contextRow()])
    );

    const { result } = renderComposite();
    await waitFor(() => expect(result.current.isError).toBe(true));

    // Degrades to exactly today's surface: context rows alone.
    expect(result.current.data.map((row) => row.id)).toEqual(["ctx-1"]);
  });

  /**
   * Primes both legs so each query HOLDS data, then fails one refetch. A query
   * keeps its last successful `data` when a refetch fails and only flips
   * `isError`, so this is the state a `data`-only combine reads straight past —
   * the cold-failure cases above never reach it, because there is nothing
   * cached to serve.
   */
  async function primeThenFailRefetch(
    failingPurpose: AttachmentPurposeSelector
  ) {
    const client = createTestQueryClient();
    respondByPurpose({
      [AttachmentPurposeSelector.Context]: [contextRow()],
      [AttachmentPurposeSelector.Inline]: [inlineRow()],
    });

    const { result } = renderHook(() => useDocumentAttachments(DOCUMENT_ID), {
      wrapper: createWrapperWithClient(client),
    });
    await waitFor(() => expect(result.current.data).toHaveLength(2));

    mockApiClient.get.mockImplementation((url: string) =>
      url.endsWith(`purpose=${failingPurpose}`)
        ? Promise.reject(new Error("boom"))
        : Promise.resolve(
            failingPurpose === AttachmentPurposeSelector.Context
              ? [inlineRow()]
              : [contextRow()]
          )
    );
    await act(async () => {
      await client.invalidateQueries({
        queryKey: attachmentKeys.list(DOCUMENT_ID),
      });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    return result;
  }

  test("returns nothing when an already-populated context refetch fails", async () => {
    const result = await primeThenFailRefetch(
      AttachmentPurposeSelector.Context
    );

    // Same contract as the cold context failure: serving the retained rows here
    // would hand back a context list the failed read can no longer vouch for.
    expect(result.current.data).toEqual([]);
  });

  test("drops the inline rows when an already-populated inline refetch fails", async () => {
    const result = await primeThenFailRefetch(AttachmentPurposeSelector.Inline);

    // Degrades to today's surface — context rows alone — rather than keeping
    // stale inline rows a user could act on, including by deleting one.
    expect(result.current.data.map((row) => row.id)).toEqual(["ctx-1"]);
  });

  test("returns nothing when the context leg fails, even if inline succeeded", async () => {
    mockApiClient.get.mockImplementation((url: string) =>
      url.endsWith("purpose=context")
        ? Promise.reject(new Error("boom"))
        : Promise.resolve([inlineRow()])
    );

    const { result } = renderComposite();
    await waitFor(() => expect(result.current.isError).toBe(true));

    // Rendering the inline leg alone would show a populated panel with every
    // user-added context attachment silently missing, and a failed list fetch
    // raises no toast — so inline rows are additive to a successful context read.
    expect(result.current.data).toEqual([]);
  });
});
function buildAttachmentIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `attachment-${index}`);
}

function resolvedImage(attachmentId: string) {
  return {
    attachmentId,
    expiresAt: "2026-06-12T00:00:00.000Z",
    filename: `${attachmentId}.png`,
    mimeType: "image/png",
    sizeBytes: 5,
    url: `https://storage.example.com/download/${attachmentId}`,
  };
}
