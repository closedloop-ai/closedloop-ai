import { z } from "zod";
import { ArtifactType } from "./artifact";
import type { Priority } from "./common";
import {
  type ArtifactStatus,
  type DocumentType,
  getRoutePrefixForType,
} from "./document";
import {
  BRANCH_DETAIL_TAB_PARAM,
  BranchDetailTabParam,
} from "./notification-routes";
import type { ProjectStatus } from "./project";
import {
  SEARCH_ENTITY_TYPE_VALUES,
  SearchEntityType,
} from "./search-entity-kind";
import type { BasicUser } from "./user";

export type DocumentSearchResult = {
  id: string;
  title: string;
  slug: string;
  type: DocumentType;
  // Either vocabulary depending on `type` (Documents vs Features). PRD-495.
  status: ArtifactStatus;
  priority: Priority | null;
  projectName: string | null;
  assignee: BasicUser | null;
  updatedAt: Date;
};

export type ProjectSearchResult = {
  id: string;
  name: string;
  slug: string | null;
  status: ProjectStatus;
  priority: Priority | null;
  teamName: string | null;
  teamId: string | null;
  assignee: BasicUser | null;
  updatedAt: Date;
};

export type GlobalSearchResponse = {
  query: string;
  documents: DocumentSearchResult[];
  projects: ProjectSearchResult[];
  /** Present when the search was scoped to a specific tag. */
  tagId?: string;
  tagName?: string;
};

/**
 * The unified-search entity-kind discriminator, its wire-value tuple, the
 * queryable-corpus list, and the `isSupportedSearchType` guard now live in the
 * dependency-free `./search-entity-kind` module (FEA-4134) so the lightweight
 * query parser can import them without pulling Zod/`./document` into the search
 * UI bundle. Import those four symbols directly from `./search-entity-kind`
 * (`@repo/api/src/types/search-entity-kind`) — they are intentionally NOT
 * re-exported here (a re-export would make this a Biome barrel file). `search.ts`
 * itself imports them above for its own Zod schema and route helpers.
 */

/**
 * Query mode for the unified `GET /search` FTS path (FEA-3863, PLN-1456 Slice
 * 3). `Fulltext` runs `websearch_to_tsquery` (phrase/operator-aware, default);
 * `Prefix` is typeahead — the trailing token is matched as a `:*` prefix so a
 * partially-typed word still matches.
 */
export const SearchMode = {
  Fulltext: "fulltext",
  Prefix: "prefix",
} as const;
export type SearchMode = (typeof SearchMode)[keyof typeof SearchMode];

/**
 * One heterogeneous, ranked hit in the unified search response. Spans the whole
 * Phase-1 corpus (documents/projects/loops); the `entityType` discriminates and
 * `deepLink` is the in-app route to the entity.
 */
export type SearchHit = {
  entityType: SearchEntityType;
  entityId: string;
  title: string;
  /** Highlighted excerpt (`ts_headline`) or a plain title fallback. */
  snippet: string;
  /** `ts_rank_cd` relevance score; higher is more relevant. */
  rank: number;
  /** The source entity's own `updatedAt` (mirrored in the projection). */
  updatedAt: Date;
  /**
   * Legacy UUID-only deep link (e.g. `/documents/<id>`). Kept for back-compat
   * with consumers that predate the route fields below; new surfaces prefer
   * {@link searchHitRoute}, which builds an actually-web-routable path from
   * `slug`/`entitySubtype`/`teamId` and falls back to this only for loops.
   */
  deepLink: string;
  /**
   * Route-building fields (Phase-2 navigation slice). All optional so an older
   * API deploy that predates them still satisfies the contract, and a hit
   * missing the data it needs degrades to a non-link row:
   *   - `slug` — the entity's URL handle (the web app routes documents by slug,
   *     not by UUID; projects carry a slug but route by id).
   *   - `entitySubtype` — a document's `type` (PRD/IMPLEMENTATION_PLAN/FEATURE),
   *     used to pick the route prefix. Absent for projects/loops.
   *   - `teamId` — a project's owning team, for the team-scoped project route.
   *     Absent for documents/loops.
   *   - `anchorEntityId` — the id of a DIFFERENT entity this hit routes to when
   *     the hit is not itself the navigation target (FEA-3930 corpus slice). A
   *     `pull_request` hit routes to its owning branch (anchor = branch artifact
   *     id); a `comment` hit routes to the artifact it is anchored on (anchor =
   *     that artifact's id, with `entitySubtype` carrying the anchor artifact's
   *     TYPE so the route helper can pick session vs branch). Absent for
   *     documents/projects/loops/sessions/branches, which route off `entityId`.
   */
  slug?: string;
  entitySubtype?: string;
  teamId?: string;
  anchorEntityId?: string;
};

