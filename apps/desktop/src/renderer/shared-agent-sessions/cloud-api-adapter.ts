import type {
  ApiAdapter,
  ApiTransportFetch,
} from "@repo/app/shared/api/api-adapter";
import { ApiError } from "@repo/app/shared/api/api-error";
import {
  API_NO_RESPONSE_STATUS,
  API_TIMEOUT_ERROR_CODE,
  API_TIMEOUT_ERROR_MESSAGE,
  type ApiRequestOptions,
} from "@repo/app/shared/api/api-timeout";
import {
  CLOUD_API_FETCH_MAX_TIMEOUT_MS,
  CloudApiFetchErrorReason,
  type CloudApiFetchResult,
  DESKTOP_CLOUD_API_PLACEHOLDER_ORIGIN,
} from "../../shared/cloud-api-fetch-contract";
import type { DesktopApi } from "../types/desktop-api";

/**
 * Desktop implementation of the shared `ApiAdapter` transport port (PLN-1138
 * D-G Option B). Replaces the former inert adapter: cloud REST requests are
 * marshalled over IPC to the main process, which resolves the real API origin
 * and attaches the first-party session token — the renderer never dials the
 * network for the cloud API and never sees the credential.
 *
 * `resolveApiOrigin` returns a deliberately non-routable placeholder; the
 * bridge fetch below rejects any URL on a different origin, so the main
 * process stays the single authority for where cloud requests may go.
 */
export function createDesktopCloudApiAdapter(
  desktopApi: DesktopApi
): ApiAdapter {
  return {
    resolveApiOrigin: () => DESKTOP_CLOUD_API_PLACEHOLDER_ORIGIN,
    fetch: createCloudIpcFetch(desktopApi),
  };
}

/** Statuses whose `Response` must carry a null body per the Fetch spec. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Bridge implementation of the platform `fetch` contract, faithful to what the
 * shared `useApiClient` consumes (`ok`/`status`/`statusText`/`text()`/`json()`):
 * completed HTTP exchanges resolve to a synthesized `Response` whatever their
 * status; transport failures reject with `TypeError`, which the client maps to
 * `ApiError("…", 0)` exactly as on web. Streaming bodies are out of scope;
 * requests are buffered whole.
 *
 * `init.signal` still cannot cross the bridge, so a caller abort does not
 * cancel the in-flight main-process request. The request's DEADLINE does cross,
 * as a plain number — the client's remaining budget at marshal time, stamped by
 * `toRequestInit` — see {@link forwardableTimeoutMs}.
 */
