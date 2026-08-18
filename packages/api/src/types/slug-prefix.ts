/**
 * The artifact/project/session slug prefixes (`FEA-`, `PRD-`, …). Kept
 * DEPENDENCY-FREE — this module imports nothing — so browser-facing consumers
 * (the search query parser {@link parseSearchQuery}, imported by the client
 * search intellisense) can pull in the bare prefix strings without dragging the
 * heavy document contract (`./document` → `@closedloop-ai/loops-api/document` + Zod) into
 * the search UI bundle. The `DocumentType`-keyed prefix map lives in
 * `./artifact-slug-prefixes.ts`, which does import `./document`.
 */
export const SlugPrefix = {
  Project: "PRO",
  Prd: "PRD",
  Plan: "PLN",
  // Issues (formerly "Features"). FEA-4137: the artifact renamed Feature → Issue,
  // so NEW slugs mint under the canonical `ISS-` prefix ({@link SlugPrefix.Issue}).
  // `Feature`/`FEA-` is retained as a COMPAT ALIAS: existing rows stored `FEA-###`,
  // and MCP clients, installed Desktop builds, OG-metadata links, the GitHub
  // artifact-reference parser, and external bookmarks still carry `FEA-###`. Both
  // prefixes resolve to the same numeric identity (FEA-592 ↔ ISS-592) via
  // {@link expandSlugAliases}; the shared counter row stays keyed on `FEA` so the
  // numeric series is continuous (no counter reset). Do NOT drop `FEA-`
  // acceptance without explicit human approval.
  Feature: "FEA",
  // Canonical prefix for the Issue artifact (FEA-4137). New Issue slugs are
  // `ISS-###`; `FEA-###` remains an accepted alias (see `Feature` above).
  Issue: "ISS",
  // SESSION artifacts (SES-*). Not in the DocumentType-keyed ARTIFACT_SLUG_PREFIXES
  // map (sessions are not documents), so session creation calls
  // generateSlug(orgId, SlugPrefix.Session) directly.
  Session: "SES",
  // WORKFLOW artifacts (WRK-*). Not a Document type, but a `{PREFIX}-{n}` slug
  // family recognized in prose/branch references by the artifact-ref extractor
  // and branch-name parser (see REFERENCEABLE_SLUG_PREFIXES).
  Workflow: "WRK",
  // Evergreen Document artifacts (DOC-*), the DOC ArtifactSubtype (FEA-3949).
  Doc: "DOC",
} as const;
export type SlugPrefix = (typeof SlugPrefix)[keyof typeof SlugPrefix];

/**
 * Cross-prefix compat aliases (FEA-4137). Maps a canonical prefix to the other
 * prefixes that address the SAME numeric identity, so a slug minted under one
 * prefix still resolves when addressed under a legacy/alias prefix. Bidirectional
 * for Issue ↔ Feature: `ISS-592` and `FEA-592` are the same entity. Keep this the
 * single source of truth for slug aliasing — resolvers, search, and the by-slug
 * lookup all derive candidate slugs from {@link expandSlugAliases}.
 */
export const SLUG_PREFIX_ALIASES: Readonly<
  Partial<Record<SlugPrefix, readonly SlugPrefix[]>>
> = {
  [SlugPrefix.Issue]: [SlugPrefix.Feature],
  [SlugPrefix.Feature]: [SlugPrefix.Issue],
};

/**
 * Counter-key overrides for slug minting (FEA-4137). A canonical prefix here
 * mints its display slug (`ISS-###`) but INCREMENTS the counter row keyed on the
 * mapped prefix (`FEA`). This keeps the numeric series continuous across the
 * Feature → Issue rename: the org's `FEA` counter row is the single source of
 * numeric truth, so the issue after `FEA-592` is `ISS-593` with no counter reset
 * and no data migration. Absent here, a prefix keys its own counter row.
 */
export const SLUG_COUNTER_KEY: Readonly<
  Partial<Record<SlugPrefix, SlugPrefix>>
> = {
  [SlugPrefix.Issue]: SlugPrefix.Feature,
};

const TYPED_SLUG = /^([A-Z]+)-(\d+)$/i;