/**
 * The unified full-text search response (FEA-3863). Ships ALONGSIDE the legacy
 * {@link GlobalSearchResponse}: the `?q=`/`?tagId=` params still return the
 * legacy shape, while the new FTS params (`mode`, `types[]`, `since`/`until`,
 * `limit`/`cursor`) return this heterogeneous ranked shape.
 */
export type UnifiedSearchResponse = {
  query: string;
  mode: SearchMode;
  results: SearchHit[];
  /** Opaque cursor for the next page, or null when the result set is drained. */
  nextCursor: string | null;
};

/**
 * Zod schema for {@link SearchHit} — validates the wire shape before it reaches
 * the render tree (FEA-3873 review: guard against version-skewed responses). The
 * route fields are optional so an older API deploy that omits them still parses.
 * The concrete shape is inlined so `z.infer` stays precise; the `satisfies`
 * guard below proves every `SearchHit` key is covered so adding a field to the
 * type fails `tsc` here until the schema is taught it (without widening infer).
 */
const searchHitSchemaShape = {
  entityType: z.enum(SEARCH_ENTITY_TYPE_VALUES),
  entityId: z.string(),
  title: z.string(),
  snippet: z.string(),
  rank: z.number(),
  // Accept both a raw ISO string and an already-revived `Date`: the web
  // `apiClient` runs `JSON.parse(..., reviveWithDates)`, so `updatedAt` is a
  // `Date` by the time this schema parses, while other consumers (MCP, tests)
  // pass the raw string. A bare `z.string()` rejected the revived `Date` and
  // threw on every unified-search response.
  updatedAt: z
    .union([z.string(), z.date()])
    .transform((v) => (v instanceof Date ? v : new Date(v))),
  deepLink: z.string(),
  slug: z.string().optional(),
  entitySubtype: z.string().optional(),
  teamId: z.string().optional(),
  anchorEntityId: z.string().optional(),
} satisfies Record<keyof SearchHit, z.ZodTypeAny>;
export const searchHitSchema = z.object(searchHitSchemaShape);

/**
 * Forward-compatible results parser (FEA-4011 version-skew review). The corpus
 * grows over time — a new API can start emitting a hit whose `entityType` an
 * OLDER web bundle's `SEARCH_ENTITY_TYPE_VALUES` does not know yet (e.g. an old
 * bundle receiving the new `agent_component` hit). A plain `z.array(hitSchema)`
 * would reject the ONE unknown hit and, because array parsing is all-or-nothing,
 * drop EVERY result. Instead, parse each hit independently and keep the ones the
 * running bundle understands, silently skipping any it cannot (unknown corpus
 * type or otherwise malformed). A stale client thus degrades to "shows the types
 * it knows" rather than a blank result set. On a current build no hit is skipped
 * (every emitted type is in the enum).
 */
const forwardCompatibleResultsSchema = z
  .array(z.unknown())
  .transform((rawHits) => {
    const hits: SearchHit[] = [];
    for (const rawHit of rawHits) {
      const parsed = searchHitSchema.safeParse(rawHit);
      if (parsed.success) {
        hits.push(parsed.data);
      }
    }
    return hits;
  });

/**
 * Zod schema for {@link UnifiedSearchResponse} — validates the full API
 * response shape including nested hits (FEA-3873 review). Hits with an
 * unrecognized `entityType` are dropped rather than failing the whole response,
 * so an older client stays forward-compatible with a newer corpus (FEA-4011).
 */
export const unifiedSearchResponseSchema = z.object({
  query: z.string(),
  mode: z.enum([SearchMode.Fulltext, SearchMode.Prefix]),
  results: forwardCompatibleResultsSchema,
  nextCursor: z.string().nullable(),
});

/**
 * Org-relative deep-link path fragment for a search hit. The API does not know
 * the requester's org slug, so surfaces (web renderer, MCP) prepend their own
 * org/base prefix. Kept here as the single source of truth for the per-type
 * route segment so the query service and any consumer agree.
 *
 * ROUTABILITY (FEA-3863): built from the projection's `entityId` (a UUID) alone.
 * `/loops/<id>` resolves directly (the web loop route is id-keyed). Document and
 * project fragments are BEST-EFFORT locators, NOT guaranteed web-routable yet:
 * the web app routes documents by type-specific slug (`/prds|/features/<slug>`,
 * or the `/documents/<slug>` catch-all that resolves via `by-slug`) and projects
 * under their team (`/teams/<teamId>/projects/<id>`). The Phase-1 projection is
 * metadata-first and carries neither the slug/type nor the team, so a fully
 * type-/team-aware link is deferred to the query-side slice that joins that
 * route data. Consumers must treat a returned fragment as a hint, not a promise
 * that the target resolves at that exact path.
 */
