/**
 * Local title/heading/body search index for the desktop Docs & Help bundle
 * (FEA-3843 / PRD-555 M1). Pure, in-memory, no server round-trip.
 *
 * The index is built once over the {@link DocsBundle} snapshot and answers
 * `search(query)` with ranked {@link DocsHelpSearchHit}s. Ranking is a simple
 * field-weighted term-frequency model — title matches beat heading matches beat
 * body matches — good enough for M1's in-app + command-palette lookups without
 * pulling in an external search dependency. The reader UI (M2/FEA-3844) consumes
 * these hits; M1 only produces them.
 */
import {
  DocsHelpMatchField,
  type DocsHelpSearchHit,
} from "../../shared/docs-help-contract.js";
import type { DocsBundle } from "./docs-bundle-types.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const EXCERPT_RADIUS = 80;
const MAX_EXCERPT = 200;

// Field weights: a query term found in the title is worth much more than the
// same term buried in the body.
const TITLE_WEIGHT = 100;
const HEADING_WEIGHT = 20;
const BODY_WEIGHT = 1;
// A group (meta.json facet) match is a weak tie-breaker.
const GROUP_WEIGHT = 5;

const TOKEN_SPLIT_RE = /[^a-z0-9]+/;
const WHITESPACE_RE = /\s+/g;

/** Lowercase + split a string into non-empty alphanumeric terms. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(TOKEN_SPLIT_RE)
    .filter((token) => token.length > 0);
}

/** Count occurrences of `term` as a substring of the lowercased `haystack`. */
function countMatches(haystack: string, term: string): number {
  if (!term) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(term, index + term.length);
  }
  return count;
}

/**
 * Build a plain-text excerpt around the first occurrence of any query term in
 * `body`, or a leading slice when no term is found. Whitespace-collapsed and
 * length-capped.
 */
function buildExcerpt(body: string, terms: readonly string[]): string {
  const collapsed = body.replace(WHITESPACE_RE, " ").trim();
  if (!collapsed) {
    return "";
  }
  const lower = collapsed.toLowerCase();
  let firstIndex = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index !== -1 && (firstIndex === -1 || index < firstIndex)) {
      firstIndex = index;
    }
  }
  if (firstIndex === -1) {
    return truncate(collapsed, MAX_EXCERPT);
  }
  const start = Math.max(0, firstIndex - EXCERPT_RADIUS);
  const slice = collapsed.slice(start, start + MAX_EXCERPT);
  const prefix = start > 0 ? "…" : "";
  const suffix = start + MAX_EXCERPT < collapsed.length ? "…" : "";
  return `${prefix}${slice.trim()}${suffix}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trim()}…`;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/** A pre-lowercased projection of one page, so `search` avoids re-lowercasing per query. */
type IndexedPage = {
  path: string;
  title: string;
  group?: string;
  lowerTitle: string;
  lowerGroup: string;
  lowerHeadings: readonly { text: string; slug: string; lower: string }[];
  lowerBody: string;
  description: string;
  body: string;
};

export type DocsSearchIndex = {
  readonly pageCount: number;
  search: (query: string, limit?: number) => DocsHelpSearchHit[];
};

/**
 * Build the search index over a docs bundle. Precomputes lowercased fields once;
 * `search` is a linear scan (the bundle is a few dozen small pages, so an
 * inverted index would be over-engineering for M1).
 */
export function buildDocsSearchIndex(bundle: DocsBundle): DocsSearchIndex {
  const indexed: IndexedPage[] = bundle.pages.map((page) => ({
    path: page.path,
    title: page.title,
    ...(page.group ? { group: page.group } : {}),
    lowerTitle: page.title.toLowerCase(),
    lowerGroup: (page.group ?? "").toLowerCase(),
    lowerHeadings: page.headings.map((heading) => ({
      text: heading.text,
      slug: heading.slug,
      lower: heading.text.toLowerCase(),
    })),
    lowerBody: page.body.toLowerCase(),
    description: page.description ?? "",
    body: page.body,
  }));

  const search = (query: string, limit?: number): DocsHelpSearchHit[] => {
    const terms = tokenize(query);
    if (terms.length === 0) {
      return [];
    }
    const hits: DocsHelpSearchHit[] = [];
    for (const page of indexed) {
      const scored = scorePage(page, terms);
      if (scored) {
        hits.push(scored);
      }
    }
    hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    return hits.slice(0, clampLimit(limit));
  };

  return { pageCount: indexed.length, search };
}

/**
 * Score one page against the query terms. Returns a hit only when EVERY term
 * matches somewhere on the page (AND semantics), so unrelated pages that happen
 * to contain one common word don't flood the results.
 */
function scorePage(
  page: IndexedPage,
  terms: readonly string[]
): DocsHelpSearchHit | null {
  let score = 0;
  let bestField: DocsHelpMatchField = DocsHelpMatchField.Body;
  let bestFieldRank = 0;
  let headingSlug: string | undefined;

  for (const term of terms) {
    const titleHits = countMatches(page.lowerTitle, term);
    const groupHits = countMatches(page.lowerGroup, term);
    let headingHits = 0;
    let termHeadingSlug: string | undefined;
    for (const heading of page.lowerHeadings) {
      const count = countMatches(heading.lower, term);
      if (count > 0) {
        headingHits += count;
        termHeadingSlug ??= heading.slug;
      }
    }
    const bodyHits = countMatches(page.lowerBody, term);

    // AND semantics: every term must appear in at least one field.
    if (
      titleHits === 0 &&
      groupHits === 0 &&
      headingHits === 0 &&
      bodyHits === 0
    ) {
      return null;
    }

    score +=
      titleHits * TITLE_WEIGHT +
      headingHits * HEADING_WEIGHT +
      groupHits * GROUP_WEIGHT +
      bodyHits * BODY_WEIGHT;

    // Track the strongest field any term matched, for the result label/anchor.
    const { field, rank } = strongestField(
      titleHits,
      headingHits,
      bodyHits,
      groupHits
    );
    if (rank > bestFieldRank) {
      bestFieldRank = rank;
      bestField = field;
      headingSlug =
        field === DocsHelpMatchField.Heading ? termHeadingSlug : undefined;
    }
  }

  const excerpt =
    bestField === DocsHelpMatchField.Body
      ? buildExcerpt(page.body, terms)
      : page.description || buildExcerpt(page.body, terms);

  return {
    path: page.path,
    title: page.title,
    ...(page.group ? { group: page.group } : {}),
    matchField: bestField,
    score,
    excerpt,
    ...(headingSlug ? { headingSlug } : {}),
  };
}

/** Rank the fields a single term hit; higher rank = stronger match for labeling. */
function strongestField(
  titleHits: number,
  headingHits: number,
  bodyHits: number,
  groupHits: number
): { field: DocsHelpMatchField; rank: number } {
  if (titleHits > 0) {
    return { field: DocsHelpMatchField.Title, rank: 4 };
  }
  if (headingHits > 0) {
    return { field: DocsHelpMatchField.Heading, rank: 3 };
  }
  if (bodyHits > 0) {
    return { field: DocsHelpMatchField.Body, rank: 2 };
  }
  // A group-only match (term in the meta.json facet, nowhere in the page text)
  // ranks below body so it never mislabels a body hit, but above the 0 default
  // so it is reported as a Group match with a description excerpt.
  if (groupHits > 0) {
    return { field: DocsHelpMatchField.Group, rank: 1 };
  }
  return { field: DocsHelpMatchField.Body, rank: 0 };
}
