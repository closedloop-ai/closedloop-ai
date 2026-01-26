"use client";

import { useAuth } from "@repo/auth/client";
import { useCallback, useMemo } from "react";
import { env } from "@/env";
import { ApiError } from "@/lib/api-error";
import { ApiResult } from "@repo/api/src/types/common";

const API_URL = env.NEXT_PUBLIC_API_URL;

/**
 * This hook provides an HTTP client for interacting with the REST API.
 *
 * Unlike the previous implementation, this throws ApiError on failures
 * instead of returning { success: false, error }. This allows TanStack Query
 * to handle errors natively via its error state and global error handlers.
 */
export function useApiClient() {
  const { getToken } = useAuth();

  const fetchApi = useCallback(
    async <T>(path: string, options?: RequestInit): Promise<T> => {
      if (!API_URL) {
        throw new ApiError("API URL not configured (NEXT_PUBLIC_API_URL)", 0);
      }

      const url = `${API_URL}${path}`;

      try {
        const token = await getToken();

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
        } else if (response.status >= 400) {
          throw new ApiError("An unexpected error occurred", response.status);
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
    },
    [getToken]
  );

  return useMemo(
    () => ({
      get: <T>(path: string, options?: RequestInit) =>
        fetchApi<T>(path, options),

      post: <T>(path: string, data: unknown) =>
        fetchApi<T>(path, {
          method: "POST",
          body: JSON.stringify(data),
        }),

      put: <T>(path: string, data: unknown) =>
        fetchApi<T>(path, {
          method: "PUT",
          body: JSON.stringify(data),
        }),

      delete: <T>(path: string) =>
        fetchApi<T>(path, {
          method: "DELETE",
        }),
    }),
    [fetchApi]
  );
}