export function searchHitDeepLink(
  entityType: SearchEntityType,
  entityId: string
): string {
  switch (entityType) {
    case SearchEntityType.Document:
      return `/documents/${entityId}`;
    case SearchEntityType.Project:
      return `/projects/${entityId}`;
    case SearchEntityType.Loop:
      return `/loops/${entityId}`;
    case SearchEntityType.AgentSession:
      // Session detail is id-keyed (the entityId is the session's artifactId).
      return `/sessions/${entityId}`;
    case SearchEntityType.Branch:
      // Branch detail is id-keyed on the branch's artifact id (entityId).
      return `/branches/${entityId}`;
    // Comment and PullRequest route to a DIFFERENT entity (the anchored artifact
    // / owning branch), which this UUID-only locator does not carry — the real
    // route is built by {@link searchHitRoute} from `anchorEntityId`. Fall back
    // to the global-search locator so the deep link never 404s a bare UUID.
    // AgentComponent routes to `/agents/<slug>`, and this locator carries only
    // the UUID `entityId`, not the org-identity slug — so it likewise falls back
    // to the global-search locator (the real route is built by
    // {@link searchHitRoute} from `slug`).
    case SearchEntityType.Comment:
    case SearchEntityType.PullRequest:
    case SearchEntityType.AgentComponent:
      return `/search?entity=${entityId}`;
    default: {
      const exhaustive: never = entityType;
      return exhaustive;
    }
  }
}

/**
 * Build the ORG-RELATIVE, actually-web-routable path for a search hit from its
 * Phase-2 route fields, or null when the hit lacks the data to build one safely
 * (so the consumer renders a non-link row rather than a 404-bound link). Unlike
 * {@link searchHitDeepLink} — the UUID-only best-effort locator — this resolves
 * the real app route:
 *   - Document → `/<prefix>/<slug>` (`/prds|/implementation-plans|/features`),
 *     needing both `slug` and a routable `entitySubtype`.
 *   - Project  → `/teams/<teamId>/projects/<entityId>` (team-scoped), needing
 *     `teamId`.
 *   - Loop     → `/loops/<entityId>` (the loop route is id-keyed).
 *   - AgentSession → `/sessions/<entityId>` (session detail is id-keyed).
 *   - Branch   → `/branches/<entityId>` (branch detail is id-keyed on the
 *     branch's artifact id).
 *   - PullRequest → `/branches/<anchorEntityId>` (a PR is nested state on its
 *     owning branch; anchor = the branch artifact id), needing `anchorEntityId`.
 *   - Comment  → the artifact it is anchored on: `/sessions/<anchorEntityId>` or
 *     `/branches/<anchorEntityId>?tab=sessions-timeline`, chosen by the anchor
 *     artifact's TYPE in `entitySubtype`; needs both. Document-anchored (and
 *     unknown-type) comments are not routable here and degrade to a non-link.
 *   - AgentComponent → `/agents/<slug>` (component detail is slug-keyed on the
 *     org-identity `${kind}::${normalizedKey}` handle), needing `slug`.
 *
 * The single source of truth for building each type's route so the query
 * service, the MCP tool, and the web/desktop renderer cannot drift. Surfaces
 * prepend their own org slug (the API cannot know the requester's org).
 */
