import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import { FEATURE_FLAG_OVERRIDES_HEADER } from "@repo/api/src/types/feature-flag-overrides";
import { GRID_PREFERENCE_ROUTE } from "@repo/api/src/types/grid-preferences";
import { ORG_IDENTITY_HEADER } from "@repo/api/src/types/headers";
import { GUIDED_ONBOARDING_TRANSITION_PATH } from "@repo/api/src/types/onboarding-guided";
import { PENSERO_INTEGRATION_PATH } from "@repo/api/src/types/pensero-integration";
import { TagEntityType } from "@repo/api/src/types/tag";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { z } from "zod";
import {
  CLOUD_API_FETCH_CHANNEL,
  CLOUD_API_FETCH_MAX_TIMEOUT_MS,
  CloudApiFetchErrorReason,
  type CloudApiFetchRequest,
  type CloudApiFetchResult,
} from "../../shared/cloud-api-fetch-contract.js";
import {
  type DesktopAccountAdmission,
  isSameDesktopAccountAdmission,
} from "../session/desktop-account-admission.js";
import { applyDesktopClientAttribution } from "../util/desktop-client-attribution-provider.js";
import {
  TRACE_COMMENT_RETRY_SYNC_ROUTE,
  UNIFIED_COMMENT_WRITE_ROUTES,
} from "./cloud-api-fetch-comment-routes.js";
import { buildDocumentWriteRoutes } from "./cloud-api-fetch-document-routes.js";
import { executeAdmittedCloudApiFetch } from "./cloud-api-fetch-execution.js";
import { buildProjectWriteRoutes } from "./cloud-api-fetch-project-routes.js";
import { buildTeamWriteRoutes } from "./cloud-api-fetch-team-routes.js";
import {
  admitsArtifactEntityTagAttachBody,
  admitsArtifactEntityTagDetachSurface,
  admitsArtifactPatchBody,
} from "./cloud-api-fetch-write-body-schemas.js";
import { rewriteDocumentAssetResponse } from "./document-asset-proxy.js";

/**
 * Main-process half of the desktop cloud-API fetch bridge (PLN-1138 D-G Option
 * B; write transport FEA-3522). Executes renderer-marshalled cloud REST requests
 * against the configured API origin with the first-party desktop session token.
 *
 * Security properties:
 * - Untrusted senders are rejected before anything else, matching the rest of the desktop IPC surface.
 * - The renderer supplies only an origin-relative path; main resolves and
 *   re-asserts the target origin, refusing other hosts and protocol-relative paths.
 * - Renderer-supplied headers are dropped except for a small allowlist; the
 *   `Authorization` (real token) and org-identity headers are injected here
 *   from the session manager. The access token never crosses to the renderer.
 * - Reads over GET are permitted org-wide — the authenticated read surface
 *   (Dashboard, Sessions, Branches, agent-components). Non-GET requests are
 *   confined to a tight per-method path allowlist ({@link NON_GET_ALLOWLIST}):
 *   trace comments, unified comment routes, the single session / branch priority
 *   PATCH (ISS-10332 — which also bounds the BODY, see
 *   {@link refusedArtifactPatchBody}), one session / branch custom-field
 *   value PUT and DELETE (ISS-12302), the single entity-tag POST and DELETE
 *   (ISS-10995 — bounded to one `entityType`, see {@link refusedEntityTagWrite}),
 *   the batch-mutation POST routes, exact Branches read-like cohort analytics POST, grid
 *   preferences, browser-session revocation, and the Settings v2 API Keys
 *   panel's BYO Anthropic/Pensero credential save+remove routes. A blanket authenticated
 *   mutation proxy from a potentially compromised renderer is a real security risk — the
 *   credential is main-held, so allowed mutations use the org's authority. A new
 *   non-GET surface requires an explicit reviewed entry, never an "any path" rule.
 * - A body is accepted only for non-GET allowlisted methods; GET still rejects bodies outright.
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
 * - A main-process deadline failure returns `reason: "timeout"`, so the renderer
 *   can distinguish it from an anonymous transport error (ISS-5082).
 */

