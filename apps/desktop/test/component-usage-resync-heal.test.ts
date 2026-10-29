/**
 * @file component-usage-resync-heal.test.ts
 * @description ISS-6998. Proves the boot pass re-queues sessions whose component
 * usage reached the cloud truncated at `MAX_SYNCED_COMPONENT_USAGE`, and — the
 * property the whole design turns on — that it CONVERGES.
 *
 * The convergence case is not decoration. This pass selects on
 * `COUNT(agent_component_session_usage) > cap`, which a re-queue does not change
 * by a single row, so the obvious implementation re-bumps the same population on
 * every boot forever and churns the durable sync cursor. A single-run fixture
 * cannot observe that, which is precisely the defect — so every claim here is
 * made across TWO runs, and one case deletes the marker to prove the marker is
 * what stops the second run rather than some accident of the predicate.
 *
 * The durable cursor (`listUpdatedSessionCursorRows`) selects by
 * `sessions.updated_at`, so the bump IS the re-queue; these tests assert on that
 * column and on the marker table, which are the pass's only two writes.
 *
 * `USAGE_CAP` is imported rather than restated: a test that hard-coded 500 would
 * stay green if the wire cap moved and the pass started selecting the wrong
 * population. The per-session ROW COUNTS below are hand-written literals derived
 * from it, so no assertion reads its expectation from the pass under test.
 */
import assert from "node:assert/strict";
import { MAX_SYNCED_COMPONENT_USAGE as USAGE_CAP } from "@repo/api/src/types/agent-session";
import { test } from "vitest";
import { startBootMaintenance } from "../src/main/database/boot-maintenance.js";
import {
  componentUsageResyncChunkSelectSql,
  requeueTruncatedComponentUsage,
} from "../src/main/database/component-usage-resync-heal.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import type { OpenTestPrisma } from "./prisma-test-utils.js";
import { openTestPrisma } from "./prisma-test-utils.js";

/** Historical rows, already behind any realistic sync cursor. */
const SEEDED_UPDATED_AT = "2026-06-01T00:00:00.000Z";
/** Later than the pass's own `new Date()` start stamp, so it is out of bounds. */
const FUTURE_UPDATED_AT = "2099-01-01T00:00:00.000Z";

const TRUNCATED_SESSION = "s-truncated";
const SECOND_TRUNCATED_SESSION = "s-truncated-2";
const COMPLETE_SESSION = "s-complete";
/** Extra truncated rows so the candidate list OUTNUMBERS the failure cap. */
const EXTRA_TRUNCATED_SESSIONS = ["s-truncated-3", "s-truncated-4"];

/** One row past the wire cap: the smallest set that was actually truncated. */
const TRUNCATED_ROWS = USAGE_CAP + 1;
/** Comfortably under the cap — this session's delivery was never cut short. */
const COMPLETE_ROWS = 3;

type Store = OpenTestPrisma["db"];

async function seedSession(
  store: Store,
  id: string,
  usageRows: number
): Promise<void> {
  await store.query(
    "INSERT INTO sessions (id, status, updated_at, last_activity_at) VALUES ($1, 'inactive', $2, $2)",
    [id, SEEDED_UPDATED_AT]
  );
  // The PK is (session_id, component_kind, component_key, git_branch), so the
  // key alone varies to make each row distinct.
  const values: string[] = [];
  const params: string[] = [id];
  for (let index = 0; index < usageRows; index += 1) {
    values.push(`($1, 'skill', $${index + 2}, '')`);
    params.push(`component-${index}`);
  }
  await store.query(
    `INSERT INTO agent_component_session_usage (session_id, component_kind, component_key, git_branch) VALUES ${values.join(", ")}`,
    params
  );
}

async function updatedAt(store: Store, id: string): Promise<string | null> {
  const result = await store.query<{ updated_at: string | null }>(
    "SELECT updated_at FROM sessions WHERE id = $1",
    [id]
  );
  return result.rows[0]?.updated_at ?? null;
}

async function markers(
  store: Store
): Promise<{ session_id: string; usage_rows: number }[]> {
  const result = await store.query<{ session_id: string; usage_rows: number }>(
    "SELECT session_id, usage_rows FROM component_usage_resync_seen ORDER BY session_id",
    []
  );
  return result.rows.map((row) => ({
    session_id: row.session_id,
    usage_rows: Number(row.usage_rows),
  }));
}

