import type { ApiResult } from "@repo/api/src/types/common";
import type { User } from "@repo/api/src/types/user";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { resolveApiOrigin } from "@/lib/api-origin";

/**
 * Fetches the authenticated user from the BFF API using the provided auth token.
 * Shared by collaboration API routes that need org-scoped user context.
 */
export async function fetchUser(
  getToken: () => Promise<string | null>
): Promise<User | null> {
  try {
    const token = await getToken();
    if (!token) {
      log.error("Unable to fetch auth token");
      return null;
    }

    const response = await fetch(`${resolveApiOrigin()}/me`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      log.error("Unable to fetch user", { status: response.status });
      return null;
    }

    const result = (await response.json()) as ApiResult<User>;
    if (!result.success) {
      log.error("Unable to fetch user", { error: result.error });
      return null;
    }

    return result.data;
  } catch (error) {
    log.error("Error fetching user", { error: parseError(error) });
    return null;
  }
}
