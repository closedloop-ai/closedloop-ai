import { describe, expect, it, vi } from "vitest";
import { InlineImageNode } from "../inline-image";
import { InlineImageLayout } from "../inline-image-layout";
import { parseHtml, serializeHtml } from "./fixtures/schema-dom";

const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000001";

type ParseMarkdownForTest = (
  token: Record<string, unknown>,
  helpers: unknown
) => unknown;

type RenderMarkdownForTest = (node: unknown) => string;

function makeExtension() {
  return InlineImageNode.configure({});
}

describe("InlineImageNode", () => {
  // Width and layout joined src/alt as durable attrs with the image layout
  // controls; transient upload state still must not become a node attr.
  it("registers only durable src, alt, width, and layout attrs", () => {
    const extension = makeExtension();
    const addAttributes = extension.config.addAttributes as
      | (() => Record<string, unknown>)
      | undefined;
    const attrs = addAttributes?.();

    expect(Object.keys(attrs ?? {})).toEqual(["src", "alt", "width", "layout"]);
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
        width: null,
        layout: null,
      },
    });
    expect(renderMarkdown(parsed)).toBe(
      `![Architecture](attachment://${ATTACHMENT_ID})`
    );
  });

  it("round-trips width and layout through the markdown image title", () => {
    const extension = makeExtension();
    const helpers = {
      createNode: vi.fn((type: string, attrs: Record<string, unknown>) => ({
        type,
        attrs,
      })),
      createTextNode: vi.fn(),
    };
    const parseMarkdown = extension.config
      .parseMarkdown as unknown as ParseMarkdownForTest;
    const renderMarkdown = extension.config
      .renderMarkdown as unknown as RenderMarkdownForTest;

    const parsed = parseMarkdown(
      {
        href: `attachment://${ATTACHMENT_ID}`,
        text: "Card",
        title: "width=480 align=right",
      },
      helpers
    );

    expect(parsed).toEqual({
      type: "inlineImage",
      attrs: {
        alt: "Card",
        src: `attachment://${ATTACHMENT_ID}`,
        width: 480,
        layout: InlineImageLayout.WrapRight,
      },
    });
    expect(renderMarkdown(parsed)).toBe(
      `![Card](attachment://${ATTACHMENT_ID} "width=480 align=right")`
    );
  });

  it("drops an invalid stored width instead of serializing it", () => {
    const renderMarkdown = makeExtension().config
      .renderMarkdown as unknown as RenderMarkdownForTest;

    expect(
      renderMarkdown({
        type: "inlineImage",
        attrs: {
          alt: "Card",
          src: `attachment://${ATTACHMENT_ID}`,
          width: -20,
          layout: InlineImageLayout.Center,
        },
      })
    ).toBe(`![Card](attachment://${ATTACHMENT_ID} "align=center")`);
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
});

describe("InlineImageNode markdown and HTML edges", () => {
  function markdownHandlers() {
    const extension = makeExtension();
    return {
      parseMarkdown: extension.config
        .parseMarkdown as unknown as ParseMarkdownForTest,
      renderMarkdown: extension.config
        .renderMarkdown as unknown as RenderMarkdownForTest,
    };
  }

  it("degrades a token with non-string href and text to empty image markdown text", () => {
    const { parseMarkdown } = markdownHandlers();
    const helpers = {
      createNode: vi.fn(),
      createTextNode: vi.fn((text: string) => ({ type: "text", text })),
    };

    const parsed = parseMarkdown({ href: 42, text: null }, helpers);

    expect(helpers.createNode).not.toHaveBeenCalled();
    expect(parsed).toEqual({ type: "text", text: "![]()" });
  });

  it("serializes nothing for a node without attrs", () => {
    const { renderMarkdown } = markdownHandlers();

    expect(renderMarkdown({ type: "inlineImage" })).toBe("");
  });

  it("serializes a null alt as empty alt text", () => {
    const { renderMarkdown } = markdownHandlers();

    expect(
      renderMarkdown({
        type: "inlineImage",
        attrs: { src: `attachment://${ATTACHMENT_ID}`, alt: null },
      })
    ).toBe(`![](attachment://${ATTACHMENT_ID})`);
  });

  it("renders no ref attribute when src is empty", () => {
    const addAttributes = makeExtension().config.addAttributes as () => {
      src: { renderHTML: (attrs: { src: string | null }) => object };
    };
    const { src } = addAttributes();

    expect(src.renderHTML({ src: null })).toEqual({});
    expect(
      Object.values(src.renderHTML({ src: `attachment://${ATTACHMENT_ID}` }))
    ).toEqual([`attachment://${ATTACHMENT_ID}`]);
  });

  it("round-trips a valid width and layout through HTML attributes", () => {
    const html = `<p><span data-inline-image="attachment://${ATTACHMENT_ID}" data-width="480" data-layout="${InlineImageLayout.WrapRight}"></span></p>`;
    const doc = parseHtml(html);

    expect(doc.firstChild?.firstChild?.attrs).toEqual({
      src: `attachment://${ATTACHMENT_ID}`,
      alt: null,
      width: 480,
      layout: InlineImageLayout.WrapRight,
    });
    expect(serializeHtml(doc)).toBe(html);
  });

  it("drops an invalid width and layout from HTML attributes", () => {
    const doc = parseHtml(
      `<p><span data-inline-image="attachment://${ATTACHMENT_ID}" data-width="-20" data-layout="sideways"></span></p>`
    );

    expect(doc.firstChild?.firstChild?.attrs).toMatchObject({
      width: null,
      layout: null,
    });
    expect(serializeHtml(doc)).toBe(
      `<p><span data-inline-image="attachment://${ATTACHMENT_ID}"></span></p>`
    );
  });
});
