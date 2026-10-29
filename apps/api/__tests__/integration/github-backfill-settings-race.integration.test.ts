/**
 * ISS-7111 — the GitHub backfill's `Organization.settings` writes must not
 * clobber a concurrent write to a DIFFERENT settings key.
 *
 * `persistLatestBackfillSummary` read the whole `settings` blob inside
 * `withDb.tx`, merged the summary in JS, and wrote the whole object back — and,
 * unlike its two siblings, without taking the run gate's advisory lock
 * (`lockOrganizationRunGate`, `@/lib/organization-run-gate`). A transaction
 * alone does not prevent a lost update at READ COMMITTED (Postgres's default and
 * this repo's): both writers read the blob, each merges into its own stale copy,
 * and the second commit overwrites the first. No error, no conflict — the first
 * writer's key is simply gone.
 *
 * A SEQUENTIAL test proves nothing here: two writes one after the other pass
 * under the broken implementation too. The first two cases therefore INTERLEAVE
 * the two writers deterministically, with no sleeps — a statement-level
 * advisory-lock barrier parks one production UPDATE, the competing key is
 * committed inside that window, and only then is the UPDATE let through. Those
 * two are the concurrency proof; they are the cases that go red against the
 * unguarded read-modify-write.
 *
 * The remaining cases are deliberately sequential and are NOT concurrency
 * evidence — they pin the semantics the atomic rewrite has to preserve: that a
 * settings key predating the run survives it, the cross-tenant scoping of the
 * `WHERE` (ISS-7141, the only case here that seeds a SECOND organization), and
 * the zero-rows-affected guard. Each dies under a mutation of its own target;
 * none of them would catch the race.
 *
 * The competing writer uses `frustration-setting-service`'s atomic `jsonb_set`
 * shape, so a lost key can only be attributed to the backfill's own write.
 *
 * The organization deliberately has no GitHub installation, so the run does zero
 * provider I/O and the only statements it issues against `organizations` are the
 * three settings writes under test: the run-gate claim, the summary persist, and
 * the run-gate release, in that order.
 */
import { GitHubBackfillStatus } from "@repo/api/src/types/github";
import { SESSION_FRUSTRATION_SETTING_KEY } from "@repo/api/src/types/settings";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  installOrganizationSettingsWriteBarrier,
  type OrganizationSettingsWriteBarrier,
} from "@/__tests__/support/organizations/organization-settings-write-barrier";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import {
  BACKFILL_RUN_GATE_SETTINGS_KEY,
  BACKFILL_SETTINGS_KEY,
  githubBackfillService,
} from "@/app/integrations/github/backfill-service";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const COMPUTE_MODE_KEY = "computeMode";
const NOT_PERSISTED_PATTERN = /not persisted/;
/**
 * Statements to let through before parking: the run-gate claim precedes the
 * summary persist, and since ISS-7157 each settings write is TWO `organizations`
 * UPDATEs — the `jsonb_set` patch, then the post-lock `updated_at` re-stamp the
 * shared writer appends. The barrier counts statements ISSUED, so the claim
 * consumes two turns.
 */
const SKIP_UNTIL_SUMMARY_PERSIST = 2;

/**
 * ISS-7141: the settings blob of an organization the backfill is NOT run
 * against.
 *
 * Written as a standalone literal on purpose — it imports nothing from the
 * service under test, so removing or renaming a settings key there cannot
 * quietly reshape what this fixture claims to guard. It deliberately carries a
 * summary object AND a run-gate object of its own, under the same key names the
 * backfill writes, with values no run could ever produce (a status the enum
 * does not spell, a negative repository count, sentinel timestamps). A write
 * that reaches this row therefore corrupts something observable rather than
 * landing on an absent key.
 */
const SIBLING_ORG_SETTINGS = {
  githubBackfillLatestSummary: {
    status: "NEVER_WRITTEN_BY_A_RUN",
    repositoryCount: -41,
    dryRun: true,
  },
  githubBackfillRunGate: {
    inFlightUntil: 4_102_444_800_000,
    cooldownUntil: 4_102_444_800_000,
  },
  [COMPUTE_MODE_KEY]: "LOOPS",
};

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

