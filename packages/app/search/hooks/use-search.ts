"use client";

import type {
  GlobalSearchResponse,
  SearchMode,
  UnifiedSearchResponse,
} from "@repo/api/src/types/search";
import {
  MAX_UNIFIED_SEARCH_LIMIT,
  SearchMode as SearchModeValues,
  unifiedSearchResponseSchema,
} from "@repo/api/src/types/search";
import type { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { clamp } from "@repo/api/src/utils/math";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { ApiError, getErrorMessage } from "../../shared/api/api-error";
import { useApiClient } from "../../shared/api/use-api-client";
import {
  isOfferedSearchHit,
  type OfferedSearchHit,
} from "../lib/search-display";

export const searchKeys = {
  all: ["search"] as const,
  query: (q: string) => [...searchKeys.all, "q", q] as const,
  tag: (tagId: string) => [...searchKeys.all, "tag", tagId] as const,
  unified: (params: UnifiedSearchKeyParams) =>
    [...searchKeys.all, "unified", params] as const,
};

type UseGlobalSearchParams = {
  query?: string;
  tagId?: string;
};

export function useGlobalSearch(
  params: UseGlobalSearchParams,
  options?: Omit<UseQueryOptions<GlobalSearchResponse>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();
  const trimmed = (params.query ?? "").trim();
  const tagId = params.tagId?.trim();

  const isTagSearch = !!tagId;
  const isTextSearch = !!trimmed;

  const queryKey = isTagSearch
    ? searchKeys.tag(tagId)
    : searchKeys.query(trimmed);

  const queryFn = isTagSearch
    ? () =>
        apiClient.get<GlobalSearchResponse>(
          `/search?tagId=${encodeURIComponent(tagId)}`
        )
    : () =>
        apiClient.get<GlobalSearchResponse>(
          `/search?q=${encodeURIComponent(trimmed)}`
        );

  return useQuery({
    queryKey,
    queryFn,
    enabled: isTagSearch || isTextSearch,
    staleTime: 30_000,
    ...options,
  });
}

type UnifiedSearchKeyParams = {
  query: string;
  mode: SearchMode;
  types: SearchEntityType[];
  limit: number | undefined;
};

export type UseUnifiedSearchParams = {
  /** Free-text query. Requests are gated until it is at least 2 chars. */
  query?: string;
  /**
   * `Fulltext` (default) runs the phrase/operator-aware query; `Prefix` is the
   * typeahead mode where the trailing token matches as a `:*` prefix.
   */
  mode?: SearchMode;
  /** Corpus filter; empty means "all Phase-1 types". */
  types?: SearchEntityType[];
  /** Page size; normalized to the server's `[1, MAX_UNIFIED_SEARCH_LIMIT]` contract before it reaches the cache key or request. */
  limit?: number;
};

/**
 * The unified FTS search hook (FEA-3873 / parent FEA-3800, PLN-1456 Slice 5).
 * Consumes the `GET /search` full-text path, passing `mode`, repeated
 * `types[]`, and `limit`, and returns the ranked heterogeneous
 * {@link UnifiedSearchResponse} (documents, projects and the other offered
 * kinds, with snippet + deep link). Repeated `types=document&types=project`
 * params match the route contract.
 */
export function useUnifiedSearch(
  params: UseUnifiedSearchParams,
  options?: Omit<
    UseQueryOptions<OfferedUnifiedSearchResponse>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();
  const trimmed = (params.query ?? "").trim();
  const mode = params.mode ?? SearchModeValues.Fulltext;
  const types = params.types ?? [];
  const limit = normalizeUnifiedSearchLimit(params.limit);

  const isEnabled = trimmed.length >= MIN_UNIFIED_QUERY_LENGTH;

  const queryKey = searchKeys.unified({
    query: trimmed,
    mode,
    types,
    limit,
  });

  const queryFn = async (): Promise<OfferedUnifiedSearchResponse> => {
    const search = new URLSearchParams();
    search.set("q", trimmed);
    search.set("mode", mode);
    for (const type of types) {
      search.append("types", type);
    }
    if (limit !== undefined) {
      search.set("limit", String(limit));
    }
    const response = await apiClient.get<UnifiedSearchResponse>(
      `/search?${search.toString()}`
    );
    const parsed = unifiedSearchResponseSchema.parse(response);
    return { ...parsed, results: parsed.results.filter(isOfferedSearchHit) };
  };

  return useQuery({
    queryKey,
    queryFn,
    enabled: isEnabled,
    staleTime: 30_000,
    ...options,
  });
}

/**
 * The minimum trimmed query length before a unified-search request fires; must
 * match the server's `MIN_QUERY_LENGTH` in `apps/api/app/search/route.ts`
 * (currently 2). The route 400s a single-char `q`, so gating the request at the
 * same floor avoids firing a request that can only fail. Exported so result
 * surfaces (e.g. the mobile overlay) gate their "results" branch at the SAME
 * floor and never render a false "No results" state for a query the hook is
 * still idle on.
 */
export const MIN_UNIFIED_QUERY_LENGTH = 2;

/**
 * Whether a failed unified-search query is a malformed-filter 400, whose message
 * the route builds from {@link parseSearchQuery}'s errors and is safe to show
 * inline (e.g. "Unknown priority value: huge"). Restricted to 400 on purpose:
 * the route only ever 400s for a bad query/filter, so a 401/403/404/429 (auth,
 * missing, rate-limit) must NOT be shown verbatim as a filter banner — those,
 * and any 5xx, fall through to the caller's generic error copy.
 */
export function isSearchFilterError(error: unknown): boolean {
  return (
    error instanceof ApiError && error.status === SEARCH_FILTER_ERROR_STATUS
  );
}

// The search route surfaces every malformed-query/filter failure as a 400
// (`badRequestResponse` in apps/api/app/search/route.ts). Other 4xx codes are
// auth/not-found/rate-limit and are not safe-to-show filter messages.
const SEARCH_FILTER_ERROR_STATUS = 400;

export type SearchPanelState = {
  /** Ranked heterogeneous hits (empty until the query settles). */
  results: OfferedSearchHit[];
  /** True while the first page is loading. */
  isLoading: boolean;
  /**
   * True while a RETRY of a failed query is in flight (davetho review).
   *
   * `isLoading` covers the initial request alone, so after a failure `refetch()`
   * leaves it false while `isError` stays latched — and a surface that reads
   * only those two keeps showing the settled failure, and its retry button,
   * during the retry it just started. That is the same "renders as the failure
   * it is already fixing" the desktop producer avoids by clearing its resolved
   * query; the web path had no equivalent. Kept as a named fact rather than
   * leaving each consumer to compose `isError && isFetching` for itself.
   */
  isRetrying: boolean;
  /** True when the query settled in a (non-filter) error state. */
  isError: boolean;
  /**
   * Safe-to-show message for a malformed inline filter (the 400 body). Absent
   * for non-filter errors, which fall back to the generic error copy.
   */
  filterErrorMessage: string | undefined;
  /** Continuation cursor from the server, present when more hits exist. */
  nextCursor: string | null | undefined;
  /**
   * Re-runs the underlying query. Wired to the load-error "Try again" action so
   * a retry actually re-invokes the query function — replacing the URL with the
   * already-active value would not, because the query key is unchanged.
   */
  refetch: () => void;
};

/**
 * The shared unified-search panel state consumed by both the `/search` page
 * panel and the mobile search sheet: runs {@link useUnifiedSearch} and derives
 * the `results`, loading/error flags, and the inline `filterErrorMessage` from
 * one place so the two surfaces cannot drift on how they classify a 400 filter
 * error or unwrap the response. UI treatment (facets, layout) stays per-surface.
 */
export function useSearchPanelState(
  params: UseUnifiedSearchParams
): SearchPanelState {
  const { data, isLoading, isFetching, isError, error, refetch } =
    useUnifiedSearch(params);

  const filterErrorMessage = isSearchFilterError(error)
    ? getErrorMessage(error)
    : undefined;

  return {
    results: data?.results ?? [],
    isLoading,
    isRetrying: isError && isFetching,
    isError,
    filterErrorMessage,
    nextCursor: data?.nextCursor,
    refetch: () => {
      refetch();
    },
  };
}

/**
 * Mirrors the server's `clampSearchLimit` so the cache key and the request URL
 * both describe the page size the API will actually apply. `NaN` resolves to an
 * omitted param rather than a serialized `limit=NaN`, because the route parses
 * that as absent and falls back to its own default page size.
 */
function normalizeUnifiedSearchLimit(
  raw: number | undefined
): number | undefined {
  if (raw === undefined || Number.isNaN(raw)) {
    return undefined;
  }
  return clamp(Math.floor(raw), 1, MAX_UNIFIED_SEARCH_LIMIT);
}

/** The unified search response, holding only the kinds this build offers. */
export type OfferedUnifiedSearchResponse = Omit<
  UnifiedSearchResponse,
  "results"
> & {
  results: OfferedSearchHit[];
};
