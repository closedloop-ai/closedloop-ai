/**
 * @file billing-mode-heal.test.ts
 * @description ISS-4869 review follow-up. Proves the boot heal re-queues
 * sessions frozen at an `unknown` billing mode for the cloud metadata lane, and
 * that the pass is convergent — a second run selects nothing, so it cannot churn
 * the durable sync cursor on every boot.
 *
 * The durable cursor (`listUpdatedSessionCursorRows`) selects by
 * `sessions.updated_at`, so a historical completed session that never changes
 * again is invisible to sync once the cursor has advanced past it. Re-stamping
 * the row alone would not reach the cloud; the `updated_at` bump is what
 * re-queues it, and these tests assert through that cursor rather than the
 * column.
 *
 * `copilot` and `cursor` are the harnesses under test on purpose:
 * `detectCopilotBillingMode` is a pure constant (`copilot_seat`) and
 * `detectCursorBillingMode` resolves to `cursor_pro` absent a `CURSOR_API_KEY`,
 * so both expectations hold with no env, filesystem, or Keychain state. Two of
 * them are needed to prove the pass keeps each harness's OWN detected mode
 * rather than collapsing onto the first.
 *
 * There are two negatives. An unrecognized harness resolves to `unknown` and
 * must be left alone. So, since ISS-5445, must `opencode`: billing follows the
 * session's MODEL rather than the harness, and this pass reads no model, so it
 * has no evidence to stamp and must leave the row eligible to heal later.
 *
 * The multi-chunk case passes an explicit small `chunkSize` rather than seeding
 * a corpus past `BILLING_MODE_HEAL_CHUNK`: the pass drains chunk by chunk, so
 * two chunks prove the drain and the FEA-3485 staggering just as well as forty
 * would, without the rows.
 *
 * ISS-5259 adds the drain properties at the bottom of the file. The boundary and
 * keyset cases drive the pass through `afterFirstWrite`, which mutates the store
 * BETWEEN chunks on the real production code path — the only way to observe a
 * boundary or a scan position from outside, since the pass exposes neither. The
 * failure-isolation case uses `failFirstWrite` for the same reason.
 *
 * The keyset case here is SEMANTIC: it proves a row behind the bound is not
 * re-visited, which is a property of the drain's bookkeeping and stays green
 * whether the emitted `id >` term is sargable or not. That the term actually
 * plans as an index range is a separate, mechanical claim, pinned by
 * `billing-mode-heal-scan.test.ts` with a real `EXPLAIN QUERY PLAN`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { healUnknownBillingModes } from "../src/main/database/billing-mode-heal.js";
import type { PrismaClient } from "../src/main/database/generated/client.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import type { WriteQueueRunOptions } from "../src/main/database/write-queue.js";
import { openTestDb } from "./agent-db-test-utils.js";

const T0 = "2026-06-01T00:00:00.000Z";
const T1 = "2026-06-01T01:00:00.000Z";
/** A cursor position already PAST the historical rows, as on a real install. */
const CURSOR_AFTER_IMPORT = "2026-06-02T00:00:00.000Z";
/**
 * ISS-5259: sorts AFTER every seeded id, so the id keyset alone would still walk
 * onto this row — only the pass-start boundary can exclude it.
 */
const INTERLOPER_ID = "s-zz-interloper";
/** Unambiguously later than the pass's own `new Date()` start stamp. */
const INTERLOPER_UPDATED_AT = "2099-01-01T00:00:00.000Z";

type TestDb = Awaited<ReturnType<typeof openTestDb>>;

/**
 * ISS-5259 review: settle the fire-and-forget boot-maintenance chain BEFORE any
 * fixture is seeded.
 *
 * `openSqliteAgentDatabase` calls `startBootMaintenance` unconditionally, and
 * that chain runs the REAL `healUnknownBillingModes` — `billing-mode-heal.ts`
 * imports the production `detectBillingMode`, not the `openTestDb` stub, so a
 * `copilot` fixture resolves definitely for the background pass too. Every test
 * here seeds after the open and then asserts on what an EXPLICIT pass did, so
 * racing that chain would let the boot pass heal the fixtures and leave the
 * assertions passing VACUOUSLY. The sibling billing-mode suites
 * (`billing-mode-read-path-parity`, `branch-reads-billing-parity`) settle for
 * the same reason.
 */
