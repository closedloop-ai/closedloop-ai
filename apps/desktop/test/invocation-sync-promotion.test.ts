/**
 * @file invocation-sync-promotion.test.ts
 * @description ISS-5789 (PRD-634 / PRD-635 layer 3): the invocation lane's
 * PROMOTION step — the `$transaction` that clones template rows into a
 * target-scoped delivery queue.
 *
 * Its own suite rather than another block in the materialization tests, because
 * this is a distinct failure mode with a distinct blast radius: materialization
 * asks "is the right generation queued?", promotion asks "does queued work get
 * ATTEMPTED, and does one undrainable row take the queue down with it?". That
 * second question is the outage this ticket was filed for.
 */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { describe, test } from "node:test";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
  AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID,
  buildAgentComponentInvocationSyncSourceKey,
} from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import {
  MAX_PENDING_INVOCATION_DELIVERY_PARTS as MAX_PENDING,
  selectPromotableInvocationSessions,
  selectSessionsWithinPartBudget,
} from "../src/main/database/invocation-sync-pending-templates.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import {
  type Db,
  makeInvocationSyncDir,
  NOW,
  openDb,
  SKILL_CONTENT_V1,
  skillSession,
} from "./helpers/invocation-sync-fixtures.js";

/** Retries charged to the jammed row before promotion re-sweeps it. */
const JAMMED_ATTEMPTS = 3;

