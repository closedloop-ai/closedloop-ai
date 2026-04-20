/**
 * Parser for extracting artifact references (e.g., PLN-42, FEA-17) from PR
 * title and body.
 *
 * Supports two formats per registered artifact type:
 * 1. Slug pattern: `{PREFIX}-{n}` (case-insensitive, word-boundary)
 * 2. URL pattern: `{NEXT_PUBLIC_APP_URL}/{routePath}/{PREFIX}-{n}`
 *
 * Title matches take precedence over body matches.
 * Within a source, URL matches take precedence over slug matches.
 * First occurrence of a given normalized slug wins.
 */

import { DocumentType, TYPE_ROUTE_PREFIX } from "@repo/api/src/types/document";
import {
  ARTIFACT_SLUG_PREFIXES,
  type SlugPrefix,
} from "@repo/api/src/types/slug-prefix";

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

export type ArtifactReference = {
  slug: string;
  prefix: SlugPrefix;
  docType: DocumentType;
  matchType: MatchType;
  source: MatchSource;
};

type PrefixConfig = {
  prefix: SlugPrefix;
  docType: DocumentType;
  routePath: string;
  slugPattern: RegExp;
};

// Strip trailing slashes from URLs
const TRAILING_SLASH_PATTERN = /\/+$/;

function escapeForRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

// Artifact types the parser currently recognizes. Broader than the scope of
// PRD-177 (Plan + Feature) — add entries here as additional types need
// PR-link parsing.
const PARSABLE_DOC_TYPES: ReadonlySet<DocumentType> = new Set([
  DocumentType.ImplementationPlan,
  DocumentType.Feature,
]);

function buildPrefixConfigs(): PrefixConfig[] {
  const configs: PrefixConfig[] = [];
  for (const [docType, prefix] of Object.entries(ARTIFACT_SLUG_PREFIXES) as [
    DocumentType,
    SlugPrefix,
  ][]) {
    if (!PARSABLE_DOC_TYPES.has(docType)) {
      continue;
    }
    const routePath = TYPE_ROUTE_PREFIX[docType];
    if (!routePath) {
      continue;
    }
    configs.push({
      prefix,
      docType,
      routePath,
      slugPattern: new RegExp(
        String.raw`\b${escapeForRegex(prefix)}-(\d+)\b`,
        "gi"
      ),
    });
  }
  return configs;
}

const PREFIX_CONFIGS: PrefixConfig[] = buildPrefixConfigs();

function buildUrlPattern(baseUrl: string, config: PrefixConfig): RegExp {
  const escapedBase = escapeForRegex(baseUrl);
  const escapedRoute = escapeForRegex(config.routePath);
  return new RegExp(
    String.raw`${escapedBase}/${escapedRoute}/${escapeForRegex(
      config.prefix
    )}-(\d+)\b`,
    "gi"
  );
}

function pushRef(
  results: ArtifactReference[],
  seen: Set<string>,
  ref: ArtifactReference
): void {
  const normalizedSlug = ref.slug.toUpperCase();
  if (seen.has(normalizedSlug)) {
    return;
  }
  seen.add(normalizedSlug);
  results.push(ref);
}

/**
 * Extract all artifact references from a single text. URL matches are checked
 * first (more specific), then slug matches — so a given slug always wins via
 * its URL form when both appear. Within each pass, entries are emitted in
 * PREFIX_CONFIGS order (Plan before Feature), but across passes URL matches
 * precede slug matches regardless of docType. Callers that require a stable
 * docType ordering should sort the returned array. Deduplicates by normalized
 * slug — first match for a given slug wins.
 */
function extractFromText(
  text: string,
  source: MatchSource,
  appBaseUrl: string | undefined
): ArtifactReference[] {
  const seen = new Set<string>();
  const results: ArtifactReference[] = [];

  if (appBaseUrl) {
    for (const config of PREFIX_CONFIGS) {
      const urlPattern = buildUrlPattern(appBaseUrl, config);
      for (const match of text.matchAll(urlPattern)) {
        pushRef(results, seen, {
          slug: `${config.prefix}-${match[1]}`,
          prefix: config.prefix,
          docType: config.docType,
          matchType: MatchType.Url,
          source,
        });
      }
    }
  }

  for (const config of PREFIX_CONFIGS) {
    for (const match of text.matchAll(config.slugPattern)) {
      pushRef(results, seen, {
        slug: `${config.prefix}-${match[1]}`,
        prefix: config.prefix,
        docType: config.docType,
        matchType: MatchType.Slug,
        source,
      });
    }
  }

  return results;
}

/**
 * Parse artifact references from a PR title and body.
 * Returns an ordered array with title matches first, then body matches.
 *
 * @param title - PR title text
 * @param body - PR body/description text (may be null)
 * @param appBaseUrl - Optional app base URL for URL pattern matching (NEXT_PUBLIC_APP_URL)
 */
export function parseArtifactReferences(
  title: string | null | undefined,
  body: string | null | undefined,
  appBaseUrl?: string
): ArtifactReference[] {
  const seen = new Set<string>();
  const results: ArtifactReference[] = [];

  const normalizedBaseUrl = appBaseUrl?.replace(TRAILING_SLASH_PATTERN, "");

  if (title) {
    for (const ref of extractFromText(
      title,
      MatchSource.Title,
      normalizedBaseUrl
    )) {
      pushRef(results, seen, ref);
    }
  }

  if (body) {
    for (const ref of extractFromText(
      body,
      MatchSource.Body,
      normalizedBaseUrl
    )) {
      pushRef(results, seen, ref);
    }
  }

  return results;
}