/**
 * The marker's `requeued_at` — the chunk watermark the pass stamps onto BOTH the
 * marker row and `sessions.updated_at`, in one transaction. Kept apart from
 * {@link markers} so the existing `deepEqual` shapes above stay stable.
 */
async function requeuedAt(store: Store, id: string): Promise<string | null> {
  const result = await store.query<{ requeued_at: string | null }>(
    "SELECT requeued_at FROM component_usage_resync_seen WHERE session_id = $1",
    [id]
  );
  return result.rows[0]?.requeued_at ?? null;
}

/**
 * A `DesktopPrisma` that runs `mutate` once, immediately BEFORE the pass's first
 * write lands — the only way to observe the discovery -> write window from
 * outside, since the pass exposes no seam of its own. Without a test that enters
 * that window the write's re-assertion of the pass-start bound, and the fact
 * that the marker set is derived from `RETURNING` rather than from the ids the
 * read proposed, are both deletable with every assertion still green.
 */
function prismaWithMutationBeforeFirstWrite(
  prisma: DesktopPrisma,
  mutate: () => Promise<void>
): DesktopPrisma {
  let pending = true;
  return {
    ...prisma,
    write: async <T>(fn: (client: never) => Promise<T>): Promise<T> => {
      if (pending) {
        pending = false;
        await mutate();
      }
      return await prisma.write(fn as never);
    },
  } as DesktopPrisma;
}

test("ISS-6998: re-queues a truncated session and leaves a complete one alone", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, TRUNCATED_SESSION, TRUNCATED_ROWS);
    await seedSession(store, COMPLETE_SESSION, COMPLETE_ROWS);

    const result = await requeueTruncatedComponentUsage(
      prisma,
      () => undefined
    );

    assert.equal(result.requeued, 1, "exactly the truncated session re-queued");
    assert.equal(result.unusableCounts, 0);

    const bumped = await updatedAt(store, TRUNCATED_SESSION);
    assert.notEqual(
      bumped,
      SEEDED_UPDATED_AT,
      "the truncated session is bumped past the cursor, which IS the re-queue"
    );
    assert.ok(bumped !== null && bumped > SEEDED_UPDATED_AT);

    // The negative's positive sibling is the assertion directly above: a pass
    // that bumped nothing would satisfy this line just as well.
    assert.equal(
      await updatedAt(store, COMPLETE_SESSION),
      SEEDED_UPDATED_AT,
      "a session whose usage always fitted the cap is never re-queued"
    );

    assert.deepEqual(
      await markers(store),
      [{ session_id: TRUNCATED_SESSION, usage_rows: TRUNCATED_ROWS }],
      "only the re-queued session is marked, carrying the count that selected it"
    );
  } finally {
    await close();
  }
});

test("ISS-6998: a second run is a no-op — the pass cannot churn the sync cursor", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, TRUNCATED_SESSION, TRUNCATED_ROWS);
    await seedSession(store, SECOND_TRUNCATED_SESSION, TRUNCATED_ROWS);

    const first = await requeueTruncatedComponentUsage(prisma, () => undefined);
    assert.equal(first.requeued, 2, "both truncated sessions re-queued once");
    const afterFirst = await Promise.all([
      updatedAt(store, TRUNCATED_SESSION),
      updatedAt(store, SECOND_TRUNCATED_SESSION),
    ]);
    const markersAfterFirst = await markers(store);
    assert.equal(markersAfterFirst.length, 2);

    // The row counts are UNCHANGED by the first run — which is exactly why a
    // pass keyed on the predicate alone would select them again here.
    const second = await requeueTruncatedComponentUsage(
      prisma,
      () => undefined
    );

    assert.equal(
      second.requeued,
      0,
      "the second run re-queues nothing: no boot after the first pays for this repair"
    );
    assert.deepEqual(
      await Promise.all([
        updatedAt(store, TRUNCATED_SESSION),
        updatedAt(store, SECOND_TRUNCATED_SESSION),
      ]),
      afterFirst,
      "no session's updated_at moved, so the durable cursor is not churned"
    );
    assert.deepEqual(
      await markers(store),
      markersAfterFirst,
      "and no duplicate or restamped marker was written"
    );
  } finally {
    await close();
  }
});

