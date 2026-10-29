import {
  ProjectArtifactBoardAnalyticsFailureKind,
  type SurfaceAnalyticsProperties,
} from "@repo/api/src/types/surface-analytics";
import { ApiError } from "@repo/app/shared/api/api-error";
import { ZodError } from "zod";
import {
  analyticsCountBucket,
  analyticsDurationProperties,
  isAnalyticsCount,
} from "../../shared/observability/analytics-performance-sample";

/** Classify failures without emitting messages, identifiers, or payload data. */
export function projectArtifactBoardFailureKind(
  error: unknown
): ProjectArtifactBoardAnalyticsFailureKind {
  if (error instanceof ZodError) {
    return ProjectArtifactBoardAnalyticsFailureKind.Contract;
  }
  if (error instanceof ApiError) {
    if (error.status === 0) {
      return ProjectArtifactBoardAnalyticsFailureKind.Network;
    }
    if (error.isServerError()) {
      return ProjectArtifactBoardAnalyticsFailureKind.Server;
    }
  }
  return ProjectArtifactBoardAnalyticsFailureKind.Unknown;
}

/** A move conflict is an authoritative HTTP 409, never a message match. */
export function isProjectArtifactBoardConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

/** Build one bounded performance sample, or refuse invalid measurements. */
export function projectArtifactBoardPerformanceProperties(input: {
  cardCount: number;
  durationMs: number;
  laneCount: number;
}): SurfaceAnalyticsProperties | null {
  const duration = analyticsDurationProperties(input.durationMs);
  if (
    !(
      duration &&
      isAnalyticsCount(input.cardCount) &&
      isAnalyticsCount(input.laneCount)
    )
  ) {
    return null;
  }
  return {
    card_count_bucket: analyticsCountBucket(input.cardCount),
    ...duration,
    lane_count_bucket: analyticsCountBucket(input.laneCount),
  };
}
