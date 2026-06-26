import { describe, expect, it, vi } from "vitest";
import {
  InlineImageExtension,
  resolveInlineImageWithBatch,
} from "./inline-image-extension";

const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_ATTACHMENT_ID = "00000000-0000-4000-8000-000000000002";

type ParseMarkdownForTest = (
  token: Record<string, unknown>,
  helpers: unknown
) => unknown;

type RenderMarkdownForTest = (node: unknown) => string;

function makeExtension() {
  return InlineImageExtension.configure({ enabled: true });
}

describe("InlineImageExtension", () => {
  it("registers only durable src and alt attrs", () => {
    const extension = makeExtension();
    const addAttributes = extension.config.addAttributes as
      | (() => Record<string, unknown>)
      | undefined;
    const attrs = addAttributes?.();

    expect(Object.keys(attrs ?? {})).toEqual(["src", "alt"]);
  });

  it("parses and serializes attachment refs without transient upload attrs", () => {
    const extension = makeExtension();
    const helpers = {
      createNode: vi.fn((type: string, attrs: Record<string, unknown>) => ({
        type,
        attrs,
      })),
      createTextNode: vi.fn((text: string) => ({ type: "text", text })),
    };

    const parseMarkdown = extension.config
      .parseMarkdown as unknown as ParseMarkdownForTest;
    const renderMarkdown = extension.config
      .renderMarkdown as unknown as RenderMarkdownForTest;

    const parsed = parseMarkdown(
      {
        href: `attachment://${ATTACHMENT_ID}`,
        text: "Architecture",
        title: "ignored",
      },
      helpers
    );

    expect(parsed).toEqual({
      type: "inlineImage",
      attrs: {
        alt: "Architecture",
        src: `attachment://${ATTACHMENT_ID}`,
      },
    });
    expect(renderMarkdown(parsed)).toBe(
      `![Architecture](attachment://${ATTACHMENT_ID})`
    );
  });

  it("keeps external image markdown out of document inline image nodes", () => {
    const extension = makeExtension();
    const helpers = {
      createNode: vi.fn(),
      createTextNode: vi.fn((text: string) => ({ type: "text", text })),
    };

    const parseMarkdown = extension.config
      .parseMarkdown as unknown as ParseMarkdownForTest;
    const parsed = parseMarkdown(
      { href: "https://example.com/image.png", text: "external" },
      helpers
    );

    expect(helpers.createNode).not.toHaveBeenCalled();
    expect(parsed).toEqual({
      type: "text",
      text: "![external](https://example.com/image.png)",
    });
  });

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
