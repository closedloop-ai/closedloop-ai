import {
  type GlobalSearchResponse,
  SearchMode,
  UNIFIED_SEARCH_OPT_IN_PARAMS,
  type UnifiedSearchResponse,
} from "@repo/api/src/types/search";
import {
  isSupportedSearchType,
  type SearchEntityType,
} from "@repo/api/src/types/search-entity-kind";
import {
  hasStructuredFilters,
  type ParsedSearchQuery,
  parseSearchQuery,
} from "@repo/api/src/types/search-query";
import { uuidValidator } from "@/app/compute-targets/validators";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  successResponse,
} from "@/lib/route-utils";
import {
  clampSearchLimit,
  decodeCursor,
  searchFtsService,
  type UnifiedSearchParams,
} from "./search-fts-service";
import { searchService } from "./service";

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 200;

/**
 * GET /search — global search.
 *
 * Legacy contract (unchanged): `?q=<query>` runs the substring search over
 * documents + projects and returns `GlobalSearchResponse`; `?tagId=<uuid>`
 * returns tag-scoped documents.
 *
 * Unified FTS contract (FEA-3863): when any of `mode`, `types` (repeated),
 * `since`, `until`, or `cursor` is present, the request runs the full-text
 * query over the `search_document` projection and returns a heterogeneous ranked
 * `UnifiedSearchResponse` instead. Per-hit re-authorization is enforced in the
 * service (the index is not an access boundary).
 *
 * Accepts API key authentication (sk_live_) or Clerk session authentication.
 */
export const GET = withAnyAuth<
  GlobalSearchResponse | UnifiedSearchResponse,
  "/search"
>(async ({ user }, request) => {
  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get("q")?.trim();
    const tagId = searchParams.get("tagId")?.trim();

    if (tagId) {
      const parseResult = uuidValidator.safeParse(tagId);
      if (!parseResult.success) {
        return badRequestResponse("tagId must be a valid UUID");
      }
      const results = await searchService.searchByTag(
        user.organizationId,
        tagId
      );
      return successResponse(results);
    }

    if (!query) {
      return badRequestResponse("q is required");
    }
    if (query.length < MIN_QUERY_LENGTH) {
      return badRequestResponse("q must be at least 2 characters");
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return badRequestResponse("q must be 200 characters or fewer");
    }

    // The unified FTS path is taken when the caller opts in via an FTS param, OR
    // when the query itself carries inline query-language filters (`@owner`,
    // `:status`, …) that the legacy substring search cannot honor. Parse once
    // here to decide; `handleUnified` receives the parsed result (including any
    // exact ID/slug lookup, FEA-3930, which the service ranks first).
    //
    // A bare `?q=<id-or-slug>` with NO FTS opt-in and NO structured filters is
    // deliberately NOT diverted here: legacy q-only callers (the mobile search
    // overlay via `useGlobalSearch`, the MCP default `search` tool) read the
    // `GlobalSearchResponse` documents/projects shape, so silently returning a
    // `UnifiedSearchResponse` for `q=FEA-123` would show them zero results. The
    // real search UI opts into the unified path (it always sends `mode` via
    // `useUnifiedSearch`), so the exact-lookup boost still reaches that surface.
    const parsed = parseSearchQuery(query);
    if (
      isUnifiedRequest(searchParams) ||
      hasStructuredFilters(parsed.filters)
    ) {
      return handleUnified(user.organizationId, parsed, searchParams);
    }

    const results = await searchService.search(user.organizationId, query);
    return successResponse(results);
  } catch (error) {
    return errorResponse("Failed to search", error);
  }
});

/**
 * A request opts into the unified FTS path when it carries any of the new FTS
 * params. Absent them, `?q=` keeps its legacy shape (backward compatible).
 */
function isUnifiedRequest(searchParams: URLSearchParams): boolean {
  return UNIFIED_SEARCH_OPT_IN_PARAMS.some((param) => searchParams.has(param));
}

async function handleUnified(
  organizationId: string,
  parsed: ParsedSearchQuery,
  searchParams: URLSearchParams
) {
  // A malformed filter token is a 400 (never silently dropped).
  if (parsed.errors.length > 0) {
    return badRequestResponse(parsed.errors[0].message);
  }
  const rawMode = searchParams.get("mode");
  if (
    rawMode !== null &&
    rawMode !== SearchMode.Fulltext &&
    rawMode !== SearchMode.Prefix
  ) {
    return badRequestResponse(
      `mode must be one of: ${SearchMode.Fulltext}, ${SearchMode.Prefix}`
    );
  }
  const mode: SearchMode =
    rawMode === SearchMode.Prefix ? SearchMode.Prefix : SearchMode.Fulltext;

  // Repeated `types=document&types=loop` per AGENTS (not comma-joined). Any value
  // outside the Phase-1 corpus is rejected, never silently dropped. The `types[]`
  // query param is kept as a backward-compatible ALIAS for the inline `type:`
  // filter (FEA-4134): a skewed client that still sends `types[]` keeps working,
  // and a query mixing both (`?types=loop&q=type:document`) unions the two into
  // one corpus predicate (deduped, first-seen order). The parser already
  // validated the inline `type:` kinds; the `types[]` param is validated here.
  const types: SearchEntityType[] = [...(parsed.filters.type?.kinds ?? [])];
  const seenTypes = new Set<SearchEntityType>(types);
  const rawTypes = searchParams.getAll("types");
  for (const value of rawTypes) {
    if (!isSupportedSearchType(value)) {
      return badRequestResponse(`Unsupported types value: ${value}`);
    }
    if (!seenTypes.has(value)) {
      seenTypes.add(value);
      types.push(value);
    }
  }

  const since = parseDate(searchParams.get("since"));
  if (since === "invalid") {
    return badRequestResponse("since must be an ISO-8601 date");
  }
  const until = parseDate(searchParams.get("until"));
  if (until === "invalid") {
    return badRequestResponse("until must be an ISO-8601 date");
  }

  const limit = clampSearchLimit(numberParam(searchParams.get("limit")));
  const rawCursor = searchParams.get("cursor");
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;

  // The remaining free text (filter tokens removed) is the FTS query — empty is
  // valid when the query was all filters (FEA-3930).
  const params: UnifiedSearchParams = {
    organizationId,
    query: parsed.text,
    mode,
    types,
    since,
    until,
    limit,
    cursor,
    filters: parsed.filters,
    idLookup: parsed.idLookup,
  };
  const results = await searchFtsService.searchUnified(params);
  return successResponse(results);
}

/**
 * Parse an optional ISO date param. Returns null when absent, a `Date` when
 * valid, or the `"invalid"` sentinel when present-but-unparseable so the route
 * can 400.
 */
function parseDate(raw: string | null): Date | null | "invalid" {
  if (raw === null || raw.trim().length === 0) {
    return null;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "invalid" : date;
}

function numberParam(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? null : parsed;
}
