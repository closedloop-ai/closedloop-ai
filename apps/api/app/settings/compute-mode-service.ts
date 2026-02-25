import type { ComputeMode } from "@repo/api/src/types/settings";

export type { ComputeMode } from "@repo/api/src/types/settings";

import { withDb } from "@repo/database";

const VALID_MODES: Set<string> = new Set(["GITHUB_ACTIONS", "LOOPS"]);

export const computeModeService = {
  /**
   * Get the organization's compute mode setting.
   * Stored in the Organization.settings JSON field.
   */
  async getComputeMode(organizationId: string): Promise<ComputeMode> {
    const org = await withDb((db) =>
      db.organization.findUnique({
        where: { id: organizationId },
        select: { settings: true },
      })
    );

    const settings = (org?.settings ?? {}) as Record<string, unknown>;
    const mode = settings.computeMode;

    if (typeof mode === "string" && VALID_MODES.has(mode)) {
      return mode as ComputeMode;
    }

    return "GITHUB_ACTIONS";
  },

  /**
   * Set the organization's compute mode.
   * Merges into the existing settings JSON field.
   *
   * NOTE: This is a read-modify-write on the JSON `settings` column, so
   * concurrent calls could lose intermediate writes. Acceptable here because
   * this is a low-traffic admin settings page (one user, manual toggle).
   * If contention becomes a concern, use `jsonb_set` via $executeRaw.
   */
  async setComputeMode(
    organizationId: string,
    mode: ComputeMode
  ): Promise<void> {
    if (!VALID_MODES.has(mode)) {
      throw new Error(`Invalid compute mode: ${mode}`);
    }

    const org = await withDb((db) =>
      db.organization.findUnique({
        where: { id: organizationId },
        select: { settings: true },
      })
    );

    const existing = (org?.settings ?? {}) as Record<string, unknown>;

    await withDb((db) =>
      db.organization.update({
        where: { id: organizationId },
        data: {
          settings: { ...existing, computeMode: mode },
        },
      })
    );
  },
};
