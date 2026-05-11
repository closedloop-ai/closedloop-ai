import { isFeatureFlagEnabledForDistinctId } from "@repo/analytics/feature-flags";
import type { ApiResult } from "@repo/api/src/types/common";
import { conflictBody } from "@repo/api/src/types/common";
import type { ComputePreferenceRequiredBody } from "@repo/api/src/types/compute-target";
import {
  ComputePreferenceRequiredError,
  ComputePreferenceRequiredMessage,
  EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY,
} from "@repo/api/src/types/compute-target";
import { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import {
  fetchUserComputePreferences,
  type UserComputePreferences,
} from "@/lib/loops/compute-target-resolver";

export type ExplicitComputeSelectionIdentity = {
  userId: string;
  clerkUserId?: string | null;
};

function resolveDistinctIds({
  clerkUserId,
  userId,
}: ExplicitComputeSelectionIdentity): string[] {
  return [
    ...new Set(
      [clerkUserId, userId].filter((value): value is string => Boolean(value))
    ),
  ];
}

/**
 * Evaluates the explicit-compute-selection rollout for server-side admission.
 * Missing PostHog configuration, false, null, or thrown evaluation all preserve
 * legacy behavior by returning false.
 */
export async function isExplicitComputeSelectionRequired(
  identity: ExplicitComputeSelectionIdentity
): Promise<boolean> {
  try {
    for (const distinctId of resolveDistinctIds(identity)) {
      if (
        (await isFeatureFlagEnabledForDistinctId(
          EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY,
          distinctId
        )) === true
      ) {
        return true;
      }
    }
    return false;
  } catch (error) {
    log.warn("explicit_compute_selection_feature_flag_unavailable", {
      error: parseError(error),
    });
    return false;
  }
}

/**
 * Returns true only when the user has persisted Cloud or Local explicitly.
 * The nullable user preference remains the source of truth; no migration or
 * derived persisted marker is introduced.
 */
export function hasExplicitComputePreference(userId: string): Promise<boolean> {
  return withDb(async (db) => {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { preferredComputeMode: true },
    });
    return user?.preferredComputeMode != null;
  });
}

export type ExplicitComputeSelectionGateResult = {
  response: NextResponse<ApiResult<never>> | null;
  userComputePreferences?: UserComputePreferences;
};

/**
 * Builds the run-loop admission response for users who must explicitly choose
 * Cloud or Local before launching. When the request can continue and the user
 * preference had to be loaded, the same preferences are returned so route-level
 * compute resolution does not repeat the DB read.
 */
export async function buildMissingExplicitPreferenceResponse({
  clerkUserId,
  computeTargetId,
  userId,
}: {
  clerkUserId: string;
  computeTargetId?: string | null;
  userId: string;
}): Promise<ExplicitComputeSelectionGateResult> {
  if (computeTargetId !== undefined) {
    return { response: null };
  }

  const selectionRequired = await isExplicitComputeSelectionRequired({
    clerkUserId,
    userId,
  });
  if (!selectionRequired) {
    return { response: null };
  }

  const userComputePreferences = await fetchUserComputePreferences(userId);
  if (userComputePreferences.preferredComputeMode != null) {
    return { response: null, userComputePreferences };
  }

  const responseBody: ComputePreferenceRequiredBody = {
    error: ComputePreferenceRequiredError,
    message: ComputePreferenceRequiredMessage,
  };
  return {
    response: NextResponse.json(
      conflictBody(ComputePreferenceRequiredMessage, responseBody),
      { status: 409 }
    ) as NextResponse<ApiResult<never>>,
  };
}
