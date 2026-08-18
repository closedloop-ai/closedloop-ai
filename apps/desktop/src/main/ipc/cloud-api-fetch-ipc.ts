import { ORG_IDENTITY_HEADER } from "@repo/api/src/types/headers";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { z } from "zod";
import {
  CLOUD_API_FETCH_CHANNEL,
  CLOUD_API_FETCH_MAX_TIMEOUT_MS,
  CloudApiFetchErrorReason,
  type CloudApiFetchRequest,
  type CloudApiFetchResult,
} from "../../shared/cloud-api-fetch-contract.js";

/**
 * Main-process half of the desktop cloud-API fetch bridge (PLN-1138 D-G
 * Option B; write transport FEA-3522). Executes renderer-marshalled cloud REST
 * requests against the configured API origin with the first-party desktop
 * session token.
 *
 * Security properties:
 * - Untrusted senders are rejected before anything else, matching the rest of
 *   the desktop IPC surface.
 * - The renderer supplies only an origin-relative path; the target origin is
 *   resolved here and re-asserted after URL composition, so a renderer cannot
 *   direct the bridge at any other host (including via protocol-relative
 *   `//evil.example` paths).
 * - Renderer-supplied headers are dropped except for a small allowlist; the
 *   `Authorization` (real token) and org-identity headers are injected here
 *   from the session manager. The access token never crosses to the renderer.
 * - Reads (GET) are permitted org-wide — the authenticated read surface
 *   (Dashboard, Sessions, Branches, agent-components). Writes (POST/PATCH/
 *   DELETE) are confined to a tight per-method path allowlist
 *   ({@link WRITE_ALLOWLIST}): trace-comment create / reply / edit / delete
 *   only. A blanket authenticated-mutation proxy from a (potentially
 *   compromised) renderer is a real security risk — the credential is
 *   main-held, so any path we let it mutate is a path the renderer can mutate
 *   with the org's authority. Opening a new write surface means adding an
 *   explicit, reviewed allowlist entry here, never relaxing to "any path".
 * - A request body is accepted only for the mutating methods; GET still rejects
 *   bodies outright.
 * - Signed-out short-circuits to a synthesized 401 without touching the
 *   network, in the shared `ApiResult` failure envelope so `useApiClient`
 *   surfaces a clean `ApiError`.
 * - A renderer-supplied per-request deadline is honored in either direction
 *   for a READ, clamped to the 5-minute ceiling; a WRITE's deadline is honored
 *   only downward — it can shorten below the main-owned bound, never extend
 *   past it (see {@link resolveRequestTimeoutMs}). An unusable one degrades to
 *   absent rather than failing the request. It lengthens how long ONE read may
 *   run — it does not cap how many bridged requests may be in flight at once,
 *   which stays unbounded (a known gap this module does not close).
 * - A failure this process's own deadline caused is labeled as such on the way
 *   back (`reason: "timeout"`), so the renderer can surface a client-side
 *   timeout rather than an anonymous transport error (ISS-5082).
 */

/** Request headers the renderer may set; everything else is dropped. */
const FORWARDED_REQUEST_HEADERS = new Set(["content-type", "accept"]);

/** HTTP methods the bridge understands at all; anything else is rejected. */
const ALLOWED_METHODS = new Set(["GET", "POST", "PATCH", "DELETE"]);

/**
 * Mutating methods. These must additionally match {@link WRITE_ALLOWLIST}, and
 * are the only methods for which a request body is accepted.
 */
const WRITE_METHODS = new Set(["POST", "PATCH", "DELETE"]);

/**
 * A single opaque, `encodeURIComponent`-escaped path segment. The trace-comment
 * routes carry the target id and comment id as encoded segments; `%2F` stays
 * percent-encoded in the raw pathname, so `[^/]` cannot span a real separator
 * and no traversal ("../", nested collections) slips into a segment slot.
 */
const SEGMENT = "[^/]+";