/** Request headers the renderer may set; everything else is dropped. */
const FORWARDED_REQUEST_HEADERS = new Set([
  "content-type",
  "accept",
  FEATURE_FLAG_OVERRIDES_HEADER.toLowerCase(),
]);

/** HTTP methods the bridge understands at all; anything else is rejected. */
const ALLOWED_METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);

/**
 * Non-GET methods. These must additionally match {@link NON_GET_ALLOWLIST}, and
 * are the only methods for which a request body is accepted. PUT is listed here
 * too so adding it to {@link ALLOWED_METHODS} does not, by itself, open PUT for
 * any path — it still has to clear the allowlist gate below like every other
 * mutation.
 */
const NON_GET_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * A single opaque, `encodeURIComponent`-escaped path segment. The trace-comment
 * routes carry the target id and comment id as encoded segments; `%2F` stays
 * percent-encoded in the raw pathname, so `[^/]` cannot span a real separator
 * and no traversal ("../", nested collections) slips into a segment slot.
 */
const SEGMENT = "[^/]+";

/**
 * One artifact id, which is always a UUID on the cloud routes the grids write
 * to (ISS-10332). Narrower than {@link SEGMENT} on purpose: the session and
 * branch collections also carry single-segment NON-id routes under the same
 * prefix (`/agent-sessions/bulk-assign`), and an id slot that admitted any
 * segment would admit those too.
 */
const UUID_SEGMENT =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

const DOCUMENT_WRITE_ROUTES = buildDocumentWriteRoutes(UUID_SEGMENT);

/**
 * The single session / branch write the Cloud-mode grids reach for a priority
 * (ISS-10332). Named once because two gates read it: the PATCH allowlist and
 * {@link refusedArtifactPatchBody}, which bounds what a body on this path may
 * carry.
 */
const SINGLE_ARTIFACT_PRIORITY_PATCH_PATTERN = new RegExp(
  `^/(?:agent-sessions|branches)/${UUID_SEGMENT}$`
);

/**
 * The SESSION half of the pattern above. Rename (ISS-8718) and project
 * reassignment (ISS-10995) are session writes and nothing else, so those two
 * bodies are admitted on this path only — `PATCH /branches/[id]` stays bounded
 * to the priority keys.
 */
const SINGLE_SESSION_PATCH_PATTERN = new RegExp(
  `^/agent-sessions/${UUID_SEGMENT}$`
);

/**
 * One custom-field value on one session or branch, which the Cloud-mode
 * Details tabs set and clear (ISS-12302). Both slots are UUIDs: the artifact id
 * and `CustomField.id` are `@db.Uuid`.
 */
const CUSTOM_FIELD_VALUE_WRITE_PATTERN = new RegExp(
  `^/(?:agent-sessions|branches)/${UUID_SEGMENT}/custom-field-values/${UUID_SEGMENT}$`
);

const GRID_PREFERENCE_ROUTE_PATTERN = new RegExp(`^${GRID_PREFERENCE_ROUTE}$`);

// Settings v2 API Keys panel credential cards (ISS-10316): exact routes only.
// The Anthropic key routes have no `@repo/api` route constant today.
const API_KEYS_ORG_ROUTE_PATTERN = /^\/settings\/api-keys\/org$/;
const API_KEYS_USER_ROUTE_PATTERN = /^\/settings\/api-keys\/user$/;
const PENSERO_ROUTE_PATTERN = new RegExp(`^${PENSERO_INTEGRATION_PATH}$`);

/**
 * The guided onboarding run's one write (ISS-11249). Exact path: the snapshot
 * sibling is a GET and is not allowlist-gated, and no other `/onboarding/*`
 * surface is opened. The server scopes the write to the caller's own run — the
 * command carries no user or organization, and the route resolves both from the
 * main-held session — so the path alone is the whole gate here.
 */
const GUIDED_ONBOARDING_TRANSITION_PATTERN = new RegExp(
  `^${GUIDED_ONBOARDING_TRANSITION_PATH}$`
);

