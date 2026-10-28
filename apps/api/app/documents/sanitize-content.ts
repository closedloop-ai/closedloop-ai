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

// A bare `&` in prose, and the HTML tags its interiors must NOT be taken from
// (ISS-9925). `sanitize-html` entity-encodes every `&` it sees in text, so
// `R&D` was stored as `R&amp;D` and a link's `?a=1&b=2` as `?a=1&amp;b=2`.
// Inside a tag the escaping is CORRECT — a bare `&` in an `href` is not
// conformant HTML — so tags are matched only to be skipped. By the time this
// runs every non-tag `<` has already been placeholdered, so a `<…>` still
// standing here is a real tag.
const AMP_OR_HTML_TAG = /<[^>]*>|&/g;

// An `&` plus the run that could make it an entity reference: a name, `#` and
// decimal digits, or `#x` and hex. The longest HTML5 named reference is 32
// characters (`&CounterClockwiseContourIntegral;`), so a longer window can
// never change the answer — and bounding it is what keeps both the protect pass
// and the restore guard O(1) per ampersand instead of O(document).
const ENTITY_CANDIDATE_PATTERN = /^&#?[a-zA-Z0-9]{0,32};?/;
const ENTITY_CANDIDATE_MAX_LENGTH = 34;

// Probe options for the entity oracle below. Deliberately not SANITIZE_OPTIONS:
// the probe asks one question about one short string, and allowing tags there
// would let a candidate be interpreted as markup instead of text.
const ENTITY_PROBE_OPTIONS: IOptions = {
  allowedTags: [],
  allowedAttributes: {},
};

// Bound on the oracle memo. One document holds a handful of distinct
// entity-shaped spellings, but the keys come from user content, so the map
// cannot be allowed to grow with it.
const ENTITY_ORACLE_CACHE_LIMIT = 512;
const entityOracleCache = new Map<string, boolean>();

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

  function placeholder(tag: PlaceholderTag, match: string): string {
    const key = `${placeholderPrefix}${tag}_${placeholderIndex}__`;
    placeholderMap.set(key, match);
    placeholderIndex++;
    return key;
  }

  // Order matters: fenced code first (most protective), then inline code,
  // then indented code, then autolinks/placeholders, then bare <, then blockquotes.

  let placeholderContent = content.replaceAll(CODE_BLOCK_PATTERN, (match) =>
    placeholder(PLACEHOLDER_TAG.Code, match)
  );

  placeholderContent = placeholderContent.replaceAll(
    INLINE_CODE_PATTERN,
    (match) => placeholder(PLACEHOLDER_TAG.InlineCode, match)
  );

  placeholderContent = placeholderContent.replaceAll(
    INDENTED_CODE_PATTERN,
    (match) => placeholder(PLACEHOLDER_TAG.Indent, match)
  );

  placeholderContent = placeholderContent.replaceAll(
    AUTOLINK_PATTERN,
    (match) => placeholder(PLACEHOLDER_TAG.Autolink, match)
  );

  placeholderContent = placeholderContent.replaceAll(
    ANGLE_PLACEHOLDER_PATTERN,
    (match) => placeholder(PLACEHOLDER_TAG.AngleBracket, match)
  );

  placeholderContent = placeholderContent.replaceAll(
    SELF_CLOSING_COMPONENT_PATTERN,
    (match) => placeholder(PLACEHOLDER_TAG.Component, match)
  );

  placeholderContent = placeholderContent.replaceAll(
    HTML_COMMENT_PATTERN,
    (match) => placeholder(PLACEHOLDER_TAG.Comment, match)
  );

  placeholderContent = placeholderContent.replaceAll(BARE_LT_NOT_TAG, (match) =>
    placeholder(PLACEHOLDER_TAG.LessThan, match)
  );

  placeholderContent = placeholderContent.replaceAll(
    MID_WORD_LT_PATTERN,
    (match) => placeholder(PLACEHOLDER_TAG.LessThan, match)
  );

  const ampKey = `${placeholderPrefix}AMP__`;
  placeholderContent = placeholderContent.replaceAll(
    AMP_OR_HTML_TAG,
    (match, offset: number, whole: string) =>
      shouldProtectAmpersand(match, offset, whole) ? ampKey : match
  );

  placeholderContent = placeholderContent.replaceAll(
    ARROW_OPERATOR_PATTERN,
    (match) => placeholder(PLACEHOLDER_TAG.Arrow, match)
  );

  placeholderContent = placeholderContent.replaceAll(
    SPACED_GT_OPERATOR_PATTERN,
    (match) => placeholder(PLACEHOLDER_TAG.GreaterThan, match)
  );

  placeholderContent = placeholderContent.replaceAll(
    BLOCKQUOTE_PREFIX_PATTERN,
    (match) => placeholder(PLACEHOLDER_TAG.Quote, match)
  );

  const sanitized = sanitizeHtml(placeholderContent, SANITIZE_OPTIONS);

  const restored = restorePlaceholders(
    restoreBareAmpersands(sanitized, ampKey),
    placeholderMap,
    placeholderPrefix
  );

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

