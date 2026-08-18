/**
 * @file sync-source-hydration-chunk-equivalence.test.ts
 * @description ISS-6105 — hydrating a set of sessions must produce exactly what
 * hydrating each of them separately produces.
 *
 * This is the SAFETY property behind the ISS-6105 chunk planner, not a
 * nice-to-have. The planner is free to move the chunk boundaries around
 * according to how heavy each session is, and it is only allowed to do that
 * because `assembleSyncedSessions` builds each session from that session's OWN
 * rows (`ids.flatMap`) — so where the boundaries fall cannot matter. The moment
 * any per-session field starts depending on which siblings rode in the same
 * chunk, an adaptive boundary silently changes what the desktop uploads to the
 * cloud and what the Sessions list renders, and it changes it differently on
 * every install because the boundaries depend on local data.
 *
 * A heap win that quietly truncates or alters a session is far worse than a fat
 * read, so the assertion is on the WHOLE projected session, not on a count or a
 * size. The fixture deliberately mixes the boundary shapes: a session with no
 * relations at all, a session with exactly one row in each relation, and a
 * session with several — because an off-by-one in a per-session grouping shows
 * up first at zero and one.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  planSyncedSessionHydration,
  SYNCED_SESSION_HYDRATE_CHUNK_SIZE,
} from "../src/main/database/synced-session-hydration-plan.js";

/**
 * Stored `sessions.metadata` big enough that ONE session fits the 48 MiB chunk
 * budget on its own but TWO cannot share a chunk.
 *
 * At the module's measured ratios a stored character costs
 * 3.5 (parse) * 1.75 (assembly) = 6.125 heap bytes, so 5 MB of metadata
 * estimates at ~30.6 MB: under the 48 MiB budget alone, over it in pairs.
 */
const HALF_BUDGET_METADATA_CHARS = 5_000_000;
/** Stored `events.data` per row for the payload-heavy session. */
const HEAVY_EVENT_DATA_CHARS = 450_000;
const PAYLOAD_EVENT_ROWS = 20;

function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

/** JSON round-trip so BigInt columns compare structurally, not by identity. */
function normalize(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, inner) =>
      typeof inner === "bigint" ? Number(inner) : inner
    )
  );
}

const SESSION_IDS = ["s-empty", "s-single", "s-many"] as const;