/**
 * Per-method write allowlist (FEA-3522). Each pattern is anchored (`^…$`)
 * against the composed request `pathname` (already asserted to be on the
 * configured origin). Confined to the trace-comment mutation routes the
 * Cloud-mode desktop needs — create / reply on a collection, edit / delete on a
 * member — for both session- and branch-scoped targets (mirrors
 * `traceCommentsPath` / `traceCommentPath` / `traceCommentRepliesPath` in
 * `@repo/api`). GET is intentionally absent: reads are not allowlist-gated. To
 * open another write surface, add an explicit entry here and a covering test.
 */
const WRITE_ALLOWLIST: Record<string, RegExp[]> = {
  POST: [
    // Create a root trace comment on a session/branch target.
    new RegExp(`^/(?:agent-sessions|branches)/${SEGMENT}/trace-comments$`),
    // Reply under an existing trace comment.
    new RegExp(
      `^/(?:agent-sessions|branches)/${SEGMENT}/trace-comments/${SEGMENT}/replies$`
    ),
  ],
  PATCH: [
    // Edit a trace comment (or reply) by id.
    new RegExp(
      `^/(?:agent-sessions|branches)/${SEGMENT}/trace-comments/${SEGMENT}$`
    ),
  ],
  DELETE: [
    // Delete a trace comment (or reply) by id.
    new RegExp(
      `^/(?:agent-sessions|branches)/${SEGMENT}/trace-comments/${SEGMENT}$`
    ),
  ],
};

/**
 * Whether a mutating request to `pathname` is permitted for `method`. Only the
 * path is matched (callers pass `url.pathname`, never the query), so a
 * `?`-smuggled suffix cannot widen an entry; the trace-comment write routes
 * carry no query string.
 */
function isAllowedWrite(method: string, pathname: string): boolean {
  const patterns = WRITE_ALLOWLIST[method];
  if (!patterns) {
    return false;
  }
  return patterns.some((pattern) => pattern.test(pathname));
}

/**
 * Main-owned bound: the CEILING on every WRITE, and the deadline for any
 * request that carries no deadline of its own. Mapped to a network error.
 *
 * The no-deadline case is a defensive fallback, not a production read path:
 * the real renderer stamps `timeoutMs` on every bridged request
 * (`toRequestInit` in `packages/app/shared/api/api-timeout.ts` stamps the
 * deadline unconditionally, and the opt-out maps to the bridge ceiling). The
 * wire field stays optional, though — the renderer is untrusted and may omit
 * it, and an UNUSABLE one degrades to absent rather than failing the request
 * (see {@link cloudApiFetchRequestShape}) — so main must still fail safe to its
 * own bound whenever it does not have a usable deadline.
 */
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Deadline for one bridged request, in milliseconds (ISS-5082).
 *
 * The shared API client raises its deadline at the handful of call sites that
 * do long synchronous server work (`LONG_RUNNING_API_TIMEOUT_MS` in
 * `packages/app/shared/api/api-timeout.ts`). An `AbortSignal` cannot cross the
 * IPC bridge, so that override reaches this process as a number on the request;
 * before it was forwarded, EVERY bridged request was pinned to
 * {@link DEFAULT_TIMEOUT_MS} regardless of what its call site asked for.
 *
 * Only a READ's deadline may exceed the main-owned bound. That is deliberate:
 * the renderer is treated as potentially compromised, and this credential holds
 * the org's authority, so the knob is confined to the surface that can actually
 * use it. Every long-running WRITE call site is a POST, and
 * {@link WRITE_ALLOWLIST} admits only the fast trace-comment routes — so no
 * write can benefit today, and letting one ask for five minutes would only
 * lengthen how long a compromised renderer can hold a credentialed MUTATION
 * open. Long-running READS, by contrast, are already here: the branch
 * selected-PR files and diff queries
 * (`packages/app/branches/hooks/use-branch-selected-pull-request-files.ts`,
 * ISS-4471) raise the deadline on a GET, and are the first call sites this
 * forwarding actually serves. Adding a genuinely long-running route to
 * {@link WRITE_ALLOWLIST} means revisiting this rule in the same change.
 *
 * A write's deadline is still honored DOWNWARD: the security rule only needs
 * to stop the renderer from extending a mutation, and this transport cannot
 * observe the renderer's own abort signal — so discarding a shorter ask would
 * leave a trace-comment write that asked for one second pinned open in main
 * for the full main-owned bound. Writes therefore get
 * `min(requested, main-owned bound)`.
 *
 * The read value is honored but NOT trusted. It is truncated to whole
 * milliseconds and clamped into `[1, CLOUD_API_FETCH_MAX_TIMEOUT_MS]` — the
 * schema already rejects `NaN`/`Infinity`/non-positive, but a FRACTIONAL value
 * survives it and `AbortSignal.timeout()` throws `ERR_OUT_OF_RANGE` on one, so
 * the floor and the truncation are enforced here rather than being inherited
 * from a validator in another function. The renderer's `forwardableTimeoutMs`
 * already rounds UP to whole milliseconds before sending — that ceil is the
 * canonical rounding; the truncation here is only a backstop against a value
 * that did not come through it.
 *
 * Scope note: this bounds ONE request. Nothing here (or anywhere on this
 * channel) caps how many bridged requests a renderer may have in flight at
 * once, so the aggregate socket/memory/upstream-rate-limit pressure a
 * compromised renderer can apply is unbounded and unchanged by this function —
 * a known gap, not a claim this clamp closes.
 */