/**
 * The batch-mutation POST routes, v1 or the ISS-9464 `/v2` sibling where both
 * exist, and no other suffix: no `/v3`, no trailing characters or segments
 * (ISS-9466). A v2-only route ends in `/v2` in the shared list. Like
 * every entry, it is matched against the pathname only, so a query string is
 * carried to the server and never part of the match.
 */
const BATCH_MUTATION_ROUTE_PATTERNS = Object.values(BatchMutationRoute).map(
  (route) => new RegExp(`^${route}${route.endsWith("/v2") ? "" : "(?:/v2)?"}$`)
);

/**
 * ISS-10995: the Details tab's Tags row attaches with `POST /entity-tags` and
 * detaches with `DELETE /entity-tags?…`. Exact path, so `/entity-tags/batch`
 * and its v2 keep their own {@link BATCH_MUTATION_ROUTE_PATTERNS} entries and
 * nothing nested is opened.
 *
 * The path alone is not the whole gate. `entityTagValidator`
 * (`apps/api/app/tags/validators.ts`) also accepts PROJECT, so this one route
 * also tags and untags projects, a write no bridged surface makes.
 * {@link refusedEntityTagWrite} bounds `entityType` on both halves, the attach
 * from the body and the detach from `url.searchParams`, which this bridge holds
 * in full even though {@link isAllowedNonGet} matches `url.pathname` alone.
 */
const ENTITY_TAG_WRITE_PATTERN = /^\/entity-tags$/;

/**
 * Per-method non-GET allowlist (FEA-3522). Each pattern is anchored (`^…$`)
 * against the composed request `pathname` (already asserted to be on the
 * configured origin). Each entry below names the route family and ticket that
 * opened it. GET is intentionally absent: reads without bodies are not
 * allowlist-gated. To open another non-GET surface, add an explicit entry here
 * and a covering test.
 */
const TEAM_WRITE_ROUTES = buildTeamWriteRoutes(UUID_SEGMENT);
const PROJECT_WRITE_ROUTES = buildProjectWriteRoutes(UUID_SEGMENT);

