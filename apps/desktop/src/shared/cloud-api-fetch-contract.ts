/**
 * Wire contract for the desktop cloud-API fetch bridge (PLN-1138 D-G Option B).
 *
 * The renderer performs authenticated cloud REST reads by marshalling a
 * same-origin request over IPC to the main process, which executes the HTTP
 * call against the configured cloud API origin with the first-party desktop
 * session token. The credential never enters renderer JS; the renderer's auth
 * port surfaces only {@link DESKTOP_AUTH_TOKEN_SENTINEL}, and the main-process
 * handler strips any renderer-supplied Authorization header before injecting
 * the real one.
 *
 * Per AGENTS.md, values that cross the main/renderer process boundary live in
 * a shared module so the two sides can't drift — `cloud-api-fetch-ipc.ts`
 * (main), `preload-common.ts`, and the renderer adapter all import from here.
 */

/** IPC channel the renderer invokes with a {@link CloudApiFetchRequest}. */
export const CLOUD_API_FETCH_CHANNEL = "desktop:cloud-api-fetch";

/**
 * Placeholder origin the renderer `ApiAdapter` resolves. It is syntactically a
 * valid base URL (so `useApiClient`'s `${origin}${path}` composition works) but
 * deliberately non-routable (RFC 2606 `.invalid`): the renderer never dials the
 * network itself, and the bridge rejects any URL on a different origin, so the
 * main process stays the single authority for where cloud requests may go.
 */
export const DESKTOP_CLOUD_API_PLACEHOLDER_ORIGIN =
  "https://cloud-api.desktop.invalid";

/**
 * Opaque non-null value the renderer auth port returns from `getToken()` while
 * a desktop session exists. It satisfies the shared `useApiClient` contract
 * (signed-in ⇒ non-null token, so its retry loop settles) without surfacing the
 * real access token; the bridge discards it and the main process attaches the
 * genuine credential.
 */
export const DESKTOP_AUTH_TOKEN_SENTINEL = "desktop-session-token-held-in-main";

/**
 * Ceiling the main process clamps a renderer-supplied
 * {@link CloudApiFetchRequest.timeoutMs} to (ISS-5082).
 *
 * 5 minutes mirrors `LONG_RUNNING_API_TIMEOUT_MS` in
 * `packages/app/shared/api/api-timeout.ts` — the longest deadline any shared
 * call site legitimately asks for, itself pinned to the `maxDuration = 300` the
 * long-running routes declare. The value is restated here rather than imported
 * because `@repo/app` is browser/renderer code and must not enter the main
 * process. The two are kept equal by an executable assertion in
 * `apps/desktop/src/renderer/shared-agent-sessions/__tests__/cloud-api-adapter.test.ts`
 * (the renderer can see both modules), so raising the shared constant without
 * raising this one fails a test rather than silently re-capping desktop
 * requests.
 */
export const CLOUD_API_FETCH_MAX_TIMEOUT_MS = 5 * 60_000;

/**
 * Request half of the bridge. `path` is origin-relative (must start with "/");
 * the main process resolves it against the configured API origin and rejects
 * anything that escapes it (absolute URLs, protocol-relative paths).
 */
export type CloudApiFetchRequest = {
  path: string;
  method?: string;
  /** Flattened request headers; only an allowlist is forwarded upstream. */
  headers?: Record<string, string>;
  /**
   * UTF-8 request body. Accepted for the mutating methods (POST/PATCH/DELETE)
   * whose path matches the main handler's write allowlist (FEA-3522 — trace
   * comments); rejected outright for GET. Absent for bodyless requests.
   */
  body?: string;
  /**
   * Deadline for THIS request, in milliseconds — the REMAINING budget of the
   * shared API client's deadline at marshal time, not the original duration
   * (ISS-5082). An `AbortSignal` cannot cross this bridge, so the number is
   * what carries the deadline — without it every bridged request was pinned to
   * the main process's own 60s default no matter what its call site asked for.
   * Main arms a FRESH timer from this value, which is why the client deducts
   * the time its auth-hydration wait already spent before stamping it. Omitted
   * when the caller has no override; main then applies its default. Not
   * trusted in main: a read is clamped to
   * {@link CLOUD_API_FETCH_MAX_TIMEOUT_MS}; a write is honored only downward,
   * `min(requested, main-owned bound)`.
   */
  timeoutMs?: number;
};

/**
 * Result half of the bridge. `response` marshals a completed HTTP exchange
 * (whatever the status); `network-error` maps to a rejected fetch in the
 * renderer — mirroring the platform `fetch` contract the shared client
 * expects (HTTP errors resolve, transport errors reject). An UNCLASSIFIED
 * transport error rejects as the `TypeError` that contract calls for; the one
 * documented departure is a `reason: "timeout"` failure, which the renderer
 * rejects with the shared client's timeout `ApiError` instead so the deadline
 * keeps its identity (ISS-5082 — see `synthesizeResponse` in the adapter).
 *
 * `bodyText` deliberately crosses as raw text rather than a parsed object: the
 * main process stays a dumb transport, and the shared `useApiClient` remains
 * the single JSON-parse authority for both surfaces. That is what keeps desktop
 * responses identical to web — including `reviveWithDates`, which turns ISO
 * date strings into `Date` objects as the client parses, so the REST types in
 * `@repo/api` hold on desktop too. Parsing in main would fork that behavior and
 * require re-implementing the reviver here.
 */
export type CloudApiFetchResult =
  | {
      kind: "response";
      status: number;
      statusText: string;
      headers: [string, string][];
      bodyText: string;
    }
  | {
      kind: "network-error";
      message: string;
      /**
       * Why the transport failed, when main can say (ISS-5082). Additive and
       * OPTIONAL: an older main process omits it, a newer one may send a value
       * this renderer has never heard of, and both must land on exactly the
       * generic network-error behavior that shipped before this field existed
       * (see `synthesizeResponse` in the renderer adapter). Never widen a
       * consumer to `reason !== something` — always match a known member.
       */
      reason?: CloudApiFetchErrorReason;
    };

/**
 * Classification main can attach to a {@link CloudApiFetchResult} transport
 * failure (ISS-5082).
 *
 * Main owns the authoritative deadline on desktop — the renderer's
 * `AbortSignal` cannot cross this bridge — so main is the only side that knows
 * an abort was the DEADLINE expiring rather than a dropped socket. Without this
 * discriminator that fact died in an untyped message string, and the renderer
 * could only ever produce a generic `ApiError(msg, 0)`: desktop was
 * structurally incapable of reaching the `API_TIMEOUT_ERROR_CODE` /
 * `ApiError#isTimeout()` "we stopped waiting" state that ISS-5013 built, and a
 * deadline expiry was indistinguishable from a connection failure.
 *
 * A CALLER abort is deliberately not a member: this transport cannot observe
 * the renderer's own signal at all, so every abort main sees is its own timer.
 */
export const CloudApiFetchErrorReason = {
  /** Main's own deadline for this request expired before the server answered. */
  Timeout: "timeout",
} as const;

export type CloudApiFetchErrorReason =
  (typeof CloudApiFetchErrorReason)[keyof typeof CloudApiFetchErrorReason];
