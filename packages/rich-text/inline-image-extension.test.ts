import { describe, expect, it, vi } from "vitest";
import { resolveInlineImageWithBatch } from "./inline-image-extension";

const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_ATTACHMENT_ID = "00000000-0000-4000-8000-000000000002";

describe("InlineImageExtension", () => {
  it("batches same-tick inline image resolution for one resolver", async () => {
    const resolveInlineImages = vi.fn().mockResolvedValue({
      images: [
        {
          attachmentId: ATTACHMENT_ID,
          expiresAt: "2026-06-12T08:00:00.000Z",
          filename: "first.png",
          mimeType: "image/png",
          sizeBytes: 10,
          url: "https://example.com/first.png",
        },
        {
          attachmentId: SECOND_ATTACHMENT_ID,
          expiresAt: "2026-06-12T08:00:00.000Z",
          filename: "second.png",
          mimeType: "image/png",
          sizeBytes: 20,
          url: "https://example.com/second.png",
        },
      ],
    });

    const [first, second] = await Promise.all([
      resolveInlineImageWithBatch(resolveInlineImages, ATTACHMENT_ID),
      resolveInlineImageWithBatch(resolveInlineImages, SECOND_ATTACHMENT_ID),
    ]);

    expect(resolveInlineImages).toHaveBeenCalledTimes(1);
    expect(resolveInlineImages).toHaveBeenCalledWith([
      ATTACHMENT_ID,
      SECOND_ATTACHMENT_ID,
    ]);
    expect(first?.filename).toBe("first.png");
    expect(second?.filename).toBe("second.png");
  });
});
