import {
  BRANCH_VIEW_PROVIDER_RETRY_FALLBACK_SECONDS,
  type BranchViewSyncErrorCode,
  type BranchViewSyncScope,
  BranchViewSyncThrottleReason,
} from "@repo/api/src/types/branch-view";
import type { JsonObject } from "@repo/api/src/types/common";

export type SyncResult =
  | { synced: true; error: null; scope: BranchViewSyncScope }
  | {
      synced: false;
      error: string;
      code: BranchViewSyncErrorCode;
      httpStatus: number;
      details?: JsonObject;
      scope: BranchViewSyncScope;
    }
  | {
      synced: false;
      error: null;
      retryAfterSeconds: number;
      throttleReason: BranchViewSyncThrottleReason;
      scope: BranchViewSyncScope;
    };

export type BranchViewSyncFailure = Extract<SyncResult, { error: string }>;
export type BranchViewProviderThrottle = {
  retryAfterSeconds: number;
};

export function providerThrottleFromRetry(
  retryAfterSeconds: number | null | undefined
): BranchViewProviderThrottle {
  return {
    retryAfterSeconds:
      retryAfterSeconds ?? BRANCH_VIEW_PROVIDER_RETRY_FALLBACK_SECONDS,
  };
}

export function toProviderThrottleResult(
  scope: BranchViewSyncScope,
  throttle: BranchViewProviderThrottle
): SyncResult {
  return {
    synced: false,
    error: null,
    retryAfterSeconds: throttle.retryAfterSeconds,
    throttleReason: BranchViewSyncThrottleReason.ProviderRateLimit,
    scope,
  };
}

export function maxProviderThrottle(
  throttles: BranchViewProviderThrottle[]
): BranchViewProviderThrottle | null {
  if (throttles.length === 0) {
    return null;
  }
  return {
    retryAfterSeconds: Math.max(
      ...throttles.map((throttle) => throttle.retryAfterSeconds)
    ),
  };
}
