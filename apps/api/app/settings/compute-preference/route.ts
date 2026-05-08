import {
  ComputePreference,
  type ComputePreferenceResponse,
} from "@repo/api/src/types/compute-target";
import { type PreferredComputeMode, withDb } from "@repo/database";
import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveEffectiveComputePreference } from "@/lib/loops/compute-target-resolver";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";

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

const computePreferenceValidator = z.object({
  mode: z.enum(["LOCAL", "CLOUD"]),
  computeTargetId: z.string().uuid().optional(),
});

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
        select: { preferredComputeMode: true, preferredComputeTargetId: true },
      })
    );

    if (dbUser?.preferredComputeMode != null) {
      return successResponse({
        preferredComputeMode: toComputePreference(dbUser.preferredComputeMode),
        ...(dbUser.preferredComputeTargetId != null && {
          computeTargetId: dbUser.preferredComputeTargetId,
        }),
      });
    }

    const effectiveMode = await resolveEffectiveComputePreference(
      user.id,
      user.organizationId
    );
    return successResponse({
      preferredComputeMode: effectiveMode,
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
      computePreferenceValidator
    );
    if (parseError || !body) {
      return parseError;
    }

    await withDb((db) =>
      db.user.update({
        where: { id: user.id, organizationId: user.organizationId },
        data: {
          preferredComputeMode: body.mode,
          ...(body.computeTargetId !== undefined && {
            preferredComputeTargetId: body.computeTargetId,
          }),
        },
      })
    );

    return successResponse({
      preferredComputeMode: toComputePreference(body.mode),
      ...(body.computeTargetId !== undefined && {
        computeTargetId: body.computeTargetId,
      }),
    });
  } catch (error) {
    return errorResponse("Failed to update compute preference", error);
  }
});
