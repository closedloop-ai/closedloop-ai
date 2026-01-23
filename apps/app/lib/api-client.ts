import "server-only";

import type { ApiResult } from "@repo/api/src/types/common";
import { auth } from "@repo/auth/server";
import { env } from "@/env";

const API_BASE = env.API_URL;

async function fetchApi<T>(
  path: string,
  options?: RequestInit
): Promise<ApiResult<T>> {
  const url = `${API_BASE}${path}`;

  try {
    const { getToken } = await auth();
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

    // Ensure error is always a string if response indicates failure
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
    console.error(`API request failed: ${path}`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Network error",
    };
  }
}

export const apiClient = {
  get: <T>(path: string, options?: RequestInit) => fetchApi<T>(path, options),

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
};
