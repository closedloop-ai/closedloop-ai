import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  GlobalSearchResponse,
  UnifiedSearchResponse,
} from "@repo/api/src/types/search.js";
import {
  MAX_UNIFIED_SEARCH_LIMIT,
  type SearchHit,
  SearchMode,
  searchHitDeepLink,
  searchHitRoute,
} from "@repo/api/src/types/search.js";
import {
  PHASE_1_SEARCH_ENTITY_TYPES,
  type SearchEntityType,
} from "@repo/api/src/types/search-entity-kind.js";
import {
  hasStructuredFilters,
  parseSearchQuery,
} from "@repo/api/src/types/search-query.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  DOCUMENT_DOC_HELP,
  extractArrayItems,
  type McpUrlBuilder,
  readNumber,
  readString,
  withErrorHandling,
} from "./tool-utils.js";

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 200;

/** Shape a BasicUser assignee row, or null when absent. */
function shapeAssignee(value: unknown) {
  if (!value) {
    return null;
  }
  const raw = asRecord(value);
  return {
    id: readString(raw.id),
    email: readString(raw.email),
    firstName: readString(raw.firstName),
    lastName: readString(raw.lastName),
    avatarUrl: readString(raw.avatarUrl),
  };
}

/** Shape one API document search row for the legacy `search` MCP response. */
function shapeSearchDocument(value: unknown, urls: McpUrlBuilder) {
  const row = asRecord(value);
  return {
    id: readString(row.id),
    title: readString(row.title),
    slug: readString(row.slug),
    type: readString(row.type),
    status: readString(row.status),
    priority: readString(row.priority),
    projectName: readString(row.projectName),
    assignee: shapeAssignee(row.assignee),
    updatedAt: readString(row.updatedAt),
    webUrl: urls.buildDocumentUrlFromRecord(row),
  };
}

/** Shape one API project search row for the legacy `search` MCP response. */
function shapeSearchProject(value: unknown) {
  const row = asRecord(value);
  return {
    id: readString(row.id),
    name: readString(row.name),
    slug: readString(row.slug),
    status: readString(row.status),
    priority: readString(row.priority),
    teamName: readString(row.teamName),
    teamId: readString(row.teamId),
    assignee: shapeAssignee(row.assignee),
    updatedAt: readString(row.updatedAt),
  };
}

/**
 * Shape one unified search hit into a compact per-hit MCP result. The value is a
 * raw JSON row off the wire (its `updatedAt` is an ISO string, not a `Date`, and
 * every field is untrusted), so it is narrowed with the same `asRecord`/`readString`
 * helpers as the sibling document/project shapers rather than typed as `SearchHit`.
 */
function shapeSearchHit(value: unknown, urls: McpUrlBuilder) {
  const row = asRecord(value);
  const entityType = readString(row.entityType);
  const entityId = readString(row.entityId);
  const resolvedRoute = resolveHitRoute(row, entityType, entityId);
  return {
    entityType,
    entityId,
    title: readString(row.title),
    snippet: readString(row.snippet),
    rank: readNumber(row.rank),
    updatedAt: readString(row.updatedAt),
    // Prefer the routable Phase-2 path (type+slug / team-scoped / loop-by-id);
    // fall back to the server `deepLink`, then the shared UUID-only builder.
    webUrl: resolvedRoute === null ? null : urls.withOrgPrefix(resolvedRoute),
  };
}

/**
 * Resolve a unified hit's org-relative route from the untrusted wire row.
 * Prefers the Phase-2 route built from `slug`/`entitySubtype`/`teamId` (via the
 * shared {@link searchHitRoute}); falls back to the server-provided legacy
 * `deepLink`, then to the UUID-only {@link searchHitDeepLink} for a known type.
 */
