/**
 * Parser for extracting plan references (e.g., PLAN-42) from PR title and body.
 * Supports two formats:
 * 1. Slug pattern: `PLAN-{n}` (case-insensitive, word-boundary)
 * 2. URL pattern: `{NEXT_PUBLIC_APP_URL}/implementation-plans/PLAN-{n}`
 *
 * Title matches take precedence over body matches.
 * Within a source, first occurrence wins.
 */

export const MatchType = {
  Slug: "slug",
  Url: "url",
} as const;
export type MatchType = (typeof MatchType)[keyof typeof MatchType];

export const MatchSource = {
  Title: "title",
  Body: "body",
} as const;
export type MatchSource = (typeof MatchSource)[keyof typeof MatchSource];

export type PlanReference = {
  slug: string;
  matchType: MatchType;
  source: MatchSource;
};

// Word-boundary slug pattern: PLAN-{n} case-insensitive
const SLUG_PATTERN = /\bPLAN-(\d+)\b/gi;

// Strip trailing slashes from URLs
const TRAILING_SLASH_PATTERN = /\/+$/;

/**
 * Build a URL pattern regex from the app base URL.
 * Matches: {baseUrl}/implementation-plans/PLAN-{n}
 */
function buildUrlPattern(baseUrl: string): RegExp {
  const escaped = baseUrl.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}/implementation-plans/PLAN-(\\d+)\\b`, "gi");
}

/**
 * Extract all plan references from a single text, returning them in order of occurrence.
 * URL matches are checked first (more specific), then slug matches.
 * Deduplicates by slug — first match for a given slug wins.
 */
function extractFromText(
  text: string,
  source: MatchSource,
  appBaseUrl: string | undefined
): PlanReference[] {
  const seen = new Set<string>();
  const results: PlanReference[] = [];

  // Check URL pattern first (more specific match)
  if (appBaseUrl) {
    const urlPattern = buildUrlPattern(appBaseUrl);
    for (const match of text.matchAll(urlPattern)) {
      const slug = `PLAN-${match[1]}`;
      const normalizedSlug = slug.toUpperCase();
      if (!seen.has(normalizedSlug)) {
        seen.add(normalizedSlug);
        results.push({ slug, matchType: MatchType.Url, source });
      }
    }
  }

  // Then check slug pattern
  for (const match of text.matchAll(SLUG_PATTERN)) {
    const slug = `PLAN-${match[1]}`;
    const normalizedSlug = slug.toUpperCase();
    if (!seen.has(normalizedSlug)) {
      seen.add(normalizedSlug);
      results.push({ slug, matchType: MatchType.Slug, source });
    }
  }

  return results;
}

/**
 * Parse plan references from a PR title and body.
 * Returns an ordered array with title matches first, then body matches.
 * First match overall is the "winning" reference for linking.
 *
 * @param title - PR title text
 * @param body - PR body/description text (may be null)
 * @param appBaseUrl - Optional app base URL for URL pattern matching (NEXT_PUBLIC_APP_URL)
 */
export function parsePlanReferences(
  title: string | null | undefined,
  body: string | null | undefined,
  appBaseUrl?: string
): PlanReference[] {
  const seen = new Set<string>();
  const results: PlanReference[] = [];

  // Strip trailing slash from base URL if present
  const normalizedBaseUrl = appBaseUrl?.replace(TRAILING_SLASH_PATTERN, "");

  // Title matches first (higher precedence)
  if (title) {
    for (const ref of extractFromText(
      title,
      MatchSource.Title,
      normalizedBaseUrl
    )) {
      const normalizedSlug = ref.slug.toUpperCase();
      if (!seen.has(normalizedSlug)) {
        seen.add(normalizedSlug);
        results.push(ref);
      }
    }
  }

  // Then body matches
  if (body) {
    for (const ref of extractFromText(
      body,
      MatchSource.Body,
      normalizedBaseUrl
    )) {
      const normalizedSlug = ref.slug.toUpperCase();
      if (!seen.has(normalizedSlug)) {
        seen.add(normalizedSlug);
        results.push(ref);
      }
    }
  }

  return results;
}