test("ISS-6998: the durable marker is what stops the re-queue, not the predicate", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, TRUNCATED_SESSION, TRUNCATED_ROWS);
    await requeueTruncatedComponentUsage(prisma, () => undefined);
    const afterFirst = await updatedAt(store, TRUNCATED_SESSION);
    assert.equal((await markers(store)).length, 1);

    // Drop the marker and nothing else. If the pass were convergent on its own
    // — the way `billing-mode-heal.ts` is — this would still select nothing, and
    // the whole marker table would be unnecessary. It is not: the session is
    // still over the cap, because a re-queue never changes its usage rows.
    await store.query("DELETE FROM component_usage_resync_seen", []);

    const rerun = await requeueTruncatedComponentUsage(prisma, () => undefined);

    assert.equal(
      rerun.requeued,
      1,
      "without its marker the session is selected again — the marker is load-bearing"
    );
    assert.notEqual(
      await updatedAt(store, TRUNCATED_SESSION),
      afterFirst,
      "and it is bumped again, which is the churn the marker exists to prevent"
    );
  } finally {
    await close();
  }
});

test("ISS-6998: a session bumped inside the discovery->write window is neither re-queued nor marked", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, TRUNCATED_SESSION, TRUNCATED_ROWS);
    await seedSession(store, SECOND_TRUNCATED_SESSION, TRUNCATED_ROWS);

    // A live writer settles ONE of the two candidates past the pass-start bound
    // after discovery selected it. Overwriting that newer stamp with the pass's
    // older one would drop the row behind the durable cursor, so the write must
    // re-assert the bound and skip it — and, having skipped it, must not record
    // a marker claiming it was asked for.
    const wrapped = prismaWithMutationBeforeFirstWrite(prisma, async () => {
      await store.query("UPDATE sessions SET updated_at = $1 WHERE id = $2", [
        FUTURE_UPDATED_AT,
        SECOND_TRUNCATED_SESSION,
      ]);
    });

    const result = await requeueTruncatedComponentUsage(
      wrapped,
      () => undefined
    );

    assert.equal(
      result.requeued,
      1,
      "the count is derived from what the write actually changed, not from the ids discovery proposed"
    );
    assert.equal(
      await updatedAt(store, SECOND_TRUNCATED_SESSION),
      FUTURE_UPDATED_AT,
      "the live writer's newer stamp survives the pass"
    );
    assert.deepEqual(
      await markers(store),
      [{ session_id: TRUNCATED_SESSION, usage_rows: TRUNCATED_ROWS }],
      "the skipped session is left unmarked, so a later boot can still re-queue it"
    );

    // The positive half of that last claim, and the reason leaving it unmarked
    // is correct rather than merely cautious: once it falls back inside the
    // bound it IS repaired, with no manual intervention.
    await store.query("UPDATE sessions SET updated_at = $1 WHERE id = $2", [
      SEEDED_UPDATED_AT,
      SECOND_TRUNCATED_SESSION,
    ]);
    const later = await requeueTruncatedComponentUsage(prisma, () => undefined);
    assert.equal(
      later.requeued,
      1,
      "the skipped session heals on a later boot"
    );
    assert.equal((await markers(store)).length, 2);
  } finally {
    await close();
  }
});

test("ISS-6998: the pass drains every chunk, and converges across chunk boundaries", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, TRUNCATED_SESSION, TRUNCATED_ROWS);
    await seedSession(store, SECOND_TRUNCATED_SESSION, TRUNCATED_ROWS);
    await seedSession(store, COMPLETE_SESSION, COMPLETE_ROWS);

    // One session per chunk, so the keyset has to carry across three reads to
    // reach both. A drain that stopped after its first chunk would report 1.
    const first = await requeueTruncatedComponentUsage(
      prisma,
      () => undefined,
      1
    );
    assert.equal(first.requeued, 2, "both truncated sessions drained");
    assert.equal((await markers(store)).length, 2);

    const second = await requeueTruncatedComponentUsage(
      prisma,
      () => undefined,
      1
    );
    assert.equal(
      second.requeued,
      0,
      "chunked drains converge exactly as the single-chunk run does"
    );
    assert.equal(
      await updatedAt(store, COMPLETE_SESSION),
      SEEDED_UPDATED_AT,
      "and the complete session was never touched by either run"
    );
  } finally {
    await close();
  }
});

