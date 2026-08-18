import type { JsonObject } from "@repo/api/src/types/common";
import { SESSION_FRUSTRATION_SETTING_KEY } from "@repo/api/src/types/settings";
import { Prisma, withDb } from "@repo/database";

/**
 * FEA-4022 (PLN-1481): reads/writes the org's `calculateSessionFrustration`
 * toggle in the `Organization.settings` JSON column (mirrors
 * `compute-mode-service`). OFF by default — the org must opt in before the cloud
 * persists the desktop's per-session frustration signal or surfaces it in
 * Insights. The desktop always computes the raw signal into its own local
 * column; this gate governs only cloud persistence + Insights visibility.
 */
export const frustrationSettingService = {
  /**
   * Whether the org has opted into computing/persisting session frustration.
   * Defaults to `false` when unset or malformed.
   */
  async isFrustrationEnabled(organizationId: string): Promise<boolean> {
    const org = await withDb((db) =>
      db.organization.findUnique({
        where: { id: organizationId },
        select: { settings: true },
      })
    );

    const settings = (org?.settings ?? {}) as JsonObject;
    return settings[SESSION_FRUSTRATION_SETTING_KEY] === true;
  },

  /**
   * Set the org's frustration toggle atomically.
   *
   * Uses a single `jsonb_set` UPDATE so a concurrent write to a DIFFERENT
   * `Organization.settings` key cannot clobber this one (read-modify-write of the
   * whole JSON blob would race). Postgres serializes the two row updates, and
   * each patches only its own key in place, so both survive.
   */
  async setFrustrationEnabled(
    organizationId: string,
    enabled: boolean
  ): Promise<void> {
    await withDb((db) =>
      db.$executeRaw(Prisma.sql`
        UPDATE "organizations"
        SET "settings" = jsonb_set(
          COALESCE("settings", '{}'::jsonb),
          ARRAY[${SESSION_FRUSTRATION_SETTING_KEY}]::text[],
          to_jsonb(${enabled}::boolean),
          true
        )
        WHERE "id" = ${organizationId}::uuid
      `)
    );
  },
};