/**
 * Whether the `&` matched at `offset` is a bare one this pass must protect.
 *
 * `match` is a whole HTML tag whenever the combined pattern hit one, and a tag's
 * attribute values belong to sanitize-html — a bare `&` left in an `href` is not
 * conformant HTML, so those are skipped rather than protected.
 */
function shouldProtectAmpersand(
  match: string,
  offset: number,
  whole: string
): boolean {
  if (match !== "&") {
    return false;
  }
  return !startsEntityReference(
    whole.slice(offset, offset + ENTITY_CANDIDATE_MAX_LENGTH)
  );
}

/**
 * Whether the text at `window` opens an entity reference sanitize-html will
 * DECODE rather than escape.
 *
 * Asked of sanitize-html itself, not of a table of entity names. A second copy
 * of the HTML5 set is the SSOT-drift-by-copy shape, and it would answer this
 * differently the moment the dependency moved — while the only answer that
 * matters is the one the sanitizer a few lines below is about to give. Testing
 * the SHAPE of a reference instead is what the first cut of this got wrong:
 * `&A;` in `Q&A; see below` is shaped exactly like `&lt;`, is not an entity, and
 * so was left for sanitize-html to corrupt into `Q&amp;A;`.
 *
 * The candidate's characters are alphanumeric plus `#` and `;`, none of which
 * sanitize-html rewrites, so an escaped leading `&` is the only difference the
 * probe can produce — which makes an exact comparison the test, not a prefix
 * one. `&amp;` decodes to `&` and re-encodes to `&amp;`, so a prefix test would
 * call the most common real entity in the corpus a non-entity.
 */
function startsEntityReference(window: string): boolean {
  const candidate = ENTITY_CANDIDATE_PATTERN.exec(window)?.[0];
  if (candidate === undefined) {
    return false;
  }

  const cached = entityOracleCache.get(candidate);
  if (cached !== undefined) {
    return cached;
  }

  const isReference =
    sanitizeHtml(candidate, ENTITY_PROBE_OPTIONS) !==
    `&amp;${candidate.slice(1)}`;

  if (entityOracleCache.size >= ENTITY_ORACLE_CACHE_LIMIT) {
    entityOracleCache.clear();
  }
  entityOracleCache.set(candidate, isReference);
  return isReference;
}

/**
 * Put the protected bare `&` characters back, escaping any that would otherwise
 * become an entity reference they were not.
 *
 * A `&` is only protected when the input did not already spell an entity, but
 * sanitize-html can DELETE the characters that separated it from entity-ish
 * text: `A &<span>#60;script>` loses the discarded `<span>` and leaves the
 * marker butted against `#60;`, so restoring a plain `&` would manufacture
 * `&#60;` out of two things the author never wrote together — and the next save
 * would read that as a real entity and rewrite it again, which is the
 * round-trip instability this fix exists to remove.
 *
 * One shared marker rather than a numbered key per ampersand, and deliberately
 * NOT an entry in `placeholderMap`: an ampersand is restored to `&` or `&amp;`
 * depending on what follows it AFTER sanitizing, which is a decision the general
 * restore cannot make because it only looks a key up. (ISS-9925 also measured a
 * per-occurrence key costing a full-body scan each — 1797 ms against 13 ms on a
 * 1 MB body. ISS-10138 removed that scan from the general restore, so the cost
 * is no longer the reason; the decision is.)
 *
 * Runs BEFORE `restorePlaceholders` on purpose: it decides from the text that
 * follows, and no other placeholder key — nor any value one restores to — begins
 * with a character an entity reference can start with. Correctness no longer
 * RESTS on that order, though: `AMP` is not in `PLACEHOLDER_TAG`, so an ampKey
 * left standing is skipped by the restore pattern rather than swallowed along
 * with the key behind it.
 */
