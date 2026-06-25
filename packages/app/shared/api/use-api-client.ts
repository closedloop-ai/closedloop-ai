"use client";

import type { ApiResult } from "@repo/api/src/types/common";
import {
  DEPLOYMENT_ID_HEADER,
  ORG_IDENTITY_HEADER,
} from "@repo/api/src/types/headers";
import { useMemo } from "react";
import { useAuthSnapshot } from "../auth/use-auth-snapshot";
import { useWaitForAuthLoaded } from "../auth/use-wait-for-auth-loaded";
import { ApiError } from "./api-error";
import {
  extractRawErrorMessage as getRawErrorMessage,
  parseRawErrorBody,
} from "./api-error-response";
import { useApiAdapter } from "./provider";
import { reviveWithDates } from "./revive-with-dates";

type ResolveOrigin = () => string;

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
  const { getToken, orgId } = useAuthSnapshot();
  const waitForAuthLoaded = useWaitForAuthLoaded();
  const {
    resolveApiOrigin,
    fetch: injectedFetch,
    deploymentId,
  } = useApiAdapter();
  const doFetch = injectedFetch ?? globalThis.fetch;

  return useMemo(
    () => ({
      get: async <T>(path: string, options?: RequestInit) => {
        await waitForAuthLoaded();
        return apiFetch<T>(
          resolveApiOrigin,
          doFetch,
          path,
          await getToken(),
          orgId,
          deploymentId,
          options
        );
      },

      post: async <T>(path: string, data: unknown) => {
        await waitForAuthLoaded();
        return apiFetch<T>(
          resolveApiOrigin,
          doFetch,
          path,
          await getToken(),
          orgId,
          deploymentId,
          { method: "POST", body: JSON.stringify(data) }
        );
      },

      put: async <T>(path: string, data: unknown) => {
        await waitForAuthLoaded();
        return apiFetch<T>(
          resolveApiOrigin,
          doFetch,
          path,
          await getToken(),
          orgId,
          deploymentId,
          { method: "PUT", body: JSON.stringify(data) }
        );
      },

      patch: async <T>(path: string, data: unknown) => {
        await waitForAuthLoaded();
        return apiFetch<T>(
          resolveApiOrigin,
          doFetch,
          path,
          await getToken(),
          orgId,
          deploymentId,
          { method: "PATCH", body: JSON.stringify(data) }
        );
      },

      delete: async <T>(path: string) => {
        await waitForAuthLoaded();
        return apiFetch<T>(
          resolveApiOrigin,
          doFetch,
          path,
          await getToken(),
          orgId,
          deploymentId,
          { method: "DELETE" }
        );
      },

      getRaw: async <T>(path: string, options?: RequestInit) => {
        await waitForAuthLoaded();
        return apiFetchRaw<T>(
          resolveApiOrigin,
          doFetch,
          path,
          await getToken(),
          orgId,
          deploymentId,
          options
        );
      },

      postRaw: async <T>(path: string, data: unknown) => {
        await waitForAuthLoaded();
        return apiFetchRaw<T>(
          resolveApiOrigin,
          doFetch,
          path,
          await getToken(),
          orgId,
          deploymentId,
          { method: "POST", body: JSON.stringify(data) }
        );
      },
    }),
    [
      getToken,
      orgId,
      deploymentId,
      waitForAuthLoaded,
      resolveApiOrigin,
      doFetch,
    ]
  );
}

async function apiFetch<T>(
  resolveOrigin: ResolveOrigin,
  fetchImpl: typeof fetch,
  path: string,
  token: string | null,
  orgId: string | null | undefined,
  deploymentId: string | null | undefined,
  options?: RequestInit
): Promise<T> {
  try {
    const response = await apiRequest(
      resolveOrigin,
      fetchImpl,
      path,
      token,
      orgId,
      deploymentId,
      options
    );
    const rawBody = await response.text();
    let result: ApiResult<T>;
    try {
      result = JSON.parse(rawBody, reviveWithDates);
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
  } catch (error) {
    // Re-throw ApiError as-is
    if (error instanceof ApiError) {
      throw error;
    }

    // Wrap other errors (network errors, JSON parse errors, etc.)
    throw new ApiError(
      error instanceof Error ? error.message : "Network error",
      0
    );
  }
}

async function apiFetchRaw<T>(
  resolveOrigin: ResolveOrigin,
  fetchImpl: typeof fetch,
  path: string,
  token: string | null,
  orgId: string | null | undefined,
  deploymentId: string | null | undefined,
  options?: RequestInit
): Promise<T> {
  try {
    const response = await apiRequest(
      resolveOrigin,
      fetchImpl,
      path,
      token,
      orgId,
      deploymentId,
      options
    );
    const body = await response.json().catch(() => null);

    if (!response.ok) {
      throwApiErrorFromResponseWithBody(response, body);
    }

    return body as T;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(
      error instanceof Error ? error.message : "Network error",
      0
    );
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
  fetchImpl: typeof fetch,
  path: string,
  token: string | null,
  orgId: string | null | undefined,
  deploymentId: string | null | undefined,
  options?: RequestInit
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
