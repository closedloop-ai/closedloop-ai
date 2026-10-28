"use client";

/**
 * The HTTP client both `useApiClient` entry points hand out, and everything it
 * is built from.
 *
 * Its own module (ISS-9450) rather than a private half of `use-api-client.ts`,
 * because ~100 suites `vi.mock` that path with a partial mock naming only
 * `useApiClient` — so any second export added there is `undefined` at every one
 * of those mount sites. A consumer that reaches for the factory or the
 * non-throwing hook imports from here or from `use-api-client-optional.ts`,
 * neither of which those mocks shadow.
 */

import type { ApiResult } from "@repo/api/src/types/common";
import {
  DEPLOYMENT_ID_HEADER,
  ORG_IDENTITY_HEADER,
} from "@repo/api/src/types/headers";
import type { AuthSnapshot } from "../auth/auth-adapter";
import type { ApiTransportFetch } from "./api-adapter";
import { ApiError } from "./api-error";
import {
  extractRawErrorMessage as getRawErrorMessage,
  parseRawErrorBody,
} from "./api-error-response";
import {
  API_NO_RESPONSE_STATUS,
  API_TIMEOUT_ERROR_CODE,
  API_TIMEOUT_ERROR_MESSAGE,
  type ApiRequestDeadline,
  type ApiRequestOptions,
  isAbortError,
  raceRequestDeadline,
  startApiRequestDeadline,
  toRequestInit,
} from "./api-timeout";
import { refreshAuthToken } from "./refresh-auth-token";
import { createDateReviver } from "./revive-with-dates";

type ResolveOrigin = () => string;
type GetToken = AuthSnapshot["getToken"];

const AUTH_TOKEN_RETRY_DELAY_MS = 100;
const AUTH_TOKEN_MAX_ATTEMPTS = 20;

/**
 * The status that means "we do not know who you are" — the only one this client
 * answers by refreshing the token and retrying (ISS-9701). Deliberately NOT 403:
 * a bare 403 says the caller IS known and one resource is not theirs, which no
 * amount of fresh credential changes, and treating the two alike is the
 * conflation ISS-5095 removed from the shell.
 */
const UNAUTHORIZED_STATUS = 401;

/**
 * Clerk can briefly report a loaded signed-in user before `getToken()` returns
 * a bearer token. Authenticated API calls wait through that short gap so polling
 * queries do not cache a transient 401 immediately after page load.
 */
