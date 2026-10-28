/**
 * ISS-7121 — pins the CURRENT persistence semantics of the `settings` field on
 * `PUT /organizations/[id]`: `organizationsService.update` writes the caller's
 * object over the whole `Organization.settings` jsonb column.
 *
 * This is deliberately NOT the defect ISS-7092 / ISS-7111 / ISS-7119 closed.
 * Those were stale-read races between two writers, fixed by moving each writer
 * onto `jsonb_set`. Nothing here is racing and nothing is stale: a single
 * writer, alone, replaces the column, because that is what the endpoint was
 * written to do. What this suite records is the blast radius of that one write
 * — every sibling key the caller did not send is gone, whether or not the
 * caller knew the key existed.
 *
 * Of the two open questions this endpoint carried, one has since been answered
 * and one has not. The operator decided the AUTHORIZATION question on
 * 2026-08-19 — `settings` is now admin-only, enforced at the route in
 * `updateOrganizationForRoute`. REPLACE-VS-MERGE was deliberately left alone
 * and is still open. Nothing in this suite changed as a result: it drives
 * `organizationsService` directly, below the route's gate, so what it pins is
 * the persistence consequence that an admin's write still carries. Narrowing
 * who may trigger this blast radius did not shrink it.
 *
 * Two organizations are seeded on purpose. A single-org fixture cannot observe
 * a cross-tenant leak, and ISS-7119 found exactly that hole in a sibling suite;
 * the second org is asserted untouched so a `settings` write that widened its
 * `where` clause could not pass here.
 */
import { SESSION_FRUSTRATION_SETTING_KEY } from "@repo/api/src/types/settings";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { organizationsService } from "@/app/organizations/service";
import { frustrationSettingService } from "@/app/settings/frustration-setting-service";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

/**
 * A blob standing in for a real org's accumulated settings. The key names are
 * literals rather than imports from the modules that own them, deliberately:
 * here they are fixture data, not a contract this suite must agree with, and
 * a suite that imports the shape it guards cannot fail when that shape moves.
 *
 * The canonical `SESSION_FRUSTRATION_SETTING_KEY` is exercised in the two
 * cases below that go through `frustrationSettingService` itself, where the
 * constant and the persisted column actually meet. It is deliberately NOT
 * asserted against this hand-seeded blob — a literal seed and a constant
 * assertion never meet, so such a pairing would claim a cross-check it does
 * not perform.
 */
const SEEDED_SETTINGS = {
  calculateSessionFrustration: true,
  computeMode: "LOOPS",
  githubBackfillLatestSummary: { repositories: 4 },
  maxConcurrentLoops: 25,
  onboarding: { wizardCompletedBy: "user-iss7121" },
};
const OTHER_ORG_SETTINGS = { maxConcurrentLoops: 99 };

async function readSettings(
  organizationId: string
): Promise<Record<string, unknown>> {
  const organization = await withDb((db) =>
    db.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    })
  );
  return (organization?.settings ?? {}) as Record<string, unknown>;
}

