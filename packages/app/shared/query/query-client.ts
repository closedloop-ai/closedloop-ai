"use client";

import { toast } from "@repo/design-system/components/ui/sonner";
import {
  type DefaultError,
  type DefaultedQueryObserverOptions,
  QueryCache,
  QueryClient,
  type QueryClientConfig,
  type QueryKey,
  type QueryObserverOptions,
} from "@tanstack/react-query";
import { ApiError, getFriendlyError } from "../api/api-error";
import { publishAuthRejectionForQuery } from "./auth-rejection-store";

export type ErrorToastAction = { label: string; onClick: () => void };

/**
 * Render the standard error toast for a failed mutation. The generic toast
 * primitive shared across surfaces (FEA-1510): the default mutation handler
 * calls it, and domain code calls it from its own mutation `onError` when it
 * needs custom suppression or an action (e.g. loops' "View loop"). Keeps all
 * domain-specific error behavior out of this shared file.
 */
export function toastMutationError(error: unknown, action?: ErrorToastAction) {
  const friendly = getFriendlyError(error);
  toast.error(friendly.title, {
    description: friendly.description,
    ...(action ? { action } : {}),
  });
}

/**
 * QueryClient factory shared across surfaces (FEA-1510): both the web shell
 * and the desktop renderer construct their clients from this so retry and
 * the default mutation-error toast stay identical. Mutations that need
 * domain-specific error behavior override their own `onError` (which replaces
 * this default) rather than threading concerns through here. The React
 * provider wiring stays shell-side (web: `apps/app/lib/query-client.tsx`).
 *
 * ## Freshness policy (ISS-5976)
 *
 * The refetch triggers below both default ON, following React Query's own stock
 * values — reconnect as a plain `true`, focus as `shouldRefetchOnFocus`, which is
 * `true` minus a cooldown on queries currently in `error` state (codex P2 review;
 * see that function). A surface that must NOT refetch on them opts out
 * **explicitly, at its own construction site, with its reason written there** —
 * the default is never the place a surface's exception is recorded.
 *
 * That inversion is the fix for a real defect. This factory used to force both
 * triggers to `false` for everyone, and the comment justifying it named "the web
 * shell and the desktop *local* (push-bridge) client" as though they shared a
 * property. They do not: desktop local has a push bridge, the web shell has
 * none. So on web the trigger was removed and nothing replaced it, leaving a
 * 60-second `staleTime` with no event that ever acted on staleness — every web
 * list (Sessions, Branches, Agents, Documents, Packs, Routines, Projects,
 * Teams…) was stale until manually refreshed, which is why the Sessions list
 * grew a manual Refresh button (ISS-5315) to fill the hole. Defaulting ON means
 * a NEW surface inherits freshness rather than silently inheriting staleness,
 * and an exception has to be argued at the call site instead of arriving by
 * grouping.
 *
 * The per-surface positions, each stated where it is constructed:
 *  - **web shell** (`apps/app/lib/query-client.tsx`) — inherits both ON. No push
 *    stream, so focus/reconnect are the cheap triggers that stand in for one.
 *  - **desktop cloud** (`desktop-app-core-provider.tsx`) — focus ON (unchanged,
 *    now the consistent case rather than the exceptional one), reconnect OFF
 *    with its own reason.
 *  - **desktop local** (same file) — both OFF: it genuinely has the push bridge.
 *  - **desktop branches** (`desktop-branches-consumption.tsx`) — focus OFF,
 *    reconnect ON, per FEA-3754's canonical-cache policy.
 */
