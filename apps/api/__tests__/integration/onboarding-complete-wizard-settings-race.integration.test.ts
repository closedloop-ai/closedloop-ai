/**
 * ISS-7092 — `onboardingService.completeWizard` must not clobber a concurrent
 * write to a DIFFERENT `Organization.settings` key.
 *
 * The defect was an unguarded read-modify-write of the whole `settings` JSON
 * blob: read it, merge the wizard state in JS, write the whole object back.
 * Anything committed by another writer between that read and that write was
 * silently lost — no error, no conflict, nothing in a log.
 *
 * A SEQUENTIAL test proves nothing here: two writes one after the other pass
 * under the broken implementation too. The FIRST TWO cases therefore INTERLEAVE
 * the two writers deterministically, with no sleeps — a statement-level
 * advisory-lock barrier parks the production UPDATE, the competing key is
 * committed inside that window, and only then is the production UPDATE let
 * through. That ordering is exactly the one the old code lost data on, and it
 * is reproduced on every run rather than raced for. Those two are the
 * concurrency proof; measured, they are the cases that go red against the
 * unguarded read-modify-write.
 *
 * The remaining four cases are deliberately sequential and are NOT concurrency
 * evidence — they pin the semantics the atomic rewrite has to preserve: the
 * sub-key `||` merge, the `jsonb_typeof` tolerance for a malformed blob, the
 * cross-tenant scoping of the `WHERE` (ISS-7122, the only case here that seeds
 * a SECOND organization), and the zero-rows-affected guard. Each dies under a
 * mutation of its own target; none of them would catch the race.
 *
 * The competing writer is `frustration-setting-service`'s atomic `jsonb_set`
 * shape, so a lost key can only be attributed to `completeWizard`'s own write.
 */
import type { OnboardingStatus } from "@repo/api/src/types/onboarding";
import { SESSION_FRUSTRATION_SETTING_KEY } from "@repo/api/src/types/settings";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  installOrganizationSettingsWriteBarrier,
  type OrganizationSettingsWriteBarrier,
} from "@/__tests__/support/organizations/organization-settings-write-barrier";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { onboardingService } from "@/app/onboarding/service";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const NOT_PERSISTED_PATTERN = /not persisted/;

/** A settings key no service under test writes, so only a clobber can change it. */
const SIBLING_SETTING_KEY = "siblingSetting";
const SIBLING_SETTING_VALUE = "kept";

/**
 * ISS-7122: the settings blob of an organization the wizard is NOT run against.
 *
 * Written as a standalone literal on purpose — it imports nothing from the
 * service under test, so removing or renaming a key there cannot quietly
 * reshape what this fixture claims to guard. It deliberately carries an
 * `onboarding` object of its own, with values no run of `completeWizard` would
 * ever produce, so a write that reaches this row corrupts something observable
 * rather than landing on an absent key. That `onboarding` value is a well-formed
 * object on purpose, which does mean this row only ever exercises the
 * preserve-and-merge arm of the statement's `jsonb_typeof` guard — the malformed
 * arm is pinned by its own (single-org) case below.
 */
const SIBLING_ORG_SETTINGS = {
  onboarding: {
    wizardCompletedAt: "2026-03-04T05:06:07.890Z",
    wizardCompletedBy: "user-from-another-tenant",
    checklistDismissedAt: "2026-03-04T05:06:08.901Z",
  },
  [SIBLING_SETTING_KEY]: SIBLING_SETTING_VALUE,
};

type PersistedSettings = {
  onboarding?: {
    wizardCompletedAt?: string;
    wizardCompletedBy?: string;
    checklistDismissedAt?: string;
  };
  [key: string]: unknown;
};

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

