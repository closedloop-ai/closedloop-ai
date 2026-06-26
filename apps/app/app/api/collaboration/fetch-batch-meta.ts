import type { ApiResult } from "@repo/api/src/types/common";
import type { DocumentMetaMap } from "@repo/api/src/types/document";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { env } from "@/env";

/**
 * Fetches a batch of artifact titles from the BFF API for a list of slugs.
 * Used by the rooms/resolve route to enrich room names with human-readable titles.
 * Returns an empty map on any failure to ensure graceful degradation.
 */
export async function fetchBatchMeta(
  slugs: string[],
  getToken: () => Promise<string | null>
): Promise<DocumentMetaMap> {
  if (slugs.length === 0) {
    return {};
  }

  if (!env.NEXT_PUBLIC_API_URL) {
    log.error("NEXT_PUBLIC_API_URL is not set");
    return {};
  }

  try {
    const token = await getToken();
    if (!token) {
      log.error("Unable to fetch auth token for batch meta");
      return {};
    }

    const url = `${env.NEXT_PUBLIC_API_URL}/documents/batch-meta?slugs=${slugs.join(",")}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      log.error("Unable to fetch batch meta", { status: response.status });
      return {};
    }

    const result = (await response.json()) as ApiResult<DocumentMetaMap>;
    if (!result.success) {
      log.error("Unable to fetch batch meta", { error: result.error });
      return {};
    }

    return result.data;
  } catch (error) {
    log.error("Error fetching batch meta", { error: parseError(error) });
    return {};
  }
}
