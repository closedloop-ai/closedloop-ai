import type { ComputePreferenceResponse } from "@repo/api/src/types/compute-target";
import { toComputePreference } from "@repo/api/src/types/compute-target";
import { withDb } from "@repo/database";
import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveEffectiveComputePreference } from "@/lib/loops/compute-target-resolver";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";

const computePreferenceValidator = z.object({
  mode: z.enum(["LOCAL", "CLOUD"]),
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
        select: { preferredComputeMode: true },
      })
    );

    if (dbUser?.preferredComputeMode != null) {
      return successResponse({
        preferredComputeMode: toComputePreference(dbUser.preferredComputeMode),
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
        data: { preferredComputeMode: body.mode },
      })
    );

    return successResponse({
      preferredComputeMode: toComputePreference(body.mode),
    });
  } catch (error) {
    return errorResponse("Failed to update compute preference", error);
  }
});