function resolveHitRoute(
  row: Record<string, unknown>,
  entityType: string | null,
  entityId: string | null
): string | null {
  if (isPhase1SearchEntityType(entityType) && entityId !== null) {
    const hit: SearchHit = {
      entityType: entityType as SearchEntityType,
      entityId,
      title: readString(row.title) ?? "",
      snippet: readString(row.snippet) ?? "",
      rank: readNumber(row.rank) ?? 0,
      updatedAt: new Date(readString(row.updatedAt) ?? 0),
      deepLink: readString(row.deepLink) ?? "",
      slug: readString(row.slug) ?? undefined,
      entitySubtype: readString(row.entitySubtype) ?? undefined,
      teamId: readString(row.teamId) ?? undefined,
      // Pull-request and comment hits route through their anchor (branch /
      // session artifact id); without carrying `anchorEntityId` here,
      // `searchHitRoute` can never build their Phase-2 route and every such hit
      // silently falls back to the legacy deepLink.
      anchorEntityId: readString(row.anchorEntityId) ?? undefined,
    };
    const route = searchHitRoute(hit);
    if (route !== null) {
      return route;
    }
  }
  const deepLink = readString(row.deepLink);
  if (deepLink !== null) {
    return deepLink;
  }
  return isPhase1SearchEntityType(entityType) && entityId !== null
    ? searchHitDeepLink(entityType, entityId)
    : null;
}

