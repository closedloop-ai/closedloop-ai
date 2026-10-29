/**
 * ISS-7142 — the shared `Organization.settings` writer must refuse, and roll
 * back, a statement that matches anything other than exactly one organization.
 *
 * All four settings writers scope on `WHERE "id" = …::uuid`, and
 * `Organization.id` is the table's single-column primary key, so a correct
 * statement matches at most one row. `updatedRows > 1` is therefore reachable
 * ONLY through a widened predicate — the cross-tenant mutation ISS-7092,
 * ISS-7111, ISS-7119 and ISS-7121 each test for from their own side. This guard
 * is defence in depth for that class, for the case where such an edit lands and
 * the test coverage is somehow bypassed.
 *
 * WHY THIS SUITE DOES NOT MOCK THE ROW COUNT. Stubbing `$executeRaw` to return
 * `2` and asserting the throw proves the `if` statement exists; it proves
 * nothing about whether real code executing a real statement against a real
 * database can reach it, and it cannot observe the rollback at all — a mock has
 * no rows to leave behind. Every case here therefore runs the PRODUCTION
 * `writeOrganizationSettings` against a real Postgres holding two committed
 * organizations, and reads both rows back afterwards.
 *
 * WHY THE WIDENING IS `OR "id" = <other org>` AND NOT `OR TRUE`. Both are the
 * additive form `renderedWhereClause` was written to catch — the dangerous one,
 * because it keeps the correct equality intact as a prefix. The two-org form is
 * used here because it matches a KNOWN count (2), so the refusal message can be
 * asserted exactly rather than by regex, and because its blast radius is
 * bounded to this suite's own fixtures: the integration tier shares one
 * database under `--no-file-parallelism`, so if the rollback ever regressed,
 * `OR TRUE` would rewrite every organization a later file depends on. A test
 * for a containment guard must not itself be the containment failure.
 */