const NON_GET_ALLOWLIST: Record<string, RegExp[]> = {
  POST: [
    ...DOCUMENT_WRITE_ROUTES.POST,
    ...TEAM_WRITE_ROUTES.POST,
    ...PROJECT_WRITE_ROUTES.POST,
    // ISS-11204: the existing organization invitation form.
    /^\/organizations\/invitations$/,
    // ISS-11249: the guided onboarding run's transition command. Without this
    // entry the renderer can READ the run and never move it, so every resumed
    // checklist step on a signed-in Desktop is an enabled control that silently
    // does nothing — a failed guided transition is deliberately not toasted.
    GUIDED_ONBOARDING_TRANSITION_PATTERN,
    // Authenticated per-user grid preference upsert (ISS-9448).
    GRID_PREFERENCE_ROUTE_PATTERN,
    // Bulk artifact/session mutations (ISS-9466). Same user, same token, same
    // server-side scope check and entity cap as the web caller.
    ...BATCH_MUTATION_ROUTE_PATTERNS,
    // Read-like exact-cohort analytics request; POST carries the bounded cohort body.
    /^\/branches\/analytics\/cohort$/,
    // Documents/Issues shared listing reads carry a bounded cohort in the body.
    /^\/documents\/costs$/,
    /^\/artifacts\/related-sessions$/,
    // Shared Add Issue creation; scope and payload validation remain API-owned.
    /^\/documents$/,
    /^\/artifact-links$/,
    // Existing listing favorite and inline tag controls.
    new RegExp(`^/artifacts/${UUID_SEGMENT}/favorite$`),
    /^\/entity-tags$/,
    /^\/tags$/,
    // Create a root trace comment on a session/branch target.
    new RegExp(`^/(?:agent-sessions|branches)/${SEGMENT}/trace-comments$`),
    // Reply under an existing trace comment.
    new RegExp(
      `^/(?:agent-sessions|branches)/${SEGMENT}/trace-comments/${SEGMENT}/replies$`
    ),
    TRACE_COMMENT_RETRY_SYNC_ROUTE,
    ...UNIFIED_COMMENT_WRITE_ROUTES.POST,
    // ISS-10995: attach one tag from the Session / Branch Details tab. The
    // route takes any `TagEntityType`, so the body is bounded too
    // ({@link refusedEntityTagWrite}).
    ENTITY_TAG_WRITE_PATTERN,
  ],
  PATCH: [
    // Edit a trace comment (or reply) by id.
    new RegExp(
      `^/(?:agent-sessions|branches)/${SEGMENT}/trace-comments/${SEGMENT}$`
    ),
    // ISS-10332 / PLN-2086 Milestone 2: set or clear one session's or branch's
    // priority from the Cloud-mode grids. Exact path — the id fills one UUID
    // slot, so the collections, their single-segment non-id routes and every
    // nested path stay refused. The server scopes the write to the caller's
    // org, but `PATCH /agent-sessions/[id]` also admits the status and owner
    // grouping writes, which no bridged surface makes — so the body is bounded
    // too ({@link refusedArtifactPatchBody}: priority on either path, rename or
    // project on the session path), and the path alone opens nothing else.
    SINGLE_ARTIFACT_PRIORITY_PATCH_PATTERN,
    ...UNIFIED_COMMENT_WRITE_ROUTES.PATCH,
  ],
  PUT: [
    ...DOCUMENT_WRITE_ROUTES.PUT,
    ...TEAM_WRITE_ROUTES.PUT,
    ...PROJECT_WRITE_ROUTES.PUT,
    // Settings v2 API Keys panel (ISS-10316): BYO Anthropic org/user
    // credential save, and the Pensero credential save.
    API_KEYS_ORG_ROUTE_PATTERN,
    API_KEYS_USER_ROUTE_PATTERN,
    PENSERO_ROUTE_PATTERN,
    // ISS-12302: set one custom-field value from the Session / Branch Details
    // tab. No body bound, unlike the priority PATCH: the route parses
    // `{ value, surface? }` and reads nothing else, so the path admits no other
    // write.
    CUSTOM_FIELD_VALUE_WRITE_PATTERN,
    ...UNIFIED_COMMENT_WRITE_ROUTES.PUT,
  ],
  DELETE: [
    ...DOCUMENT_WRITE_ROUTES.DELETE,
    ...TEAM_WRITE_ROUTES.DELETE,
    ...PROJECT_WRITE_ROUTES.DELETE,
    // Remove only the current user's favorite or one entity tag association.
    new RegExp(`^/artifacts/${UUID_SEGMENT}/favorite$`),
    /^\/entity-tags$/,
    // ISS-12302: clear one custom-field value (the PUT above, without a body).
    CUSTOM_FIELD_VALUE_WRITE_PATTERN,
    // ISS-10995: detach one tag from the Session / Branch Details tab. Its
    // parameters are a query string, which the allowlist never sees, so
    // {@link refusedEntityTagWrite} reads `entityType` off `url.searchParams`.
    ENTITY_TAG_WRITE_PATTERN,
    // Authenticated per-user grid preference reset (ISS-9448).
    GRID_PREFERENCE_ROUTE_PATTERN,
    // Delete a trace comment (or reply) by id.
    new RegExp(
      `^/(?:agent-sessions|branches)/${SEGMENT}/trace-comments/${SEGMENT}$`
    ),
    ...UNIFIED_COMMENT_WRITE_ROUTES.DELETE,
    // Revoke ONE of the caller's own browser sign-in sessions (ISS-8366 /
    // PLN-1915 D7). The route's authority is the authenticated caller, never
    // the supplied id: it refuses the caller's current session before any
    // provider lookup, and answers 404 identically for an unknown id, a
    // malformed one, and another user's, so it is not an existence oracle.
    // The id fills exactly one segment slot, so the collection itself and any
    // nested path under a session stay refused.
    new RegExp(`^/settings/browser-sessions/${SEGMENT}$`),
    // Settings v2 API Keys panel (ISS-10316): BYO Anthropic org/user
    // credential removal, and the Pensero credential removal. The platform
    // key routes (`POST /api-keys`, `DELETE /api-keys/{id}`) are a
    // pre-existing gap this change deliberately leaves closed.
    API_KEYS_ORG_ROUTE_PATTERN,
    API_KEYS_USER_ROUTE_PATTERN,
    PENSERO_ROUTE_PATTERN,
  ],
};