/** Narrow an untrusted `entityType` string to a Phase-1 corpus member. */
function isPhase1SearchEntityType(
  value: string | null
): value is (typeof PHASE_1_SEARCH_ENTITY_TYPES)[number] {
  return (
    value !== null &&
    (PHASE_1_SEARCH_ENTITY_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Run the legacy documents+projects search (no unified inputs supplied) and
 * shape the `GlobalSearchResponse`.
 */
async function runLegacySearch(
  apiClient: ApiClient,
  q: string,
  urls: McpUrlBuilder
) {
  const response = await apiClient.get<GlobalSearchResponse>("/search", { q });
  const record = asRecord(response);
  const documents = extractArrayItems<unknown>(record.documents ?? []).map(
    (item) => shapeSearchDocument(item, urls)
  );
  const projects = extractArrayItems<unknown>(record.projects ?? []).map(
    shapeSearchProject
  );
  return {
    query: readString(record.query) ?? q,
    documentCount: documents.length,
    projectCount: projects.length,
    documents,
    projects,
  };
}

/**
 * Run the unified FTS search across the whole Phase-1 corpus
 * (documents/projects/loops) and shape the ranked `UnifiedSearchResponse`.
 */
async function runUnifiedSearch(
  apiClient: ApiClient,
  q: string,
  mode: SearchMode,
  types: readonly string[],
  limit: number | undefined,
  cursor: string | undefined,
  urls: McpUrlBuilder
) {
  const query: Record<string, string | readonly string[]> = { q, mode };
  if (types.length > 0) {
    query.types = types;
  }
  // Forward paging inputs so an agent can raise the page size past the server
  // default and follow a prior page's `nextCursor` (both honored on the route's
  // unified path). Query params are strings; the route clamps `limit`.
  if (limit !== undefined) {
    query.limit = String(limit);
  }
  if (cursor !== undefined) {
    query.cursor = cursor;
  }
  const response = await apiClient.get<UnifiedSearchResponse>("/search", query);
  const record = asRecord(response);
  const results = extractArrayItems<unknown>(record.results ?? []).map((item) =>
    shapeSearchHit(item, urls)
  );
  return {
    mode: readString(record.mode) ?? mode,
    query: readString(record.query) ?? q,
    resultCount: results.length,
    nextCursor: readString(record.nextCursor),
    results,
  };
}

/**
 * Register the search tool on the given MCP server. Calls `GET /search`.
 *
 * Default (plain-text `q`): the legacy documents + projects response. The
 * unified full-text search over the Phase-1 corpus (documents, projects, loops,
 * …) — ranked heterogeneous hits — runs when `mode` or `types` is supplied OR
 * when `q` itself carries inline query-language filters (`type:`, `@owner`,
 * `:status`, …), which the shared decoder detects (FEA-4134/FEA-4151).
 */
export function registerSearch(
  server: McpServer,
  apiClient: ApiClient,
  urls: McpUrlBuilder
): void {
  server.registerTool(
    "search",
    {
      description: `Full-text search across the platform. Default returns documents (by title, slug, type, tag) and projects (by name, slug, description). Pass \`mode\`/\`types\` — or inline query-language filters in \`q\` such as \`type:loop\`, \`@owner\`, or \`status:TODO\` — to run the unified full-text search across documents, projects, and loops with ranked results and highlighted snippets. ${DOCUMENT_DOC_HELP} Returned \`slug\` values are the preferred user-facing handles for follow-up calls.`,
      inputSchema: {
        q: z
          .string()
          .min(MIN_QUERY_LENGTH)
          .max(MAX_QUERY_LENGTH)
          .describe(
            `Free-text search query (${MIN_QUERY_LENGTH}-${MAX_QUERY_LENGTH} characters).`
          ),
        mode: z
          .enum([SearchMode.Fulltext, SearchMode.Prefix])
          .optional()
          .describe(
            `Search mode. \`${SearchMode.Fulltext}\` (default) is phrase/operator-aware full-text; \`${SearchMode.Prefix}\` is typeahead (matches a partially-typed trailing word). Supplying this runs the unified corpus search.`
          ),
        types: z
          .array(z.enum(PHASE_1_SEARCH_ENTITY_TYPES))
          .optional()
          .describe(
            `Restrict the unified search to these entity types (${PHASE_1_SEARCH_ENTITY_TYPES.join(", ")}). Omit for all. Supplying this runs the unified corpus search.`
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_UNIFIED_SEARCH_LIMIT)
          .optional()
          .describe(
            `Unified-search page size (1-${MAX_UNIFIED_SEARCH_LIMIT}). Applies only to the unified corpus search; omit for the server default. Ignored by the default documents+projects search.`
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            "Continuation token from a prior response's `nextCursor` to fetch the next page of unified results. Supplying this runs the unified corpus search; re-send the same `q`/`mode`/`types` alongside it."
          ),
      },
    },
    ({ q, mode, types, limit, cursor }) =>
      withErrorHandling(async () => {
        // Structured `type:`/`@owner`/`:status` filters typed INLINE in `q` route
        // through the unified corpus search — matching the `GET /search` route,
        // which parses `q` with the same shared decoder and diverts to the
        // unified path when it carries structured filters (FEA-4134/FEA-4151).
        // Without this, a `q=type:loop` query with no `mode`/`types` param falls
        // to the legacy documents+projects path, whose corpus never matches the
        // inline filter and silently returns an empty payload.
        const parsed = parseSearchQuery(q);
        // `cursor` opts into the unified path (matching the route's own
        // `isUnifiedRequest`) so a continuation call carrying only `q`+`cursor`
        // still pages the unified corpus instead of dead-ending on the legacy
        // path. `limit` deliberately does NOT opt in (mirroring the route): it is
        // a page-size modifier, not a response-shape switch, and the legacy path
        // can't page anyway.
        const useUnified =
          mode !== undefined ||
          types !== undefined ||
          cursor !== undefined ||
          hasStructuredFilters(parsed.filters);
        // The RAW `q` is forwarded to `GET /search`: the route re-parses it with
        // the same shared decoder, lifts the inline `type:`/`@owner`/`:status`
        // tokens into predicates itself, and unions any inline `type:` kinds with
        // the explicit `types[]` param (deduped). Sending the parsed remainder or
        // re-extracting the kinds here would double-handle the filters and drop
        // the free-text remainder the route expects to strip. We only decide the
        // RESPONSE SHAPE (unified vs legacy) locally; a `mode` is still sent so a
        // bare `q=type:loop` (no `mode` param) reaches the unified path
        // deterministically instead of relying on the route's own divert.
        const payload = useUnified
          ? await runUnifiedSearch(
              apiClient,
              q,
              mode ?? SearchMode.Fulltext,
              types ?? [],
              limit,
              cursor,
              urls
            )
          : await runLegacySearch(apiClient, q, urls);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(payload, null, 2) },
          ],
        };
      })
  );
}