describe("ISS-5789 invocation sync promotion", () => {
  // Promotion used to bail out entirely whenever the delivery queue held ANY
  // pending row, so a single part the cloud rejects forever kept every other
  // session from ever being attempted — the reported install had 225 queued
  // records, 18 of them from 9 recent sessions, that had never been tried once.
  // A never-cleared row must cost only itself.
  test("an undrainable delivery row does not block promotion of other sessions", async () => {
    const dir = await makeInvocationSyncDir("aci-jam-");
    const db = await openDb(dir);
    try {
      // "a" sorts first, so it is the one promoted by the batch-of-one below and
      // therefore the one left jammed — the poisoned row is AHEAD of the healthy
      // work in the keyset sweep, exactly as in the incident.
      await db.importer.importSession(
        skillSession("session-jam-a", [SKILL_CONTENT_V1]),
        "claude"
      );
      await db.importer.importSession(
        skillSession("session-jam-b", [SKILL_CONTENT_V1]),
        "claude"
      );
      const target = buildAgentComponentInvocationSyncSourceKey("target-jam");
      const prepare = db.syncSource.prepareInvocationSyncTarget;
      const load = db.syncSource.loadReadyInvocationSyncParts;
      const retry = db.syncSource.recordInvocationSyncRetry;
      assert.ok(prepare && load && retry);

      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 1);
      const jammed = await load(target, NOW, 10);
      assert.equal(jammed.length, 1);
      assert.equal(jammed[0]?.part.externalSessionId, "session-jam-a");

      // Never acknowledged: this is the orphan the cloud rejects with
      // `session_missing` on every attempt, so it stays `pending` indefinitely.
      // Charge it some retries first, so the row carries in-flight budget state
      // that promotion would destroy if it re-materialized the session.
      await retry(
        target,
        jammed[0]?.part ?? assert.fail("missing jammed part"),
        JAMMED_ATTEMPTS,
        NOW,
        "session_missing"
      );

      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);
      const afterJam = await load(target, NOW, 10);

      const promotedSessionIds = afterJam
        .map((entry) => entry.part.externalSessionId)
        .sort();
      assert.deepEqual(
        promotedSessionIds,
        ["session-jam-a", "session-jam-b"],
        "the healthy session must promote while the jammed one is still pending"
      );

      // The jammed session's own row must be left exactly as it was: promotion
      // re-materializes by DELETE + re-clone, which would silently reset the
      // in-flight retry budget that has to stay bounded and reachable. Resetting
      // it is how "retries forever" comes back through the other door — the
      // budget could never be exhausted if every sweep zeroed it.
      const jammedRows = await db.prisma.client.$queryRawUnsafe<
        { status: string; attempt_count: number; last_error: string | null }[]
      >(
        `SELECT status, attempt_count, last_error
           FROM agent_component_invocation_sync_outbox
          WHERE source_key = $1 AND external_session_id = $2`,
        target,
        "session-jam-a"
      );
      assert.equal(jammedRows.length, 1);
      assert.equal(jammedRows[0]?.status, OutboxStatus.Pending);
      assert.equal(
        Number(jammedRows[0]?.attempt_count),
        JAMMED_ATTEMPTS,
        "promotion must not reset the jammed row's retry budget"
      );
      // Why the row was skipped stays durable on the row itself, which is what
      // lets promotion skip it without needing a logger on the write path.
      assert.equal(jammedRows[0]?.last_error, "session_missing");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The other half of layer 3, and the half the fix could silently lose. Replacing
  // "bail on ANY pending row" with "bail on DEPTH" is only safe if the depth guard
  // actually still engages — otherwise the throttle that stops the delivery queue
  // growing without bound while nothing drains is simply gone, and the fix for one
  // outage has created a different one.
  test("promotion still throttles once the delivery queue reaches its depth ceiling", async () => {
    const dir = await makeInvocationSyncDir("aci-depth-");
    const db = await openDb(dir);
    try {
      await db.importer.importSession(
        skillSession("session-depth-a", [SKILL_CONTENT_V1]),
        "claude"
      );
      const target = buildAgentComponentInvocationSyncSourceKey("target-depth");
      const prepare = db.syncSource.prepareInvocationSyncTarget;
      const load = db.syncSource.loadReadyInvocationSyncParts;
      assert.ok(prepare && load);

      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);
      const promoted = await load(target, NOW, MAX_PENDING + 10);
      assert.equal(promoted.length, 1);

      // Fill the queue to exactly the ceiling with rows the lane is not draining.
      // Synthetic rather than imported because the guard counts DEPTH, and what
      // matters is the count the transaction sees, not how the rows got there.
      await seedPendingDeliveryRows(db, target, MAX_PENDING - promoted.length);
      assert.equal(await countPending(db, target), MAX_PENDING);

      // A brand-new session is now available to promote, and every condition
      // except depth is satisfied.
      await db.importer.importSession(
        skillSession("session-depth-b", [SKILL_CONTENT_V1]),
        "claude"
      );
      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);

      assert.equal(
        await countPending(db, target),
        MAX_PENDING,
        "at the ceiling, promotion must add nothing to the delivery queue"
      );
      assert.equal(
        await countPendingForSession(db, target, "session-depth-b"),
        0,
        "the new session must not be promoted while the queue is at depth"
      );

      // Drain back under the ceiling and the same session promotes — proving the
      // block above was the depth guard and not some unrelated refusal.
      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          `DELETE FROM agent_component_invocation_sync_outbox
            WHERE source_key = $1 AND external_session_id LIKE $2`,
          target,
          `${SEEDED_SESSION_PREFIX}%`
        )
      );
      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);

      assert.ok(
        (await countPendingForSession(db, target, "session-depth-b")) > 0,
        "below the ceiling the same session must promote"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ISS-5789 (codex P1 review). Skipping a blocked session is only half the fix:
  // the pass also has to KEEP GOING. It used to read one candidate page and stop,
  // so when every session in that page was blocked it returned without advancing
  // the cursor and the next tick re-read the identical page. Measured before the
  // fix: ten blocked sessions ahead of one healthy session starved that session
  // across five consecutive ticks, promoting zero rows — the same queue-wide
  // outage layer 3 exists to remove, reappearing one page deep.
  test("promotion pages past a fully blocked candidate page to reach a healthy session", async () => {
    const dir = await makeInvocationSyncDir("aci-scan-");
    const db = await openDb(dir);
    try {
      const target = buildAgentComponentInvocationSyncSourceKey("target-scan");
      await seedTemplateRevision(db);
      // Every session in the first page is blocked by its own in-flight delivery
      // row, and all of them sort BEFORE the healthy one.
      for (let index = 0; index < BLOCKED_PAGE_SESSIONS; index++) {
        const sessionId = `${BLOCKED_SESSION_PREFIX}${`${index}`.padStart(3, "0")}`;
        await seedTemplateSession(db, sessionId, `${index + 10}`, 1);
        await seedDeliveryRows(db, target, sessionId, `${index}`, 1);
        await seedCursor(db, target, sessionId, `${index}`, 1);
      }
      await seedTemplateSession(db, HEALTHY_SESSION_ID, "99", 1);

      const prepare = db.syncSource.prepareInvocationSyncTarget;
      assert.ok(prepare);
      await prepare(
        target,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        BLOCKED_PAGE_SESSIONS
      );

      assert.ok(
        (await countPendingForSession(db, target, HEALTHY_SESSION_ID)) > 0,
        "a healthy session behind a fully blocked page must still be promoted"
      );
      // The blocked sessions keep their in-flight state: paging forward must not
      // have re-materialized them.
      assert.equal(
        await countPendingForSession(
          db,
          target,
          `${BLOCKED_SESSION_PREFIX}000`
        ),
        1,
        "a blocked session must be skipped, not re-cloned"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ISS-5789 (@wongk review). The depth guard was a PRE-INSERT check only, so it
  // bounded the queue before the clone and not after it. Measured before the fix:
  // 499 pending rows plus ten promotable 1,000-part generations left 10,499 rows
  // in a single transaction — a 500-row ceiling overshot by 9,999.
  test("promotion admits candidates against the parts they add, not just the depth already queued", async () => {
    const dir = await makeInvocationSyncDir("aci-admit-");
    const db = await openDb(dir);
    try {
      const target = buildAgentComponentInvocationSyncSourceKey("target-admit");
      await seedTemplateRevision(db);
      // One row under the ceiling, held by sessions that are not candidates.
      await seedPendingDeliveryRows(db, target, MAX_PENDING - 1);
      for (let index = 0; index < OVERSIZED_GENERATIONS; index++) {
        await seedTemplateSession(
          db,
          `${OVERSIZED_SESSION_PREFIX}${index}`,
          `${100 + index}`,
          OVERSIZED_GENERATION_PARTS
        );
      }

      const prepare = db.syncSource.prepareInvocationSyncTarget;
      assert.ok(prepare);
      await prepare(
        target,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        OVERSIZED_GENERATIONS
      );

      // These generations are each larger than the whole ceiling, so SOME
      // overshoot is unavoidable — the clone is atomic per generation and a
      // session this size is unpromotable at every depth. What must not happen is
      // the overshoot STACKING: the measured pre-fix behaviour admitted all ten.
      const afterPass = await countPending(db, target);
      assert.ok(
        afterPass <= MAX_PENDING - 1 + OVERSIZED_GENERATION_PARTS,
        `one pass may overshoot by at most a single oversized generation, but the queue reached ${afterPass}`
      );
      const promotedSessions = await countPromotedSessions(
        db,
        target,
        OVERSIZED_SESSION_PREFIX
      );
      assert.equal(
        promotedSessions,
        1,
        "an oversized generation must be promoted alone, never stacked with others"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The ordinary case, where the ceiling must hold EXACTLY: generations that
  // could fit are admitted only while they do, and one that does not fit yet waits
  // for the queue to drain rather than being force-admitted.
  test("promotion stops admitting once the next generation would cross the ceiling", async () => {
    const dir = await makeInvocationSyncDir("aci-fit-");
    const db = await openDb(dir);
    try {
      const target = buildAgentComponentInvocationSyncSourceKey("target-fit");
      await seedTemplateRevision(db);
      await seedPendingDeliveryRows(
        db,
        target,
        MAX_PENDING - FITTING_PARTS * 2
      );
      for (let index = 0; index < 5; index++) {
        await seedTemplateSession(
          db,
          `${FITTING_SESSION_PREFIX}${index}`,
          `${200 + index}`,
          FITTING_PARTS
        );
      }

      const prepare = db.syncSource.prepareInvocationSyncTarget;
      assert.ok(prepare);
      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);

      const afterPass = await countPending(db, target);
      assert.equal(
        afterPass,
        MAX_PENDING,
        "the pass must fill the queue to its ceiling and stop, not cross it"
      );
      assert.equal(
        await countPromotedSessions(db, target, FITTING_SESSION_PREFIX),
        2,
        "exactly the two generations that fit may be admitted"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The bounded oversized-generation path. A generation with more parts than the
  // whole ceiling must still be delivered eventually — admitting nothing would
  // stop that session syncing forever at any queue depth — so it is promoted
  // ALONE and the overshoot is bounded by that one generation.
  test("promotion still admits a single generation larger than the whole ceiling", async () => {
    const dir = await makeInvocationSyncDir("aci-huge-");
    const db = await openDb(dir);
    try {
      const target = buildAgentComponentInvocationSyncSourceKey("target-huge");
      await seedTemplateRevision(db);
      await seedTemplateSession(db, "huge-solo", "100", MAX_PENDING + 25);
      await seedTemplateSession(db, "zz-follower", "101", 5);

      const prepare = db.syncSource.prepareInvocationSyncTarget;
      assert.ok(prepare);
      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);

      assert.equal(
        await countPendingForSession(db, target, "huge-solo"),
        MAX_PENDING + 25,
        "an oversized generation must still be promoted rather than stranded"
      );
      assert.equal(
        await countPendingForSession(db, target, "zz-follower"),
        0,
        "it must be promoted ALONE so the overshoot stays bounded by one generation"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// The admission rule itself, without a database.
describe("ISS-5789 selectSessionsWithinPartBudget", () => {
  test("admits the prefix that fits the remaining budget", () => {
    assert.deepEqual(
      selectSessionsWithinPartBudget(
        ["a", "b", "c"],
        new Map([
          ["a", 3],
          ["b", 4],
          ["c", 1],
        ]),
        7
      ),
      ["a", "b"]
    );
  });

  // Stops rather than skips: the caller advances a keyset cursor to the LAST id it
  // promoted, so admitting "c" past an unaffordable "b" would move the cursor
  // beyond "b" and strand it until the sweep wrapped.
  test("stops at the first candidate that does not fit instead of skipping it", () => {
    assert.deepEqual(
      selectSessionsWithinPartBudget(
        ["a", "b", "c"],
        new Map([
          ["a", 1],
          ["b", 900],
          ["c", 1],
        ]),
        10
      ),
      ["a"]
    );
  });

  // Can NEVER fit (larger than the whole ceiling), so deferring would strand it
  // forever: admitted alone.
  test("admits an unpromotable oversized generation alone rather than stranding it", () => {
    assert.deepEqual(
      selectSessionsWithinPartBudget(
        ["a", "b"],
        new Map([
          ["a", MAX_PENDING + 1],
          ["b", 1],
        ]),
        10
      ),
      ["a"]
    );
  });

  // Could fit at a lower depth, so it waits instead of being force-admitted —
  // otherwise the ceiling means nothing whenever the queue is nearly full.
  test("defers a generation that merely does not fit right now", () => {
    assert.deepEqual(
      selectSessionsWithinPartBudget(["a", "b"], new Map([["a", 50]]), 10),
      []
    );
  });

  test("treats a candidate with no template parts as free", () => {
    assert.deepEqual(
      selectSessionsWithinPartBudget(["a", "b"], new Map([["b", 2]]), 2),
      ["a", "b"]
    );
  });

  test("admits nothing for an empty candidate set", () => {
    assert.deepEqual(selectSessionsWithinPartBudget([], new Map(), 100), []);
  });
});

// The skip rule itself, without a database. The DB-backed cases above prove the
// rule is WIRED; these prove it is RIGHT at the edges a single fixture cannot
// reach — and in particular that a blocked candidate removes only itself and
// leaves sweep order intact, since the caller advances a keyset cursor to the last
// id it promoted and would skip work if this reordered.
describe("ISS-5789 selectPromotableInvocationSessions", () => {
  test("drops only the blocked candidates and preserves sweep order", () => {
    assert.deepEqual(
      selectPromotableInvocationSessions(["a", "b", "c", "d"], ["c", "a"]),
      ["b", "d"]
    );
  });

  test("promotes everything when nothing is blocked", () => {
    assert.deepEqual(selectPromotableInvocationSessions(["a", "b"], []), [
      "a",
      "b",
    ]);
  });

  test("promotes nothing when every candidate is blocked", () => {
    assert.deepEqual(
      selectPromotableInvocationSessions(["a", "b"], ["b", "a"]),
      []
    );
  });

  test("ignores a blocked id that is not a candidate this pass", () => {
    assert.deepEqual(selectPromotableInvocationSessions(["a"], ["zzz"]), ["a"]);
  });

  test("returns nothing for an empty candidate set", () => {
    assert.deepEqual(selectPromotableInvocationSessions([], ["a"]), []);
  });
});

/** Distinguishes the synthetic depth-filler rows from real promoted ones. */
const SEEDED_SESSION_PREFIX = "seeded-depth-";

/**
 * `count` pending delivery rows in the target queue, one per synthetic session, so
 * the depth guard sees a genuine backlog. Written as a single multi-row INSERT
 * because the point is the resulting COUNT, not the write path.
 */
async function seedPendingDeliveryRows(
  db: Db,
  targetSourceKey: string,
  count: number
): Promise<void> {
  const columns = 16;
  const tuples: string[] = [];
  const values: unknown[] = [];
  for (let index = 0; index < count; index++) {
    const base = index * columns;
    tuples.push(
      `(${Array.from({ length: columns }, (_, offset) => `$${base + offset + 1}`).join(", ")})`
    );
    values.push(
      targetSourceKey,
      `${SEEDED_SESSION_PREFIX}${index}`,
      `${index}`.padStart(64, "0"),
      0,
      1,
      `${index}`.padStart(64, "f"),
      NOW,
      1,
      1,
      "{}",
      OutboxStatus.Pending,
      0,
      null,
      null,
      NOW,
      NOW
    );
  }
  await db.prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_component_invocation_sync_outbox
       (source_key, external_session_id, external_generation_id, part_index,
        part_count, part_hash, source_updated_at, data_revision, source_sequence,
        payload, status, attempt_count, next_attempt_at, last_error, created_at,
        updated_at)
     VALUES ${tuples.join(", ")}`,
      ...values
    )
  );
}

async function countPending(db: Db, targetSourceKey: string): Promise<number> {
  const rows = await db.prisma.client.$queryRawUnsafe<{ total: bigint }[]>(
    `SELECT COUNT(*) AS total
       FROM agent_component_invocation_sync_outbox
      WHERE source_key = $1 AND status = $2`,
    targetSourceKey,
    OutboxStatus.Pending
  );
  return Number(rows[0]?.total ?? 0);
}

async function countPendingForSession(
  db: Db,
  targetSourceKey: string,
  externalSessionId: string
): Promise<number> {
  const rows = await db.prisma.client.$queryRawUnsafe<{ total: bigint }[]>(
    `SELECT COUNT(*) AS total
       FROM agent_component_invocation_sync_outbox
      WHERE source_key = $1 AND status = $2 AND external_session_id = $3`,
    targetSourceKey,
    OutboxStatus.Pending,
    externalSessionId
  );
  return Number(rows[0]?.total ?? 0);
}

/** Sessions filling the first candidate page in the paging case, all blocked. */
const BLOCKED_PAGE_SESSIONS = 10;
const BLOCKED_SESSION_PREFIX = "blocked-";
/** Sorts after every blocked id, so only a paging scan can reach it. */
const HEALTHY_SESSION_ID = "zz-healthy";
/** The generation shape from @wongk's review: ten generations of 1,000 parts. */
const OVERSIZED_GENERATIONS = 10;
const OVERSIZED_GENERATION_PARTS = 1000;
const OVERSIZED_SESSION_PREFIX = "huge-";
/** Generations small enough to fit inside the ceiling, for the ordinary case. */
const FITTING_PARTS = 60;
const FITTING_SESSION_PREFIX = "fits-";

/** How many distinct sessions with `prefix` ended up in the delivery queue. */
async function countPromotedSessions(
  db: Db,
  targetSourceKey: string,
  prefix: string
): Promise<number> {
  const rows = await db.prisma.client.$queryRawUnsafe<{ total: bigint }[]>(
    `SELECT COUNT(DISTINCT external_session_id) AS total
       FROM agent_component_invocation_sync_outbox
      WHERE source_key = $1 AND external_session_id LIKE $2`,
    targetSourceKey,
    `${prefix}%`
  );
  return Number(rows[0]?.total ?? 0);
}

/**
 * A template revision the target has not consumed, which is what makes promotion
 * run at all. Seeded directly rather than through the importer because these cases
 * are about the promotion transaction's admission arithmetic, not about how
 * template rows come to exist.
 */
function seedTemplateRevision(db: Db): Promise<void> {
  return seedCursor(
    db,
    AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
    AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID,
    "1",
    1
  );
}

/** One promotable template session with `partCount` pending template rows. */
async function seedTemplateSession(
  db: Db,
  externalSessionId: string,
  generation: string,
  partCount: number
): Promise<void> {
  await seedCursor(
    db,
    AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
    externalSessionId,
    generation,
    2
  );
  await seedDeliveryRows(
    db,
    AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
    externalSessionId,
    generation,
    partCount
  );
}

/** `partCount` pending outbox rows for one session under one source key. */
async function seedDeliveryRows(
  db: Db,
  sourceKey: string,
  externalSessionId: string,
  generation: string,
  partCount: number
): Promise<void> {
  const columns = 16;
  for (let offset = 0; offset < partCount; offset += 250) {
    const size = Math.min(250, partCount - offset);
    const tuples: string[] = [];
    const values: unknown[] = [];
    for (let index = 0; index < size; index++) {
      const base = index * columns;
      tuples.push(
        `(${Array.from({ length: columns }, (_, column) => `$${base + column + 1}`).join(", ")})`
      );
      values.push(
        sourceKey,
        externalSessionId,
        generation.padStart(64, "0"),
        offset + index,
        partCount,
        `${externalSessionId}-${offset + index}`.padStart(64, "f").slice(-64),
        NOW,
        1,
        1,
        "{}",
        OutboxStatus.Pending,
        0,
        null,
        null,
        NOW,
        NOW
      );
    }
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO agent_component_invocation_sync_outbox
         (source_key, external_session_id, external_generation_id, part_index,
          part_count, part_hash, source_updated_at, data_revision,
          source_sequence, payload, status, attempt_count, next_attempt_at,
          last_error, created_at, updated_at)
       VALUES ${tuples.join(", ")}`,
        ...values
      )
    );
  }
}

/** One sync cursor row, upserted. */
async function seedCursor(
  db: Db,
  sourceKey: string,
  externalSessionId: string,
  generation: string,
  sourceSequence: number
): Promise<void> {
  await db.prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_component_invocation_sync_cursors
         (source_key, external_session_id, external_generation_id,
          source_sequence, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source_key, external_session_id) DO UPDATE SET
         external_generation_id = excluded.external_generation_id,
         source_sequence = excluded.source_sequence,
         updated_at = excluded.updated_at`,
      sourceKey,
      externalSessionId,
      generation.padStart(64, "0"),
      sourceSequence,
      NOW
    )
  );
}
