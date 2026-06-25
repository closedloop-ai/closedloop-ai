import {
  ComputePreference,
  type ComputePreferenceResponse,
  setComputePreferenceRequestValidator,
} from "@repo/api/src/types/compute-target";
import { type PreferredComputeMode, withDb } from "@repo/database";
import { parseSelectedHarness } from "@/app/compute-targets/service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveEffectiveComputePreference } from "@/lib/loops/compute-target-resolver";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { computePreferenceService } from "./compute-preference-service";

/**
 * Maps a Prisma PreferredComputeMode enum value to the API ComputePreference type.
 * The Record type ensures the mapping covers all Prisma enum values at compile time.
 */
function toComputePreference(mode: PreferredComputeMode): ComputePreference {
  const mapping: Record<PreferredComputeMode, ComputePreference> = {
    LOCAL: ComputePreference.Local,
    CLOUD: ComputePreference.Cloud,
  };
  return mapping[mode];
}

/**
 * GET /settings/compute-preference
 * Returns the user's effective compute preference.
 *
 * Fast-path: when user.preferredComputeMode is set, return it immediately.
 * Fallback: when NULL, resolve the effective preference (stub until T-2.1).
 */
export const GET = withAnyAuth<
  ComputePreferenceResponse,
  "/settings/compute-preference"
>(async ({ user }) => {
  try {
    const dbUser = await withDb((db) =>
      db.user.findUnique({
        where: { id: user.id },
        select: {
          preferredComputeMode: true,
          preferredComputeTargetId: true,
          preferredHarness: true,
        },
      })
    );

    // Coerce the raw column to a valid HarnessType only when set; omit when
    // null so the client falls back to the Claude default (mirrors how
    // computeTargetId is conditionally returned).
    const harnessField =
      dbUser?.preferredHarness == null
        ? {}
        : { selectedHarness: parseSelectedHarness(dbUser.preferredHarness) };

    if (dbUser?.preferredComputeMode != null) {
      return successResponse({
        preferredComputeMode: toComputePreference(dbUser.preferredComputeMode),
        isExplicit: true,
        ...(dbUser.preferredComputeTargetId != null && {
          computeTargetId: dbUser.preferredComputeTargetId,
        }),
        ...harnessField,
      });
    }

    const effectiveMode = await resolveEffectiveComputePreference(
      user.id,
      user.organizationId
    );
    return successResponse({
      preferredComputeMode: effectiveMode,
      isExplicit: false,
      ...harnessField,
    });
  } catch (error) {
    return errorResponse("Failed to fetch compute preference", error);
  }
});

/**
 * PUT /settings/compute-preference
 * Sets the user's preferred compute mode.
 */
export const PUT = withAnyAuth<
  ComputePreferenceResponse,
  "/settings/compute-preference"
>(async ({ user }, request) => {
  try {
    const { body, errorResponse: parseError } = await parseBody(
      request,
      setComputePreferenceRequestValidator
    );
    if (parseError || !body) {
      return parseError;
    }

    await computePreferenceService.setPreference({
      userId: user.id,
      organizationId: user.organizationId,
      mode: body.mode,
      computeTargetId: body.computeTargetId,
      selectedHarness: body.selectedHarness,
    });

    return successResponse({
      preferredComputeMode: toComputePreference(body.mode),
      isExplicit: true,
      ...(body.computeTargetId !== undefined && {
        computeTargetId: body.computeTargetId,
      }),
      ...(body.selectedHarness !== undefined && {
        selectedHarness: parseSelectedHarness(body.selectedHarness),
      }),
    });
  } catch (error) {
    return errorResponse("Failed to update compute preference", error);
  }
});
