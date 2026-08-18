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

import { ARTIFACT_SLUG_PREFIXES } from "@repo/api/src/types/artifact-slug-prefixes";
import {
  DocumentType,
  LEGACY_TYPE_ROUTE_PREFIXES,
  TYPE_ROUTE_PREFIX,
} from "@repo/api/src/types/document";
import {
  SLUG_PREFIX_ALIASES,
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
  // Canonical slug prefix for the doc type (e.g. ISS for Issues). Emitted on the
  // ArtifactReference only when the reference matched via the canonical prefix;
  // an alias-prefix match echoes the matched prefix verbatim (see extractFromText).
  prefix: SlugPrefix;
  docType: DocumentType;
  routePath: string;
  // FEA-4137: every route path this doc type can appear under in a URL — the
  // canonical `routePath` plus retired paths (e.g. `features` for Issues). The
  // URL pattern accepts any of these.
  routePaths: readonly string[];
  // FEA-4137: every slug prefix that addresses this doc type — the canonical
  // prefix plus its compat aliases (FEA ↔ ISS). Both the bare-slug and URL
  // patterns accept any of these so `FEA-17` and `ISS-17` both parse.
  matchPrefixes: readonly SlugPrefix[];
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

// Build a `(A|B|C)` alternation from a set of literal strings, longest first so
// the regex engine prefers the most specific match (irrelevant for the fixed
// prefixes/paths here, but a safe habit).
function alternation(values: readonly string[]): string {
  const escaped = [...new Set(values)]
    .sort((a, b) => b.length - a.length)
    .map(escapeForRegex);
  return escaped.join("|");
}

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
    // FEA-4137: accept the canonical prefix plus its compat aliases (FEA ↔ ISS),
    // and the canonical route path plus retired ones (/features/ for Issues), so
    // both new and legacy slugs/links still parse.
    const matchPrefixes: SlugPrefix[] = [
      prefix,
      ...(SLUG_PREFIX_ALIASES[prefix] ?? []),
    ];
    const routePaths: string[] = [
      routePath,
      ...(LEGACY_TYPE_ROUTE_PREFIXES[docType] ?? []),
    ];
    configs.push({
      prefix,
      docType,
      routePath,
      routePaths,
      matchPrefixes,
      slugPattern: new RegExp(
        String.raw`\b(${alternation(matchPrefixes)})-(\d+)\b`,
        "gi"
      ),
    });
  }
  return configs;
}

const PREFIX_CONFIGS: PrefixConfig[] = buildPrefixConfigs();

function buildUrlPattern(baseUrl: string, config: PrefixConfig): RegExp {
  const escapedBase = escapeForRegex(baseUrl);
  return new RegExp(
    String.raw`${escapedBase}/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?/)?(?:${alternation(
      config.routePaths
    )})/(${alternation(config.matchPrefixes)})-(\d+)\b`,
    "gi"
  );
}

// Normalize a matched prefix (any letter case) to the typed SlugPrefix member.
// Every alternation branch derives from a SlugPrefix literal, so the uppercase
// form is always a valid member.
function toSlugPrefix(rawPrefix: string): SlugPrefix {
  return rawPrefix.toUpperCase() as SlugPrefix;
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
        // FEA-4137: echo the MATCHED prefix verbatim (normalized to its typed
        // member) so a legacy `FEA-17` link surfaces as `FEA-17` and a new
        // `ISS-17` as `ISS-17` — the DB resolver bridges both to one identity.
        const matchedPrefix = toSlugPrefix(match[1]);
        pushRef(results, seen, {
          slug: `${matchedPrefix}-${match[2]}`,
          prefix: matchedPrefix,
          docType: config.docType,
          matchType: MatchType.Url,
          source,
        });
      }
    }
  }

  for (const config of PREFIX_CONFIGS) {
    for (const match of text.matchAll(config.slugPattern)) {
      const matchedPrefix = toSlugPrefix(match[1]);
      pushRef(results, seen, {
        slug: `${matchedPrefix}-${match[2]}`,
        prefix: matchedPrefix,
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
