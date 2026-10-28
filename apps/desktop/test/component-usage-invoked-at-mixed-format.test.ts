/**
 * @file component-usage-invoked-at-mixed-format.test.ts
 * @description ISS-7449 regression suite for the `agent_component_session_usage`
 * rollup's persisted `first_invoked_at` / `last_invoked_at` bounds.
 *
 * Every fixture is MIXED-FORMAT on purpose: byte order and time order DISAGREE
 * in it. A single-format fixture passes while the defect is live — that is
 * exactly how ISS-6414 escaped its first review — so the canonical case seeds a
 * whole-second `Z` stamp, a sub-second one, and an extended-offset form chosen
 * so that BOTH the byte-wise MIN and the byte-wise MAX name the wrong instant.
 *
 * Also pinned: the ISS-5497 all-or-nothing fallback. A group holding one
 * un-canonicalizable value (the BASIC-format offset `+0530`, which SQLite
 * cannot parse) must fall back to the raw column VERBATIM for every row in the
 * group, never mix a canonicalized operand with a raw one.
 */
import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import { rebuildAgentComponentSessionUsageFromInvocations } from "../src/main/database/component-session-usage-rollup.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { openTestPrisma } from "./prisma-test-utils.js";

// 14:30:00.000Z — an extended-offset form whose wall-clock digits sort BELOW
// both `Z` stamps while its instant is the LATEST, so a byte-wise MAX misses it
// and a byte-wise MIN wrongly returns it.
const OFFSET_FORM_LATEST = "2026-06-22T09:00:00-05:30";
// 10:00:00.000Z — the true EARLIEST instant. A whole-second `Z` stamp sorts
// ABOVE any sub-second stamp in the same second (`Z` 0x5A, `.` 0x2E), so a
// byte-wise MAX returns this instead of the later sub-second value.
const WHOLE_SECOND_EARLIEST = "2026-06-22T10:00:00Z";
const SUBSECOND_MIDDLE = "2026-06-22T10:00:00.500Z";
// SQLite cannot parse a BASIC-format offset, so this canonicalizes to NULL and
// drops its whole group back to the raw byte-wise expression.
const UNPARSEABLE_OFFSET = "2026-06-22T21:00:00.000+0530";

// Row bookkeeping only — `created_at`/`updated_at`/`anchor_value` are NOT NULL
// and are not what these fixtures vary.
const SEED_ROW_STAMP = "2026-06-22T00:00:00.000Z";

// ISS-7579: the canonical `sessions.started_at` every pre-existing case seeds.
// The EVENT fixtures above are deliberately mixed-format, but this column was
// canonical in every case until the day-bucket case below, so nothing exercised
// `storedUtcDaySql`'s NULL arm through the writer.
const SEED_SESSION_STARTED_AT = "2026-06-22T00:00:00.000Z";
const CANONICAL_EARLIEST = "2026-06-22T10:00:00.000Z";
const CANONICAL_LATEST = "2026-06-22T14:30:00.000Z";

const openStores: Array<() => Promise<void>> = [];
afterAll(async () => {
  // Settled, not sequential: one wedged disconnect must not leak the remaining
  // stores' libSQL handles and keep the lane's worker from exiting.
  await Promise.allSettled(openStores.map((close) => close()));
});

async function openStore(): Promise<DesktopPrisma> {
  const { prisma, close } = await openTestPrisma();
  openStores.push(close);
  return prisma;
}

async function seedSession(
  prisma: DesktopPrisma,
  sessionId: string,
  startedAt: string = SEED_SESSION_STARTED_AT
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness, cwd)
       VALUES ($1, $1, 'inactive', $2, '2026-06-22T00:00:00.000Z', 'claude', '/repo')`,
      sessionId,
      startedAt
    )
  );
}

/**
 * ISS-7579: the persisted UTC day bucket the rollup writes for a session, or
 * null when `sessions.started_at` is not date-shaped.
 */
async function rolledUpStartedDay(
  prisma: DesktopPrisma,
  sessionId: string
): Promise<string | null> {
  await prisma.write((client) =>
    client.$transaction((tx) =>
      rebuildAgentComponentSessionUsageFromInvocations(tx, [sessionId])
    )
  );
  const rows = await prisma.read((client) =>
    client.$queryRawUnsafe<{ started_day: string | null }[]>(
      "SELECT started_day FROM agent_component_session_usage WHERE session_id = $1",
      sessionId
    )
  );
  if (rows.length !== 1) {
    throw new Error(`expected exactly one usage row, got ${rows.length}`);
  }
  return rows[0].started_day;
}

async function seedInvocations(
  prisma: DesktopPrisma,
  sessionId: string,
  invokedAts: readonly (string | null)[],
  componentKey = "Read"
): Promise<void> {
  for (const [index, invokedAt] of invokedAts.entries()) {
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO agent_component_invocations
           (id, session_id, external_invocation_id, component_kind, component_key,
            relationship, invoked_at, sequence, anchor_kind, anchor_value,
            attribution_status, evidence_class, created_at, updated_at)
         VALUES ($1, $2, $1, 'tool', $6, 'direct', $3, $4, 'timestamp', $1,
                 'exact', 'transcript', $5, $5)`,
        `${sessionId}-${componentKey}-inv-${index}`,
        sessionId,
        invokedAt,
        index,
        SEED_ROW_STAMP,
        componentKey
      )
    );
  }
}

