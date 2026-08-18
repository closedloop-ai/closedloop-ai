"use client";

import type { ApiResult } from "@repo/api/src/types/common";
import {
  DEPLOYMENT_ID_HEADER,
  ORG_IDENTITY_HEADER,
} from "@repo/api/src/types/headers";
import { useMemo } from "react";
import { useAuthSnapshot } from "../auth/use-auth-snapshot";
import { useWaitForAuthLoaded } from "../auth/use-wait-for-auth-loaded";
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
import { useApiAdapter } from "./provider";
import { createDateReviver } from "./revive-with-dates";

type ResolveOrigin = () => string;
type GetToken = () => Promise<string | null>;

const AUTH_TOKEN_RETRY_DELAY_MS = 100;
const AUTH_TOKEN_MAX_ATTEMPTS = 20;

/**
 * This hook provides an HTTP client for interacting with the REST API.
 *
 * Surface-agnostic port of the former `apps/app/hooks/use-api-client.ts`
 * (FEA-1510): the API origin comes from the transport adapter and the
 * token/org identity from the auth port, so the web and desktop shells each
 * supply their own without forking this code.
 *
 * Throws ApiError on failures. This allows TanStack Query to handle errors
 * natively via its error state and global error handlers.
 */
export function useApiClient() {
  const { getToken, orgId, userId } = useAuthSnapshot();
  const waitForAuthLoaded = useWaitForAuthLoaded();
  const {
    resolveApiOrigin,
    fetch: injectedFetch,
    deploymentId,
  } = useApiAdapter();
  const doFetch = injectedFetch ?? globalThis.fetch;

  return useMemo(() => {
    /**
     * One request, start to finish, entirely inside its deadline (ISS-5013).
     *
     * The deadline is armed BEFORE the auth wait on purpose. `waitForAuthLoaded`
     * resolves only when the shell's auth state hydrates, so a shell that never
     * hydrates would otherwise leave the caller hanging before any timer was
     * ever armed — the same "waits forever, tells you nothing" failure one layer
     * up. Racing both auth steps against the deadline closes that hole.
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
        const response = await apiRequest(
          resolveApiOrigin,
          doFetch,
          path,
          token,
          orgId,
          deploymentId,
          toRequestInit(options, deadline)
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

      postRaw: <T>(path: string, data: unknown, options?: ApiRequestOptions) =>
        run<T>(path, withBody("POST", data, options), readRawBody),
    };
  }, [
    getToken,
    userId,
    orgId,
    deploymentId,
    waitForAuthLoaded,
    resolveApiOrigin,
    doFetch,
  ]);
}

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
