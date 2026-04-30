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

const CODE_BLOCK_PATTERN = /(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1/g;
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

  let placeholderContent = content.replaceAll(CODE_BLOCK_PATTERN, (match) => {
    const placeholder = `${placeholderPrefix}CODE_${placeholderIndex}__`;
    placeholderMap.set(placeholder, match);
    placeholderIndex++;
    return placeholder;
  });

  placeholderContent = placeholderContent.replaceAll(
    BLOCKQUOTE_PREFIX_PATTERN,
    (match) => {
      const placeholder = `${placeholderPrefix}QUOTE_${placeholderIndex}__`;
      placeholderMap.set(placeholder, match);
      placeholderIndex++;
      return placeholder;
    }
  );

  const sanitized = sanitizeHtml(placeholderContent, SANITIZE_OPTIONS);

  let restored = sanitized;
  for (const [placeholder, original] of placeholderMap) {
    restored = restored.replaceAll(placeholder, () => original);
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