export function resolveRequestTimeoutMs(
  requestTimeoutMs: number | undefined,
  depsTimeoutMs: number | undefined,
  isWrite: boolean
): number {
  const mainOwnedBound = depsTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (requestTimeoutMs === undefined) {
    return mainOwnedBound;
  }
  const requested = Math.max(1, Math.trunc(requestTimeoutMs));
  if (isWrite) {
    return Math.min(requested, mainOwnedBound);
  }
  return Math.min(requested, CLOUD_API_FETCH_MAX_TIMEOUT_MS);
}

/**
 * Field validators for the renderer-supplied request, kept as a standalone
 * literal so the keys-covered guard below can see them.
 *
 * `satisfies Record<keyof CloudApiFetchRequest, …>` is the compile-time guard
 * the `z.ZodType<CloudApiFetchRequest>` annotation alone does NOT provide: zod's
 * `ZodType` is covariant in its output, so a schema that omits an optional key
 * still satisfies that annotation. Because the schema is `.strict()`, a field
 * added to {@link CloudApiFetchRequest} and sent by the renderer without being
 * taught here would make main reject the ENTIRE request as malformed — every
 * bridged cloud call failing at once (the FEA-3701 lesson in the root
 * AGENTS.md). `satisfies` turns that into a `tsc` failure: a missing key and an
 * extra key are both errors, and the object literal keeps its precise inferred
 * type so `parsed.data` stays exactly typed.
 */
const cloudApiFetchRequestShape = {
  // Origin-relative only. This is a necessary but not sufficient check: a
  // protocol-relative "//evil.example/x" also starts with "/", so the
  // composed URL is re-asserted against the configured origin below.
  path: z.string().startsWith("/"),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  // Positive only: a zero/negative deadline would arm a timer that fires
  // immediately, turning every request into an instant fake timeout. Neither
  // the upper bound nor whole-millisecond-ness is enforced here — both are
  // clamps in `resolveRequestTimeoutMs`, so an over-long or fractional ask
  // degrades instead of failing the request outright.
  //
  // `.catch(undefined)` makes an UNUSABLE value degrade the same way, rather
  // than failing validation. This object is `.strict()`, so without it an
  // explicit `null` — or a string, a `NaN`, a zero — sank the ENTIRE request:
  // `safeParse` failed, the call never reached the network, and the caller got
  // a "malformed request (expected an origin-relative path)" message naming a
  // field that was fine. A deadline is the single most degradable value on this
  // payload — losing it costs the override and nothing else, and main still has
  // its own bound to fall back to — so per the root AGENTS.md rule that a
  // missing or unknown OPTIONAL value degrades to a safe default and never
  // blocks the core flow, a bad one loses only itself. This is the same
  // FEA-3701 lesson the `satisfies` guard below encodes, applied to VALUES
  // rather than keys.
  timeoutMs: z.number().positive().optional().catch(undefined),
} satisfies Record<keyof CloudApiFetchRequest, z.ZodTypeAny>;