function createCloudIpcFetch(desktopApi: DesktopApi): ApiTransportFetch {
  return async (
    input: RequestInfo | URL,
    init?: ApiRequestOptions
  ): Promise<Response> => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      throw new TypeError(
        "The desktop cloud transport does not support Request objects; pass a URL string."
      );
    }
    if (typeof desktopApi?.cloudApiFetch !== "function") {
      // Partial test stubs may omit the bridge; fail like an unreachable
      // network rather than a crash (mirrors the auth provider's guard).
      throw new TypeError("The desktop cloud-API bridge is unavailable.");
    }

    let url: URL;
    try {
      url = new URL(String(input));
    } catch {
      throw new TypeError(
        `Invalid URL for the desktop cloud transport: ${String(input)}`
      );
    }
    if (url.origin !== DESKTOP_CLOUD_API_PLACEHOLDER_ORIGIN) {
      throw new TypeError(
        "The desktop cloud transport only reaches the cloud API origin; cross-origin requests are not supported."
      );
    }

    const body = init?.body;
    if (body != null && typeof body !== "string") {
      throw new TypeError(
        "The desktop cloud transport only supports string request bodies."
      );
    }

    const timeoutMs = forwardableTimeoutMs(init?.timeoutMs);
    const result: CloudApiFetchResult = await desktopApi.cloudApiFetch({
      path: `${url.pathname}${url.search}`,
      method: init?.method ?? "GET",
      headers: flattenRequestHeaders(init?.headers),
      // Omit these fields entirely when absent rather than serializing an
      // explicit `undefined` across the IPC boundary.
      ...(body == null ? {} : { body }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return synthesizeResponse(result);
  };
}

/**
 * Converts a bridge result into a platform `Response`. Transport failures and
 * malformed results throw `TypeError` — a garbage result must never fall
 * through into a synthesized `Response`.
 *
 * The one exception is a failure main CLASSIFIED as its deadline expiring
 * (ISS-5082). Because main's timer is the authoritative deadline on desktop,
 * that abort would otherwise arrive as an anonymous transport failure and
 * `toApiClientError` would wrap it as `ApiError(message, 0)` with no code —
 * making desktop structurally incapable of ever reaching the
 * `API_TIMEOUT_ERROR_CODE` state ISS-5013 built the "we stopped waiting"
 * surface for. Throwing the same `ApiError` the shared client itself builds for
 * a web timeout puts desktop on that surface: `toApiClientError` passes an
 * `ApiError` through untouched and `ApiError#isTimeout()` answers true, so
 * `getFriendlyError` renders the timeout copy instead of a generic transport
 * failure.
 *
 * The gain is CLASSIFICATION, not retry avoidance — be precise about this. The
 * unlabeled path was never retried either: `isResponseBackedError` short-
 * circuits on `error instanceof ApiError` without reading the status, so every
 * `ApiError` this client throws (status 0 included) already failed fast. What
 * changes is that the failure now says which failure it was.
 *
 * An ABSENT or UNKNOWN `reason` deliberately falls through to the `TypeError`
 * below — the version-skew rule, and what keeps an older or newer main process
 * behaving exactly as it did before this field existed.
 */
function synthesizeResponse(result: CloudApiFetchResult): Response {
  if (result?.kind === "network-error") {
    if (result.reason === CloudApiFetchErrorReason.Timeout) {
      throw new ApiError(API_TIMEOUT_ERROR_MESSAGE, API_NO_RESPONSE_STATUS, {
        code: API_TIMEOUT_ERROR_CODE,
      });
    }
    throw new TypeError(result.message);
  }
  if (
    result?.kind !== "response" ||
    typeof result.status !== "number" ||
    typeof result.bodyText !== "string"
  ) {
    throw new TypeError("Malformed result from the desktop cloud-API bridge.");
  }
  return new Response(
    NULL_BODY_STATUSES.has(result.status) ? null : result.bodyText,
    {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    }
  );
}

/**
 * Flattens any `HeadersInit` shape to the bridge's plain record, dropping
 * `Authorization` on this side too (defense in depth — the main process strips
 * it regardless and injects the real credential).
 */
function flattenRequestHeaders(
  headersInit: HeadersInit | undefined
): Record<string, string> {
  const flattened: Record<string, string> = {};
  if (!headersInit) {
    return flattened;
  }
  const entries =
    headersInit instanceof Headers || Array.isArray(headersInit)
      ? [...(headersInit instanceof Headers ? headersInit : headersInit)]
      : Object.entries(headersInit);
  for (const [name, value] of entries) {
    if (name.toLowerCase() !== "authorization") {
      flattened[name] = value;
    }
  }
  return flattened;
}

/**
 * The deadline to put on the wire, or `undefined` to send none (ISS-5082).
 *
 * Three cases, and the `null` one is the subtle one:
 * - a positive number: forwarded, rounded UP to whole milliseconds because
 *   `AbortSignal.timeout()` in the main process rejects a fractional delay.
 *   Rounding up rather than down keeps the bridge's deadline from landing
 *   inside the client's.
 * - `null`, the client's explicit "wait indefinitely" opt-out: the bridge has
 *   no unbounded mode, so it is sent as {@link CLOUD_API_FETCH_MAX_TIMEOUT_MS},
 *   the longest wait it can express. Omitting it instead would give the call
 *   site that asked to wait LONGEST the bridge's SHORTEST bound. The residual
 *   cost of that choice is now only the CEILING, not the classification: the
 *   opt-out arms no renderer timer, so the client's own `timedOut()` stays
 *   false, but main labels its expiry `reason: "timeout"` and
 *   {@link synthesizeResponse} maps that onto the same
 *   `API_TIMEOUT_ERROR_CODE` a web timeout produces — so an opt-out read that
 *   dies at five minutes still reaches the "we stopped waiting" state instead
 *   of an anonymous transport error. What it cannot do is wait longer than
 *   five minutes. Latent today (no call site passes `timeoutMs: null`).
 * - `undefined` (no override) or a value the bridge cannot express: omitted, so
 *   the main process applies its own default. Non-finite and non-positive
 *   values are dropped here rather than forwarded because they are not
 *   deadlines at all — main would only clamp or discard them anyway. Dropping
 *   them is no longer load-bearing for SAFETY: main's request schema tolerates
 *   an unusable `timeoutMs` and degrades it to its own bound instead of
 *   failing the whole request (ISS-5082), so a value that slipped through
 *   would cost the override and nothing more.
 */
function forwardableTimeoutMs(timeoutMs: number | null | undefined) {
  if (timeoutMs === null) {
    return CLOUD_API_FETCH_MAX_TIMEOUT_MS;
  }
  if (typeof timeoutMs !== "number") {
    return undefined;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return Math.min(Math.ceil(timeoutMs), CLOUD_API_FETCH_MAX_TIMEOUT_MS);
}