async function resolveLoadedAuthToken(
  getToken: GetToken,
  userId: string | null
): Promise<string | null> {
  let token = await getToken();
  if (token || !userId) {
    return token;
  }

  for (let attempt = 1; attempt < AUTH_TOKEN_MAX_ATTEMPTS; attempt += 1) {
    await delay(AUTH_TOKEN_RETRY_DELAY_MS);
    token = await getToken();
    if (token) {
      return token;
    }
  }

  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

/**
 * Read an `ApiResult` envelope response, throwing `ApiError` on any failure.
 *
 * `path` is the request path, which scopes date revival to the endpoint that
 * produced this body (ISS-6208).
 */
async function readEnvelopeBody<T>(
  response: Response,
  path: string
): Promise<T> {
  {
    const rawBody = await response.text();
    let result: ApiResult<T>;
    try {
      result = JSON.parse(rawBody, createDateReviver(path));
    } catch {
      // Body isn't JSON (e.g. a 404/500 HTML page from a missing route or a
      // proxy/gateway). Surface the HTTP status with a readable message rather
      // than leaking a raw "Unexpected token '<'" JSON.parse error.
      throw new ApiError(
        response.ok
          ? "Received a malformed (non-JSON) response from the server."
          : `Request failed with status ${response.status}.`,
        response.status
      );
    }

    // Check the HTTP status before the envelope. An error response may not
    // carry a well-formed ApiResult — `success` can be undefined (e.g. a
    // proxy/gateway body), and `!result.success` would then be read as a
    // failed envelope with an undefined message. Parse defensively via the
    // raw-error helpers instead.
    if (!response.ok) {
      const parsed = parseRawErrorBody(result);
      throw new ApiError(getRawErrorMessage(result), response.status, {
        code: parsed?.code,
        data: result,
        details: parsed?.details,
        timestamp: parsed?.timestamp,
      });
    }
    if (result.success === false) {
      // HTTP 2xx but the envelope reports failure — surface it rather than
      // returning undefined data.
      throw new ApiError(result.error, response.status, {
        code: result.code,
        data: result,
        details: result.details,
        timestamp: result.timestamp,
      });
    }

    return result.data;
  }
}

/** Read an un-enveloped response body, throwing `ApiError` on an error status. */
async function readRawBody<T>(response: Response): Promise<T> {
  const body = await response.json().catch((error: unknown) => {
    // A non-JSON body is a `null` body, as before — but an ABORTED body stream
    // is not "no JSON", it is the request being cut off. Swallowing it here
    // would resolve a timed-out request as a fake `null` success that never
    // reaches the error classifier (review finding, ISS-5013).
    if (isAbortError(error)) {
      throw error;
    }
    return null;
  });

  if (!response.ok) {
    throwApiErrorFromResponseWithBody(response, body);
  }

  return body as T;
}

/**
 * Read a text response body, throwing `ApiError` on an error status.
 *
 * An aborted stream is NOT caught here at all — the `response.text()` rejection
 * propagates through `run`'s own handler and reaches the error classifier. That
 * is the same OUTCOME {@link readRawBody} reaches by rethrowing from its catch,
 * arrived at differently: that reader has to catch, because it swallows a JSON
 * parse failure and must not swallow an abort along with it. This one parses
 * nothing, so it needs no catch to avoid the same trap. Either way a cut-off
 * request never resolves as a successful empty export.
 */
async function readTextBody(response: Response): Promise<string> {
  const text = await response.text();
  if (!response.ok) {
    throwApiErrorFromResponseWithBody(response, safeParseJson(text));
  }
  return text;
}

/** The error envelope carried by a failed text-route response, or the raw text. */
function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function throwApiErrorFromResponseWithBody(
  response: Response,
  body: unknown
): never {
  const parsed = parseRawErrorBody(body);
  throw new ApiError(getRawErrorMessage(body), response.status, {
    code: parsed?.code,
    data: body,
    details: parsed?.details,
    timestamp: parsed?.timestamp,
  });
}

function apiRequest(
  resolveOrigin: ResolveOrigin,
  fetchImpl: ApiTransportFetch,
  path: string,
  token: string | null,
  orgId: string | null | undefined,
  deploymentId: string | null | undefined,
  options?: ApiRequestOptions
): Promise<Response> {
  const authHeaders: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {};

  if (orgId) {
    authHeaders[ORG_IDENTITY_HEADER] = orgId;
  }

  // FEA-1485: pin the cross-origin app→api fetch to the api deployment this
  // build was paired with. Set only when a pin is resolved (app-prod);
  // otherwise omitted so the request hits the latest api (no-pin fallback).
  if (deploymentId) {
    authHeaders[DEPLOYMENT_ID_HEADER] = deploymentId;
  }

  return fetchImpl(`${resolveOrigin()}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
      ...options?.headers,
    },
  });
}

/**
 * Classify a thrown request failure into the error the caller should see
 * (ISS-5013).
 *
 * Order matters. An `ApiError` already carries a real HTTP answer and passes
 * through untouched. A deadline abort becomes a TIMEOUT error — a distinct code
 * and the no-response status, so a surface can say "we stopped waiting" rather
 * than implying the server rejected the request. A CALLER-initiated abort
 * (React Query cancelling a superseded query, a user navigating away) is
 * re-thrown unchanged so it stays a real `AbortError` and is treated as a
 * cancellation rather than being laundered into an error state the UI would
 * render. Everything else keeps the previous network-error wrapping.
 */
function toApiClientError(
  error: unknown,
  deadline: ApiRequestDeadline
): unknown {
  if (error instanceof ApiError) {
    return error;
  }

  // Only an ABORT that our own deadline caused is a timeout. An unrelated
  // failure that merely happens after the timer fired keeps its own identity.
  if (isAbortError(error)) {
    if (deadline.timedOut()) {
      return new ApiError(API_TIMEOUT_ERROR_MESSAGE, API_NO_RESPONSE_STATUS, {
        code: API_TIMEOUT_ERROR_CODE,
      });
    }
    return error;
  }

  return new ApiError(
    error instanceof Error ? error.message : "Network error",
    API_NO_RESPONSE_STATUS
  );
}

/**
 * Issue one request, and if the server answers 401, mint a fresh token and
 * issue it exactly once more (ISS-9701).
 *
 * A session token is short-lived and the client holds it for the life of the
 * request. A backgrounded tab, a sleeping laptop, or a long idle can therefore
 * produce a 401 on a session that is perfectly alive — and nothing downstream
 * recovers from it: `shouldRetryQuery` refuses to retry any response-backed
 * error, and the shared auth-rejection boundary latches the FIRST 401 from ANY
 * query into the web shell's "Your session expired" card. One aged-out token
 * therefore replaced the whole workspace, ~20 times a day, for a user who never
 * needed to sign in.
 *
 * The recovery is here, at the request layer, rather than in that guard. Making
 * the guard more tolerant of a 401 would hide a REAL expiry, and a user whose
 * session actually ended needs that card. So the client attempts the refresh and
 * lets the guard classify whatever survives it: a token that was merely stale
 * succeeds silently, a session that is genuinely gone still reaches the card,
 * having earned it.
 *
 * Exactly one retry, and only for 401:
 *  - A refresh that yields no token means there is nothing fresher to try, so
 *    the ORIGINAL 401 is returned — a signed-out caller reaches the same answer
 *    it would have before.
 *  - A second 401 after a genuine refresh is terminal by construction: this
 *    function returns it, and there is no loop to re-enter.
 *  - A deadline that expires while the refresh is in flight also returns that
 *    original 401 rather than a timeout, so the answer the server already gave
 *    still reaches the auth classifier.
 *  - Every 401 caused by the SAME token shares one refresh
 *    ({@link refreshAuthToken}) — the concurrent ones and the ones that land
 *    after an earlier request has already recovered — so a token that ages out
 *    under a dozen in-flight queries costs one token mint, not a dozen. The
 *    token the request actually carried is what scopes that, which is why it is
 *    passed down: a late 401 is answered with the credential its own expiry
 *    already produced, while a genuinely later expiry still refreshes.
 *
 * The retry is safe for writes as well as reads: `withAnyAuth` answers 401 at
 * the auth boundary, before any route handler runs, so a rejected mutation had
 * no server-side effect to duplicate.
 */
async function sendWithStaleTokenRetry(
  send: (token: string | null) => Promise<Response>,
  token: string | null,
  getToken: GetToken,
  deadline: ApiRequestDeadline
): Promise<Response> {
  const response = await send(token);
  if (response.status !== UNAUTHORIZED_STATUS) {
    return response;
  }

  // Buffered BEFORE the refresh is awaited, and that ordering is the whole
  // point. The first attempt was issued with the deadline's signal
  // (`toRequestInit`), so a deadline that fires while the refresh is in flight
  // also errors THIS response's body stream — and both fallbacks below hand
  // this response to `readBody`, whose `response.text()` would then reject with
  // an `AbortError` that `toApiClientError` folds straight back into a timeout.
  // Catching the abort without this would fix nothing on the web transport.
  const unauthorized = await bufferResponse(response);

  let refreshed: string | null;
  try {
    refreshed = await raceRequestDeadline(
      refreshAuthToken(getToken, token),
      deadline
    );
  } catch (error) {
    // OUR deadline expiring mid-refresh must not upgrade an answer we already
    // have into a TIMEOUT. The server said 401; that is what
    // `classifyAuthRejection` reads to raise the session-expired card, and a
    // timeout classifies as nothing — the guard would leave a genuinely dead
    // session on "we stopped waiting", with no way back in. Before the retry
    // existed that 401 reached the classifier immediately, so swallowing it
    // here would be strictly worse than not retrying at all.
    //
    // A CALLER abort still propagates. The two are not interchangeable: a
    // cancelled query must stay a cancellation, not become a rendered 401.
    if (isAbortError(error) && deadline.timedOut()) {
      return unauthorized;
    }
    throw error;
  }

  if (refreshed === null) {
    return unauthorized;
  }
  return await send(refreshed);
}

/**
 * Re-wrap `response` around a body already read into memory, so a later read
 * cannot fail on a signal that has since aborted. See the call site for the
 * ordering this exists to enforce.
 */
async function bufferResponse(response: Response): Promise<Response> {
  const body = await response.text();
  return new globalThis.Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * Build the client object from already-resolved ports (ISS-9450).
 *
 * Extracted from {@link useApiClient}'s memo so {@link useApiClientOptional}
 * can produce the identical client from the NON-throwing port accessors. One
 * body, so the two entry points cannot drift on deadlines, token retry, org
 * identity, or body reading.
 */
export function createApiClient({
  getToken,
  userId,
  orgId,
  deploymentId,
  honorsAbortSignal,
  waitForAuthLoaded,
  resolveApiOrigin,
  doFetch,
}: ApiClientPorts) {
  /**
   * One request, start to finish, entirely inside its deadline (ISS-5013).
   *
   * The deadline is armed BEFORE the auth wait on purpose. `waitForAuthLoaded`
   * resolves only when the shell's auth state hydrates, so a shell that never
   * hydrates would otherwise leave the caller hanging before any timer was
   * ever armed — the same "waits forever, tells you nothing" failure one layer
   * up. Racing both auth steps against the deadline closes that hole.
   *
   * A 401 answer gets one refresh-and-retry inside this same deadline
   * (ISS-9701) — see {@link sendWithStaleTokenRetry}. Whatever survives that
   * is the answer the caller and the shell's auth guard classify.
   */
  const run = async <T>(
    path: string,
    options: ApiRequestOptions | undefined,
    readBody: (response: Response, path: string) => Promise<T>
  ): Promise<T> => {
    const deadline = startApiRequestDeadline(options);
    try {
      await raceRequestDeadline(waitForAuthLoaded(), deadline);
      const token = await raceRequestDeadline(
        resolveLoadedAuthToken(getToken, userId),
        deadline
      );
      const response = await sendWithStaleTokenRetry(
        (bearer) =>
          apiRequest(
            resolveApiOrigin,
            doFetch,
            path,
            bearer,
            orgId,
            deploymentId,
            // Rebuilt per attempt: `toRequestInit` stamps what is LEFT of the
            // deadline, and a transport that arms its own timer from that
            // number (the desktop bridge) must not be handed the first
            // attempt's budget again.
            toRequestInit(options, deadline)
          ),
        token,
        getToken,
        deadline
      );
      return await readBody(response, path);
    } catch (error) {
      throw toApiClientError(error, deadline);
    } finally {
      deadline.dispose();
    }
  };

  const withBody = (
    method: string,
    data: unknown,
    options?: ApiRequestOptions
  ): ApiRequestOptions => ({
    ...options,
    method,
    body: JSON.stringify(data),
  });

  return {
    /**
     * ISS-9741: the adapter's `honorsAbortSignal`, forwarded so a caller
     * holding only the client can still ask whether cancelling a request
     * stops the work behind it.
     */
    honorsAbortSignal,

    get: <T>(path: string, options?: ApiRequestOptions) =>
      run<T>(path, options, readEnvelopeBody),

    post: <T>(path: string, data: unknown, options?: ApiRequestOptions) =>
      run<T>(path, withBody("POST", data, options), readEnvelopeBody),

    put: <T>(path: string, data: unknown, options?: ApiRequestOptions) =>
      run<T>(path, withBody("PUT", data, options), readEnvelopeBody),

    patch: <T>(path: string, data: unknown, options?: ApiRequestOptions) =>
      run<T>(path, withBody("PATCH", data, options), readEnvelopeBody),

    delete: <T>(path: string, options?: ApiRequestOptions) =>
      run<T>(path, { ...options, method: "DELETE" }, readEnvelopeBody),

    getRaw: <T>(path: string, options?: ApiRequestOptions) =>
      run<T>(path, options, readRawBody),

    /**
     * FEA-4217: a route whose success body is NOT JSON — today the Sessions
     * CSV export.
     *
     * It needs its own reader rather than `getRaw`: that one calls
     * `response.json()` first and folds a parse failure to `null`, so a
     * perfectly good CSV would resolve as an empty success. Errors still come
     * back as JSON envelopes from `withAnyAuth`, so the FAILURE path parses
     * the text it already read instead of issuing a second read of a consumed
     * body.
     */
    getText: (path: string, options?: ApiRequestOptions) =>
      run<string>(path, options, readTextBody),

    postRaw: <T>(path: string, data: unknown, options?: ApiRequestOptions) =>
      run<T>(path, withBody("POST", data, options), readRawBody),
  };
}
/** The ports {@link createApiClient} needs, already resolved by a caller. */
export type ApiClientPorts = {
  getToken: GetToken;
  userId: string | null;
  orgId: string | null;
  deploymentId: string | null | undefined;
  honorsAbortSignal: boolean;
  waitForAuthLoaded: () => Promise<void>;
  resolveApiOrigin: ResolveOrigin;
  doFetch: ApiTransportFetch;
};

/** The client {@link useApiClient} hands out. */
export type ApiClient = ReturnType<typeof createApiClient>;
