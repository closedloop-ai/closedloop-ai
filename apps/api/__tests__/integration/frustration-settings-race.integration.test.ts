/**
 * ISS-7147 — the concurrency evidence for the fourth `Organization.settings`
 * writer, which its three siblings each have and this one still lacks.
 *
 * `frustration-setting-service` writes atomically (a single `jsonb_set`
 * UPDATE), and its docstring claims something no mocked `Prisma.sql` tag can
 * check: that a concurrent write to a DIFFERENT settings key survives it. Its
 * siblings each got a suite proving that (ISS-7092, ISS-7111, ISS-7119); this
 * writer never did.
 *
 * SCOPE, because it is narrower than the ticket was written against. ISS-7142
 * (#5419) landed first and moved this writer onto the shared
 * `writeOrganizationSettings`, taking the ticket's other two asks with it: the
 * whole-clause predicate assertion now lives in this service's unit suite, and
 * the two-organization scoping case lives in
 * `iss7142-organization-settings-row-count-guard.integration.test.ts`. That
 * suite's docstring argues explicitly against repeating a database-level
 * scoping proof per caller, so this file does not add a second one.
 *
 * The first case INTERLEAVES the two writers deterministically, with no sleeps —
 * a statement-level advisory-lock barrier parks the production UPDATE, the
 * competing key is committed inside that window, and only then is the UPDATE let
 * through. That ordering is the one a read-modify-write of the whole blob loses
 * data on, and it is reproduced on every run rather than raced for. It is the
 * only concurrency evidence here.
 *
 * The second case is deliberately sequential and is NOT concurrency evidence: it
 * pins the boolean round-trip through the public read path, which is what dies
 * if `jsonb_set` stops overwriting an existing key or the parameter is cast to
 * text instead of boolean.
 */
import { SESSION_FRUSTRATION_SETTING_KEY } from "@repo/api/src/types/settings";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  installOrganizationSettingsWriteBarrier,
  type OrganizationSettingsWriteBarrier,
} from "@/__tests__/support/organizations/organization-settings-write-barrier";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { frustrationSettingService } from "@/app/settings/frustration-setting-service";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

/** A settings key the service under test never writes. */
const COMPETING_SETTING_KEY = "siblingSetting";
const COMPETING_SETTING_VALUE = "kept";

type PersistedSettings = Record<string, unknown>;

async function readSettings(
  organizationId: string
): Promise<PersistedSettings> {
  const org = await withDb((db) =>
    db.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    })
  );
  return (org?.settings ?? {}) as PersistedSettings;
}

describeIfDb("setFrustrationEnabled settings write (ISS-7147)", () => {
  const tracker = createCommittedTestOrganizationTracker();
  let barrier: OrganizationSettingsWriteBarrier | null = null;

  afterEach(async () => {
    await barrier?.dispose();
    barrier = null;
    await tracker.cleanup();
  });

  it("keeps a sibling settings key written concurrently by another service", async () => {
    const organizationId = await tracker.create();
    // `setFrustrationEnabled` issues exactly one `organizations` UPDATE, and it
    // is the only statement of the `withDb.tx` transaction ISS-7142 moved it
    // into — so parking the first one parks the write under test, and the
    // `lock_timeout` the barrier sets cannot leak onto the pooled connection
    // past it.
    const active = await installOrganizationSettingsWriteBarrier({
      subject: "setFrustrationEnabled",
    });
    barrier = active;

    const set = frustrationSettingService.setFrustrationEnabled(
      organizationId,
      true
    );
    await active.waitUntilBlocked();
    await active.commitCompetingSettingsKey(
      organizationId,
      COMPETING_SETTING_KEY,
      COMPETING_SETTING_VALUE
    );
    await active.release();
    await set;

    // BOTH survive. A read-modify-write of the whole blob would drop the
    // concurrently-committed key entirely — no error, no conflict.
    const settings = await readSettings(organizationId);
    expect(settings[SESSION_FRUSTRATION_SETTING_KEY]).toBe(true);
    expect(settings[COMPETING_SETTING_KEY]).toBe(COMPETING_SETTING_VALUE);
    // The surviving blob still deserializes through the public read path.
    await expect(
      frustrationSettingService.isFrustrationEnabled(organizationId)
    ).resolves.toBe(true);
  });

  it("round-trips the opt-in and the opt-out through the public read path", async () => {
    const organizationId = await tracker.create();

    await frustrationSettingService.setFrustrationEnabled(organizationId, true);
    await expect(
      frustrationSettingService.isFrustrationEnabled(organizationId)
    ).resolves.toBe(true);
    // The stored value is a JSON boolean, not the string "true": the read path
    // requires `=== true`, so casting the parameter to text instead of boolean
    // would persist a value the org can never turn back on.
    expect(await readSettings(organizationId)).toEqual({
      [SESSION_FRUSTRATION_SETTING_KEY]: true,
    });

    await frustrationSettingService.setFrustrationEnabled(
      organizationId,
      false
    );

    // `jsonb_set` must OVERWRITE the existing key, not no-op on it — otherwise
    // the org can opt in but never back out.
    await expect(
      frustrationSettingService.isFrustrationEnabled(organizationId)
    ).resolves.toBe(false);
    expect(await readSettings(organizationId)).toEqual({
      [SESSION_FRUSTRATION_SETTING_KEY]: false,
    });
  });
});
