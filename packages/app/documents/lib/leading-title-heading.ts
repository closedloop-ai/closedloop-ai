/**
 * Detects the leading body heading that repeats an artifact's own title
 * (ISS-5006).
 *
 * Every artifact template seeds the document body with an H1 equal to the
 * record title, and the detail chrome renders that title independently above
 * the metadata row. The result is the same string twice, back to back, at two
 * sizes — a full band of vertical space above the fold, and two competing
 * top-level headings for assistive tech on a page that should have one.
 *
 * The body is author-owned content inside a collaborative editor, so nothing
 * here rewrites it: this only answers whether the body *leads* with the title,
 * and the read view hides that one node. Edit mode always shows the real
 * document.
 */

/** `# Title`, with optional closing hashes (`# Title #`). */
const ATX_H1 = /^#[^\S\n]+(.+?)(?:[^\S\n]+#+)?$/;

/** The `=====` underline of a setext H1. */
const SETEXT_H1_UNDERLINE = /^=+$/;

/** Collapse runs of whitespace so a soft-wrapped title still compares equal. */
const WHITESPACE_RUN = /\s+/g;

/**
 * True when the first block of `content` is a top-level heading whose text is
 * the artifact's `title`. Comparison is whitespace-collapsed and
 * case-insensitive: the duplicate is generated from the title, so a casing or
 * spacing difference is still the same repeat, while a body that merely
 * starts with some other heading is left alone.
 */
export function bodyLeadsWithTitleHeading(
  content: string | null | undefined,
  title: string | null | undefined
): boolean {
  const heading = readLeadingHeading(content);
  if (heading === null) {
    return false;
  }
  const normalizedTitle = normalizeHeadingText(title ?? "");
  return normalizedTitle.length > 0 && heading === normalizedTitle;
}

/**
 * The normalized text of the document's leading H1, or null when the body does
 * not start with one. Only the first non-empty line is considered — a heading
 * further down is real content, not the template's title repeat.
 */
function readLeadingHeading(content: string | null | undefined): string | null {
  if (!content) {
    return null;
  }
  const lines = content.split("\n");
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstIndex === -1) {
    return null;
  }
  const first = lines[firstIndex].trim();
  const atx = ATX_H1.exec(first);
  if (atx) {
    return normalizeHeadingText(atx[1]);
  }
  const next = lines[firstIndex + 1]?.trim() ?? "";
  if (SETEXT_H1_UNDERLINE.test(next)) {
    return normalizeHeadingText(first);
  }
  return null;
}

function normalizeHeadingText(value: string): string {
  return value.trim().replace(WHITESPACE_RUN, " ").toLowerCase();
}