export type MakeQueryClientOptions = {
  /**
   * Override the default query `staleTime` — how long fetched data is served
   * without revalidation.
   *
   * Defaults to one minute, which is the value the **web shell** and the
   * **desktop cloud** client both run on. The **desktop local** client passes
   * `Number.POSITIVE_INFINITY` for a push model: queries never go stale on a
   * timer and refresh only when the live DB-change bridge invalidates them
   * (FEA-1834).
   *
   * This is also the ceiling on what the refetch triggers below can cost — for a
   * query that both succeeds and takes this default. A focus or reconnect event
   * only refetches a query that is already stale, so this one minute is the
   * minimum spacing between two trigger-driven reads of the same query no matter
   * how often the user tabs away and back.
   *
   * Two shapes fall outside that bound, and neither is covered by this value
   * (wongk / codex P2 review):
   *  - A query that FAILED: a failure advances `errorUpdatedAt`, not
   *    `dataUpdatedAt`, so `staleTime` never restarts and the query is stale on
   *    every focus. `shouldRefetchOnFocus` bounds that case instead.
   *  - A query that sets its own `staleTime: 0` and is therefore ALWAYS stale.
   *    Such a query refetches on every trigger by construction, so it must decide
   *    the triggers for itself; `branch-comments-controller.tsx` is the worked
   *    example (it opts both off, because its read is a per-collection fan-out).
   */
  staleTime?: number;
  /**
   * Refetch a stale query when the window regains focus.
   *
   * **Defaults to ON** (ISS-5976) — specifically to the `shouldRefetchOnFocus`
   * predicate, which is React Query's stock `true` minus a cooldown on queries
   * currently in `error` state; see that function for why `staleTime` cannot
   * bound the failure path on its own. Applies to the web shell (no push stream:
   * focus is the cheap freshness trigger that stands in for one) and to the
   * desktop *cloud* client (PLN-1138 D-E, which reached the same conclusion from
   * the same premise and passes `true` explicitly — an explicit caller value is
   * taken verbatim and does not get the cooldown).
   *
   * The desktop *local* client opts OUT (`false`): it has a real push bridge
   * (`desktop:db:changed`, FEA-1834) plus the FEA-2187 visibility-gated list
   * poll, so the bridge — not focus — drives freshness there. The desktop
   * branches client also opts out, per FEA-3754. Both say so at their own
   * construction site.
   */
  refetchOnWindowFocus?: boolean;
  /**
   * Refetch stale queries when connectivity returns.
   *
   * **Defaults to `true`** — React Query's stock value (ISS-5976). Decided
   * deliberately, not inherited: for the web shell this is the same class of
   * cheap trigger as focus and the same premise applies (no push stream), and
   * it is strictly RARER than focus, so it adds no request volume beyond what
   * focus already permits. Regaining connectivity is also precisely when a
   * cache is most likely to be wrong.
   *
   * The desktop *cloud* client opts OUT (`false`): regaining connectivity there
   * changes the mode, which rebuilds that client from empty and refetches
   * anyway, so a reconnect refetch would be redundant. The desktop *local*
   * client opts out with the push-bridge reason above. The desktop *branches*
   * client opts IN explicitly (FEA-3754) so paused reads resume against their
   * canonical source rather than requiring a remount.
   */
  refetchOnReconnect?: boolean;
  /**
   * Override the *base* `gcTime` applied to every query (the retention window
   * for an inactive, no-observer query before React Query garbage-collects it).
   * Defaults to `DEFAULT_QUERY_GC_TIME_MS` — React Query's stock 5 minutes — for
   * the browser/desktop shells.
   *
   * FEA-4104 does NOT raise this base default. Only *listing-family* queries get
   * the long `LIST_QUERY_GC_TIME_MS` retention, and they get it automatically
   * (see `isListQueryKey`) without touching this option; detail/large queries
   * (document version content, branch diffs, parsed transcripts) stay on this
   * base window so navigating across them doesn't pin their large payloads in
   * cache for the full listing window (wongk review, PR #3714).
   *
   * The desktop/web SSR path passes `Number.POSITIVE_INFINITY` here: on the
   * server, Infinity means no gcTime timer is ever scheduled, so a per-request
   * client stays timer-free and is collected once rendering completes. Passing
   * an explicit value here also **disables the listing scope-up** (list keys are
   * left on the provided base), so SSR never schedules the finite 30-minute
   * listing timer that the codex P1 review flagged.
   */
  gcTime?: number;
};

