import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGetDocument } from "../tools/get-document.js";
import {
  createToolHarness,
  parseToolPayload,
} from "./fixtures/tool-harness.js";

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  },
}));

const DOCUMENT_ID = "019c2991-0bce-76bc-bc7e-a4750929f668";
const FIRST_ATTACHMENT_ID = "00000000-0000-0000-0000-000000000001";
const SECOND_ATTACHMENT_ID = "00000000-0000-0000-0000-000000000002";
const FIRST_URL = "https://x/1.png";
const SECOND_URL = "https://x/2.png";
const MAX_IMAGE_BLOCK_BYTES = 2 * 1024 * 1024;

function resolvedImage(attachmentId: string, url: string, sizeBytes = 10) {
  return {
    attachmentId,
    url,
    filename: "img.png",
    mimeType: "image/png",
    sizeBytes,
    expiresAt: "2026-12-01T00:00:00.000Z",
  };
}

function makeHandler(content: string, images: unknown[]) {
  const get = vi.fn().mockResolvedValue({
    id: DOCUMENT_ID,
    slug: "ISS-1",
    version: { content },
  });
  const post = vi.fn().mockResolvedValue({ images, skipped: [] });
  const handler = createToolHarness(registerGetDocument, {
    get,
    post,
  } as never);
  return { handler, get, post };
}

type Payload = {
  contentWithResolvedInlineImages?: string;
  inlineImageBlockSkips?: Array<{ attachmentId: string; reason: string }>;
};

describe("get-document resolved-content truncation", () => {
  it("cuts at the char budget when the only image token past a complete one starts beyond it", async () => {
    const source = `![a](attachment://${FIRST_ATTACHMENT_ID}) filler ![b](attachment://${SECOND_ATTACHMENT_ID})`;
    const { handler } = makeHandler(source, [
      resolvedImage(FIRST_ATTACHMENT_ID, FIRST_URL),
      resolvedImage(SECOND_ATTACHMENT_ID, SECOND_URL),
    ]);
    const resolved = `![a](${FIRST_URL}) filler ![b](${SECOND_URL})`;
    // First token ends at 21 (<= 25, loop continues); second starts at 29
    // (>= 25, loop breaks), so the cut stays at the raw budget.
    const budget = 25;

    const payload = parseToolPayload(
      await handler({
        documentId: "ISS-1",
        includeContent: true,
        includeParentArtifact: false,
        contentMaxChars: budget,
      })
    ) as Payload;

    expect(payload.contentWithResolvedInlineImages).toBe(
      `${resolved.slice(0, budget)}...[truncated]`
    );
  });
});

describe("get-document resolved-content truncation boundaries", () => {
  const source = `![a](attachment://${FIRST_ATTACHMENT_ID}) tail`;
  const resolvedToken = `![a](${FIRST_URL})`;

  async function resolvedContent(budget: number) {
    const { handler } = makeHandler(source, [
      resolvedImage(FIRST_ATTACHMENT_ID, FIRST_URL),
    ]);
    const payload = parseToolPayload(
      await handler({
        documentId: "ISS-1",
        includeContent: true,
        includeParentArtifact: false,
        contentMaxChars: budget,
      })
    ) as Payload;
    return payload.contentWithResolvedInlineImages;
  }

  it("returns resolved content untouched when it is exactly the budget", async () => {
    const resolved = `${resolvedToken} tail`;

    expect(await resolvedContent(resolved.length)).toBe(resolved);
  });

  it("keeps an image token that ends exactly at the budget", async () => {
    expect(await resolvedContent(resolvedToken.length)).toBe(
      `${resolvedToken}...[truncated]`
    );
  });
});

describe("get-document inline image blocks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips an image whose fetched bytes exceed the per-image cap even though its declared size fit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array(MAX_IMAGE_BLOCK_BYTES + 1))
      );
    vi.stubGlobal("fetch", fetchMock);
    const { handler } = makeHandler(
      `![a](attachment://${FIRST_ATTACHMENT_ID})`,
      [resolvedImage(FIRST_ATTACHMENT_ID, FIRST_URL)]
    );

    const result = await handler({
      documentId: "ISS-1",
      includeContent: true,
      includeImages: true,
      includeParentArtifact: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.content.filter((block) => block.type !== "text")).toEqual([]);
    const payload = parseToolPayload(result) as Payload;
    expect(payload.inlineImageBlockSkips).toEqual([
      {
        attachmentId: FIRST_ATTACHMENT_ID,
        status: "skipped",
        reason: "image_block_too_large",
      },
    ]);
  });

  it("reports a non-OK fetch as a fetch failure with a trimmed status line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    );
    const { handler } = makeHandler(
      `![a](attachment://${FIRST_ATTACHMENT_ID})`,
      [resolvedImage(FIRST_ATTACHMENT_ID, FIRST_URL)]
    );

    const payload = parseToolPayload(
      await handler({
        documentId: "ISS-1",
        includeContent: true,
        includeImages: true,
        includeParentArtifact: false,
      })
    ) as Payload;

    expect(payload.inlineImageBlockSkips?.[0]?.reason).toBe(
      "image_block_fetch_failed"
    );
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining(": HTTP 500. ")
    );
  });

  it("records a fetch failure and stringifies a non-Error rejection into the warning", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("socket hang up"));
    const { handler } = makeHandler(
      `![a](attachment://${FIRST_ATTACHMENT_ID})`,
      [resolvedImage(FIRST_ATTACHMENT_ID, FIRST_URL)]
    );

    const payload = parseToolPayload(
      await handler({
        documentId: "ISS-1",
        includeContent: true,
        includeImages: true,
        includeParentArtifact: false,
      })
    ) as Payload;

    expect(payload.inlineImageBlockSkips).toEqual([
      {
        attachmentId: FIRST_ATTACHMENT_ID,
        status: "skipped",
        reason: "image_block_fetch_failed",
      },
    ]);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining(": socket hang up.")
    );
  });
});
