/**
 * ISS-7167 — the settings-write barrier's own contract.
 *
 * The barrier (`__tests__/support/organizations/organization-settings-write-barrier`)
 * is the concurrency proof under four merged race suites (ISS-7092, ISS-7111,
 * ISS-7119, ISS-7122). Those suites assert the behaviour of the PRODUCTION
 * services, not of the barrier, so a barrier that quietly stopped parking would
 * leave all four green while proving nothing: their interleaved cases would
 * collapse into sequential ones, which the unguarded read-modify-write they were
 * written to catch passes. Nothing on `main` asserted that the helper does its
 * job. The first case here does.
 *
 * The second case is the ISS-7167 defect itself. The park used to be unbounded:
 * a statement that reached the barrier and was never released waited forever.
 * Vitest's 30s `testTimeout` fails the TEST but cancels nothing in PostgreSQL,
 * so the backend kept its connection inside an open transaction for the rest of
 * the run. Because the whole `test:integration` tier shares one database under
 * `--no-file-parallelism`, those backends accumulated until `max_connections`
 * was gone, and from that point every remaining file failed — first `Unable to
 * start a transaction`, then `sorry, too many clients already` (53300) — the
 * large majority of them files that never touch this helper.
 *
 * The first two cases are deliberately opposed: one fails if the barrier stops
 * parking, the other fails if it parks without bound. Neither passes a helper
 * that only satisfies the other. The rest close the two doors that reopen the
 * same defect without touching either of those lines — a `parkTimeoutMs` of `0`
 * (PostgreSQL reads it as "wait forever") and a timeout set on the SESSION
 * rather than the transaction, which would ride the pooled connection into
 * every later query in the file.
 */
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import {
  installOrganizationSettingsWriteBarrier,
  ORGANIZATION_SETTINGS_BARRIER_LOCK_CLASS_ID,
  type OrganizationSettingsWriteBarrier,
} from "@/__tests__/support/organizations/organization-settings-write-barrier";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const LOCK_TIMEOUT_PATTERN = /lock timeout/i;
const NON_FINITE_PARK_TIMEOUT_PATTERN = /parkTimeoutMs must be a finite number/;
const PRODUCTION_MARKER_KEY = "iss7167ProductionMarker";
const COMPETING_MARKER_KEY = "iss7167CompetingMarker";
/**
 * Short enough that the abandoned-park case finishes well inside the tier's 30s
 * `testTimeout` (before the fix it consumed all 30s and left a live backend
 * behind), and still orders of magnitude longer than the sub-millisecond park
 * the first case needs.
 */
const SHORT_PARK_TIMEOUT_MS = 750;
/**
 * Explicit per-case budget for the cases whose subject is that a park ENDS.
 * Leaning on the tier's global 30s `testTimeout` would make a regression here
 * cost a full 30s hang and report as an opaque timeout — the very shape this
 * suite exists to stop.
 */
const ABANDONED_PARK_CASE_TIMEOUT_MS = 12_000;
/** PostgreSQL's own default for `lock_timeout`: no bound. */
const NO_LOCK_TIMEOUT = "0";

type PersistedSettings = Record<string, unknown>;
/** What this suite writes: boolean markers, so it stays a Prisma JSON object input. */
type MarkerSettings = Record<string, boolean>;

async function readSettings(
  organizationId: string
): Promise<PersistedSettings> {
  const organization = await withDb((db) =>
    db.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    })
  );
  return (organization?.settings ?? {}) as PersistedSettings;
}

/** A production-shaped whole-blob `organizations` UPDATE, which the barrier parks. */
function writeSettingsBlob(
  organizationId: string,
  settings: MarkerSettings
): Promise<unknown> {
  return withDb((db) =>
    db.organization.update({
      where: { id: organizationId },
      data: { settings },
      select: { id: true },
    })
  );
}

/** Backends currently queued behind a barrier advisory lock, from outside the pool. */
async function countUngrantedBarrierWaiters(): Promise<number> {
  const databaseUrl = keys().DATABASE_URL;
  const observer = new Client({ connectionString: databaseUrl });
  await observer.connect();
  try {
    const result = await observer.query<{ waiting: string }>(
      `SELECT count(*)::text AS waiting
       FROM pg_locks
       WHERE locktype = 'advisory' AND classid = $1::oid AND NOT granted`,
      [ORGANIZATION_SETTINGS_BARRIER_LOCK_CLASS_ID]
    );
    return Number(result.rows[0]?.waiting ?? "0");
  } finally {
    await observer.end();
  }
}