/**
 * Runtime validator for the renderer-supplied request. It lives here rather
 * than beside the contract because the preload bundle imports that module and
 * stays free of the zod runtime (see `renderer-otel-bridge-constants.ts` for
 * the same split).
 */
const cloudApiFetchRequestSchema: z.ZodType<CloudApiFetchRequest> = z
  .object(cloudApiFetchRequestShape)
  .strict();

export type CloudApiFetchDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: WebContents) => boolean;
  /** Current desktop session access token, or null when signed out. */
  getAccessToken: () => Promise<string | null>;
  /** Signed-in identity for the org-identity header, or null. */
  getIdentity: () => { userId: string; organizationId: string } | null;
  /** Configured cloud API origin; may throw when unset/invalid. */
  resolveApiOrigin: () => string;
  /**
   * Main-owned bound: the ceiling on every write, and the deadline for a
   * request that carries none of its own; defaults to
   * {@link DEFAULT_TIMEOUT_MS}. Nothing sets it in production wiring
   * (`desktop-ipc-registration.ts`) — it exists as a seam so tests can pin the
   * bound. Note the no-deadline READ case is a defensive fallback the real
   * renderer never takes (it stamps a deadline on every request), so a test
   * that drives a read through this seam alone is exercising that fallback,
   * not the production read path. See {@link resolveRequestTimeoutMs}.
   */
  timeoutMs?: number;
  /**
   * Test seam; defaults to the platform fetch. Narrowed to how this bridge
   * actually calls it (an absolute URL it composed itself, plus an init), which
   * the global `fetch` satisfies.
   */
  fetchImpl?: (url: URL, init: RequestInit) => Promise<Response>;
};

/**
 * The slice of Electron's `ipcMain` this module drives, narrowed to a port so
 * the handler and its tests don't depend on the full runtime. The payload stays
 * `unknown` deliberately — it is attacker-controlled data from a potentially
 * compromised renderer, and {@link cloudApiFetchRequestSchema} is what turns it
 * into a typed {@link CloudApiFetchRequest}. Declaring it as the request type
 * here would assert a shape nothing has validated yet.
 */
type IpcMainLike = {
  handle: (
    channel: typeof CLOUD_API_FETCH_CHANNEL,
    listener: (
      event: IpcMainInvokeEvent,
      request: unknown
    ) => Promise<CloudApiFetchResult>
  ) => void;
};

function networkError(
  message: string,
  reason?: CloudApiFetchErrorReason
): CloudApiFetchResult {
  // Omit `reason` entirely when there is none rather than serializing an
  // explicit `undefined` across the IPC boundary (the wire rule in the root
  // AGENTS.md), so an unclassified failure stays byte-identical to the shape
  // that shipped before this field existed.
  return { kind: "network-error", message, ...(reason ? { reason } : {}) };
}

/** Synthesized 401 in the `ApiResult` failure envelope (no network touched). */
function signedOutResponse(): CloudApiFetchResult {
  return {
    kind: "response",
    status: 401,
    statusText: "Unauthorized",
    headers: [["content-type", "application/json"]],
    bodyText: JSON.stringify({
      success: false,
      error: "Desktop is not signed in.",
    }),
  };
}