async function rollupBounds(
  prisma: DesktopPrisma,
  sessionId: string,
  componentKey = "Read"
): Promise<{
  first_invoked_at: string | null;
  last_invoked_at: string | null;
}> {
  await prisma.write((client) =>
    client.$transaction((tx) =>
      rebuildAgentComponentSessionUsageFromInvocations(tx, [sessionId])
    )
  );
  const rows = await prisma.read((client) =>
    client.$queryRawUnsafe<
      { first_invoked_at: string | null; last_invoked_at: string | null }[]
    >(
      `SELECT first_invoked_at, last_invoked_at
         FROM agent_component_session_usage
        WHERE session_id = $1 AND component_key = $2`,
      sessionId,
      componentKey
    )
  );
  const row = rows[0];
  if (!row || rows.length !== 1) {
    throw new Error(
      `expected exactly one rolled-up usage row, got ${rows.length}`
    );
  }
  return row;
}

test("persists the latest instant, not the largest byte string, as last_invoked_at", async () => {
  const prisma = await openStore();
  await seedSession(prisma, "s-canonical");
  await seedInvocations(prisma, "s-canonical", [
    OFFSET_FORM_LATEST,
    WHOLE_SECOND_EARLIEST,
    SUBSECOND_MIDDLE,
  ]);
  const bounds = await rollupBounds(prisma, "s-canonical");
  assert.equal(bounds.last_invoked_at, CANONICAL_LATEST);
});

test("persists the earliest instant, not the smallest byte string, as first_invoked_at", async () => {
  const prisma = await openStore();
  await seedSession(prisma, "s-first");
  await seedInvocations(prisma, "s-first", [
    OFFSET_FORM_LATEST,
    WHOLE_SECOND_EARLIEST,
    SUBSECOND_MIDDLE,
  ]);
  const bounds = await rollupBounds(prisma, "s-first");
  assert.equal(bounds.first_invoked_at, CANONICAL_EARLIEST);
});

test("one un-canonicalizable invocation drops both bounds to the raw column verbatim", async () => {
  const prisma = await openStore();
  await seedSession(prisma, "s-legacy");
  await seedInvocations(prisma, "s-legacy", [
    OFFSET_FORM_LATEST,
    WHOLE_SECOND_EARLIEST,
    SUBSECOND_MIDDLE,
    UNPARSEABLE_OFFSET,
  ]);
  const bounds = await rollupBounds(prisma, "s-legacy");
  // Byte-wise over all four, which is exactly what shipped before ISS-7449. A
  // per-value COALESCE(canonical, raw) instead ranks canonicalized operands
  // against the one raw survivor and returns `2026-06-22T10:00:00.000Z`.
  assert.equal(bounds.first_invoked_at, OFFSET_FORM_LATEST);
  assert.equal(bounds.last_invoked_at, UNPARSEABLE_OFFSET);
});

test("a NULL invoked_at does not drop its group out of canonical mode", async () => {
  const prisma = await openStore();
  await seedSession(prisma, "s-null");
  await seedInvocations(prisma, "s-null", [
    null,
    WHOLE_SECOND_EARLIEST,
    SUBSECOND_MIDDLE,
  ]);
  const bounds = await rollupBounds(prisma, "s-null");
  // The guard counts rows that hold a value AT ALL, never `COUNT(*)`: a NULL
  // row is absent from both counts, so the group stays canonical and the
  // sub-second value wins. Under `COUNT(*)` this drops to legacy mode and the
  // byte-wise winner `WHOLE_SECOND_EARLIEST` — the earlier instant — is stored.
  assert.equal(bounds.last_invoked_at, SUBSECOND_MIDDLE);
});

test("an un-canonicalizable row drops only its OWN group, not its session", async () => {
  const prisma = await openStore();
  await seedSession(prisma, "s-groups");
  await seedInvocations(
    prisma,
    "s-groups",
    [OFFSET_FORM_LATEST, WHOLE_SECOND_EARLIEST, UNPARSEABLE_OFFSET],
    "Bash"
  );
  await seedInvocations(
    prisma,
    "s-groups",
    [OFFSET_FORM_LATEST, WHOLE_SECOND_EARLIEST, SUBSECOND_MIDDLE],
    "Read"
  );
  // The all-or-nothing guard is scoped by the GROUP BY, not by the session: a
  // session-scoped guard would drop `Read` to legacy mode along with `Bash`.
  const dissenting = await rollupBounds(prisma, "s-groups", "Bash");
  assert.equal(dissenting.last_invoked_at, UNPARSEABLE_OFFSET);
  const clean = await rollupBounds(prisma, "s-groups", "Read");
  assert.equal(clean.last_invoked_at, CANONICAL_LATEST);
});

// ISS-7579: production-wiring proof that the rollup buckets `started_day`
// through `storedUtcDaySql`. Every other case here seeds a canonical
// `sessions.started_at`, so the bucket's date guard is never exercised end to
// end and a mis-wired writer would go unnoticed.
test("ISS-7579: started_day is the UTC day prefix of a date-shaped started_at", async () => {
  const prisma = await openStore();
  await seedSession(prisma, "s-day-shaped", "2026-03-09T23:45:00.000Z");
  await seedInvocations(prisma, "s-day-shaped", [CANONICAL_EARLIEST]);
  // The UTC day, NOT a local one: 23:45Z is already 2026-03-10 in +02:00 and
  // still 2026-03-09 in America/Chicago. The stored column must not move with
  // the operator's zone (FEA-2430).
  assert.equal(await rolledUpStartedDay(prisma, "s-day-shaped"), "2026-03-09");
});

test("ISS-7579: started_day is NULL for a started_at with no leading date", async () => {
  const prisma = await openStore();
  await seedSession(prisma, "s-day-unshaped", "not-a-timestamp");
  await seedInvocations(prisma, "s-day-unshaped", [CANONICAL_EARLIEST]);
  // NULL, not a meaningless 10-character slice. Drop the GLOB guard from
  // `storedUtcDaySql` and this returns "not-a-time".
  assert.equal(await rolledUpStartedDay(prisma, "s-day-unshaped"), null);
});