/**
 * Whether a non-GET request to `pathname` is permitted for `method`. Only the
 * path is matched (callers pass `url.pathname`, never the query), so a
 * `?`-smuggled suffix cannot widen an entry.
 */
function isAllowedNonGet(method: string, pathname: string): boolean {
  if (method !== "POST" && batchMutationPaths.has(pathname)) {
    return false;
  }
  const patterns = NON_GET_ALLOWLIST[method];
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
 * `packages/api/src/types/long-running-api-timeout.ts`). An `AbortSignal`
 * cannot cross the IPC bridge, so that override reaches this process as a
 * number on the request; before it was forwarded, EVERY bridged request was
 * pinned to {@link DEFAULT_TIMEOUT_MS} regardless of what its call site asked
 * for.
 *
 * Only a READ's deadline may exceed the main-owned bound. That is deliberate:
 * the renderer is treated as potentially compromised, and this credential holds
 * the org's authority, so the knob is confined to the surface that can actually
 * use it. Every long-running WRITE call site is a POST, and
 * {@link NON_GET_ALLOWLIST} admits none of them (its entries are listed there,
 * none raises its deadline) — so no non-GET call can benefit today, and letting
 * one ask for five minutes would only lengthen how long a compromised renderer
 * can hold a credentialed request open. Long-running GET reads, by contrast,
 * are already here: the branch
 * selected-PR files and diff queries
 * (`packages/app/branches/hooks/use-branch-selected-pull-request-files.ts`,
 * ISS-4471) raise the deadline on a GET, and are the first call sites this
 * forwarding actually serves. Adding a genuinely long-running route to
 * {@link NON_GET_ALLOWLIST} means revisiting this rule in the same change.
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
  isNonGet: boolean
): number {
  const mainOwnedBound = depsTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (requestTimeoutMs === undefined) {
    return mainOwnedBound;
  }
  const requested = Math.max(1, Math.trunc(requestTimeoutMs));
  if (isNonGet) {
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
  /** Cleanup-aware account-generation witness for the whole async request. */
  getAccountAdmission?: () => DesktopAccountAdmission | null;
  /** Signed-in identity for the org-identity header, or null. */
  getIdentity: () => { userId: string; organizationId: string } | null;
  /**
   * Drop the cached access token because the server rejected it (ISS-9701).
   *
   * Wired to `DesktopSessionManager.invalidateAccessToken`, the same handler the
   * sync lanes already attach to their own 401s — this
   * bridge was the one credentialed cloud caller that did not. Without it a
   * token the server has rejected keeps being re-sent until its LOCAL expiry
   * passes, so the renderer's refresh-and-retry (the shared `useApiClient`) has
   * nothing fresher to retry with and a live desktop session renders the
   * session-expired banner instead. Invalidating here is what makes that retry
   * mean something on desktop: the next {@link CloudApiFetchDeps.getAccessToken}
   * runs the manager's single-flight refresh, so N simultaneously-rejected
   * requests still cost exactly one refresh.
   *
   * Deliberately does NOT retry here. One retry belongs to one layer, and it is
   * the renderer's — retrying in both would multiply every rejected request into
   * four upstream calls. Auth status is untouched either way: a live session
   * recovers on the refresh, a revoked one fails it and clears to
   * `RefreshFailed` in the manager.
   *
   * The rejected token is passed so the manager can scope the eviction to it
   * (ISS-9701). 401s do not come back in the order their requests left: when two
   * requests are both carrying token T1 and the first recovers to T2, the
   * second's 401 still describes T1, and clearing unconditionally on it would
   * discard the freshly minted T2 and force another refresh — one per straggler,
   * for an expiry that was already recovered.
   *
   * Optional so an existing caller (test harness) compiles unchanged; a missing
   * handler degrades to exactly the behavior that shipped before.
   */
  onUnauthorized?: (rejectedToken: string) => void;
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

/**
 * The status that means the server did not accept this credential. Named so the
 * synthesized signed-out envelope and the token-invalidation check below cannot
 * drift apart.
 */
const UNAUTHORIZED_STATUS = 401;

/** Synthesized 401 in the `ApiResult` failure envelope (no network touched). */
function signedOutResponse(): CloudApiFetchResult {
  return {
    kind: "response",
    status: UNAUTHORIZED_STATUS,
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
  return applyDesktopClientAttribution(headers);
}

const CLOUD_API_ADMISSION_SUPERSEDED = Symbol("cloud-api-admission-superseded");

async function executeCloudApiFetch(
  deps: CloudApiFetchDeps,
  rawRequest: unknown
): Promise<CloudApiFetchResult> {
  try {
    return await executeCloudApiFetchForAdmission(deps, rawRequest);
  } catch (error) {
    if (error === CLOUD_API_ADMISSION_SUPERSEDED) {
      return signedOutResponse();
    }
    throw error;
  }
}

async function executeCloudApiFetchForAdmission(
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
  const isNonGet = NON_GET_METHODS.has(method);
  // A body is only accepted for allowlisted non-GET methods. GET stays
  // body-free, as it was before the write path existed.
  if (request.body !== undefined && !isNonGet) {
    return networkError(
      `cloud-api-fetch: request bodies are not supported for ${method}`
    );
  }

  const accountAdmission = deps.getAccountAdmission?.() ?? null;
  assertCloudApiAdmissionCurrent(deps, accountAdmission);
  const token = await deps.getAccessToken();
  if (!token) {
    return signedOutResponse();
  }
  assertCloudApiAdmissionCurrent(deps, accountAdmission);

  // Resolve + re-assert the target origin (protocol-relative / absolute paths
  // cannot re-target the host); a failure returns the mapped network error.
  const resolved = resolveTargetUrl(deps, request.path);
  if (resolved instanceof URL === false) {
    return resolved.error;
  }
  const url = resolved;
  assertCloudApiAdmissionCurrent(deps, accountAdmission);

  // Non-GET requests are confined to the exact path allowlist. Checked on the
  // composed `url.pathname` (already origin-asserted), after the origin guard so
  // a cross-origin request can never even reach this gate — and before the
  // fetch, so a non-allowlisted request never touches the network with the org
  // token.
  if (isNonGet && !isAllowedNonGet(method, url.pathname)) {
    return networkError(
      `cloud-api-fetch: ${method} ${url.pathname} is not an allowlisted write endpoint`
    );
  }
  const bodyRefusal = refusedArtifactPatchBody(
    method,
    url.pathname,
    request.body
  );
  if (bodyRefusal) {
    return bodyRefusal;
  }
  const entityTagRefusal = refusedEntityTagWrite(method, url, request.body);
  if (entityTagRefusal) {
    return entityTagRefusal;
  }

  return executeAdmittedCloudApiFetch(
    {
      fetchImpl: deps.fetchImpl,
      getIdentity: deps.getIdentity,
      onUnauthorized: deps.onUnauthorized,
      assertAdmissionCurrent: (captured) =>
        assertCloudApiAdmissionCurrent(deps, captured),
      buildUpstreamHeaders,
      resolveTimeoutMs: (requested, requestIsNonGet) =>
        resolveRequestTimeoutMs(requested, deps.timeoutMs, requestIsNonGet),
      rewriteDocumentAssets: (captured, responseOk, pathname, bodyText) =>
        rewriteAdmittedDocumentAssets(
          deps,
          captured,
          responseOk,
          pathname,
          bodyText
        ),
      transportError,
    },
    { request, method, isNonGet, accountAdmission, token, url }
  );
}

function assertCloudApiAdmissionCurrent(
  deps: CloudApiFetchDeps,
  captured: DesktopAccountAdmission | null
): void {
  if (
    deps.getAccountAdmission &&
    !isSameDesktopAccountAdmission(captured, deps.getAccountAdmission())
  ) {
    throw CLOUD_API_ADMISSION_SUPERSEDED;
  }
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
 * The body gate behind the one PATCH allowlist entry whose server route admits
 * more than the grids write (ISS-10332 review). `PATCH /agent-sessions/[id]`
 * also renames a session and reassigns its status, project and owner; a path
 * allowlist alone would hand a compromised renderer those writes over the
 * main-held credential. A body on this path must be a JSON object carrying
 * only the priority keys, or — on the session path — only the rename keys or
 * only the project keys; values are the server's to validate. Every other allowlisted path is untouched: `undefined` means "no
 * refusal", and the route's own strict schema still applies upstream.
 */
function refusedArtifactPatchBody(
  method: string,
  pathname: string,
  body: string | undefined
): CloudApiFetchResult | undefined {
  if (
    method !== "PATCH" ||
    !SINGLE_ARTIFACT_PRIORITY_PATCH_PATTERN.test(pathname)
  ) {
    return undefined;
  }
  // Each schema is `.strict()` and each required field is required, so the
  // three are mutually exclusive: a body pairing `name` with `priority`
  // satisfies NONE and is refused, which is what the server route does too.
  const onSessionPath = SINGLE_SESSION_PATCH_PATTERN.test(pathname);
  const admitted = admitsArtifactPatchBody(body, onSessionPath);
  if (!admitted) {
    return networkError(
      `cloud-api-fetch: PATCH ${pathname} admits a priority, rename or project body and nothing else`
    );
  }
  return undefined;
}

/**
 * The gate behind the two {@link ENTITY_TAG_WRITE_PATTERN} allowlist entries,
 * bounding `entityType` the way {@link refusedArtifactPatchBody} bounds the
 * PATCH body. The attach carries it in the body; the detach carries it in the
 * QUERY, which the allowlist never matches but this bridge holds in full.
 *
 * A detach naming no `entityType` is refused rather than forwarded: the route
 * answers 400, so forwarding only spends the credential on a write that cannot
 * land. `undefined` means "no refusal", and the route's own validator still
 * applies upstream.
 */
function refusedEntityTagWrite(
  method: string,
  url: URL,
  body: string | undefined
): CloudApiFetchResult | undefined {
  if (!ENTITY_TAG_WRITE_PATTERN.test(url.pathname)) {
    return undefined;
  }
  if (admitsArtifactEntityTagWrite(method, url, body)) {
    return undefined;
  }
  return networkError(
    `cloud-api-fetch: ${method} ${url.pathname} admits entityType ${TagEntityType.Artifact} and nothing else`
  );
}

function admitsArtifactEntityTagWrite(
  method: string,
  url: URL,
  body: string | undefined
): boolean {
  if (method === "POST") {
    return admitsArtifactEntityTagAttachBody(body);
  }
  if (method === "DELETE") {
    return (
      url.searchParams.get("entityType") === TagEntityType.Artifact &&
      admitsArtifactEntityTagDetachSurface(url.searchParams.get("surface"))
    );
  }
  return false;
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

function rewriteAdmittedDocumentAssets(
  deps: CloudApiFetchDeps,
  admission: DesktopAccountAdmission | null,
  successful: boolean,
  pathname: string,
  bodyText: string
): string {
  const getAdmission = deps.getAccountAdmission;
  if (successful && admission && getAdmission) {
    return rewriteDocumentAssetResponse(pathname, bodyText, () =>
      isSameDesktopAccountAdmission(admission, getAdmission())
    );
  }
  return bodyText;
}

const batchMutationPaths = new Set<string>(Object.values(BatchMutationRoute));
