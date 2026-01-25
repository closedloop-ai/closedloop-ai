"use client";

import { env } from "@/env";
import type { ApiResult } from "@repo/api/src/types/common";
import { useAuth } from "@repo/auth/client";
import { useCallback, useMemo } from "react";

const API_URL = env.NEXT_PUBLIC_API_URL;

/**
 * Hook that creates a client-side API client for use with TanStack Query.
 * Handles authentication by getting the token from Clerk.
 */
export function useApiClient() {
  const { getToken } = useAuth();

  const fetchApi = useCallback(
    async <T>(path: string, options?: RequestInit): Promise<ApiResult<T>> => {
      console.debug("API request: ", API_URL, path);

      if (!API_URL) {
        return {
          success: false,
          error: "API URL not configured (NEXT_PUBLIC_API_URL)",
        };
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

        const result = await response.json();

        if (
          result.success === false &&
          result.error &&
          typeof result.error !== "string"
        ) {
          return {
            success: false,
            error: result.error.message || JSON.stringify(result.error),
          };
        }

        return result as ApiResult<T>;
      } catch (error) {
        console.error(`Client API request failed: ${path}`, error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Network error",
        };
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
