import type { JsonObject } from "@repo/api/src/types/common";
import { SESSION_FRUSTRATION_SETTING_KEY } from "@repo/api/src/types/settings";
import { Prisma, withDb } from "@repo/database";
import { writeOrganizationSettings } from "@/lib/organization-settings-write";

/**
 * FEA-4022 (PLN-1481): reads/writes the org's `calculateSessionFrustration`
 * toggle in the `Organization.settings` JSON column. OFF by default — the org must opt in before the cloud
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
   *
   * ISS-7142: the row count is now judged by the shared writer. This path is
   * where the asymmetry the ticket names actually was — its three siblings
   * already refused a zero-row write and it did not, so a toggle against a
   * deleted organization reported success and persisted nothing. It refuses
   * both counts now, on the same terms as the other three.
   *
   * ISS-7157: `updated_at` is set by the statement because a raw UPDATE never
   * reaches the Prisma client layer that applies `@updatedAt`, and set through
   * `GREATEST` so a delayed write cannot put its older captured time back. The
   * bound value is a FLOOR — the shared writer raises it to a reading taken
   * after this statement took the row lock. See `writeOrganizationSettings`.
   */
  async setFrustrationEnabled(
    organizationId: string,
    enabled: boolean
  ): Promise<void> {
    await writeOrganizationSettings(
      Prisma.sql`
        UPDATE "organizations"
        SET "settings" = jsonb_set(
          COALESCE("settings", '{}'::jsonb),
          ARRAY[${SESSION_FRUSTRATION_SETTING_KEY}]::text[],
          to_jsonb(${enabled}::boolean),
          true
        ),
        "updated_at" = GREATEST("updated_at", ${new Date()})
        WHERE "id" = ${organizationId}::uuid
      `,
      { organizationId, subject: FRUSTRATION_SETTING_WRITE_SUBJECT }
    );
  },
};

/** Names this writer in the shared row-count guard's messages. */
export const FRUSTRATION_SETTING_WRITE_SUBJECT = "Session frustration setting";