async function openSettledTestDb(dir: string): Promise<TestDb> {
  const db = await openTestDb(dir);
  try {
    await db.whenBootMaintenanceSettled();
  } catch (error) {
    await db.close();
    throw error;
  }
  return db;
}

async function insertSession(
  db: TestDb,
  input: { id: string; harness: string | null; billingMode: string | null }
): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, started_at, ended_at, updated_at, billing_mode, harness)
     VALUES ($1, 'completed', $2, $3, $3, $4, $5)`,
    input.id,
    T0,
    T1,
    input.billingMode,
    input.harness
  );
}

async function readBillingMode(db: TestDb, id: string): Promise<string | null> {
  const [row] = await db.prisma.client.$queryRawUnsafe<
    { billing_mode: string | null }[]
  >("SELECT billing_mode FROM sessions WHERE id = $1", id);
  return row.billing_mode;
}

async function readUpdatedAt(db: TestDb, id: string): Promise<string | null> {
  const [row] = await db.prisma.client.$queryRawUnsafe<
    { updated_at: string | null }[]
  >("SELECT updated_at FROM sessions WHERE id = $1", id);
  return row.updated_at;
}

/**
 * ISS-5259: wrap a `DesktopPrisma` so `hook` runs once, immediately after the
 * pass's FIRST chunk write has committed — i.e. squarely between chunk 0 and
 * chunk 1. That is the interleaving both ISS-5259 findings are about: on a real
 * install DB-host readiness lets a live writer land between two chunks of boot
 * maintenance. Everything else is the production object, so the pass under test
 * is the production pass.
 */
function afterFirstWrite(
  prisma: DesktopPrisma,
  hook: () => Promise<void>
): DesktopPrisma {
  let fired = false;
  return {
    ...prisma,
    write: async <T>(
      fn: (client: PrismaClient) => Promise<T>,
      token?: string,
      opts?: WriteQueueRunOptions
    ): Promise<T> => {
      const result = await prisma.write(fn, token, opts);
      if (!fired) {
        fired = true;
        await hook();
      }
      return result;
    },
  };
}

/**
 * ISS-5259 review: wrap a `DesktopPrisma` so `hook` runs once immediately BEFORE
 * the pass's first chunk write — i.e. between that chunk's id read and the
 * `UPDATE` those ids feed. Reading the chunk and writing it are two statements,
 * so a live writer can settle or re-stamp a selected row inside that window; the
 * write re-asserts the selection predicate for exactly this reason, and this is
 * the seam that exercises it.
 */
function beforeFirstWrite(
  prisma: DesktopPrisma,
  hook: () => Promise<void>
): DesktopPrisma {
  let fired = false;
  return {
    ...prisma,
    write: async <T>(
      fn: (client: PrismaClient) => Promise<T>,
      token?: string,
      opts?: WriteQueueRunOptions
    ): Promise<T> => {
      if (!fired) {
        fired = true;
        await hook();
      }
      return await prisma.write(fn, token, opts);
    },
  };
}

/**
 * ISS-5259 review: wrap a `DesktopPrisma` so the FIRST chunk write rejects and
 * every later one runs for real. That is the shape the starvation regression is
 * about — a chunk that fails for a reason tied to its own rows, with healthy
 * rows queued behind it — and the keyset bound resets every boot, so a drain
 * that bailed on the failure would re-select that same chunk first next boot and
 * never reach the tail.
 */
function failFirstWrite(prisma: DesktopPrisma): DesktopPrisma {
  let failed = false;
  return {
    ...prisma,
    write: <T>(
      fn: (client: PrismaClient) => Promise<T>,
      token?: string,
      opts?: WriteQueueRunOptions
    ): Promise<T> => {
      if (failed) {
        return prisma.write(fn, token, opts);
      }
      failed = true;
      return Promise.reject(new Error("database is locked"));
    },
  };
}

const RESTAMPED_ONE_RE = /re-stamped 1 session\(s\)/;
const RESTAMPED_TWO_RE = /re-stamped 2 session\(s\)/;
const RESTAMPED_THREE_RE = /re-stamped 3 session\(s\)/;
const HEAL_FAILED_COPILOT_RE = /billing-mode heal failed for copilot/;
const LOCKED_REASON_RE = /database is locked/;
const HEAL_COMPLETE_RE = /heal complete/;

test("ISS-4869: the heal re-stamps unknown rows and re-queues them past the cursor", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "billing-heal-"));
  const db = await openSettledTestDb(dir);
  try {
    await insertSession(db, {
      id: "s-legacy",
      harness: "copilot",
      billingMode: "unknown",
    });
    await insertSession(db, {
      id: "s-null",
      harness: "copilot",
      billingMode: null,
    });
    // A row that ALREADY carries a definite mode must not be touched at all.
    await insertSession(db, {
      id: "s-settled",
      harness: "copilot",
      billingMode: "api",
    });

    // Precondition: the durable cursor has advanced past every historical row,
    // so none of them would ever reach the cloud on their own.
    const beforeHeal = await db.syncSource.listUpdatedSessionCursorRows(
      CURSOR_AFTER_IMPORT,
      []
    );
    assert.deepEqual(beforeHeal, [], "cursor must start past the corpus");

    await healUnknownBillingModes(db.prisma, () => undefined);

    assert.equal(await readBillingMode(db, "s-legacy"), "copilot_seat");
    assert.equal(await readBillingMode(db, "s-null"), "copilot_seat");
    assert.equal(
      await readBillingMode(db, "s-settled"),
      "api",
      "a stored definite mode is never overwritten"
    );

    // The point of the pass: the healed rows are now visible to the sync lane.
    const requeued = await db.syncSource.listUpdatedSessionCursorRows(
      CURSOR_AFTER_IMPORT,
      []
    );
    assert.deepEqual(
      requeued.map((row) => row.id).sort(),
      ["s-legacy", "s-null"],
      "only the healed rows are re-queued"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-4869: the heal is convergent — a second pass re-queues nothing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "billing-heal-idem-"));
  const db = await openSettledTestDb(dir);
  try {
    await insertSession(db, {
      id: "s-legacy",
      harness: "copilot",
      billingMode: "unknown",
    });

    const firstLogs: string[] = [];
    await healUnknownBillingModes(db.prisma, (m) => firstLogs.push(m));
    const [firstPass] = await db.syncSource.listUpdatedSessionCursorRows(
      CURSOR_AFTER_IMPORT,
      []
    );
    assert.equal(firstPass.id, "s-legacy");
    const watermarkAfterFirst = firstPass.updated_at;
    assert.equal(firstLogs.length, 1, "first pass must report work done");

    // Second boot: the row now carries a definite mode, so it no longer matches
    // the selection predicate. The pass reports NO work — asserted on the count
    // rather than only the watermark, because two runs inside the same
    // millisecond would leave an identical timestamp either way.
    const secondLogs: string[] = [];
    await healUnknownBillingModes(db.prisma, (m) => secondLogs.push(m));
    assert.deepEqual(secondLogs, [], "a converged corpus must do no work");
    const [secondPass] = await db.syncSource.listUpdatedSessionCursorRows(
      CURSOR_AFTER_IMPORT,
      []
    );
    assert.equal(
      secondPass.updated_at,
      watermarkAfterFirst,
      "a converged row must not be re-bumped"
    );
    assert.equal(await readBillingMode(db, "s-legacy"), "copilot_seat");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-4869: a row whose harness cannot be classified is left eligible", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "billing-heal-skip-"));
  const db = await openSettledTestDb(dir);
  try {
    // An unrecognized harness detects as `unknown`. Re-stamping it would be a
    // lie, and bumping updated_at anyway would churn the cursor every boot.
    await insertSession(db, {
      id: "s-unclassifiable",
      harness: "some-future-harness",
      billingMode: "unknown",
    });
    // A null harness can never resolve either.
    await insertSession(db, {
      id: "s-no-harness",
      harness: null,
      billingMode: "unknown",
    });

    // A harness set that yields NO definite mode must also stay silent: the
    // completion log is gated on work actually done, and this path reaches it
    // with a non-empty harness list (unlike the converged case above, which
    // returns early on an empty one).
    const logs: string[] = [];
    await healUnknownBillingModes(db.prisma, (m) => logs.push(m));

    assert.equal(await readBillingMode(db, "s-unclassifiable"), "unknown");
    assert.equal(await readBillingMode(db, "s-no-harness"), "unknown");
    assert.deepEqual(logs, [], "no rows healed must report no work");
    const requeued = await db.syncSource.listUpdatedSessionCursorRows(
      CURSOR_AFTER_IMPORT,
      []
    );
    assert.deepEqual(requeued, [], "nothing unclassifiable may be re-queued");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-4869: each harness is stamped with its OWN detected mode in one pass", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "billing-heal-multi-"));
  const db = await openSettledTestDb(dir);
  try {
    // Two harnesses that BOTH resolve definitely, so the per-harness loop runs
    // its write body more than once in a single pass. `copilot` is a constant
    // and `cursor` resolves to its seat mode with no CURSOR_API_KEY, so neither
    // needs env, filesystem, or Keychain state to reach a definite answer.
    //
    // ISS-5445: this pair used to be `copilot`/`opencode`. `opencode` is no
    // longer a definite answer — billing follows the MODEL, and the heal reads
    // no model — so it moved to the assertion below, which pins that honest
    // degradation instead.
    await insertSession(db, {
      id: "s-copilot",
      harness: "copilot",
      billingMode: "unknown",
    });
    await insertSession(db, {
      id: "s-cursor",
      harness: "cursor",
      billingMode: null,
    });
    // ISS-5445: an OpenCode row cannot be classified without model evidence, so
    // the heal must LEAVE IT ALONE — still eligible to heal later — rather than
    // stamping the old harness-shaped constant.
    await insertSession(db, {
      id: "s-opencode",
      harness: "opencode",
      billingMode: null,
    });

    const logs: string[] = [];
    await healUnknownBillingModes(db.prisma, (m) => logs.push(m));

    // The detection is resolved once per DISTINCT harness, so the two rows must
    // not collapse onto whichever mode was detected first.
    assert.equal(await readBillingMode(db, "s-copilot"), "copilot_seat");
    assert.equal(await readBillingMode(db, "s-cursor"), "cursor_pro");
    // Untouched: no model evidence ⇒ no confident stamp.
    assert.equal(await readBillingMode(db, "s-opencode"), null);

    // The healed tally accumulates ACROSS harnesses, not per harness.
    assert.equal(logs.length, 1, "one completion log for the whole pass");
    assert.match(logs[0], RESTAMPED_TWO_RE);

    const requeued = await db.syncSource.listUpdatedSessionCursorRows(
      CURSOR_AFTER_IMPORT,
      []
    );
    assert.deepEqual(
      requeued.map((row) => row.id).sort(),
      ["s-copilot", "s-cursor"],
      "every harness's healed rows reach the sync lane"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-4869/FEA-3485: a multi-chunk heal drains the set and staggers each chunk", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "billing-heal-chunk-"));
  const db = await openSettledTestDb(dir);
  try {
    for (const id of ["s-a", "s-b", "s-c"]) {
      await insertSession(db, {
        id,
        harness: "copilot",
        billingMode: "unknown",
      });
    }

    // chunkSize 2 over 3 rows: chunks of 2 then 1, then an empty read that
    // terminates the drain. Each chunk carries an id keyset forward (ISS-5259),
    // so what ends the loop is a bounded read returning no candidates — not the
    // affected-row count.
    const logs: string[] = [];
    await healUnknownBillingModes(db.prisma, (m) => logs.push(m), 2);

    assert.match(
      logs[0],
      RESTAMPED_THREE_RE,
      "every row is healed exactly once"
    );
    for (const id of ["s-a", "s-b", "s-c"]) {
      assert.equal(await readBillingMode(db, id), "copilot_seat");
    }

    const requeued = await db.syncSource.listUpdatedSessionCursorRows(
      CURSOR_AFTER_IMPORT,
      []
    );
    assert.equal(requeued.length, 3, "all three reach the sync lane");

    // The point of the staggering: the cursor's top-timestamp group holds the
    // LAST chunk, not the whole healed set.
    const stamps = requeued.map((row) => row.updated_at);
    assert.equal(new Set(stamps).size, 2, "each chunk gets its OWN updated_at");
    const top = [...stamps].sort().at(-1);
    assert.equal(
      stamps.filter((stamp) => stamp === top).length,
      1,
      "the top-timestamp group is bounded to the final chunk"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-4869: a failed chunk leaves its rows eligible and uncounted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "billing-heal-fail-"));
  const db = await openSettledTestDb(dir);
  try {
    await insertSession(db, {
      id: "s-legacy",
      harness: "copilot",
      billingMode: "unknown",
    });

    // The reads still succeed; only the write transaction fails, which is the
    // shape of a real disk/lock failure mid-pass.
    const failing: typeof db.prisma = {
      ...db.prisma,
      write: () => Promise.reject(new Error("database is locked")),
    };
    const logs: string[] = [];
    await healUnknownBillingModes(failing, (m) => logs.push(m));

    // Never throws into the caller — boot maintenance must survive it.
    assert.equal(logs.length, 1, "the failure is reported, and nothing else");
    assert.match(logs[0], HEAL_FAILED_COPILOT_RE);
    assert.match(logs[0], LOCKED_REASON_RE);
    assert.doesNotMatch(
      logs[0],
      HEAL_COMPLETE_RE,
      "a failed chunk is not counted as healed"
    );

    // The row keeps its unresolved mode, so it stays selectable next boot
    // rather than being silently skipped forever.
    assert.equal(await readBillingMode(db, "s-legacy"), "unknown");
    const requeued = await db.syncSource.listUpdatedSessionCursorRows(
      CURSOR_AFTER_IMPORT,
      []
    );
    assert.deepEqual(requeued, [], "a failed heal re-queues nothing");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5259: a row inserted BETWEEN chunks is outside the pass's bounded set", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "billing-heal-interloper-"));
  const db = await openSettledTestDb(dir);
  try {
    for (const id of ["s-a", "s-b", "s-c"]) {
      await insertSession(db, {
        id,
        harness: "copilot",
        billingMode: "unknown",
      });
    }

    // The shape a live `minimalCodexSessionUpsert` produces mid-pass: a fresh
    // row stamped `unknown` carrying the writer's own, NEWER `updated_at`.
    // Sweeping it would overwrite that stamp with this pass's older watermark
    // and — if the sync cursor had already advanced past it — strand the row
    // behind the durable cursor forever.
    const insertInterloper = () =>
      db.run(
        `INSERT INTO sessions (id, status, started_at, ended_at, updated_at, billing_mode, harness)
         VALUES ($1, 'running', $2, NULL, $3, 'unknown', 'copilot')`,
        INTERLOPER_ID,
        T0,
        INTERLOPER_UPDATED_AT
      );

    // chunkSize 1 leaves two chunks still to run after the insert, so a drain
    // that re-evaluates the predicate every chunk would pick the newcomer up.
    await healUnknownBillingModes(
      afterFirstWrite(db.prisma, insertInterloper),
      () => undefined,
      1
    );

    for (const id of ["s-a", "s-b", "s-c"]) {
      assert.equal(
        await readBillingMode(db, id),
        "copilot_seat",
        "every row that predated the pass is still healed"
      );
    }
    assert.equal(
      await readBillingMode(db, INTERLOPER_ID),
      "unknown",
      "a row written after the pass started is not re-classified by it"
    );
    assert.equal(
      await readUpdatedAt(db, INTERLOPER_ID),
      INTERLOPER_UPDATED_AT,
      "and its newer updated_at is never rolled back to the pass watermark"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5259: the drain never re-visits a row behind its keyset bound", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "billing-heal-keyset-"));
  const db = await openSettledTestDb(dir);
  try {
    for (const id of ["s-a", "s-b", "s-c"]) {
      await insertSession(db, {
        id,
        harness: "copilot",
        billingMode: "unknown",
      });
    }

    // Put the LOWEST id back into the target set once chunk 0 has healed it,
    // with an `updated_at` still inside the pass-start boundary so the boundary
    // alone cannot explain the outcome. A drain that restarted at the head of
    // the primary-key index on every chunk — re-skipping everything it had
    // already healed, which is the O(N^2) scan — would select it again. A keyset
    // scan cannot: the bound has already moved past that id.
    const reopenLowestRow = () =>
      db.run(
        "UPDATE sessions SET billing_mode = 'unknown', updated_at = $1 WHERE id = $2",
        T1,
        "s-a"
      );

    const logs: string[] = [];
    await healUnknownBillingModes(
      afterFirstWrite(db.prisma, reopenLowestRow),
      (m) => logs.push(m),
      1
    );

    assert.equal(
      await readBillingMode(db, "s-a"),
      "unknown",
      "the re-opened row behind the bound is never scanned again"
    );
    for (const id of ["s-b", "s-c"]) {
      assert.equal(
        await readBillingMode(db, id),
        "copilot_seat",
        "and the drain still reaches everything ahead of the bound"
      );
    }
    assert.match(
      logs[0],
      RESTAMPED_THREE_RE,
      "three rows, three re-stamps — no row is visited twice"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5259: a failed chunk is skipped, not left blocking the rows behind it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "billing-heal-starve-"));
  const db = await openSettledTestDb(dir);
  try {
    for (const id of ["s-a", "s-b", "s-c"]) {
      await insertSession(db, {
        id,
        harness: "copilot",
        billingMode: "unknown",
      });
    }

    // chunkSize 1, so the failure lands on the LOWEST id and two healthy rows
    // sit behind it. The keyset bound resets to NULL every boot, so a drain that
    // bailed here would re-select `s-a` first on the next boot, fail the same
    // way, and never reach `s-b`/`s-c` — a permanent head-of-line block, and a
    // regression against the pre-keyset revision, which sliced a frozen id array
    // and so only ever poisoned the failing chunk.
    const logs: string[] = [];
    await healUnknownBillingModes(
      failFirstWrite(db.prisma),
      (m) => logs.push(m),
      1
    );

    assert.equal(
      await readBillingMode(db, "s-a"),
      "unknown",
      "the failed chunk's own row is not counted as healed"
    );
    for (const id of ["s-b", "s-c"]) {
      assert.equal(
        await readBillingMode(db, id),
        "copilot_seat",
        "and the rows behind it are still reached in the same pass"
      );
    }
    assert.match(logs[0], HEAL_FAILED_COPILOT_RE);
    assert.match(logs[0], LOCKED_REASON_RE);
    assert.equal(logs.length, 2, "one failure report, one completion report");
    assert.match(logs[1], RESTAMPED_TWO_RE, "only the two survivors counted");

    // Skipping is not dropping: the pass is convergent, so the row the failed
    // chunk left behind is still selectable — and healed — on the next boot.
    const secondLogs: string[] = [];
    await healUnknownBillingModes(db.prisma, (m) => secondLogs.push(m), 1);
    assert.equal(await readBillingMode(db, "s-a"), "copilot_seat");
    assert.equal(secondLogs.length, 1);
    assert.match(secondLogs[0], RESTAMPED_ONE_RE);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5259: a row that moves between the chunk read and its write is skipped", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "billing-heal-window-"));
  const db = await openSettledTestDb(dir);
  try {
    for (const id of ["s-a", "s-b", "s-c"]) {
      await insertSession(db, {
        id,
        harness: "copilot",
        billingMode: "unknown",
      });
    }

    // The chunk's ids are chosen by one statement and written by the next, so a
    // live writer can land in between. Both ways a selected row can stop being a
    // valid target are exercised at once: `s-a` gets a NEWER `updated_at` (the
    // `minimalCodexSessionUpsert` shape — rolling it back to the pass watermark
    // is the ISS-5259 data loss), and `s-b` settles on a DEFINITE mode that this
    // pass must not overwrite with its own answer.
    const moveRowsUnderThePass = async () => {
      await db.run(
        "UPDATE sessions SET updated_at = $1 WHERE id = $2",
        INTERLOPER_UPDATED_AT,
        "s-a"
      );
      await db.run(
        "UPDATE sessions SET billing_mode = 'api' WHERE id = $1",
        "s-b"
      );
    };

    const logs: string[] = [];
    await healUnknownBillingModes(
      beforeFirstWrite(db.prisma, moveRowsUnderThePass),
      (m) => logs.push(m),
      3
    );

    assert.equal(
      await readBillingMode(db, "s-a"),
      "unknown",
      "a row bumped past the boundary mid-chunk is no longer a target"
    );
    assert.equal(
      await readUpdatedAt(db, "s-a"),
      INTERLOPER_UPDATED_AT,
      "and its newer watermark is never rolled back to the pass's"
    );
    assert.equal(
      await readBillingMode(db, "s-b"),
      "api",
      "a mode settled mid-chunk is never overwritten by the pass"
    );
    assert.equal(await readBillingMode(db, "s-c"), "copilot_seat");
    assert.match(logs[0], RESTAMPED_ONE_RE, "only the still-valid row counts");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5259: a legacy row with a NULL updated_at is inside the bounded set", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "billing-heal-nullts-"));
  const db = await openSettledTestDb(dir);
  try {
    // A pre-`updated_at` legacy row: invisible to the durable sync cursor, which
    // compares `updated_at` as a raw string, so it is exactly the row this pass
    // exists to drag back into the lane. `insertSession` always stamps a value,
    // so the NULL has to be written explicitly.
    await db.run(
      `INSERT INTO sessions (id, status, started_at, ended_at, updated_at, billing_mode, harness)
       VALUES ($1, 'completed', $2, $3, NULL, 'unknown', 'copilot')`,
      "s-null-updated-at",
      T0,
      T1
    );
    // A same-harness row WITH a stamp, so a regression that dropped the NULL
    // disjunct from only the chunk select (or only the write) still shows up as
    // this row healing while the NULL one does not.
    await insertSession(db, {
      id: "s-stamped",
      harness: "copilot",
      billingMode: "unknown",
    });

    const logs: string[] = [];
    await healUnknownBillingModes(db.prisma, (m) => logs.push(m));

    assert.equal(
      await readBillingMode(db, "s-null-updated-at"),
      "copilot_seat",
      "a NULL updated_at must not strand the row outside the pass boundary"
    );
    assert.equal(await readBillingMode(db, "s-stamped"), "copilot_seat");
    assert.match(logs[0], RESTAMPED_TWO_RE);

    // And the whole point: stamping a NULL can only move it forward, so the row
    // becomes visible to the cursor for the first time.
    const requeued = await db.syncSource.listUpdatedSessionCursorRows(
      CURSOR_AFTER_IMPORT,
      []
    );
    assert.deepEqual(
      requeued.map((row) => row.id).sort(),
      ["s-null-updated-at", "s-stamped"],
      "the previously-invisible row now reaches the sync lane"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