test("ISS-6105: a batched hydration equals the per-session hydrations it replaces", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss6105-chunk-equiv-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-08-12T00:00:00.000Z",
    });
    try {
      // `s-empty` carries NO relations at all — the zero boundary.
      // `s-single` carries exactly one of each — the one boundary.
      // `s-many` carries several, with an interleaved ordering so a grouping
      // that leaked across sessions would land rows in the wrong one.
      await db.run(
        `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
         VALUES
           ('s-empty','inactive','claude','2026-08-12T00:00:00.000Z','2026-08-12T00:03:00.000Z', NULL),
           ('s-single','inactive','claude','2026-08-12T00:01:00.000Z','2026-08-12T00:04:00.000Z','{"a":1}'),
           ('s-many','active','codex','2026-08-12T00:02:00.000Z','2026-08-12T00:05:00.000Z','{"b":[1,2,3]}')`
      );
      await db.run(
        `INSERT INTO agents (id, session_id, name, type, status, started_at)
         VALUES
           ('a-single','s-single','solo','main','completed','2026-08-12T00:01:01.000Z'),
           ('a-many-1','s-many','one','main','completed','2026-08-12T00:02:01.000Z'),
           ('a-many-2','s-many','two','subagent','running','2026-08-12T00:02:02.000Z')`
      );
      await db.run(
        `INSERT INTO events (id, session_id, agent_id, event_type, tool_name, summary, data, created_at)
         VALUES
           ('e-single','s-single','a-single','PostToolUse','Read','r','{"k":1}','2026-08-12T00:01:02.000Z'),
           ('e-many-1','s-many','a-many-1','PostToolUse','Edit','e1','{"k":2}','2026-08-12T00:02:03.000Z'),
           ('e-many-2','s-many','a-many-2','PostToolUse','Bash','e2','{"k":3}','2026-08-12T00:02:04.000Z'),
           ('e-many-3','s-many','a-many-1','UserPromptSubmit',NULL,'p',NULL,'2026-08-12T00:02:05.000Z')`
      );
      await db.run(
        `INSERT INTO token_events
           (session_id, model, created_at, input_tokens, output_tokens, transport_id)
         VALUES
           ('s-single','sonnet','2026-08-12T00:01:03.000Z',10,20,'tr-1'),
           ('s-many','sonnet','2026-08-12T00:02:06.000Z',30,40,'tr-2'),
           ('s-many','opus','2026-08-12T00:02:07.000Z',50,60,'tr-3')`
      );

      const batched = await db.syncSource.loadSyncedSessions(
        [...SESSION_IDS],
        emptyAttributionCache()
      );

      const perSession: (typeof batched)[number][] = [];
      for (const id of SESSION_IDS) {
        const [session] = await db.syncSource.loadSyncedSessions(
          [id],
          emptyAttributionCache()
        );
        assert.ok(session, `${id} hydrated on its own`);
        perSession.push(session);
      }

      assert.equal(
        batched.length,
        SESSION_IDS.length,
        "the batch returns every session it was asked for — a chunk boundary must never drop one"
      );
      assert.deepEqual(
        batched.map((session) => session.externalSessionId),
        [...SESSION_IDS],
        "the batch preserves the caller's id order across chunk boundaries"
      );
      assert.deepEqual(
        normalize(batched),
        normalize(perSession),
        "every projected field of every session is identical whether it was hydrated with its siblings or alone"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-6105: a hydration for ids that do not exist returns nothing rather than throwing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss6105-chunk-absent-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-08-12T00:00:00.000Z",
    });
    try {
      // ISS-6031: an empty hydration is a READ RESULT, not proof of deletion —
      // the sizing read sees no row for these ids either, and that must resolve
      // to "sized as unknown, hydrated anyway, returned nothing" rather than to
      // an exception the sync lane would have to interpret.
      const loaded = await db.syncSource.loadSyncedSessions(
        ["missing-a", "missing-b"],
        emptyAttributionCache()
      );
      assert.deepEqual(loaded, []);
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-6105: a hydration that spans MORE THAN ONE real chunk still returns every session, in order", async () => {
  // The equivalence test above always packs into a single chunk, so the loop
  // that concatenates several real `prisma.read` chunk loads — the code path the
  // whole "chunking is result-identical" claim rests on — would go unexercised.
  // Crossing the count backstop forces at least two real chunks against a real
  // SQLite database without needing a fixture large enough to cross the byte
  // budget.
  const sessionCount = SYNCED_SESSION_HYDRATE_CHUNK_SIZE + 1;
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss6105-multi-chunk-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-08-12T00:00:00.000Z",
    });
    try {
      const ids = Array.from(
        { length: sessionCount },
        (_, i) => `bulk-${String(i).padStart(4, "0")}`
      );
      const values = ids
        .map(
          (id, i) =>
            `('${id}','inactive','claude','2026-08-12T00:00:00.000Z','2026-08-12T00:00:${String(
              i % 60
            ).padStart(2, "0")}.000Z')`
        )
        .join(",");
      await db.run(
        `INSERT INTO sessions (id, status, harness, started_at, updated_at) VALUES ${values}`
      );

      const loaded = await db.syncSource.loadSyncedSessions(
        ids,
        emptyAttributionCache()
      );

      assert.equal(
        loaded.length,
        sessionCount,
        "a multi-chunk hydration returns every session — a boundary must never truncate the result"
      );
      assert.deepEqual(
        loaded.map((session) => session.externalSessionId),
        ids,
        "chunk concatenation preserves the caller's id order end to end"
      );
      assert.equal(
        new Set(loaded.map((session) => session.externalSessionId)).size,
        sessionCount,
        "no session is emitted twice across chunk boundaries"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** JSON-valid padding of `chars` stored characters. */
function paddedJson(chars: number): string {
  return `{"pad":"${"x".repeat(Math.max(0, chars - 11))}"}`;
}

test("ISS-6105: two sessions that each fit alone but not together are split by the BYTE budget", async () => {
  // The multi-chunk case above crosses the 200-id backstop, so it would stay
  // green with the sizing read entirely disconnected. This one uses TWO ids —
  // far under any count ceiling — so the only thing that can produce a second
  // chunk is the byte budget actually reading these sessions' stored size.
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss6105-byte-split-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-08-12T00:00:00.000Z",
    });
    try {
      const metadata = paddedJson(HALF_BUDGET_METADATA_CHARS);
      for (const id of ["heavy-a", "heavy-b"]) {
        await db.run(
          `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
           VALUES (?, 'inactive', 'claude', '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:01.000Z', ?)`,
          id,
          metadata
        );
      }

      // Asserted by LENGTH, not `assert.deepEqual(degrades, [])`: under
      // `assert/strict` that carries an `asserts actual is T` signature, so it
      // narrows the array to `never[]` and every later `push` fails to compile.
      const degrades: string[] = [];
      const options = { omitEventData: true };
      const both = await planSyncedSessionHydration(
        db.prisma,
        ["heavy-a", "heavy-b"],
        options,
        (message) => degrades.push(message)
      );

      assert.equal(
        degrades.length,
        0,
        `the sizing read must actually answer — a degrade here would fall back to fixed chunking and fake the result (got: ${degrades.join(" | ")})`
      );
      assert.deepEqual(
        both,
        [["heavy-a"], ["heavy-b"]],
        "two sessions that cannot share the budget must be planned as two chunks"
      );

      for (const id of ["heavy-a", "heavy-b"]) {
        assert.deepEqual(
          await planSyncedSessionHydration(
            db.prisma,
            [id],
            options,
            (message) => degrades.push(message)
          ),
          [[id]],
          `${id} fits a chunk on its own — the split above is the budget, not an oversized single session`
        );
      }
      assert.equal(
        degrades.length,
        0,
        `no later plan degraded either (got: ${degrades.join(" | ")})`
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-6105: equal event-row counts with different payload sizes chunk differently", async () => {
  // wongk (#4910): the full-data shape used to price every `events.data` blob at
  // a fixed per-row average, so these two sessions — identical row counts, 4500x
  // the stored payload — were scored identically and packed together. The branch
  // trace lanes call `loadSyncedSessions` WITHOUT `omitEventData`, so that is a
  // real nominal-48-MiB chunk holding hundreds of MiB.
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss6105-payload-split-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-08-12T00:00:00.000Z",
    });
    try {
      await db.run(
        `INSERT INTO sessions (id, status, harness, started_at, updated_at)
         VALUES
           ('light','inactive','claude','2026-08-12T00:00:00.000Z','2026-08-12T00:00:01.000Z'),
           ('heavy','inactive','claude','2026-08-12T00:00:00.000Z','2026-08-12T00:00:02.000Z')`
      );
      const lightData = paddedJson(100);
      const heavyData = paddedJson(HEAVY_EVENT_DATA_CHARS);
      for (let i = 0; i < PAYLOAD_EVENT_ROWS; i++) {
        await db.run(
          `INSERT INTO events (id, session_id, event_type, data, created_at)
           VALUES (?, 'light', 'PostToolUse', ?, '2026-08-12T00:00:03.000Z'),
                  (?, 'heavy', 'PostToolUse', ?, '2026-08-12T00:00:03.000Z')`,
          `e-light-${i}`,
          lightData,
          `e-heavy-${i}`,
          heavyData
        );
      }

      // Asserted by LENGTH, not `assert.deepEqual(degrades, [])`: under
      // `assert/strict` that carries an `asserts actual is T` signature, so it
      // narrows the array to `never[]` and every later `push` fails to compile.
      const degrades: string[] = [];
      // No `omitEventData` — the shape that really loads the blobs.
      const chunks = await planSyncedSessionHydration(
        db.prisma,
        ["light", "heavy"],
        undefined,
        (message) => degrades.push(message)
      );

      assert.equal(
        degrades.length,
        0,
        `the sizing read must actually answer (got: ${degrades.join(" | ")})`
      );
      assert.deepEqual(
        chunks,
        [["light"], ["heavy"]],
        "the payload-heavy session is over budget on its own and must not be packed with its equal-row-count neighbour"
      );
      assert.deepEqual(
        await planSyncedSessionHydration(
          db.prisma,
          ["light", "heavy"],
          { omitEventData: true },
          (message) => degrades.push(message)
        ),
        [["light", "heavy"]],
        "and with the blob nulled in SQL the same two sessions share one chunk — the payload is what costs, not the rows"
      );
      assert.equal(
        degrades.length,
        0,
        `no later plan degraded either (got: ${degrades.join(" | ")})`
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
