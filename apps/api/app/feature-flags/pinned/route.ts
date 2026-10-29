import type { PinnedFeatureFlagsResponse } from "@repo/api/src/types/feature-flag-snapshot";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { readActiveFeatureFlagSnapshot } from "@/lib/feature-flags/feature-flag-snapshot";
import { successResponse } from "@/lib/route-utils";

/**
 * ISS-12048: the flag snapshot this API pins, so the web shell pins the
 * browser's flags to the same production values. `null` outside a preview
 * environment that stores one.
 */
export const GET = withAnyAuth<
  PinnedFeatureFlagsResponse,
  "/feature-flags/pinned"
>(async () => {
  const snapshot = await readActiveFeatureFlagSnapshot();
  return successResponse({
    snapshot: snapshot
      ? { takenAt: snapshot.takenAt, flags: snapshot.flags }
      : null,
  });
});