describeIfDb("GitHub backfill settings writes (ISS-7111)", () => {
  const tracker = createCommittedTestOrganizationTracker();
  let barrier: OrganizationSettingsWriteBarrier | null = null;

  afterEach(async () => {
    await barrier?.dispose();
    barrier = null;
    await tracker.cleanup();
  });

  /**
   * Park the backfill's `skipStatements`-th `organizations` UPDATE, commit the
   * competing key inside that window, then let the UPDATE through.
   */
  async function interleave(
    organizationId: string,
    skipStatements: number
  ): Promise<PersistedSettings> {
    const active = await installOrganizationSettingsWriteBarrier({
      skipStatements,
      subject: "runPostConnectBackfill",
    });
    barrier = active;

    const run = githubBackfillService.runPostConnectBackfill({
      organizationId,
      approvedForVisibleWrites: true,
    });
    await active.waitUntilBlocked();
    await active.commitCompetingSettingsKey(
      organizationId,
      SESSION_FRUSTRATION_SETTING_KEY,
      true
    );
    await active.release();
    await run;

    return readSettings(organizationId);
  }

  it("keeps a sibling settings key written concurrently with the summary persist", async () => {
    const organizationId = await tracker.create();

    const settings = await interleave(
      organizationId,
      SKIP_UNTIL_SUMMARY_PERSIST
    );

    // BOTH survive. The old blob write dropped the frustration opt-in entirely.
    expect(settings[SESSION_FRUSTRATION_SETTING_KEY]).toBe(true);
    expect(settings[BACKFILL_SETTINGS_KEY]).toMatchObject({
      status: GitHubBackfillStatus.Completed,
      repositoryCount: 0,
      dryRun: false,
    });
    // The run gate the claim wrote is a sibling key too: the summary persist
    // must carry it through rather than replace the blob around it.
    expect(settings[BACKFILL_RUN_GATE_SETTINGS_KEY]).toEqual(
      expect.objectContaining({ inFlightUntil: expect.any(Number) })
    );
    // The summary is readable through the public path, not just the raw column.
    const latest =
      await githubBackfillService.getLatestBackfillSummary(organizationId);
    expect(latest.status).toBe(GitHubBackfillStatus.Completed);
  });

  it("keeps a sibling settings key written concurrently with the run-gate claim", async () => {
    const organizationId = await tracker.create();

    const settings = await interleave(organizationId, 0);

    expect(settings[SESSION_FRUSTRATION_SETTING_KEY]).toBe(true);
    expect(settings[BACKFILL_RUN_GATE_SETTINGS_KEY]).toEqual(
      expect.objectContaining({ cooldownUntil: expect.any(Number) })
    );
    expect(settings[BACKFILL_SETTINGS_KEY]).toMatchObject({
      status: GitHubBackfillStatus.Completed,
    });
  });

  it("carries a settings key that predates the run through all three writes", async () => {
    const organizationId = await tracker.create();
    await withDb((db) =>
      db.organization.update({
        where: { id: organizationId },
        data: { settings: { [COMPUTE_MODE_KEY]: "LOOPS" } },
        select: { id: true },
      })
    );

    await githubBackfillService.runPostConnectBackfill({
      organizationId,
      approvedForVisibleWrites: true,
    });
    const settings = await readSettings(organizationId);

    expect(settings[COMPUTE_MODE_KEY]).toBe("LOOPS");
    expect(settings[BACKFILL_SETTINGS_KEY]).toMatchObject({
      status: GitHubBackfillStatus.Completed,
    });
    expect(settings[BACKFILL_RUN_GATE_SETTINGS_KEY]).toEqual(
      expect.objectContaining({ inFlightUntil: 0 })
    );
  });

  it("leaves a sibling organization's settings byte-identical", async () => {
    const organizationId = await tracker.create();
    const otherOrganizationId = await tracker.create();
    await withDb((db) =>
      db.organization.update({
        where: { id: otherOrganizationId },
        data: { settings: SIBLING_ORG_SETTINGS },
        select: { id: true },
      })
    );

    await githubBackfillService.runPostConnectBackfill({
      organizationId,
      approvedForVisibleWrites: true,
    });

    // Not the contract — an anti-vacuity guard. Without it a run that wrote
    // nothing at all would leave the sibling untouched and pass.
    const mutated = await readSettings(organizationId);
    expect(mutated[BACKFILL_SETTINGS_KEY]).toMatchObject({
      status: GitHubBackfillStatus.Completed,
    });

    // THE assertion. Org scoping observed as data, not as SQL text: every other
    // case in this file instantiates exactly one organization, so a `WHERE`
    // widened to match every row — whether it REPLACES the equality
    // (`WHERE "id" IS NOT NULL`) or ADDS to it (`… ::uuid OR TRUE`, which keeps
    // the org id bound and is the shape a substring check on the predicate lets
    // through) — produces an identical result in all of them and the whole
    // suite stays green. A second row has to exist for the widening to have
    // anything to corrupt.
    //
    // Compared whole rather than key by key: the run issues THREE settings
    // writes, and a per-key check would have to guess in advance which of them
    // the leak lands on.
    expect(await readSettings(otherOrganizationId)).toEqual(
      SIBLING_ORG_SETTINGS
    );
  });

  it("reports failure rather than success when no organization row matched", async () => {
    const missingOrganizationId = "00000000-0000-4000-8000-000000007111";

    await expect(
      githubBackfillService.runPostConnectBackfill({
        organizationId: missingOrganizationId,
      })
    ).rejects.toThrow(NOT_PERSISTED_PATTERN);
  });
});
