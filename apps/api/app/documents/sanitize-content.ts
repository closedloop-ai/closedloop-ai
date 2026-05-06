import { randomUUID } from "node:crypto";
import { log } from "@repo/observability/log";
import type { IOptions } from "sanitize-html";
import sanitizeHtml from "sanitize-html";

const SANITIZE_OPTIONS: IOptions = {
  allowedTags: [
    "p",
    "br",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "strong",
    "em",
    "del",
    "code",
    "pre",
    "blockquote",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "a",
    "img",
    "hr",
    "details",
    "summary",
    "kbd",
    "sub",
    "sup",
  ],
  allowedAttributes: {
    a: ["href", "title"],
    img: ["src", "alt", "title"],
    code: ["class"],
    pre: ["class"],
  },
  allowedSchemesByTag: {
    a: ["http", "https", "mailto"],
    img: ["http", "https"],
  },
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
};

const ALLOWED_TAGS_SET = new Set(
  Array.isArray(SANITIZE_OPTIONS.allowedTags)
    ? SANITIZE_OPTIONS.allowedTags
    : []
);

// Fenced code blocks: ```lang ... ``` or ~~~lang ... ~~~
const CODE_BLOCK_PATTERN = /(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1/g;

// Inline code spans: ``code`` or `code` (backtick pairs on the same line).
// Handles double-backtick spans first, then single-backtick spans.
const INLINE_CODE_PATTERN = /``(?!`)(.+?)``|`(?!`)([^`\n]+)`/g;

// Indented code blocks: lines starting with 4+ spaces or a tab,
// preceded and followed by a blank line (or start/end of string).
const INDENTED_CODE_PATTERN =
  /(?:^|\n\n)((?:(?: {4}|\t)[^\n]*\n?)+)(?=\n\n|$)/g;

// Markdown autolinks: <https://...>, <http://...>, <email@example.com>
const AUTOLINK_PATTERN =
  /<(https?:\/\/[^\s>]+|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)>/g;

// Angle-bracket placeholders used in docs:
// <REPLACE_ME>, <YOUR_API_KEY>, <NS:VALUE>, etc.
// Require placeholder-like separators so uppercase HTML tags such as <SCRIPT>
// still flow through sanitize-html instead of being restored afterward.
const ANGLE_PLACEHOLDER_PATTERN = /<([A-Z0-9]+(?:[_:.][A-Z0-9_.:-]+)+)>/g;

// Self-closing JSX/component references in prose: <Component />, <UI.Button />
// Require at least one lowercase character so uppercase HTML tags such as
// <SCRIPT /> are not preserved as placeholders.
const SELF_CLOSING_COMPONENT_PATTERN =
  /<([A-Z](?=[A-Za-z0-9]*[a-z])[A-Za-z0-9]*(?:\.[A-Z](?=[A-Za-z0-9]*[a-z])[A-Za-z0-9]*)*\s*\/)>/g;

// HTML comments: <!-- ... -->
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;

// Bare < in prose that isn't an HTML tag opening. Two sub-patterns:
//   1. < NOT followed by a letter, /, or ! — clearly not a tag (e.g., "x < 5")
//   2. < preceded by a word character, followed by a letter, where no > appears
//      before the next < or end of line — prose like "a<b for comparison".
//      "H<sub>2" has > after the tag name so it won't match.
const BARE_LT_NOT_TAG = /<(?![a-zA-Z/!])/g;
const MID_WORD_LT_PATTERN = /(?<=\w)<(?=[a-z])(?=[^>]*(?:<|$))/gm;

// Arrow operators and spaced comparison operators get entity-encoded by
// sanitize-html. Protect the full token so allowed HTML tags like
// <a href="..." > do not match.
const ARROW_OPERATOR_PATTERN = /=>/g;
const SPACED_GT_OPERATOR_PATTERN = /(?<=\S)\s>\s(?=\S)/g;

const BLOCKQUOTE_PREFIX_PATTERN = /^(?:>\s?)+/gm;

export function sanitizeDocumentContent(
  content: string | null
): SanitizeResult {
  if (!content) {
    return { content, stripped: [] };
  }

  const placeholderMap = new Map<string, string>();
  const placeholderPrefix = `__SANITIZE_${randomUUID().replaceAll("-", "")}_`;
  let placeholderIndex = 0;

  function placeholder(tag: string, match: string): string {
    const key = `${placeholderPrefix}${tag}_${placeholderIndex}__`;
    placeholderMap.set(key, match);
    placeholderIndex++;
    return key;
  }

  // Order matters: fenced code first (most protective), then inline code,
  // then indented code, then autolinks/placeholders, then bare <, then blockquotes.

  let placeholderContent = content.replaceAll(CODE_BLOCK_PATTERN, (match) =>
    placeholder("CODE", match)
  );

  placeholderContent = placeholderContent.replaceAll(
    INLINE_CODE_PATTERN,
    (match) => placeholder("ICODE", match)
  );

  placeholderContent = placeholderContent.replaceAll(
    INDENTED_CODE_PATTERN,
    (match) => placeholder("INDENT", match)
  );

  placeholderContent = placeholderContent.replaceAll(
    AUTOLINK_PATTERN,
    (match) => placeholder("ALINK", match)
  );

  placeholderContent = placeholderContent.replaceAll(
    ANGLE_PLACEHOLDER_PATTERN,
    (match) => placeholder("ABRKT", match)
  );

  placeholderContent = placeholderContent.replaceAll(
    SELF_CLOSING_COMPONENT_PATTERN,
    (match) => placeholder("COMPONENT", match)
  );

  placeholderContent = placeholderContent.replaceAll(
    HTML_COMMENT_PATTERN,
    (match) => placeholder("COMMENT", match)
  );

  placeholderContent = placeholderContent.replaceAll(BARE_LT_NOT_TAG, (match) =>
    placeholder("LT", match)
  );

  placeholderContent = placeholderContent.replaceAll(
    MID_WORD_LT_PATTERN,
    (match) => placeholder("LT", match)
  );

  placeholderContent = placeholderContent.replaceAll(
    ARROW_OPERATOR_PATTERN,
    (match) => placeholder("ARROW", match)
  );

  placeholderContent = placeholderContent.replaceAll(
    SPACED_GT_OPERATOR_PATTERN,
    (match) => placeholder("GT", match)
  );

  placeholderContent = placeholderContent.replaceAll(
    BLOCKQUOTE_PREFIX_PATTERN,
    (match) => placeholder("QUOTE", match)
  );

  const sanitized = sanitizeHtml(placeholderContent, SANITIZE_OPTIONS);

  let restored = sanitized;
  for (const [key, original] of Array.from(
    placeholderMap.entries()
  ).reverse()) {
    restored = restored.replaceAll(key, () => original);
  }

  const stripped = buildStrippedList(placeholderContent, sanitized);

  return { content: restored, stripped };
}

export function sanitizeAndLog(
  content: string | null,
  documentId: string
): string | null {
  try {
    const result = sanitizeDocumentContent(content);

    if (result.stripped.length > 0) {
      log.warn("document.content.sanitized", {
        documentId,
        strippedCount: result.stripped.length,
        stripped: result.stripped,
      });
    }

    return result.content;
  } catch (error) {
    log.error("document.content.sanitize.failed", { documentId, error });
    return content;
  }
}

function buildStrippedList(original: string, sanitized: string): string[] {
  if (original === sanitized) {
    return [];
  }

  const stripped: string[] = [];
  const sanitizedTagCounts = countTagSignatures(sanitized);

  for (const tag of extractOpeningTags(original)) {
    if (!ALLOWED_TAGS_SET.has(tag.tagName)) {
      stripped.push(tag.fullTag);
      continue;
    }

    const count = sanitizedTagCounts.get(tag.signature) ?? 0;
    if (count > 0) {
      sanitizedTagCounts.set(tag.signature, count - 1);
      continue;
    }

    stripped.push(tag.fullTag);
  }

  if (stripped.length === 0) {
    stripped.push("[sanitized content]");
  }

  return stripped;
}

export type SanitizeResult = { content: string | null; stripped: string[] };

type ParsedTag = {
  fullTag: string;
  tagName: string;
  signature: string;
};

const OPENING_TAG_PATTERN = /<([a-zA-Z][a-zA-Z0-9]*)(\s[^<>]*?)?\s*\/?>/g;
const ATTRIBUTE_PATTERN =
  /([^\s"'=<>`/]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function extractOpeningTags(html: string): ParsedTag[] {
  const tags: ParsedTag[] = [];

  for (const match of html.matchAll(OPENING_TAG_PATTERN)) {
    const fullTag = match[0];
    const tagName = match[1]?.toLowerCase() ?? "";
    const attributeSource = match[2] ?? "";
    const attributes = Array.from(attributeSource.matchAll(ATTRIBUTE_PATTERN))
      .map((attributeMatch) => {
        const name = attributeMatch[1]?.toLowerCase() ?? "";
        const rawValue =
          attributeMatch[2] ?? attributeMatch[3] ?? attributeMatch[4] ?? "";
        return [name, rawValue] as const;
      })
      .sort(([leftName, leftValue], [rightName, rightValue]) => {
        if (leftName === rightName) {
          return leftValue.localeCompare(rightValue);
        }
        return leftName.localeCompare(rightName);
      });

    const signature = `${tagName}|${attributes
      .map(([name, value]) => `${name}=${value}`)
      .join("|")}`;

    tags.push({ fullTag, tagName, signature });
  }

  return tags;
}

function countTagSignatures(html: string): Map<string, number> {
  const counts = new Map<string, number>();

  for (const tag of extractOpeningTags(html)) {
    counts.set(tag.signature, (counts.get(tag.signature) ?? 0) + 1);
  }

  return counts;
}
