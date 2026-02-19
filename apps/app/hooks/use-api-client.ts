"use client";

import type { ApiResult } from "@repo/api/src/types/common";
import { useAuth } from "@repo/auth/client";
import { useMemo } from "react";
import { env } from "@/env";
import { ApiError } from "@/lib/api-error";

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

const LOCAL_API_FALLBACK = "http://localhost:3002";
const APP_PREFIX_REGEX = /^app-/;

export function resolveApiUrl(): string {
  // Runtime detection for preview suffix domains (e.g., app-stage.preview.closedloop-stage.ai)
  // This takes priority because build-time env vars point to .vercel.app URLs,
  // not the custom preview suffix domain the user is actually on.
  if (typeof window !== "undefined") {
    const { protocol, hostname } = window.location;

    // Preview suffix pattern: {project}.preview.{domain}
    // e.g., app-stage.preview.closedloop-stage.ai → api-stage.preview.closedloop-stage.ai
    if (hostname.includes(".preview.") && hostname.startsWith("app-")) {
      return `${protocol}//${hostname.replace(APP_PREFIX_REGEX, "api-")}`;
    }

    // Vercel preview URLs: app-stage-git-{branch}-{team}.vercel.app
    // e.g., app-stage-git-my-branch-team.vercel.app → api-stage-git-my-branch-team.vercel.app
    if (hostname.includes(".vercel.app") && hostname.startsWith("app-")) {
      return `${protocol}//${hostname.replace(APP_PREFIX_REGEX, "api-")}`;
    }
  }

  // Use configured URL for staging/production
  const configured = env.NEXT_PUBLIC_API_URL;
  if (configured && configured !== LOCAL_API_FALLBACK) {
    return configured;
  }

  // Local development fallback
  return LOCAL_API_FALLBACK;
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
