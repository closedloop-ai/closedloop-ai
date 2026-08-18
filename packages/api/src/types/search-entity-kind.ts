/**
 * The unified-search entity-kind discriminator, kept DEPENDENCY-FREE — this
 * module imports nothing — so the lightweight, browser-facing search query
 * parser ({@link parseSearchQuery} in `./search-query`, imported by the client
 * search intellisense) can validate a `type:` filter value against the corpus
 * kinds WITHOUT dragging the heavy `./search` contract (Zod + `./document` +
 * `./artifact`) into the search UI bundle. `./search` re-exports these symbols
 * so existing `@repo/api/src/types/search` importers are unaffected.
 */

/**
 * Discriminator for a row in the unified-search projection (`search_document`,
 * FEA-3857 / parent FEA-3800, PLN-1456 Slice 1). One member per entity type
 * indexed into the Postgres full-text projection.
 *
 * Phase-1 corpus (backed by a real projection row today): `Document`,
 * `Project`, `Loop`. The remaining members are **forward-declared** for the
 * Phase-2 corpus expansion so the discriminator — and any exhaustive `Record`
 * maps that switch on it — is stable before their write-hooks/backfill land;
 * nothing emits them yet.
 */
export const SearchEntityType = {
  Document: "document",
  Project: "project",
  Loop: "loop",
  /** Forward-declared (Phase 2, PLN-1456) — no projection rows emitted yet. */
  Comment: "comment",
  /** Forward-declared (Phase 2, PLN-1456) — no projection rows emitted yet. */
  PullRequest: "pull_request",
  /** Forward-declared (Phase 2, PLN-1456) — no projection rows emitted yet. */
  Branch: "branch",
  /**
   * AI session transcripts (FEA-3930). Emitted only when the owning org opts in
   * via `searchIncludeTranscripts` — transcript CONTENT is privacy-sensitive.
   * Routes to the session detail page (`/sessions/<id>`), id-keyed like loops.
   */
  AgentSession: "agent_session",
  /**
   * An org-scoped agentic component (skill/command/subagent/tool/mcp/hook —
   * FEA-4011). Each `AgentComponent` row is indexed by its own `organizationId`.
   * Routes to the component detail page (`/agents/<slug>`) where the slug is the
   * org-identity `${kind}::${normalizedKey}` handle carried in the projection's
   * `slug` column; degrades to a non-link when the slug is absent.
   */
  AgentComponent: "agent_component",
} as const;
export type SearchEntityType =
  (typeof SearchEntityType)[keyof typeof SearchEntityType];

/**
 * All {@link SearchEntityType} wire values as a tuple, for building the response
 * Zod schema's `entityType` enum (FEA-3873 review). Includes the forward-declared
 * Phase-2 members so a version-skewed response carrying one is accepted, not
 * dropped whole. Kept adjacent to the const so the two cannot drift.
 */
export const SEARCH_ENTITY_TYPE_VALUES = Object.values(SearchEntityType) as [
  SearchEntityType,
  ...SearchEntityType[],
];

/**
 * The corpus members the FTS query path actually returns — a runtime-usable
 * subset of {@link SearchEntityType}. The `GET /search` route validates an
 * inbound `types[]` filter (and, FEA-4134, an inline `type:` filter value)
 * against this set (via {@link isSupportedSearchType}) so a client may facet to
 * exactly these types; an unlisted value is rejected rather than silently
 * dropped.
 *
 * Document/Project/Loop are the Phase-1 corpus (backfill enumerates their source
 * tables directly). `AgentSession` (FEA-3930) is queryable too — its rows are
 * emitted only for orgs that opted into transcript search, and the query path
 * re-checks that gate — so a `types=agent_session` filter is honored, not 400'd.
 * `Comment`/`PullRequest`/`Branch` (FEA-3930 corpus slice) are DB-resident text
 * (comment bodies, PR title+description, branch name+description) backfilled and
 * write-hook-indexed like the Phase-1 corpus; all three are queryable.
 * `AgentComponent` (FEA-4011 Slice A) indexes each org-scoped agentic component
 * (name + description) and is queryable via the same write-hook + backfill path.
 */
export const PHASE_1_SEARCH_ENTITY_TYPES = [
  SearchEntityType.Document,
  SearchEntityType.Project,
  SearchEntityType.Loop,
  SearchEntityType.AgentSession,
  SearchEntityType.Comment,
  SearchEntityType.PullRequest,
  SearchEntityType.Branch,
  SearchEntityType.AgentComponent,
] as const;

/**
 * Validate an inbound `types[]` value (or an inline `type:` filter value) against
 * the queryable corpus. A value outside the supported set is rejected (the route
 * 400s; the frontend drops it) rather than silently treated as a valid filter.
 * Shared by the FTS query service, the `GET /search` route, the query parser, and
 * the unified-search UI so all agree on which corpus members are queryable today.
 */
export function isSupportedSearchType(
  value: string
): value is SearchEntityType {
  return (PHASE_1_SEARCH_ENTITY_TYPES as readonly string[]).includes(value);
}