/*
 * The failure cap. `MAX_CONSECUTIVE_FAILED_CHUNKS` bounds a store-wide failure
 * (disk full, store locked for the whole boot) so the pass cannot walk the whole
 * corpus issuing writes that all fail. Without this case the cap could be
 * deleted, set to Infinity, or made to never increment, and every other test
 * here would stay green — none of them ever fails a read or a write.
 */
test("ISS-6998: a store-wide write failure gives up after the cap, not after the corpus", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, TRUNCATED_SESSION, TRUNCATED_ROWS);
    await seedSession(store, SECOND_TRUNCATED_SESSION, TRUNCATED_ROWS);
    for (const id of EXTRA_TRUNCATED_SESSIONS) {
      await seedSession(store, id, TRUNCATED_ROWS);
    }
    const logged: string[] = [];
    let writeAttempts = 0;
    const failing = {
      ...prisma,
      write: <T>(_fn: (client: never) => Promise<T>): Promise<T> => {
        writeAttempts += 1;
        return Promise.reject(new Error("store is locked"));
      },
    } as DesktopPrisma;

    // chunkSize 1 over FOUR candidates, so the cap (3) and the corpus (4) give
    // different numbers and this test can tell them apart. With only as many
    // candidates as the cap the keyset would run off the end first and the
    // assertion below would pass for the wrong reason.
    const result = await requeueTruncatedComponentUsage(
      failing,
      (m) => {
        logged.push(m);
      },
      1
    );

    assert.equal(result.requeued, 0, "nothing was re-queued");
    assert.equal(
      writeAttempts,
      3,
      "the pass stopped after MAX_CONSECUTIVE_FAILED_CHUNKS, not after the candidate list"
    );
    assert.ok(
      writeAttempts < 2 + EXTRA_TRUNCATED_SESSIONS.length,
      "it gave up with candidates still unvisited, so the cap bound it rather than exhaustion"
    );
    assert.ok(
      logged.every((m) => m.includes("re-queue failed")),
      "each failure is reported rather than absorbed"
    );
    assert.deepEqual(
      await markers(store),
      [],
      "a chunk whose write failed is never marked, so a later boot retries it"
    );
    assert.equal(
      await updatedAt(store, TRUNCATED_SESSION),
      SEEDED_UPDATED_AT,
      "and no session was bumped"
    );
  } finally {
    await close();
  }
});

/*
 * The unusable-count branch. `COUNT(*)` crosses the raw-query boundary as a
 * driver-supplied value, so a count that contradicts the `HAVING` that selected
 * it is reachable, not type-forbidden. It must be REPORTED and the row left
 * alone — never coerced into a re-queue, and never marked, so a later boot can
 * re-examine it once the store reads correctly.
 *
 * The corruption is injected on the READER-POOL seam (`prisma.read`), not on
 * `prisma.client`, which is also what pins discovery to that pool: `client` is
 * the single writer connection, and this pass's grouped scan must not run on it.
 * Route discovery back through `prisma.client` and this wrapper never sees a
 * row, so `unusableCounts` falls to 0 and the test fails.
 */