/**
 * Cap for transient (network) query retries. Auth failures (401/403) and any
 * other error that carried an HTTP response fail fast (0 retries); only a bare
 * network error retries, and only up to this many times. Keeping this low is a
 * deliberate anti-hammer measure (FEA-3940): a bricked API must not turn into
 * thousands of client retries.
 *
 * ISS-5976's focus/reconnect refetch defaults do NOT erode this. The two
 * policies compose in the safe direction and are bounded independently:
 *  - A refetch triggered by focus or reconnect enters the SAME `shouldRetryQuery`
 *    predicate as any other fetch, so a failing read still costs at most
 *    `MAX_TRANSIENT_QUERY_RETRIES` attempts on the capped backoff below, and a
 *    response-backed failure (4xx/5xx, most importantly a 401/403) still costs
 *    exactly one.
 *  - On the SUCCESS path the triggers are bounded by `staleTime`: a query fetched
 *    inside the last minute is fresh, and a fresh query does not refetch on focus
 *    at all, so a burst of tab-switching costs at most one refetch per mounted
 *    query per minute — not one per switch.
 *
 * That second bound does NOT extend to the failure path, and an earlier revision
 * of this comment claimed it did (codex P2 review). A failed fetch advances
 * `errorUpdatedAt`, not `dataUpdatedAt`, so `staleTime` never restarts: a query
 * whose refetch just failed is stale *immediately*, and every subsequent focus
 * would start another fetch for every mounted query — precisely during an outage,
 * which is the FEA-3940 pressure this file exists to keep bounded.
 * `shouldRefetchOnFocus` below closes that hole with an explicit error cooldown;
 * `staleTime` is deliberately not asked to carry a case it cannot express.
 * The pressure FEA-3940 was written against is a *bricked API* multiplying
 * retries per fetch; that multiplier is unchanged here.
 */
export const MAX_TRANSIENT_QUERY_RETRIES = 2;

/** Base delay for the capped exponential retry backoff, in ms. */
export const QUERY_RETRY_BASE_DELAY_MS = 1000;

/** Ceiling for the capped exponential retry backoff, in ms. */
export const QUERY_RETRY_MAX_DELAY_MS = 30_000;

/**
 * Default query `staleTime`: one minute. The window during which fetched data is
 * served without revalidation.
 *
 * Named rather than inlined (ISS-5976) because it is the BOUND on the cost of
 * the focus/reconnect refetch triggers, and the regression tests assert against
 * it. It covers the web shell AND the desktop *cloud* client — the literal it
 * replaced carried a `// 1 minute (web default)` comment that read as web-only,
 * which is the same one-client-stated-as-both mistake this ticket removed from
 * the refetch docstrings. Only the desktop *local* client overrides it
 * (`Number.POSITIVE_INFINITY`, FEA-1834).
 */
export const DEFAULT_QUERY_STALE_TIME_MS = 60 * 1000;

/**
 * How long a query that is currently in `error` state is left alone by the
 * window-focus trigger (ISS-5976, codex P2 review).
 *
 * This is the failure-path counterpart to `DEFAULT_QUERY_STALE_TIME_MS`. Set to
 * the same one minute deliberately: focus refetching is meant to cost at most one
 * read per query per minute, and a failing query should not get a *higher* budget
 * than a healthy one just because its `dataUpdatedAt` stopped advancing.
 */
export const FOCUS_REFETCH_ERROR_COOLDOWN_MS = 60 * 1000;

