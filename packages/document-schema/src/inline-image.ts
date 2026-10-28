import {
  type JSONContent,
  type MarkdownToken,
  mergeAttributes,
  Node,
} from "@tiptap/core";
import {
  formatInlineImageLayoutTitle,
  type InlineImageLayout,
  parseInlineImageLayout,
  parseInlineImageLayoutTitle,
  parseInlineImageWidth,
} from "./inline-image-layout";

export const ATTACHMENT_IMAGE_SRC_REGEX = /^attachment:\/\/([0-9a-fA-F-]{36})$/;

/**
 * DOM attribute the stored `attachment://` ref serializes to. It is deliberately
 * NOT `src`: `renderHTML` feeds ProseMirror's DOM serializer (clipboard, drag,
 * `getHTML`), which builds real elements, and a `src` the browser cannot fetch
 * is a CSP `img-src` violation rather than a picture (ISS-8387).
 */
const INLINE_IMAGE_REF_ATTRIBUTE = "data-inline-image";

const INLINE_IMAGE_WIDTH_ATTRIBUTE = "data-width";
const INLINE_IMAGE_LAYOUT_ATTRIBUTE = "data-layout";

export type InlineImageAttrs = {
  src?: string | null;
  alt?: string | null;
  width?: number | null;
  layout?: InlineImageLayout | null;
};

export function getAttachmentId(src: unknown): string | null {
  if (typeof src !== "string") {
    return null;
  }
  return ATTACHMENT_IMAGE_SRC_REGEX.exec(src)?.[1] ?? null;
}

function escapeMarkdownText(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

declare module "@tiptap/core" {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Tiptap command augmentation requires interface merging
  interface Commands<ReturnType> {
    inlineImage: {
      setInlineImage: (attrs: InlineImageAttrs) => ReturnType;
    };
  }
}

/**
 * The `inlineImage` node without a node view. The editor adds its React view
 * with `InlineImageNode.extend({ addNodeView })`.
 */
export const InlineImageNode = Node.create({
  name: "inlineImage",

  group: "inline",

  inline: true,

  atom: true,

  addAttributes() {
    return {
      src: {
        default: null,
        // Read per-attribute rather than per-rule, so the ref survives whichever
        // tag rule below matched. The ordering is load-bearing on a legacy
        // `<img>` that also carries the new attribute: the attribute wins, and
        // whatever it holds is still only a candidate — `getAttachmentId` is the
        // gate every consumer passes through.
        parseHTML: (element: HTMLElement) =>
          element.getAttribute(INLINE_IMAGE_REF_ATTRIBUTE) ??
          element.getAttribute("src"),
        renderHTML: (attributes: InlineImageAttrs) =>
          attributes.src
            ? { [INLINE_IMAGE_REF_ATTRIBUTE]: attributes.src }
            : {},
      },
      alt: { default: null },
      width: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          parseInlineImageWidth(
            element.getAttribute(INLINE_IMAGE_WIDTH_ATTRIBUTE)
          ),
        renderHTML: (attributes: InlineImageAttrs) => {
          const width = parseInlineImageWidth(attributes.width);
          return width === null
            ? {}
            : { [INLINE_IMAGE_WIDTH_ATTRIBUTE]: String(width) };
        },
      },
      layout: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          parseInlineImageLayout(
            element.getAttribute(INLINE_IMAGE_LAYOUT_ATTRIBUTE)
          ),
        renderHTML: (attributes: InlineImageAttrs) => {
          const layout = parseInlineImageLayout(attributes.layout);
          return layout ? { [INLINE_IMAGE_LAYOUT_ATTRIBUTE]: layout } : {};
        },
      },
    };
  },

  parseHTML() {
    return [
      { tag: `span[${INLINE_IMAGE_REF_ATTRIBUTE}]` },
      // Compatibility: every ref serialized before ISS-8387 — including a
      // clipboard payload cut by an older tab — still arrives as an `<img>`.
      { tag: "img[src^='attachment://']" },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes)];
  },

  addCommands() {
    return {
      setInlineImage:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },

  markdownTokenName: "image",

  parseMarkdown(token: MarkdownToken, helpers) {
    const src = typeof token.href === "string" ? token.href : "";
    const alt = typeof token.text === "string" ? token.text : "";
    if (!getAttachmentId(src)) {
      return helpers.createTextNode(`![${alt}](${src})`);
    }
    return helpers.createNode("inlineImage", {
      alt,
      src,
      ...parseInlineImageLayoutTitle(token.title),
    });
  },

  renderMarkdown(node: JSONContent) {
    const attrs = (node.attrs ?? {}) as InlineImageAttrs;
    if (!getAttachmentId(attrs.src)) {
      return "";
    }
    const alt = escapeMarkdownText(attrs.alt ?? "");
    const title = formatInlineImageLayoutTitle(attrs);
    return title
      ? `![${alt}](${attrs.src} "${title}")`
      : `![${alt}](${attrs.src})`;
  },
});
