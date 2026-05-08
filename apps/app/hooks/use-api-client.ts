"use client";

import type { ApiResult } from "@repo/api/src/types/common";
import { useAuth } from "@repo/auth/client";
import { useMemo } from "react";
import { useWaitForAuthLoaded } from "@/hooks/use-wait-for-auth-loaded";
import { ApiError } from "@/lib/api-error";
import {
  extractRawErrorMessage as getRawErrorMessage,
  parseRawErrorBody,
} from "@/lib/api-error-response";
import { resolveApiOrigin } from "@/lib/api-origin";
import { reviveWithDates } from "@/lib/revive-with-dates";

/**
 * This hook provides an HTTP client for interacting with the REST API.
 *
 * Throws ApiError on failures. This allows TanStack Query to handle errors
 * natively via its error state and global error handlers.
 */
export function useApiClient() {
  const { getToken } = useAuth();
  const waitForAuthLoaded = useWaitForAuthLoaded();

  return useMemo(
    () => ({
      get: async <T>(path: string, options?: RequestInit) => {
        await waitForAuthLoaded();
        return apiFetch<T>(path, await getToken(), options);
      },

      post: async <T>(path: string, data: unknown) => {
        await waitForAuthLoaded();
        return apiFetch<T>(path, await getToken(), {
          method: "POST",
          body: JSON.stringify(data),
        });
      },

      put: async <T>(path: string, data: unknown) => {
        await waitForAuthLoaded();
        return apiFetch<T>(path, await getToken(), {
          method: "PUT",
          body: JSON.stringify(data),
        });
      },

      patch: async <T>(path: string, data: unknown) => {
        await waitForAuthLoaded();
        return apiFetch<T>(path, await getToken(), {
          method: "PATCH",
          body: JSON.stringify(data),
        });
      },

      delete: async <T>(path: string) => {
        await waitForAuthLoaded();
        return apiFetch<T>(path, await getToken(), {
          method: "DELETE",
        });
      },

      getRaw: async <T>(path: string, options?: RequestInit) => {
        await waitForAuthLoaded();
        return apiFetchRaw<T>(path, await getToken(), options);
      },

      postRaw: async <T>(path: string, data: unknown) => {
        await waitForAuthLoaded();
        return apiFetchRaw<T>(path, await getToken(), {
          method: "POST",
          body: JSON.stringify(data),
        });
      },
    }),
    [getToken, waitForAuthLoaded]
  );
}

export function resolveApiUrl(): string {
  return resolveApiOrigin();
}

async function apiFetch<T>(
  path: string,
  token: string | null,
  options?: RequestInit
): Promise<T> {
  try {
    const response = await apiRequest(path, token, options);
    const result: ApiResult<T> = JSON.parse(
      await response.text(),
      reviveWithDates
    );

    if (!result.success) {
      throw new ApiError(result.error, response.status, {
        code: result.code,
        data: result,
        details: result.details,
        timestamp: result.timestamp,
      });
    }
    if (!response.ok) {
      throw new ApiError(
        "API contract violation: success=true but HTTP error status",
        response.status
      );
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
  path: string,
  token: string | null,
  options?: RequestInit
): Promise<T> {
  try {
    const response = await apiRequest(path, token, options);
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
  path: string,
  token: string | null,
  options?: RequestInit
): Promise<Response> {
  const authHeaders: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {};

  return fetch(`${resolveApiUrl()}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
      ...options?.headers,
    },
  });
}
