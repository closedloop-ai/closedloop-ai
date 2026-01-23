import "server-only";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import type { ApiResult } from "@repo/api/src/types/common";
import { cache } from "react";
import { apiClient } from "./api-client";

/**
 * Cached data fetching functions for React Server Components.
 *
 * These use React.cache() for per-request deduplication, preventing
 * duplicate fetches when the same data is needed in both generateMetadata
 * and the page component.
 *
 * Note: These are NOT server actions - they're regular functions for
 * use in Server Components only.
 */

/**
 * Fetch an artifact by ID with request-level caching.
 * Deduplicates calls within the same request (e.g., generateMetadata + page).
 */
export const getCachedArtifactById = cache(
  async (id: string): Promise<ApiResult<ArtifactWithWorkstream>> =>
    await apiClient.get<ArtifactWithWorkstream>(`/artifacts/${id}`)
);
