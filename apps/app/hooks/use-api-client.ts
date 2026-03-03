"use client";

import type { ApiResult } from "@repo/api/src/types/common";
import { useAuth } from "@repo/auth/client";
import { useMemo } from "react";
import { ApiError } from "@/lib/api-error";
import { resolveApiOrigin } from "@/lib/api-origin";

/**
 * This hook provides an HTTP client for interacting with the REST API.
 *
 * Throws ApiError on failures. This allows TanStack Query to handle errors
 * natively via its error state and global error handlers.
 */
export function useApiClient() {
  const { getToken } = useAuth();

  return useMemo(
    () => ({
      get: async <T>(path: string, options?: RequestInit) =>
        apiFetch<T>(path, await getToken(), options),

      post: async <T>(path: string, data: unknown) =>
        apiFetch<T>(path, await getToken(), {
          method: "POST",
          body: JSON.stringify(data),
        }),

      put: async <T>(path: string, data: unknown) =>
        apiFetch<T>(path, await getToken(), {
          method: "PUT",
          body: JSON.stringify(data),
        }),

      delete: async <T>(path: string) =>
        apiFetch<T>(path, await getToken(), {
          method: "DELETE",
        }),
    }),
    [getToken]
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
  const url = `${resolveApiUrl()}${path}`;

  try {
    const authHeaders: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
        ...options?.headers,
      },
    });

    const result: ApiResult<T> = await response.json();

    if (!result.success) {
      throw new ApiError(result.error, response.status);
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