describeIfDb("organization settings write barrier (ISS-7167)", () => {
  const tracker = createCommittedTestOrganizationTracker();
  let barrier: OrganizationSettingsWriteBarrier | null = null;

  afterEach(async () => {
    await barrier?.dispose();
    barrier = null;
    await tracker.cleanup();
  });

  it("still parks a production organizations UPDATE until it is released", async () => {
    const organizationId = await tracker.create();
    const active = await installOrganizationSettingsWriteBarrier({
      subject: "the ISS-7167 barrier self-check",
    });
    barrier = active;

    const production = writeSettingsBlob(organizationId, {
      [PRODUCTION_MARKER_KEY]: true,
    });
    await active.waitUntilBlocked();
    await active.commitCompetingSettingsKey(
      organizationId,
      COMPETING_MARKER_KEY,
      true
    );

    // The whole proof, and it needs no clock: the competing write is committed
    // and visible while the production UPDATE — issued FIRST — has still not
    // landed. That is only possible if the production statement is parked.
    const whileParked = await readSettings(organizationId);
    expect(whileParked[COMPETING_MARKER_KEY]).toBe(true);
    expect(whileParked[PRODUCTION_MARKER_KEY]).toBeUndefined();

    await active.release();
    await production;

    const afterRelease = await readSettings(organizationId);
    expect(afterRelease[PRODUCTION_MARKER_KEY]).toBe(true);
  });

  it(
    "aborts a parked UPDATE that is never released instead of holding its backend",
    async () => {
      const organizationId = await tracker.create();
      const active = await installOrganizationSettingsWriteBarrier({
        subject: "the ISS-7167 abandoned park",
        parkTimeoutMs: SHORT_PARK_TIMEOUT_MS,
      });
      barrier = active;

      // Never released. Before ISS-7167 this promise never settled, the test died
      // on the 30s timeout, and the backend stayed blocked in an open transaction
      // for the remainder of the run.
      await expect(
        writeSettingsBlob(organizationId, { [PRODUCTION_MARKER_KEY]: true })
      ).rejects.toThrow(LOCK_TIMEOUT_PATTERN);

      // The backend unwound rather than merely losing its client: nothing is
      // queued behind the barrier's lock, and the pool hands out a usable
      // connection again.
      expect(await countUngrantedBarrierWaiters()).toBe(0);
      const settings = await readSettings(organizationId);
      expect(settings[PRODUCTION_MARKER_KEY]).toBeUndefined();
    },
    ABANDONED_PARK_CASE_TIMEOUT_MS
  );

  it(
    "clamps a zero park timeout, which PostgreSQL reads as no bound at all",
    async () => {
      const organizationId = await tracker.create();
      const active = await installOrganizationSettingsWriteBarrier({
        subject: "the ISS-7167 zero park timeout",
        parkTimeoutMs: 0,
      });
      barrier = active;

      // `lock_timeout = 0` is PostgreSQL for "wait forever", so an unclamped 0
      // reopens ISS-7167 through the call site rather than through the SQL.
      await expect(
        writeSettingsBlob(organizationId, { [PRODUCTION_MARKER_KEY]: true })
      ).rejects.toThrow(LOCK_TIMEOUT_PATTERN);
    },
    ABANDONED_PARK_CASE_TIMEOUT_MS
  );

  it("rejects a park timeout that is not a finite number", async () => {
    await expect(
      installOrganizationSettingsWriteBarrier({
        parkTimeoutMs: Number.POSITIVE_INFINITY,
      })
    ).rejects.toThrow(NON_FINITE_PARK_TIMEOUT_PATTERN);
  });

  it("leaves no lock_timeout behind on the connection it parked", async () => {
    const organizationId = await tracker.create();
    const active = await installOrganizationSettingsWriteBarrier({
      subject: "the ISS-7167 park-timeout scoping check",
    });
    barrier = active;

    // Its own connection, not a pooled one, so the read after the write is
    // guaranteed to hit the very backend that was parked. `is_local => false`
    // in the trigger would leave the timeout set on it, silently shrinking the
    // lock waits of whatever the pool handed that connection to next.
    const writer = new Client({ connectionString: keys().DATABASE_URL });
    await writer.connect();
    try {
      const parked = writer.query(
        "UPDATE organizations SET name = $1 WHERE id = $2::uuid",
        ["iss7167-scoping-check", organizationId]
      );
      await active.waitUntilBlocked();
      await active.release();
      await parked;

      const setting = await writer.query<{ value: string }>(
        "SELECT current_setting('lock_timeout') AS value"
      );
      expect(setting.rows[0]?.value).toBe(NO_LOCK_TIMEOUT);
    } finally {
      await writer.end();
    }
  });
});