/**
 * Given a typed slug (`ISS-592`, `FEA-592`), return every equivalent slug that
 * addresses the same numeric identity — the input itself first, then its
 * cross-prefix aliases (FEA-4137). For `ISS-592` → `["ISS-592", "FEA-592"]`;
 * for `FEA-592` → `["FEA-592", "ISS-592"]`. Any slug without a known alias (or a
 * non-typed slug) returns just `[slug]`. Callers use the ordered result to try
 * the canonical form first and fall back to legacy-stored rows. The alias
 * prefix is emitted in the SAME letter-case as the matched input prefix so a
 * case-insensitive DB collation is not required.
 */
export function expandSlugAliases(slug: string): string[] {
  const match = TYPED_SLUG.exec(slug);
  if (!match) {
    return [slug];
  }
  const [, rawPrefix, digits] = match;
  const canonical = rawPrefix.toUpperCase() as SlugPrefix;
  const aliases = SLUG_PREFIX_ALIASES[canonical];
  if (!aliases) {
    return [slug];
  }
  const preserveCase = (prefix: string): string =>
    rawPrefix === rawPrefix.toLowerCase() ? prefix.toLowerCase() : prefix;
  return [slug, ...aliases.map((alias) => `${preserveCase(alias)}-${digits}`)];
}

/**
 * The prefixes whose entities carry a projected `slug` in the `search_document`
 * projection, and are therefore resolvable by the exact ID/slug lookup
 * (FEA-3930). Sessions (`SES-*`) are EXCLUDED: `agentSessionProjection` writes
 * `slug: null` (sessions route by id, not slug), so a `SES-###` exact-slug
 * lookup could never match a projection row — treat it as ordinary free text
 * instead of a doomed lookup.
 */
export const SLUG_LOOKUP_PREFIXES: readonly SlugPrefix[] = [
  SlugPrefix.Project,
  SlugPrefix.Prd,
  SlugPrefix.Plan,
  // Issues carry a projected slug under BOTH prefixes (FEA-4137): existing rows
  // are `FEA-###`, new rows `ISS-###`. Listing both keeps an exact-slug lookup
  // able to match either form (the alias resolver, expandSlugAliases, bridges
  // the numeric identity when only the other-prefix row exists).
  SlugPrefix.Feature,
  SlugPrefix.Issue,
  // Evergreen Document artifacts (DOC-*, FEA-3949). Like PRD/PLN/FEA they are
  // Documents, so `documentProjection` writes their non-null `slug` into the
  // `search_document` projection — a `DOC-###` exact-slug lookup can match.
  SlugPrefix.Doc,
];

/**
 * The slug prefixes that address a `{PREFIX}-{n}` reference recognizable in free
 * text, branch names, cwd paths, session slugs, and the Desktop sync contract —
 * i.e. the artifact/project/session families the artifact-ref extractor and the
 * branch-name parser emit (NOT `DOC`, which is not referenced by that family of
 * recognizers). SSOT for the recognizer/validator regex alphabet so `FEA` and
 * `ISS` (FEA-4137 Feature → Issue rename, both accepted; see
 * {@link SLUG_PREFIX_ALIASES}) can never drift between the desktop extractor,
 * the branch parser, and the cloud sync-schema validator. Consumers build a
 * `(A|B|…)` alternation from this via {@link buildSlugPrefixAlternation} rather
 * than hardcoding the family list.
 */
export const REFERENCEABLE_SLUG_PREFIXES: readonly SlugPrefix[] = [
  SlugPrefix.Prd,
  SlugPrefix.Feature,
  SlugPrefix.Issue,
  SlugPrefix.Plan,
  SlugPrefix.Project,
  // WRK (Workflow) — referenced in prose/branches even though it is not a
  // Document type; kept for parity with the pre-FEA-4137 recognizer alphabet.
  SlugPrefix.Workflow,
  SlugPrefix.Session,
];

/**
 * A regex-alternation fragment (`PRD|FEA|ISS|…`) of the referenceable slug
 * prefixes, longest-first so the engine prefers the most specific branch. Drop
 * it into a `RegExp` source (e.g. `` `\\b(${buildSlugPrefixAlternation()})-\\d+\\b` ``)
 * so every recognizer derives its accepted prefixes from the one SSOT above.
 */
export function buildSlugPrefixAlternation(): string {
  return [...new Set(REFERENCEABLE_SLUG_PREFIXES)]
    .sort((a, b) => b.length - a.length)
    .join("|");
}