describeIfDb("organization settings replace semantics (ISS-7121)", () => {
  const tracker = createCommittedTestOrganizationTracker();

  afterEach(async () => {
    await tracker.cleanup();
  });

  async function seedTwoOrganizations(): Promise<{
    subjectId: string;
    bystanderId: string;
  }> {
    const subjectId = await tracker.create({ settings: SEEDED_SETTINGS });
    const bystanderId = await tracker.create({ settings: OTHER_ORG_SETTINGS });
    return { subjectId, bystanderId };
  }

  it("drops every settings key the caller did not send", async () => {
    const { subjectId } = await seedTwoOrganizations();

    await organizationsService.update(subjectId, {
      settings: { maxConcurrentLoops: 10 },
    });

    const settings = await readSettings(subjectId);

    // The one key that was sent survives, with the sent value; every key the
    // caller omitted is GONE — not stale, not merged, absent. The seed carries
    // four other keys owned by four different services, none of which a caller
    // updating a loop limit had any reason to know about. Stated as one exact
    // key-set assertion rather than a list of `not.toHaveProperty` calls: the
    // exact set already subsumes each of them, so the list would add lines
    // that cannot fail.
    expect(settings.maxConcurrentLoops).toBe(10);
    expect(Object.keys(settings)).toEqual(["maxConcurrentLoops"]);
  });

  it("empties the blob when the caller sends an empty settings object", async () => {
    const { subjectId } = await seedTwoOrganizations();

    await organizationsService.update(subjectId, { settings: {} });

    expect(await readSettings(subjectId)).toEqual({});
  });

  it("leaves a second organization's settings untouched", async () => {
    const { subjectId, bystanderId } = await seedTwoOrganizations();

    await organizationsService.update(subjectId, { settings: {} });

    // Scope note, so this is not read as more than it is: this calls the
    // SERVICE directly, so it proves the write's `where` clause cannot widen
    // to a second row — not that the HTTP layer refuses a cross-org caller.
    // That authorization boundary is separate, pre-existing, and already
    // covered by "returns 403 for cross-organization updates before service
    // calls" in ./app/organizations/[id]/route.test.ts.
    expect(await readSettings(bystanderId)).toEqual(OTHER_ORG_SETTINGS);
  });

  it("destroys a key another service committed through its atomic writer", async () => {
    const { subjectId } = await seedTwoOrganizations();
    // Not a hand-seeded blob: the real `jsonb_set` writer that ISS-7092's
    // sibling fixes put in place precisely so a concurrent write could not
    // clobber this key. It commits, and then a single unrelated PUT-path
    // update erases it anyway — the sharper form of the finding, and the one
    // that shows the two defect families are unrelated.
    await frustrationSettingService.setFrustrationEnabled(subjectId, true);
    expect(
      await frustrationSettingService.isFrustrationEnabled(subjectId)
    ).toBe(true);

    await organizationsService.update(subjectId, {
      settings: { maxConcurrentLoops: 10 },
    });

    expect(await readSettings(subjectId)).not.toHaveProperty(
      SESSION_FRUSTRATION_SETTING_KEY
    );
    // Asserted through the owning service's own read path too, so a surviving
    // but malformed value could not read as a clean removal.
    expect(
      await frustrationSettingService.isFrustrationEnabled(subjectId)
    ).toBe(false);
  });

  it("turns the frustration opt-in ON through the settings field", async () => {
    const { subjectId } = await seedTwoOrganizations();
    await frustrationSettingService.setFrustrationEnabled(subjectId, false);
    expect(
      await frustrationSettingService.isFrustrationEnabled(subjectId)
    ).toBe(false);

    // The SET direction, proved against the persisted column rather than a
    // mock: the `settings` field reaches the same key `PUT /settings/frustration`
    // owns, and that service reads the result back as a genuine opt-in. Wiping
    // the key is fail-closed, so it is this direction that matters.
    //
    // ISS-7121 gated this field on org-admin at the ROUTE; this suite calls the
    // service directly and so is unaffected by that gate. What it pins is the
    // persistence consequence — an admin's `settings` write still replaces the
    // whole column and reaches keys other services own. Replace-vs-merge was
    // deliberately left unchanged by ISS-7121 and remains an open question.
    await organizationsService.update(subjectId, {
      settings: { [SESSION_FRUSTRATION_SETTING_KEY]: true },
    });

    expect(
      await frustrationSettingService.isFrustrationEnabled(subjectId)
    ).toBe(true);
  });

  it("leaves the settings blob alone when the update omits the field", async () => {
    const { subjectId } = await seedTwoOrganizations();

    await organizationsService.update(subjectId, { name: "Renamed Org" });

    // Omission is not replacement: a body without `settings` is not a body
    // with an empty one. This is the boundary that makes the wipe reachable
    // only through an explicit `settings` field.
    expect(await readSettings(subjectId)).toEqual(SEEDED_SETTINGS);
  });
});