import { SESSION_FRUSTRATION_SETTING_KEY } from "@repo/api/src/types/settings";
import { Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { ONBOARDING_SETTINGS_KEY } from "@/app/onboarding/service";
import {
  FRUSTRATION_SETTING_WRITE_SUBJECT,
  frustrationSettingService,
} from "@/app/settings/frustration-setting-service";
import {
  organizationSettingsNotPersistedMessage,
  organizationSettingsRowCountRefusedMessage,
  writeOrganizationSettings,
} from "@/lib/organization-settings-write";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const GUARD_SETTINGS_KEY = "iss7142Marker";
const SEEDED_MARKER = "seeded";
const WRITTEN_MARKER = "written-by-the-guarded-statement";
const TEST_SUBJECT = "ISS-7142 probe write";
/** No organization row carries this id, so a correct predicate matches zero. */
const MISSING_ORGANIZATION_ID = "00000000-0000-4000-8000-000000007142";

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

/**
 * The production statement shape, with the predicate supplied by the caller.
 * Keeping one builder means the correctly-scoped case and the widened case
 * differ ONLY in the `WHERE` clause — so a green widened case cannot be
 * explained by the two statements diverging somewhere else.
 */
function markerWrite(value: string, predicate: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    UPDATE "organizations"
    SET "settings" = jsonb_set(
      COALESCE("settings", '{}'::jsonb),
      ARRAY[${GUARD_SETTINGS_KEY}]::text[],
      to_jsonb(${value}::text),
      true
    )
    WHERE ${predicate}
  `;
}

describeIfDb("organization settings row-count guard (ISS-7142)", () => {
  const tracker = createCommittedTestOrganizationTracker();

  afterEach(async () => {
    await tracker.cleanup();
  });

  /** Two committed organizations, each carrying its own marker value. */
  async function seedTwoOrganizations(): Promise<[string, string]> {
    const first = await tracker.create();
    const second = await tracker.create();
    await withDb((db) =>
      db.organization.updateMany({
        where: { id: { in: [first, second] } },
        data: { settings: { [GUARD_SETTINGS_KEY]: SEEDED_MARKER } },
      })
    );
    return [first, second];
  }

  it("refuses a widened predicate that matches more than one organization, and rolls it back", async () => {
    const [target, sibling] = await seedTwoOrganizations();

    // A genuinely widened predicate: the correct equality survives as a prefix
    // — exactly the shape that keeps a `toContain('"id" = …')` assertion green
    // — and a second organization is added to it. Postgres really updates two
    // rows here; the count the guard sees comes from the server, not a stub.
    const widened = markerWrite(
      WRITTEN_MARKER,
      Prisma.sql`"id" = ${target}::uuid OR "id" = ${sibling}::uuid`
    );

    await expect(
      writeOrganizationSettings(widened, {
        organizationId: target,
        subject: TEST_SUBJECT,
      })
    ).rejects.toThrow(
      organizationSettingsRowCountRefusedMessage(TEST_SUBJECT, target, 2)
    );

    // The refusal is a ROLLBACK, not a report filed after the damage. Without
    // the transaction the two rows are already rewritten by the time the throw
    // is raised, and both of these read back `WRITTEN_MARKER`. This pair is the
    // only thing in the suite that can tell those two designs apart.
    expect(await readSettings(target)).toEqual({
      [GUARD_SETTINGS_KEY]: SEEDED_MARKER,
    });
    expect(await readSettings(sibling)).toEqual({
      [GUARD_SETTINGS_KEY]: SEEDED_MARKER,
    });
  });

  it("commits a correctly scoped write and leaves the sibling organization alone", async () => {
    const [target, sibling] = await seedTwoOrganizations();

    // The legitimate path, on the same two-organization fixture. A guard that
    // refused a write matching exactly one row would be a user-visible
    // regression on every settings toggle, so the affirmative case is asserted
    // rather than assumed.
    await writeOrganizationSettings(
      markerWrite(WRITTEN_MARKER, Prisma.sql`"id" = ${target}::uuid`),
      { organizationId: target, subject: TEST_SUBJECT }
    );

    expect(await readSettings(target)).toEqual({
      [GUARD_SETTINGS_KEY]: WRITTEN_MARKER,
    });
    expect(await readSettings(sibling)).toEqual({
      [GUARD_SETTINGS_KEY]: SEEDED_MARKER,
    });
  });

  it("refuses a write that matched no organization at all", async () => {
    const [, sibling] = await seedTwoOrganizations();

    await expect(
      writeOrganizationSettings(
        markerWrite(
          WRITTEN_MARKER,
          Prisma.sql`"id" = ${MISSING_ORGANIZATION_ID}::uuid`
        ),
        { organizationId: MISSING_ORGANIZATION_ID, subject: TEST_SUBJECT }
      )
    ).rejects.toThrow(
      organizationSettingsNotPersistedMessage(
        TEST_SUBJECT,
        MISSING_ORGANIZATION_ID
      )
    );

    expect(await readSettings(sibling)).toEqual({
      [GUARD_SETTINGS_KEY]: SEEDED_MARKER,
    });
  });
});

/**
 * Each production writer refuses a zero-row write, and scopes a real write to
 * one organization, against a real two-organization database.
 *
 * READ WHAT THIS DOES AND DOES NOT PROVE. It is deliberately NOT the proof that
 * these services route through the shared writer, and an earlier version of
 * this comment wrongly claimed it was. The shared writer composes
 * `<subject> was not persisted: organization <id> not found`, which is
 * BYTE-IDENTICAL to the private message `completeWizard` and the backfill
 * writer each threw before ISS-7142. `setFrustrationEnabled` is pinned by its
 * message only because it had no check at all to be confused with.
 *
 * The wiring proof therefore lives where the transport is observable: each
 * writer's unit suite asserts the statement runs through `withDb.tx` and not
 * `withDb`, with `$executeRaw` withheld from the non-transactional double so a
 * revert fails loudly. That matters because the `> 1` branch is a REFUSAL only
 * while the throw rolls the statement back; outside a transaction it is a
 * report filed after the rows are already rewritten (proven by the rollback
 * assertions in the first describe).
 *
 * What these cases are worth on their own: `setFrustrationEnabled`'s zero-row
 * refusal is genuinely new behavior and this is its first real-database
 * coverage, and the scoping case observes a second organization that a widened
 * predicate would corrupt.
 *
 * `completeWizard` and the GitHub backfill writer are not re-driven here —
 * neither is reachable from a bare organization row (the wizard's return value
 * fans out over seven more reads; the backfill needs a live installation and
 * provider stubs) and both are covered by their own suites.
 *
 * NO CALLER GETS ITS OWN WIDENED-PREDICATE CASE, and that is deliberate rather
 * than an oversight. A widened predicate cannot be committed — it IS the defect
 * — so a per-caller `> 1` test would have to mutate production SQL, which is a
 * counterfactual run, not a suite. The coverage is factored instead:
 *
 *   1. the `> 1` refusal-and-rollback itself is exercised once, against real
 *      Postgres, on the shared writer every caller funnels through (first
 *      describe, above); and
 *   2. each caller is pinned to that writer by its unit suite's transport
 *      assertion, which fails if the statement leaves `withDb.tx`.
 *
 * Together those cover every caller without duplicating a database-level proof
 * four times. The reachability of (1) from real production code was verified by
 * counterfactual: widening `setComputeMode`'s own predicate to
 * `WHERE "id" = $1::uuid OR TRUE` made the guard fire with a row count Postgres
 * produced, red here and in the ISS-7119 suite.
 */
describeIfDb(
  "settings writers route through the shared guard (ISS-7142)",
  () => {
    const tracker = createCommittedTestOrganizationTracker();

    afterEach(async () => {
      await tracker.cleanup();
    });

    it("rejects setFrustrationEnabled for an organization that does not exist", async () => {
      await expect(
        frustrationSettingService.setFrustrationEnabled(
          MISSING_ORGANIZATION_ID,
          true
        )
      ).rejects.toThrow(
        organizationSettingsNotPersistedMessage(
          FRUSTRATION_SETTING_WRITE_SUBJECT,
          MISSING_ORGANIZATION_ID
        )
      );
    });

    it("scopes setFrustrationEnabled to one organization and preserves sibling keys", async () => {
      const target = await tracker.create();
      const sibling = await tracker.create();
      await withDb((db) =>
        db.organization.update({
          where: { id: sibling },
          data: { settings: { [SESSION_FRUSTRATION_SETTING_KEY]: false } },
          select: { id: true },
        })
      );
      await withDb((db) =>
        db.organization.update({
          where: { id: target },
          data: {
            settings: {
              [ONBOARDING_SETTINGS_KEY]: { wizardCompletedBy: "u-1" },
            },
          },
          select: { id: true },
        })
      );

      await frustrationSettingService.setFrustrationEnabled(target, true);

      // The patch lands, the target's unrelated key survives it, and the second
      // organization — which a widened predicate would have flipped to `true` —
      // keeps the value it was seeded with.
      expect(await readSettings(target)).toEqual({
        [ONBOARDING_SETTINGS_KEY]: { wizardCompletedBy: "u-1" },
        [SESSION_FRUSTRATION_SETTING_KEY]: true,
      });
      expect(await readSettings(sibling)).toEqual({
        [SESSION_FRUSTRATION_SETTING_KEY]: false,
      });
      await expect(
        frustrationSettingService.isFrustrationEnabled(sibling)
      ).resolves.toBe(false);
    });
  }
);