describeIfDb("completeWizard settings write (ISS-7092)", () => {
  const tracker = createCommittedTestOrganizationTracker();
  let barrier: OrganizationSettingsWriteBarrier | null = null;

  afterEach(async () => {
    await barrier?.dispose();
    barrier = null;
    await tracker.cleanup();
  });

  /**
   * Park `completeWizard`'s organization UPDATE, commit `write` inside that
   * window, then let the UPDATE through. Resolves with the persisted settings.
   */
  async function interleave(
    organizationId: string,
    userId: string,
    write: (barrier: OrganizationSettingsWriteBarrier) => Promise<void>
  ): Promise<{ settings: PersistedSettings; status: OnboardingStatus }> {
    const active = await installOrganizationSettingsWriteBarrier({
      subject: "completeWizard",
    });
    barrier = active;

    const wizard = onboardingService.completeWizard(organizationId, userId);
    // Under the OLD read-modify-write this returns only after the settings read
    // has already happened, since that read precedes the UPDATE being parked —
    // which is precisely the window the competing write has to land in.
    await active.waitUntilBlocked();
    await write(active);
    await active.release();
    const status = await wizard;

    // Both the raw column AND the public read path, on purpose. Asserting only
    // the JSON would miss a patched shape that `onboardingStateSchema` rejects:
    // `getOnboardingState` swallows a parse failure into the all-null default,
    // so a bad round-trip would surface as `wizardCompleted: false` here and
    // nowhere else.
    return { settings: await readSettings(organizationId), status };
  }

  async function seedOrg(): Promise<{
    organizationId: string;
    userId: string;
  }> {
    const organizationId = await tracker.create();
    const user = await withDb((db) =>
      db.user.create({
        data: {
          organizationId,
          clerkId: `clerk_iss7092_${organizationId}`,
          email: `iss7092+${organizationId}@example.com`,
          firstName: "Race",
          lastName: "Writer",
          role: "ENGINEER",
          active: true,
        },
      })
    );
    return { organizationId, userId: user.id };
  }

  it("keeps a sibling settings key written concurrently by another service", async () => {
    const { organizationId, userId } = await seedOrg();

    const { settings, status } = await interleave(
      organizationId,
      userId,
      (active) =>
        active.commitCompetingSettingsKey(
          organizationId,
          SESSION_FRUSTRATION_SETTING_KEY,
          true
        )
    );

    // BOTH survive. The old blob write dropped the frustration opt-in entirely.
    expect(settings[SESSION_FRUSTRATION_SETTING_KEY]).toBe(true);
    expect(settings.onboarding?.wizardCompletedBy).toBe(userId);
    expect(settings.onboarding?.wizardCompletedAt).toEqual(expect.any(String));
    // The surviving blob still deserializes into a completed wizard.
    expect(status.wizardCompleted).toBe(true);
  });

  it("keeps a sibling settings key that already existed before the wizard ran", async () => {
    const { organizationId, userId } = await seedOrg();
    await withDb((db) =>
      db.organization.update({
        where: { id: organizationId },
        data: { settings: { [SIBLING_SETTING_KEY]: SIBLING_SETTING_VALUE } },
        select: { id: true },
      })
    );

    const { settings, status } = await interleave(
      organizationId,
      userId,
      (active) =>
        active.commitCompetingSettingsKey(
          organizationId,
          SESSION_FRUSTRATION_SETTING_KEY,
          true
        )
    );

    // The pre-existing key rides through the atomic patch untouched, and the
    // concurrently-written one is not clobbered either.
    expect(settings[SIBLING_SETTING_KEY]).toBe(SIBLING_SETTING_VALUE);
    expect(settings[SESSION_FRUSTRATION_SETTING_KEY]).toBe(true);
    expect(settings.onboarding?.wizardCompletedBy).toBe(userId);
    expect(status.wizardCompleted).toBe(true);
  });

  it("merges into the onboarding object rather than replacing it, so an unrelated sub-key survives", async () => {
    const { organizationId, userId } = await seedOrg();
    const legacyDismissedAt = "2026-01-02T03:04:05.678Z";
    await withDb((db) =>
      db.organization.update({
        where: { id: organizationId },
        data: {
          settings: { onboarding: { checklistDismissedAt: legacyDismissedAt } },
        },
        select: { id: true },
      })
    );

    await onboardingService.completeWizard(
      organizationId,
      userId,
      "team-7092",
      "project-7092"
    );
    const settings = await readSettings(organizationId);

    expect(settings.onboarding).toMatchObject({
      wizardCompletedBy: userId,
      createdTeamId: "team-7092",
      createdProjectId: "project-7092",
      // Legacy sub-key this call never sets — merged, not replaced.
      checklistDismissedAt: legacyDismissedAt,
    });
  });

  it("tolerates a malformed onboarding value instead of failing the request", async () => {
    const { organizationId, userId } = await seedOrg();
    await withDb((db) =>
      db.organization.update({
        where: { id: organizationId },
        data: {
          settings: {
            onboarding: "corrupt",
            [SIBLING_SETTING_KEY]: SIBLING_SETTING_VALUE,
          },
        },
        select: { id: true },
      })
    );

    const status = await onboardingService.completeWizard(
      organizationId,
      userId
    );
    const settings = await readSettings(organizationId);

    expect(status.wizardCompleted).toBe(true);
    expect(settings.onboarding?.wizardCompletedBy).toBe(userId);
    expect(settings[SIBLING_SETTING_KEY]).toBe(SIBLING_SETTING_VALUE);
  });

  it("leaves a sibling organization's settings byte-identical", async () => {
    const { organizationId, userId } = await seedOrg();
    const otherOrganizationId = await tracker.create();
    await withDb((db) =>
      db.organization.update({
        where: { id: otherOrganizationId },
        data: { settings: SIBLING_ORG_SETTINGS },
        select: { id: true },
      })
    );

    await onboardingService.completeWizard(organizationId, userId);

    // Not the contract — an anti-vacuity guard. Without it a `completeWizard`
    // that wrote nothing at all would leave the sibling untouched and pass.
    const mutated = await readSettings(organizationId);
    expect(mutated.onboarding?.wizardCompletedBy).toBe(userId);

    // THE assertion. Org scoping observed as data, not as SQL text: every other
    // case in this file instantiates exactly one organization, so a `WHERE`
    // widened to match every row — whether it REPLACES the equality
    // (`WHERE "id" IS NOT NULL`) or ADDS to it (`… ::uuid OR TRUE`, which keeps
    // the org id bound and is the shape a substring check on the predicate lets
    // through) — produces an identical result in all of them and the whole
    // suite stays green. A second row has to exist for the widening to have
    // anything to corrupt.
    //
    // Compared whole rather than key by key: a widening merges the wizard patch
    // into this row's `onboarding` object, and a per-key check would have to
    // guess in advance which sub-key the corruption lands on.
    expect(await readSettings(otherOrganizationId)).toEqual(
      SIBLING_ORG_SETTINGS
    );
  });

  it("reports failure rather than success when no organization row matched", async () => {
    const missingOrganizationId = "00000000-0000-4000-8000-000000007092";

    await expect(
      onboardingService.completeWizard(missingOrganizationId, "user-7092")
    ).rejects.toThrow(NOT_PERSISTED_PATTERN);
  });
});