/**
 * Base `gcTime` for inactive queries: React Query's stock 5 minutes. This is the
 * retention window for any query with no mounted observers that is NOT a listing
 * family — detail reads (document version content, branch diffs), one-offs, and
 * large payloads. Detail queries that hold especially large payloads (parsed
 * session transcripts) opt out further with their own `gcTime: 0`.
 *
 * FEA-4104's raised retention deliberately does NOT change this base window: it
 * is scoped to listing families only (`LIST_QUERY_GC_TIME_MS`) so we don't pin
 * large detail payloads in cache six times longer just to speed up list
 * back-navigation (wongk review, PR #3714).
 */
export const DEFAULT_QUERY_GC_TIME_MS = 5 * 60 * 1000;

/**
 * `gcTime` for *listing-family* queries (FEA-4104): 30 minutes, six times React
 * Query's stock 5-minute window. This is the retention window for an inactive
 * listing query — a list you've navigated away from. Holding inactive list
 * caches this long is what makes back/repeat navigation to an already-seen list
 * render from cache in well under 100ms with no skeleton flash (then
 * background-revalidate if the entry is also stale).
 *
 * It is intentionally decoupled from `staleTime`: staleness governs
 * revalidation of a mounted query, retention governs survival of an
 * unmounted one. It never makes data staler — a stale-but-resident entry still
 * refetches on the next mount; it only prevents the entry from being thrown away
 * in the first place. Scoping it to listing keys (rather than raising the global
 * default) keeps the memory cost bounded to small list payloads, not the large
 * detail payloads a blanket default would also retain.
 */
export const LIST_QUERY_GC_TIME_MS = 30 * 60 * 1000;

/**
 * The query-key segment that every listing family shares. All list-key factories
 * across the app build their keys as `[<entity>, LIST_QUERY_KEY_SEGMENT, …]`
 * (e.g. `projectKeys.lists()` → `["projects", "list"]`), so this single marker
 * at key index 1 structurally identifies a listing query without the shared
 * client needing to import any feature-slice key factory.
 */
export const LIST_QUERY_KEY_SEGMENT = "list";

/**
 * True when an error carried a real HTTP response — an `ApiError` from the
 * shared client, or any other error object exposing a numeric `status` in the
 * response range (e.g. `LivePrOverlayError` from the Branches gateway, or a
 * runner-token error that throws a plain `Error` with a `status`). A transport
 * failure with no response (fetch reject, `status === 0`, or a deterministic
 * parse error with no status) is NOT response-backed and stays eligible for a
 * bounded retry.
 *
 * Standardizing on this (instead of an `ApiError`-only check) means every
 * response-backed error fails fast, not just the ones that happen to be
 * `ApiError` — the point of `shouldRetryQuery` is "don't retry something the
 * server already answered," regardless of which error class wraps it.
 */
export function isResponseBackedError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return true;
  }
  if (error !== null && typeof error === "object" && "status" in error) {
    const status = (error as { status: unknown }).status;
    // A real HTTP response status. `0` is the fetch "no response" transport
    // sentinel and must stay retryable, so require a >= 100 status.
    return typeof status === "number" && status >= 100 && status < 600;
  }
  return false;
}

/**
 * React Query retry predicate (FEA-3940). Any error that carried an HTTP
 * response (client 4xx or server 5xx) is not retried — most importantly a 401
 * or 403, which is an auth failure, not transient instability, and must fail
 * fast so the degraded/re-auth surface can take over instead of the client
 * looping. Only a bare network error (no HTTP response) is retried, and only up
 * to `MAX_TRANSIENT_QUERY_RETRIES`.
 */
export function shouldRetryQuery(failureCount: number, error: unknown) {
  // A client-deadline timeout (ISS-5013) is deliberately NOT retried, even
  // though it carries no HTTP response. Each retry would be another full-length
  // wait — three in a row is minutes of a surface still claiming to load, which
  // is the very failure the deadline exists to end. Failing fast to the stated
  // timeout state is the point. Checked explicitly rather than left to fall out
  // of `isResponseBackedError`'s `ApiError` short-circuit, so the decision is
  // visible and pinned by a test instead of accidental.
  if (error instanceof ApiError && error.isTimeout()) {
    return false;
  }
  if (isResponseBackedError(error)) {
    return false;
  }
  return failureCount < MAX_TRANSIENT_QUERY_RETRIES;
}

