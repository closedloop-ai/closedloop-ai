/**
 * How an inline image sits relative to the surrounding text. `Inline` is the
 * pre-existing behavior and is what a node with no stored layout renders as.
 */
export const InlineImageLayout = {
  Inline: "inline",
  WrapLeft: "wrap-left",
  Center: "center",
  WrapRight: "wrap-right",
} as const;
export type InlineImageLayout =
  (typeof InlineImageLayout)[keyof typeof InlineImageLayout];

export const MIN_INLINE_IMAGE_WIDTH = 48;
export const MAX_INLINE_IMAGE_WIDTH = 4096;

export type InlineImageLayoutAttrs = {
  width: number | null;
  layout: InlineImageLayout | null;
};

/**
 * Layout is persisted in the Markdown image title (`![alt](attachment://id
 * "width=480 align=left")`) because documents are stored as Markdown and the
 * shared ref regex in `@repo/loops-api/attachment` already accepts an optional
 * title, so MCP rewriting and attachment-visibility keep matching the token.
 */
const ALIGN_BY_LAYOUT: Record<InlineImageLayout, string | null> = {
  [InlineImageLayout.Inline]: null,
  [InlineImageLayout.WrapLeft]: "left",
  [InlineImageLayout.Center]: "center",
  [InlineImageLayout.WrapRight]: "right",
};

const LAYOUT_BY_ALIGN = new Map<string, InlineImageLayout>(
  Object.values(InlineImageLayout).flatMap((layout) => {
    const align = ALIGN_BY_LAYOUT[layout];
    return align ? [[align, layout] as const] : [];
  })
);

const WIDTH_VALUE_REGEX = /^\d+$/;
const TITLE_TOKEN_SEPARATOR_REGEX = /\s+/;

export function parseInlineImageWidth(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !WIDTH_VALUE_REGEX.test(text)) {
    return null;
  }
  const width = Number(text);
  return isValidInlineImageWidth(width) ? width : null;
}

export function parseInlineImageLayout(
  value: unknown
): InlineImageLayout | null {
  return (
    Object.values(InlineImageLayout).find((layout) => layout === value) ?? null
  );
}

export function parseInlineImageLayoutTitle(
  title: unknown
): InlineImageLayoutAttrs {
  const attrs: InlineImageLayoutAttrs = { width: null, layout: null };
  if (typeof title !== "string") {
    return attrs;
  }
  for (const token of title.trim().split(TITLE_TOKEN_SEPARATOR_REGEX)) {
    const [key, value] = token.split("=");
    if (key === "width") {
      attrs.width = parseInlineImageWidth(value);
    } else if (key === "align") {
      attrs.layout = LAYOUT_BY_ALIGN.get(value ?? "") ?? null;
    }
  }
  return attrs;
}

export function formatInlineImageLayoutTitle(
  attrs: Partial<InlineImageLayoutAttrs>
): string | null {
  const tokens: string[] = [];
  const width = parseInlineImageWidth(attrs.width);
  if (width !== null) {
    tokens.push(`width=${width}`);
  }
  const layout = parseInlineImageLayout(attrs.layout);
  const align = layout ? ALIGN_BY_LAYOUT[layout] : null;
  if (align) {
    tokens.push(`align=${align}`);
  }
  return tokens.length > 0 ? tokens.join(" ") : null;
}

export function clampInlineImageWidth(width: number, maxWidth: number): number {
  const ceiling = Math.max(
    MIN_INLINE_IMAGE_WIDTH,
    Math.min(MAX_INLINE_IMAGE_WIDTH, maxWidth)
  );
  return Math.round(Math.max(MIN_INLINE_IMAGE_WIDTH, Math.min(ceiling, width)));
}

function isValidInlineImageWidth(width: number): boolean {
  return (
    Number.isSafeInteger(width) &&
    width >= MIN_INLINE_IMAGE_WIDTH &&
    width <= MAX_INLINE_IMAGE_WIDTH
  );
}