function restoreBareAmpersands(sanitized: string, ampKey: string): string {
  if (!sanitized.includes(ampKey)) {
    return sanitized;
  }

  return sanitized.replaceAll(ampKey, (_key, offset: number) => {
    const following = sanitized.slice(
      offset + ampKey.length,
      offset + ampKey.length + ENTITY_CANDIDATE_MAX_LENGTH
    );
    return startsEntityReference(`&${following}`) ? "&amp;" : "&";
  });
}

/**
 * Every tag `placeholder` may mint, declared once because both the mint and the
 * restore pattern below derive from it. A twelfth spelling added here reaches
 * the pattern for free; one added anywhere else fails `tsc` at the mint instead
 * of silently minting a key the restore cannot see, and an unrestored key is
 * corrupt user content rather than a degraded render.
 *
 * `AMP` is deliberately absent: `restoreBareAmpersands` owns that marker, and
 * keeping it out of this set is what stops the pattern from spanning a
 * still-standing `ampKey` into the real key behind it.
 */
const PLACEHOLDER_TAG = {
  Code: "CODE",
  InlineCode: "ICODE",
  Indent: "INDENT",
  Autolink: "ALINK",
  AngleBracket: "ABRKT",
  Component: "COMPONENT",
  Comment: "COMMENT",
  LessThan: "LT",
  Arrow: "ARROW",
  GreaterThan: "GT",
  Quote: "QUOTE",
} as const;

type PlaceholderTag = (typeof PLACEHOLDER_TAG)[keyof typeof PLACEHOLDER_TAG];

/**
 * The tail of a placeholder key, after the per-call prefix: `<TAG>_<index>__`.
 *
 * Closed over the tag set rather than a `\w+?` run. A wide run also matches
 * ACROSS a prefix-shaped marker that is not a key — `…_AMP____…_CODE_5__`
 * resolves as one unknown match and leaves `CODE_5` raw — so the closed
 * alternation is what makes that structural instead of a promise about call
 * order. Tags are uppercase letters, so none needs escaping.
 */
const PLACEHOLDER_KEY_TAIL_SOURCE = String.raw`(?:${Object.values(
  PLACEHOLDER_TAG
).join("|")})_\d+__`;

/**
 * Put every protected construct back in ONE left-to-right pass (ISS-10138).
 *
 * One `replaceAll` per key is O(keys × body). Measured on this box at the
 * commit before this one: 3.2 s for 0.64 MB, 11.1 s for 1.30 MB, 44.8 s for
 * 2.62 MB — 4× the body for 14× the time, spent inside the transaction that
 * already holds the document's row lock in `documentVersionService.createVersion`.
 *
 * Nesting is what the old reverse-insertion-order loop bought, and what the
 * callback buys instead: a value captured in pass K can contain keys minted in
 * an earlier pass, so the callback re-resolves its own result. Two matches
 * within one pass are disjoint, so a key can only ever nest inside a value from
 * a LATER pass — the resolution graph is acyclic and no deeper than the number
 * of protect passes, which is why the recursion needs no visited set.
 *
 * Sharing one regex across the nested calls is safe: `RegExp.prototype
 * [Symbol.replace]` collects every match before it invokes the replacer, so a
 * nested `replaceAll` cannot disturb the scan that called it.
 *
 * A key the map does not know is left standing rather than dropped — the old
 * loop could not have removed it either, and minting a value for it would be
 * inventing content.
 */
function restorePlaceholders(
  sanitized: string,
  placeholderMap: ReadonlyMap<string, string>,
  placeholderPrefix: string
): string {
  if (placeholderMap.size === 0) {
    return sanitized;
  }

  // The prefix is `__SANITIZE_` plus hex, so it carries no regex metacharacters.
  const keyPattern = new RegExp(
    `${placeholderPrefix}${PLACEHOLDER_KEY_TAIL_SOURCE}`,
    "g"
  );

  const resolve = (text: string): string =>
    text.replaceAll(keyPattern, (key) => {
      const original = placeholderMap.get(key);
      return original === undefined ? key : resolve(original);
    });

  return resolve(sanitized);
}
