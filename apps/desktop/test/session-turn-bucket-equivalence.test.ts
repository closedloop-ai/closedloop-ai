/**
 * @file session-turn-bucket-equivalence.test.ts
 * @description FEA-3132 — the materialized `session_turn_bucket` (built at ingest
 * by `rebuildSessionTurnBuckets`) must reproduce the OLD json_each-over-$.messages
 * read BYTE-FOR-BYTE for BOTH the activity heatmap and the autonomy trend. The
 * old json_each SQL is kept here as the ORACLE and run against the same seeded
 * corpus, so any drift between the ingest derivation and the read is caught even
 * after the json_each helpers were deleted from production. Edge cases pinned:
 * tool/other roles excluded, missing-timestamp excluded, non-object array
 * elements excluded, duplicate (ts,role) counted (turn_count), headless via
 * sdk%/%exec% flipping human→agent, malformed metadata + no-messages yielding
 * zero rows.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backfillSessionTurnBuckets,
  rebuildSessionTurnBuckets,
} from "../src/main/database/write-core.js";
import { openTestPrisma } from "./prisma-test-utils.js";

// The EXACT pre-FEA-3132 json_each turn source (oracle).
const turnsOracle = (ph: string) =>
  `SELECT CASE WHEN m.type='object' THEN json_extract(m.value,'$.role') END AS role,
          CASE WHEN m.type='object' THEN json_extract(m.value,'$.timestamp') END AS ts,
          CASE WHEN json_extract(s.metadata,'$.entrypoint') LIKE 'sdk%'
                 OR json_extract(s.metadata,'$.entrypoint') LIKE '%exec%'
               THEN 1 ELSE 0 END AS headless
   FROM sessions s
   JOIN json_each(CASE WHEN json_valid(s.metadata)
                       THEN CASE WHEN json_type(s.metadata,'$.messages')='array'
                                 THEN s.metadata END END, '$.messages') m
   WHERE s.id IN (${ph})`;

type Seed = {
  id: string;
  entrypoint: string;
  messages?: unknown[];
  metadataRaw?: string;
};

const SEEDS: Seed[] = [
  {
    id: "s-cli",
    entrypoint: "cli",
    messages: [
      { role: "human", timestamp: "2026-07-01T10:15:00Z" },
      { role: "assistant", timestamp: "2026-07-01T10:16:00Z" },
      { role: "assistant", timestamp: "2026-07-01T10:16:00Z" }, // dup (ts,role) -> turn_count 2
      { role: "tool", timestamp: "2026-07-01T10:17:00Z" }, // excluded (role)
      { role: "human" }, // excluded (no ts)
      "a-string-primitive", // excluded (non-object)
    ],
  },
  {
    id: "s-sdk",
    entrypoint: "sdk-ts", // headless -> a human turn counts as agent
    messages: [
      { role: "human", timestamp: "2026-07-02T09:00:00Z" },
      { role: "assistant", timestamp: "2026-07-02T09:05:00Z" },
    ],
  },
  {
    id: "s-exec",
    entrypoint: "some-exec-runner", // '%exec%' -> headless
    messages: [{ role: "human", timestamp: "2026-07-02T14:00:00Z" }],
  },
  { id: "s-malformed", entrypoint: "cli", metadataRaw: "{not valid json" },
  { id: "s-nomsgs", entrypoint: "cli", messages: undefined },
];

function norm(rows: Record<string, unknown>[], keys: string[]) {
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const k of keys) {
      o[k] = k === "day" ? r[k] : Number(r[k]);
    }
    return o;
  });
}

test("session_turn_bucket read == old json_each read (heatmap + autonomy)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await prisma.write(async (client) => {
      for (const s of SEEDS) {
        const metadata =
          s.metadataRaw ??
          JSON.stringify({
            entrypoint: s.entrypoint,
            ...(s.messages === undefined ? {} : { messages: s.messages }),
          });
        await client.$executeRawUnsafe(
          "INSERT INTO sessions (id, status, started_at, ended_at, metadata) VALUES ($1,$2,$3,$4,$5)",
          s.id,
          "completed",
          "2026-07-01T00:00:00Z",
          "2026-07-01T01:00:00Z",
          metadata
        );
      }
    });
    const ids = SEEDS.map((s) => s.id);
    await prisma.write((client) =>
      client.$transaction((tx) => rebuildSessionTurnBuckets(tx, ids))
    );

    const ph = ids.map(() => "?").join(",");
    const WSTART = "2020-01-01T00:00:00Z";
    const WEND = "2030-01-01T00:00:00Z";

    // Heatmap: old json_each vs new table.
    const oldHeatmap = await prisma.read((r) =>
      r.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT strftime('%Y-%m-%d',t.ts,'localtime') AS day,
                CAST(strftime('%H',t.ts,'localtime') AS INTEGER) AS hour,
                COUNT(*) FILTER (WHERE (t.role='human' AND t.headless=0)) AS human,
                COUNT(*) FILTER (WHERE (t.role='assistant' OR (t.role='human' AND t.headless=1))) AS agent
         FROM (${turnsOracle(ph)}) t
         WHERE t.ts IS NOT NULL AND t.role IN ('human','assistant')
         GROUP BY day,hour HAVING day IS NOT NULL ORDER BY day,hour`,
        ...ids
      )
    );
    const newHeatmap = await prisma.read((r) =>
      r.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT strftime('%Y-%m-%d',b.ts,'localtime') AS day,
                CAST(strftime('%H',b.ts,'localtime') AS INTEGER) AS hour,
                SUM(CASE WHEN b.turn_kind='human' THEN b.turn_count ELSE 0 END) AS human,
                SUM(CASE WHEN b.turn_kind='agent' THEN b.turn_count ELSE 0 END) AS agent
         FROM session_turn_bucket b JOIN sessions s ON s.id=b.session_id
         WHERE s.started_at IS NOT NULL AND s.started_at BETWEEN ? AND ?
         GROUP BY day,hour HAVING day IS NOT NULL ORDER BY day,hour`,
        WSTART,
        WEND
      )
    );
    const hkeys = ["day", "hour", "human", "agent"];
    assert.deepEqual(norm(newHeatmap, hkeys), norm(oldHeatmap, hkeys));
    assert.ok(oldHeatmap.length > 0, "expected some heatmap cells");

    // Autonomy: old json_each vs new table.
    const oldAuto = await prisma.read((r) =>
      r.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT strftime('%Y-%m-%d',t.ts,'localtime') AS day,
                COUNT(*) FILTER (WHERE (t.role='assistant' OR (t.role='human' AND t.headless=1))) AS agent,
                COUNT(*) AS total
         FROM (${turnsOracle(ph)}) t
         WHERE t.ts IS NOT NULL AND t.role IN ('human','assistant')
         GROUP BY day HAVING day IS NOT NULL ORDER BY day`,
        ...ids
      )
    );
    const newAuto = await prisma.read((r) =>
      r.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT strftime('%Y-%m-%d',b.ts,'localtime') AS day,
                SUM(CASE WHEN b.turn_kind='agent' THEN b.turn_count ELSE 0 END) AS agent,
                SUM(b.turn_count) AS total
         FROM session_turn_bucket b JOIN sessions s ON s.id=b.session_id
         WHERE s.started_at IS NOT NULL AND s.started_at BETWEEN ? AND ?
         GROUP BY day HAVING day IS NOT NULL ORDER BY day`,
        WSTART,
        WEND
      )
    );
    const akeys = ["day", "agent", "total"];
    assert.deepEqual(norm(newAuto, akeys), norm(oldAuto, akeys));

    // Idempotency: rebuilding again yields the same buckets (DELETE-then-INSERT).
    await prisma.write((client) =>
      client.$transaction((tx) => rebuildSessionTurnBuckets(tx, ids))
    );
    const [{ c }] = await prisma.read((r) =>
      r.$queryRawUnsafe<{ c: number }[]>(
        "SELECT COUNT(*) AS c FROM session_turn_bucket"
      )
    );
    // s-cli: (human@10:15)=1 human + (assistant@10:16)=1 agent(count2); s-sdk:
    // human@09:00 -> agent + assistant@09:05 -> agent (2 rows); s-exec: 1 agent.
    assert.equal(Number(c), 5);
  } finally {
    await close();
  }
});

test("backfill is race-free: ingest populating one session does not strand the rest", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // Two historical sessions with human/assistant turns.
    await prisma.write(async (client) => {
      for (const id of ["old-a", "old-b"]) {
        await client.$executeRawUnsafe(
          "INSERT INTO sessions (id, status, started_at, ended_at, metadata) VALUES ($1,$2,$3,$4,$5)",
          id,
          "completed",
          "2026-07-01T00:00:00Z",
          "2026-07-01T01:00:00Z",
          JSON.stringify({
            entrypoint: "cli",
            messages: [{ role: "human", timestamp: "2026-07-01T10:00:00Z" }],
          })
        );
      }
    });

    // Simulate a live ingest winning the race against boot backfill: it rolls up
    // only old-a, populating that session's buckets before backfill runs. A
    // whole-table COUNT>0 gate would now skip backfill entirely and strand old-b.
    await prisma.write((client) =>
      client.$transaction((tx) => rebuildSessionTurnBuckets(tx, ["old-a"]))
    );
    const before = await prisma.read((r) =>
      r.$queryRawUnsafe<{ session_id: string }[]>(
        "SELECT DISTINCT session_id FROM session_turn_bucket ORDER BY session_id"
      )
    );
    assert.deepEqual(
      before.map((b) => b.session_id),
      ["old-a"]
    );

    await backfillSessionTurnBuckets(prisma, () => undefined);

    // old-b must now be backfilled despite old-a already being present.
    const after = await prisma.read((r) =>
      r.$queryRawUnsafe<{ session_id: string }[]>(
        "SELECT DISTINCT session_id FROM session_turn_bucket ORDER BY session_id"
      )
    );
    assert.deepEqual(
      after.map((b) => b.session_id),
      ["old-a", "old-b"]
    );
  } finally {
    await close();
  }
});