/**
 * Resolves the renderer-supplied origin-relative `path` to an absolute URL on
 * the configured API origin, or a {@link networkError} describing why it could
 * not. Composition (`new URL(path, origin)`) plus the origin re-assertion live
 * here so a protocol-relative or absolute path can never re-target the host —
 * the single authority for where a bridged request may go.
 */
function resolveTargetUrl(
  deps: CloudApiFetchDeps,
  path: string
): URL | { error: CloudApiFetchResult } {
  let origin: string;
  try {
    origin = deps.resolveApiOrigin();
  } catch (error) {
    return {
      error: networkError(
        `cloud-api-fetch: API origin is not configured (${
          error instanceof Error ? error.message : String(error)
        })`
      ),
    };
  }

  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    return {
      error: networkError("cloud-api-fetch: request path is not a valid URL"),
    };
  }
  if (url.origin !== new URL(origin).origin) {
    return {
      error: networkError(
        "cloud-api-fetch: request path escapes the configured API origin"
      ),
    };
  }
  return url;
}

function buildUpstreamHeaders(
  request: CloudApiFetchRequest,
  token: string,
  identity: { organizationId: string } | null
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (FORWARDED_REQUEST_HEADERS.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }
  headers.set("Authorization", `Bearer ${token}`);
  if (identity) {
    headers.set(ORG_IDENTITY_HEADER, identity.organizationId);
  }
  return headers;
}

async function executeCloudApiFetch(
  deps: CloudApiFetchDeps,
  rawRequest: unknown
): Promise<CloudApiFetchResult> {
  const parsed = cloudApiFetchRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    return networkError(
      "cloud-api-fetch: malformed request (expected an origin-relative path)"
    );
  }
  const request = parsed.data;
  const method = (request.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return networkError(`cloud-api-fetch: method ${method} is not allowed`);
  }
  const isWrite = WRITE_METHODS.has(method);
  // A body is only meaningful (and only accepted) for a mutating method. GET
  // stays body-free, as it was before the write path existed.
  if (request.body !== undefined && !isWrite) {
    return networkError(
      `cloud-api-fetch: request bodies are not supported for ${method}`
    );
  }

  // Signed-out is checked before origin resolution so a signed-out desktop
  // with a bad/missing API origin still reports the intended 401 envelope
  // rather than a status-0 network error.
  const token = await deps.getAccessToken();
  if (!token) {
    return signedOutResponse();
  }

  // Resolve + re-assert the target origin (protocol-relative / absolute paths
  // cannot re-target the host); a failure returns the mapped network error.
  const resolved = resolveTargetUrl(deps, request.path);
  if (resolved instanceof URL === false) {
    return resolved.error;
  }
  const url = resolved;

  // Mutations are confined to the trace-comment write allowlist. Checked on the
  // composed `url.pathname` (already origin-asserted), after the origin guard so
  // a cross-origin write can never even reach this gate — and before the fetch,
  // so a non-allowlisted mutation never touches the network with the org token.
  if (isWrite && !isAllowedWrite(method, url.pathname)) {
    return networkError(
      `cloud-api-fetch: ${method} ${url.pathname} is not an allowlisted write endpoint`
    );
  }

  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    // No deployment-id pinning header (deliberate v1 omission): the desktop
    // has no pin source — the web's FEA-1485 pins come from a build-paired
    // Edge Config lookup that has no desktop equivalent — and every existing
    // main-process cloud client behaves the same way. Revisit if a desktop
    // pin source ever exists.
    response = await doFetch(url, {
      method,
      headers: buildUpstreamHeaders(request, token, deps.getIdentity()),
      // Forward the (validated string) body only for a mutating method; GET
      // never carries one. `undefined` for a bodyless request keeps the init
      // identical to the read path.
      ...(isWrite && request.body !== undefined ? { body: request.body } : {}),
      signal: AbortSignal.timeout(
        resolveRequestTimeoutMs(request.timeoutMs, deps.timeoutMs, isWrite)
      ),
    });
  } catch (error) {
    return transportError(error, "cloud-api-fetch: fetch failed");
  }

  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (error) {
    // The deadline covers the body read too — the same signal is still armed
    // while the stream drains, so a slow body aborts HERE rather than at the
    // fetch above. Routing both arms through the same mapper is what keeps a
    // timeout's reported reason from depending on which millisecond it landed
    // in, which is exactly the ambiguity the discriminator removes.
    return transportError(
      error,
      "cloud-api-fetch: reading the response body failed"
    );
  }
  return {
    kind: "response",
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    bodyText,
  };
}