/**
 * Capped exponential backoff for query retries (FEA-3940): 1s, 2s, 4s, …
 * clamped at `QUERY_RETRY_MAX_DELAY_MS`. Only bare network errors reach this
 * (see `shouldRetryQuery`), so it never applies to auth failures.
 */
export function queryRetryDelay(attemptIndex: number) {
  return Math.min(
    QUERY_RETRY_BASE_DELAY_MS * 2 ** attemptIndex,
    QUERY_RETRY_MAX_DELAY_MS
  );
}

/**
 * The default `refetchOnWindowFocus` policy (ISS-5976, codex P2 review): refetch
 * a stale query on focus, EXCEPT while it is sitting in `error` state and its
 * last failure landed inside `FOCUS_REFETCH_ERROR_COOLDOWN_MS`.
 *
 * Why a predicate rather than a bare `true`: a failed fetch advances
 * `errorUpdatedAt` but NOT `dataUpdatedAt`, so `staleTime` never restarts for it.
 * A plain `true` therefore means an errored query is stale on every single focus
 * event, and a user tabbing back and forth during an API outage re-issues a fetch
 * for every mounted query every time — request amplification aimed at an API that
 * is already failing, which is exactly what FEA-3940 exists to prevent. The
 * cooldown restores the once-per-minute ceiling on the failure path that
 * `staleTime` already provides on the success path.
 *
 * Deliberately NOT applied to `refetchOnReconnect`. A reconnect fires on an
 * offline→online transition, which is both rare and self-limiting, and it is
 * precisely the moment a cache is most likely to be wrong; suppressing the
 * recovery refetch would strand the user on stale data with no event left to
 * correct it. Cheap-and-frequent (focus) gets the cooldown; rare-and-corrective
 * (reconnect) does not.
 */
export function shouldRefetchOnFocus(query: {
  state: { status: string; errorUpdatedAt: number };
}): boolean {
  if (query.state.status !== "error") {
    return true;
  }
  return (
    Date.now() - query.state.errorUpdatedAt >= FOCUS_REFETCH_ERROR_COOLDOWN_MS
  );
}

/**
 * True when `queryKey` belongs to a listing family — i.e. its second segment is
 * the shared `LIST_QUERY_KEY_SEGMENT` marker (`[<entity>, "list", …]`). Every
 * `.lists()`/`.list(filters)` key factory in the app follows this shape, so this
 * one structural check identifies a listing query for any present or future
 * entity without the shared client importing a single feature-slice key factory.
 */
export function isListQueryKey(queryKey: QueryKey): boolean {
  return Array.isArray(queryKey) && queryKey[1] === LIST_QUERY_KEY_SEGMENT;
}

/**
 * `QueryClient` that scopes FEA-4104's raised `gcTime` retention to listing
 * families only. The base default (from `defaultOptions.queries.gcTime`) stays
 * on the stock 5-minute window for every query; this subclass bumps only listing
 * queries up to `LIST_QUERY_GC_TIME_MS`, and only when the caller did not set an
 * explicit per-query `gcTime`. That keeps two invariants:
 *   - large detail reads (document version content, branch diffs, parsed
 *     transcripts) are never pinned in cache for the long listing window; and
 *   - a per-query opt-out such as the transcript hook's `gcTime: 0` still wins,
 *     because we only fill in the listing window where no explicit value exists.
 *
 * SSR uses the plain `QueryClient` (see `makeQueryClient`) so it never schedules
 * a finite listing timer — on the server every query keeps the Infinity base and
 * stays timer-free (codex P1, PR #3714).
 */
