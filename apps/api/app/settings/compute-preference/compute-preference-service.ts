import { type PreferredComputeMode, withDb } from "@repo/database";

/**
 * Service for the user-scoped Cloud compute preference, including the
 * Cloud-launch harness persisted on `User.preferredHarness`.
 *
 * The harness read is centralized here so the GET route and the loop-launch
 * path share a single column-access point (AD-6) and cannot drift. Callers
 * coerce the raw value through `parseSelectedHarness` — this service returns the
 * stored string verbatim so a `null` (unset) stays distinguishable from an
 * explicit value.
 */

type SetPreferenceInput = {
  userId: string;
  organizationId: string;
  mode: PreferredComputeMode;
  computeTargetId?: string;
  selectedHarness?: string;
};

/**
 * Reads the user's persisted Cloud-launch harness. Returns the raw column value
 * (or `null` when unset); callers coerce via `parseSelectedHarness`. Org-scoped.
 */
async function getPreferredHarness(
  userId: string,
  organizationId: string
): Promise<string | null> {
  const user = await withDb((db) =>
    db.user.findFirst({
      where: { id: userId, organizationId },
      select: { preferredHarness: true },
    })
  );
  return user?.preferredHarness ?? null;
}

/**
 * Persists the user's compute preference. Writes `preferredHarness` only when
 * `selectedHarness` is provided (partial update — a mode/target change never
 * clobbers a persisted harness, and vice versa). Org-scoped.
 */
async function setPreference({
  userId,
  organizationId,
  mode,
  computeTargetId,
  selectedHarness,
}: SetPreferenceInput): Promise<void> {
  await withDb((db) =>
    db.user.update({
      where: { id: userId, organizationId },
      data: {
        preferredComputeMode: mode,
        ...(computeTargetId !== undefined && {
          preferredComputeTargetId: computeTargetId,
        }),
        ...(selectedHarness !== undefined && {
          preferredHarness: selectedHarness,
        }),
      },
    })
  );
}

export const computePreferenceService = {
  getPreferredHarness,
  setPreference,
};