/**
 * Registers the cloud-API fetch handler. Untrusted senders reject; every other
 * failure mode returns a typed {@link CloudApiFetchResult} so the renderer can
 * mirror the platform fetch contract (resolve HTTP errors, reject transport
 * errors) instead of decoding Electron's mangled invoke rejections.
 */
export function registerCloudApiFetchIpcHandler(
  ipcMain: IpcMainLike,
  deps: CloudApiFetchDeps
): void {
  ipcMain.handle(
    CLOUD_API_FETCH_CHANNEL,
    (event, request): Promise<CloudApiFetchResult> => {
      if (!deps.isTrustedSender(event.sender)) {
        // Throwing (rather than returning a result) rejects the renderer's
        // invoke, matching the rest of the desktop IPC surface.
        throw new Error("untrusted sender");
      }
      return executeCloudApiFetch(deps, request);
    }
  );
}

/**
 * The `name` an `AbortSignal.timeout()` abort surfaces under. Node rejects the
 * fetch with a `DOMException` carrying this name ("The operation was aborted
 * due to timeout"); it is a web-platform constant, not a message we author.
 */
const TIMEOUT_ABORT_ERROR_NAME = "TimeoutError";

/**
 * Map a caught transport failure — from the fetch itself or from draining the
 * response body — to a {@link networkError}, carrying the deadline
 * classification (ISS-5082).
 *
 * Both arms share this one mapper deliberately: main owns the authoritative
 * deadline on desktop, so main is the only side that can tell a deadline expiry
 * from a dropped socket, and a request that timed out must report the same
 * `reason` whether the abort landed before or after the response head arrived.
 */
function transportError(
  error: unknown,
  fallbackMessage: string
): CloudApiFetchResult {
  return networkError(
    error instanceof Error ? error.message : fallbackMessage,
    isTimeoutAbort(error) ? CloudApiFetchErrorReason.Timeout : undefined
  );
}

/**
 * Whether a rejected fetch was OUR deadline expiring rather than any other
 * transport failure (ISS-5082).
 *
 * Only this timer can abort a bridged request — the renderer's own
 * `AbortSignal` cannot cross the bridge — so a timeout abort here is
 * unambiguously the deadline, never a caller cancellation.
 *
 * Both the direct and the `cause`-wrapped shape are matched because which one
 * arrives depends on the bundled undici: newer versions reject with the
 * signal's `reason` directly, older ones reject with a generic abort carrying
 * the reason as `cause`. Anything else is left UNCLASSIFIED rather than guessed
 * at, which degrades to exactly the generic network error that shipped before
 * this classification existed.
 *
 * Deliberately NOT `isAbortTimeoutError` (`src/main/util/api-response-utils.ts`):
 * that one answers a different question for the write lanes — "may this request
 * already have been processed server-side?" — so it also accepts `AbortError`
 * and only recognizes a `DOMException`, whereas this bridge must name the
 * deadline SPECIFICALLY (an `AbortError` here is not one) and must unwrap
 * `cause` to survive undici version skew. The divergence is the point; keep
 * both.
 */
function isTimeoutAbort(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === TIMEOUT_ABORT_ERROR_NAME) {
    return true;
  }
  const { cause } = error;
  return cause instanceof Error && cause.name === TIMEOUT_ABORT_ERROR_NAME;
}
