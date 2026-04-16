"use client";

import type { DocumentWithWorkstream } from "@repo/api/src/types/document";
import {
  useDocumentGenerationStatus,
  useDocumentPullRequest,
} from "@/hooks/queries/use-documents";

type UsePlanMetadataConfig = {
  artifact: DocumentWithWorkstream;
};

/**
 * Hook to manage plan-specific metadata (generation status, pull request info).
 *
 * **Use this hook when:** Your component needs to display plan generation status or pull request information.
 *
 * **What it provides:**
 * - Fetching and polling generation status (PENDING, QUEUED, RUNNING, SUCCESS, FAILURE, NONE)
 * - Fetching pull request information after plan execution
 * - Derived state helpers (hasActiveGeneration, generationFailed, generationSucceeded)
 * - Invalidation callback to refresh artifact cache after successful generation
 * - Loading states for each query
 *
 * **Example usage:**
 * ```tsx
 * const { generationStatus, pullRequest, hasActiveGeneration, invalidateArtifactCache } =
 *   usePlanMetadata({ artifact });
 *
 * {hasActiveGeneration && <Spinner />}
 * {generationStatus?.status === "SUCCESS" && <Badge>Generated</Badge>}
 * {pullRequest && <Link href={pullRequest.url}>View PR #{pullRequest.number}</Link>}
 * ```
 *
 * **Important:** This hook wraps useDocumentGenerationStatus and useDocumentPullRequest with auto-polling during active generation.
 */
export function usePlanMetadata(config: UsePlanMetadataConfig) {
  const { artifact } = config;

  // Fetch generation status (supports polling for active generation workflows)
  const {
    data: generationStatus,
    isLoading: isLoadingGenerationStatus,
    refetch: refetchGenerationStatus,
    invalidateCache: invalidateArtifactCache,
  } = useDocumentGenerationStatus(artifact.id);

  // Fetch pull request info (for plans that have been executed)
  const {
    data: pullRequest,
    isLoading: isLoadingPullRequest,
    refetch: refetchPullRequest,
  } = useDocumentPullRequest(artifact.id);

  // Derived state
  const isLoadingMetadata = isLoadingGenerationStatus || isLoadingPullRequest;

  const hasActiveGeneration =
    generationStatus?.status === "PENDING" ||
    generationStatus?.status === "QUEUED" ||
    generationStatus?.status === "RUNNING";

  const generationFailed = generationStatus?.status === "FAILURE";
  const generationSucceeded = generationStatus?.status === "SUCCESS";

  return {
    // Generation status data
    generationStatus,
    isLoadingGenerationStatus,
    refetchGenerationStatus,
    invalidateArtifactCache,

    // Pull request data
    pullRequest,
    isLoadingPullRequest,
    refetchPullRequest,

    // Derived state
    isLoadingMetadata,
    hasActiveGeneration,
    generationFailed,
    generationSucceeded,
  };
}