export function searchHitRoute(hit: SearchHit): string | null {
  switch (hit.entityType) {
    case SearchEntityType.Document: {
      const prefix =
        hit.entitySubtype === undefined
          ? null
          : getRoutePrefixForType(hit.entitySubtype);
      if (prefix === null || hit.slug === undefined) {
        return null;
      }
      return `/${prefix}/${hit.slug}`;
    }
    case SearchEntityType.Project:
      return hit.teamId === undefined
        ? null
        : `/teams/${hit.teamId}/projects/${hit.entityId}`;
    case SearchEntityType.Loop:
      return `/loops/${hit.entityId}`;
    case SearchEntityType.AgentSession:
      // Session detail is id-keyed (the entityId is the session's artifactId),
      // so — like loops — it needs no slug/team to build a routable path.
      return `/sessions/${hit.entityId}`;
    case SearchEntityType.Branch:
      // Branch detail is id-keyed on the branch's artifact id (entityId).
      return `/branches/${hit.entityId}`;
    case SearchEntityType.PullRequest:
      // A PR is nested state on its owning branch — route to the branch detail
      // (anchor = branch artifact id). Non-link when the anchor is absent.
      return hit.anchorEntityId === undefined
        ? null
        : `/branches/${hit.anchorEntityId}`;
    case SearchEntityType.Comment:
      return commentSearchHitRoute(hit);
    case SearchEntityType.AgentComponent:
      // Component detail is slug-keyed (`/agents/<slug>`, slug = the
      // org-identity `${kind}::${normalizedKey}` handle). Non-link when the
      // projection carries no slug, mirroring the document arm's null handling.
      // The slug is only trimmed by the sync validator, so a `componentKey`
      // carrying `/`, `?`, or `#` would otherwise split the path/query/fragment
      // — encode it so the whole handle stays one `[slug]` segment.
      return hit.slug === undefined
        ? null
        : `/agents/${encodeURIComponent(hit.slug)}`;
    default: {
      const exhaustive: never = hit.entityType;
      return exhaustive;
    }
  }
}

/**
 * Route a `comment` search hit to the artifact it is anchored on. The comment's
 * projection carries the ANCHOR artifact's id in `anchorEntityId` and the anchor
 * artifact's TYPE in `entitySubtype` (an {@link ArtifactType} value). A comment
 * anchored on a SESSION routes to `/sessions/<anchor>`; one anchored on a BRANCH
 * routes to the branch detail with the trace-comments rail open
 * (`?tab=sessions-timeline`, where native trace comments live). A comment on a
 * DOCUMENT (or with an absent/unknown anchor) is not routable off the projection
 * alone — the document route needs the doc's slug+subtype, which the comment row
 * does not carry — so it degrades to a non-link row rather than a 404.
 */
function commentSearchHitRoute(hit: SearchHit): string | null {
  if (hit.anchorEntityId === undefined) {
    return null;
  }
  switch (hit.entitySubtype) {
    case ArtifactType.Session:
      return `/sessions/${hit.anchorEntityId}`;
    case ArtifactType.Branch:
      return `/branches/${hit.anchorEntityId}?${BRANCH_DETAIL_TAB_PARAM}=${BranchDetailTabParam.SessionsTimeline}`;
    default:
      return null;
  }
}

/**
 * Bound on a projected `search_document` title. The write-time index hooks and
 * the one-shot backfill both trim to this cap so a pathological name cannot
 * bloat the row or its generated `tsv`. (FEA-3863 / PLN-1456.)
 */
export const MAX_SEARCH_TITLE_CHARS = 500;

/**
 * Cap on the searchable `body` snippet. The Phase-1 corpus is METADATA-FIRST: a
 * loop's `prompt` or a long project description can be multiple KB, and the
 * Postgres GENERATED `tsv` recomputes over `title || body` on every write — so an
 * unbounded body would bloat every row's vector and slow writes.
 */
export const MAX_SEARCH_BODY_CHARS = 2000;

/**
 * Inclusive upper bound on a unified-search page size — the SSOT for the cap
 * enforced at every unified-search boundary. The API service clamps a requested
 * `limit` to this ceiling (`apps/api/app/search/search-fts-service.ts`) and the
 * MCP `search` tool guards its `limit` input against it, both importing this one
 * constant so the two boundaries move together.
 */
export const MAX_UNIFIED_SEARCH_LIMIT = 100;

/**
 * The `GET /search` query params whose mere PRESENCE opts a request out of the
 * legacy {@link GlobalSearchResponse} shape and into the heterogeneous
 * {@link UnifiedSearchResponse}. `limit` is deliberately absent: it tunes an
 * already-unified request but does not by itself switch the response shape.
 * The route branches on this list and the published REST reference documents
 * it, so a param added here cannot silently go undocumented (ISS-6044).
 */
export const UNIFIED_SEARCH_OPT_IN_PARAMS = [
  "mode",
  "types",
  "since",
  "until",
  "cursor",
] as const;

/**
 * Trim a projection text field to `max` chars. Returns null for a null/blank
 * source so the projection stores SQL NULL rather than an empty string (the
 * generated vector already COALESCEs null to ''). Shared by the write-time
 * index hooks (`apps/api`) and the backfill (`packages/database`) so the two
 * cannot drift.
 */
export function boundSearchText(
  raw: string | null,
  max: number
): string | null {
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}