test("ISS-6998: a candidate whose count cannot be believed is reported, not marked", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, TRUNCATED_SESSION, TRUNCATED_ROWS);
    await seedSession(store, SECOND_TRUNCATED_SESSION, TRUNCATED_ROWS);
    const logged: string[] = [];
    const corrupting = {
      ...prisma,
      read: <T>(fn: (client: never) => Promise<T>): Promise<T> =>
        prisma.read((reader) =>
          fn({
            ...reader,
            $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
              const rows = await reader.$queryRawUnsafe(sql, ...params);
              if (!Array.isArray(rows)) {
                return rows;
              }
              // Only the discovery read carries `usage_rows`; corrupt exactly
              // one row's count so the OTHER candidate proves the pass still
              // works.
              return rows.map((row: Record<string, unknown>) =>
                row.id === SECOND_TRUNCATED_SESSION && "usage_rows" in row
                  ? { ...row, usage_rows: -1 }
                  : row
              );
            },
          } as never)
        ),
    } as unknown as DesktopPrisma;

    const result = await requeueTruncatedComponentUsage(corrupting, (m) => {
      logged.push(m);
    });

    assert.equal(result.unusableCounts, 1, "the bad count is counted as such");
    assert.ok(
      logged.some(
        (m) => m.includes(SECOND_TRUNCATED_SESSION) && m.includes("unusable")
      ),
      "and reported, naming the session, rather than absorbed"
    );
    // The positive sibling: the pass is not simply broken for every row.
    assert.equal(
      result.requeued,
      1,
      "the believable candidate is still healed"
    );
    assert.deepEqual(
      await markers(store),
      [{ session_id: TRUNCATED_SESSION, usage_rows: TRUNCATED_ROWS }],
      "the unbelievable one is left unmarked for a later boot"
    );
    assert.equal(
      await updatedAt(store, SECOND_TRUNCATED_SESSION),
      SEEDED_UPDATED_AT,
      "and unbumped — a count that cannot be believed never becomes a re-queue"
    );
  } finally {
    await close();
  }
});

/*
 * PRODUCTION WIRING (whitlockk, #5650). Every case above calls
 * `requeueTruncatedComponentUsage` directly, so deleting the
 * `.then(() => requeueTruncatedComponentUsage(prisma, log))` step from
 * `boot-maintenance.ts` leaves all of them green and ships a repair that never
 * runs on a real boot. This drives `startBootMaintenance` instead.
 *
 * `component_usage_resync_seen` has exactly ONE writer in the tree — this pass —
 * so the marker is the discriminating assertion: no other step in the chain can
 * satisfy it. The session's `updated_at` is asserted against the marker's own
 * `requeued_at` rather than merely "changed", because several earlier passes in
 * the chain also bump `updated_at`; only this pass stamps the SAME chunk
 * watermark onto both columns, in one transaction.
 *
 * The session carries a `session_analytics` row on purpose. `backfillSessionAnalytics`
 * heads the chain and anti-joins on exactly that row; without it the session is
 * backfilled, and the rollup DELETEs and rebuilds `agent_component_session_usage`
 * from invocations this fixture has none of — wiping the seeded usage and leaving
 * the pass with nothing to find, which would make this test green for a reason
 * that has nothing to do with the wiring it exists to prove.
 */
test("ISS-6998: the boot-maintenance chain runs the re-queue pass", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, TRUNCATED_SESSION, TRUNCATED_ROWS);
    await seedSession(store, COMPLETE_SESSION, COMPLETE_ROWS);
    for (const id of [TRUNCATED_SESSION, COMPLETE_SESSION]) {
      await store.query(
        "INSERT INTO session_analytics (session_id, started_at, updated_at) VALUES ($1, $2, $2)",
        [id, SEEDED_UPDATED_AT]
      );
    }

    await startBootMaintenance(prisma, () => undefined);

    assert.deepEqual(
      await markers(store),
      [{ session_id: TRUNCATED_SESSION, usage_rows: TRUNCATED_ROWS }],
      "the boot chain ran the pass: the truncated session is marked as asked-for"
    );
    assert.equal(
      await updatedAt(store, TRUNCATED_SESSION),
      await requeuedAt(store, TRUNCATED_SESSION),
      "and re-queued on the same watermark the pass recorded, so the bump is this pass's"
    );
    assert.equal(
      await updatedAt(store, COMPLETE_SESSION),
      SEEDED_UPDATED_AT,
      "a session that always fitted the cap is untouched by the chain"
    );
  } finally {
    await close();
  }
});

/**
 * ISS-7701, criterion 2. The cheaper discovery read must not have bought its
 * saving by learning to stop looking.
 *
 * The pass converges by ending on an EMPTY read, and that is precisely the
 * signal a "pass complete" marker would key on — which is why the ticket refuses
 * one. A session bumped inside the discovery->write window is deliberately left
 * unmarked, and it also drops out of the discovery predicate, so the run that
 * skipped it ends empty while it is still unhealed. Anything that treated that
 * empty read as "the population is drained" would strand it forever.
 */