class ListScopedQueryClient extends QueryClient {
  defaultQueryOptions<
    TQueryFnData = unknown,
    TError = DefaultError,
    TData = TQueryFnData,
    TQueryData = TQueryFnData,
    TQueryKey extends QueryKey = QueryKey,
    TPageParam = never,
  >(
    options:
      | QueryObserverOptions<
          TQueryFnData,
          TError,
          TData,
          TQueryData,
          TQueryKey,
          TPageParam
        >
      | DefaultedQueryObserverOptions<
          TQueryFnData,
          TError,
          TData,
          TQueryData,
          TQueryKey
        >
  ): DefaultedQueryObserverOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryData,
    TQueryKey
  > {
    const defaulted = super.defaultQueryOptions(options);
    // Only scope up an inactive listing entry, and only when the effective
    // gcTime is the shared base default — i.e. neither this query nor a
    // `setQueryDefaults` entry set an explicit gcTime. `options.gcTime` is the
    // pre-merge caller value; leaving it undefined is the signal to apply the
    // listing window.
    if (
      options.gcTime === undefined &&
      defaulted.gcTime === DEFAULT_QUERY_GC_TIME_MS &&
      isListQueryKey(defaulted.queryKey)
    ) {
      defaulted.gcTime = LIST_QUERY_GC_TIME_MS;
    }
    return defaulted;
  }
}

export function makeQueryClient(options?: MakeQueryClientOptions) {
  const config: QueryClientConfig = {
    // Publish a session auth rejection from the shared query boundary (FEA-3940)
    // so the web shell's re-auth surface trips on the first 401 from ANY query,
    // not only the `/me` query it directly observes. Scoped to `ApiError` 401
    // inside the store so gateway/runner errors don't trip it, and deliberately
    // NOT a bare 403 (ISS-5095): a forbidden sub-resource means "this thing
    // isn't yours", not "your session is dead", and must never blank the
    // workspace. A query that owns its own per-resource access-denied UI (e.g.
    // `useBranchView`'s "Access required" panel) additionally opts out via
    // `meta.ownsAuthRejection` so even a 401 scoped to one resource does not
    // hijack the whole shell into a session-expired card — but a 403 the server
    // explicitly tagged session-level outranks that opt-out, since it is not a
    // statement about the resource at all. That precedence lives in
    // `publishAuthRejectionForQuery` so it cannot be re-derived here in the
    // wrong order.
    queryCache: new QueryCache({
      onError: (error, query) => {
        publishAuthRejectionForQuery(error, query.meta);
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: options?.staleTime ?? DEFAULT_QUERY_STALE_TIME_MS,
        gcTime: options?.gcTime ?? DEFAULT_QUERY_GC_TIME_MS,
        // ISS-5976: both default ON. A surface that must not refetch on these
        // triggers opts out at its own construction site with its reason there —
        // see `MakeQueryClientOptions`. Focus defaults to `shouldRefetchOnFocus`
        // rather than a bare `true` so an errored query is not re-fetched on
        // every focus event during an outage (see that function); an explicit
        // caller override still wins verbatim.
        refetchOnWindowFocus:
          options?.refetchOnWindowFocus ?? shouldRefetchOnFocus,
        refetchOnReconnect: options?.refetchOnReconnect ?? true,
        retry: shouldRetryQuery,
        retryDelay: queryRetryDelay,
      },
      mutations: {
        retry: false,
        onError: (error, _variables, _onMutateResult, mutation) => {
          if (mutation?.meta?.suppressDefaultErrorToast === true) {
            return;
          }
          toastMutationError(error);
        },
      },
    },
  };
  // When a base gcTime override is supplied (the SSR path passes Infinity), keep
  // the plain client so the listing scope-up is disabled and no finite listing
  // timer is ever scheduled server-side. The browser/desktop shells (no gcTime
  // override) get the list-scoped client so only listings retain for 30 minutes.
  if (options?.gcTime !== undefined) {
    return new QueryClient(config);
  }
  return new ListScopedQueryClient(config);
}