test("ISS-7701: a session raced past the bound is still discovered on a later boot", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, TRUNCATED_SESSION, TRUNCATED_ROWS);
    await seedSession(store, SECOND_TRUNCATED_SESSION, TRUNCATED_ROWS);

    const wrapped = prismaWithMutationBeforeFirstWrite(prisma, async () => {
      await store.query("UPDATE sessions SET updated_at = $1 WHERE id = $2", [
        FUTURE_UPDATED_AT,
        SECOND_TRUNCATED_SESSION,
      ]);
    });
    const raced = await requeueTruncatedComponentUsage(
      wrapped,
      () => undefined
    );

    assert.equal(raced.requeued, 1, "only the unraced session was re-queued");
    assert.deepEqual(
      await markers(store),
      [{ session_id: TRUNCATED_SESSION, usage_rows: TRUNCATED_ROWS }],
      "the raced session is left unmarked — the run ended empty while it was still unhealed"
    );

    // What a later boot sees: the live writer's stamp is now in the past, so the
    // pass-start bound admits it again. The marker table is the only durable
    // state the pass keeps, and it holds no claim over this session.
    await store.query("UPDATE sessions SET updated_at = $1 WHERE id = $2", [
      SEEDED_UPDATED_AT,
      SECOND_TRUNCATED_SESSION,
    ]);

    // The discovery READ is what changed, so assert it re-finds the session
    // directly, not only that the pass as a whole repaired it.
    const rediscovered = await store.query<{ id: string }>(
      componentUsageResyncChunkSelectSql(false),
      [USAGE_CAP, FUTURE_UPDATED_AT, 25]
    );
    assert.deepEqual(
      rediscovered.rows.map((row) => row.id),
      [SECOND_TRUNCATED_SESSION],
      "discovery re-selects exactly the session the race left behind"
    );

    const later = await requeueTruncatedComponentUsage(prisma, () => undefined);
    assert.equal(
      later.requeued,
      1,
      "the raced session heals on the later boot"
    );
    assert.equal((await markers(store)).length, 2);
  } finally {
    await close();
  }
});

/**
 * ISS-7701, criterion 3. Per-session usage counts are NON-MONOTONIC:
 * `rebuildAgentComponentSessionUsageFromInvocations` DELETEs and re-INSERTs
 * `agent_component_session_usage` for a session on both the data-revision
 * rebuild and live invocation ingest. So a session that was under the cap when a
 * pass ran — and was therefore never a candidate and never marked — can be over
 * it afterwards, with no write to `sessions` and no marker to invalidate.
 *
 * This is why a cutoff keyed on the usage table cannot rescue a completion
 * marker either: there is no point after which "already counted" stays true.
 */
test("ISS-7701: a session rebuilt over the cap after a completed pass is still healed", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, COMPLETE_SESSION, COMPLETE_ROWS);

    const settled = await requeueTruncatedComponentUsage(
      prisma,
      () => undefined
    );
    assert.equal(settled.requeued, 0, "nothing to heal — the pass is complete");
    assert.deepEqual(await markers(store), [], "and it recorded no claim");
    const beforeRebuild = await updatedAt(store, COMPLETE_SESSION);

    // The rebuild: every usage row for the session is deleted and re-inserted,
    // this time past the wire cap. Nothing about `sessions` changes.
    await store.query(
      "DELETE FROM agent_component_session_usage WHERE session_id = $1",
      [COMPLETE_SESSION]
    );
    const values: string[] = [];
    const params: string[] = [COMPLETE_SESSION];
    for (let index = 0; index < TRUNCATED_ROWS; index += 1) {
      values.push(`($1, 'skill', $${index + 2}, '')`);
      params.push(`rebuilt-${index}`);
    }
    await store.query(
      `INSERT INTO agent_component_session_usage (session_id, component_kind, component_key, git_branch) VALUES ${values.join(", ")}`,
      params
    );
    assert.equal(
      await updatedAt(store, COMPLETE_SESSION),
      beforeRebuild,
      "the rebuild left no trace on `sessions` for a cutoff to key on"
    );

    const afterRebuild = await requeueTruncatedComponentUsage(
      prisma,
      () => undefined
    );

    assert.equal(
      afterRebuild.requeued,
      1,
      "the newly over-cap session is re-queued by the later boot"
    );
    assert.deepEqual(await markers(store), [
      { session_id: COMPLETE_SESSION, usage_rows: TRUNCATED_ROWS },
    ]);
  } finally {
    await close();
  }
});
