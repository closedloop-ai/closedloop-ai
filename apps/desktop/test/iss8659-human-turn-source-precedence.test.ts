/**
 * @file iss8659-human-turn-source-precedence.test.ts
 * @description ISS-8659 — which field `session_analytics.human_turns` derives
 * from, proven on the stored row.
 *
 * `transcriptHumanTurnsSql` reads the parser's own `$.userMessages` scalar and
 * keeps the `role:"human"` count over `$.messages` as a FALLBACK. Before this
 * ticket it only ever counted the array, which was correct until a session
 * existed whose rendered conversation and whose tally legitimately differ — a
 * Claude `/fork` child, which keeps the parent's replayed messages so session
 * detail does not open mid-thread, but must not be credited with the parent's
 * turns.
 *
 * The golden corpus covers the fork arm end to end (Layer 2 on `aff9f567`, whose
 * oracle says 1 while its `$.messages` holds 4 human rows). It cannot cover the
 * FALLBACK arm: every dossier's `normalized.json` carries `userMessages`, so no
 * frozen input reaches the second branch. A persisted row written before that
 * field existed does, and a persisted row is a real trust boundary — hence the
 * seeded blobs here rather than a parse.
 *
 * Seeds raw metadata directly and runs the production rollup, because the point
 * is precedence BETWEEN two sources in one blob; an importer-written blob can
 * never carry the disagreeing pair.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { upsertSessionAnalyticsRollup } from "../src/main/database/session-analytics-rollup.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { ROLLUP_OPTS } from "./rollup-options-test-utils.js";

const NOW = "2026-09-02T12:00:00.000Z";
const TS = "2026-09-02T11:00:00.000Z";

/** Three human-role messages, as a `/fork` child's rendered conversation. */
const THREE_HUMAN_MESSAGES = [
  { role: "human", timestamp: TS, text: "the parent's first prompt" },
  { role: "human", timestamp: TS, text: "the parent's second prompt" },
  { role: "human", timestamp: TS, text: "the fork's own prompt" },
];

async function rollupHumanTurns(
  metadata: string
): Promise<{ humanTurns: number; isHuman: number }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss8659-human-turns-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => NOW,
  });
  try {
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, ended_at, updated_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      "iss8659-precedence",
      "completed",
      "claude_code",
      TS,
      TS,
      NOW,
      metadata
    );
    await db.prisma.write((client) =>
      client.$transaction(async (tx) => {
        await upsertSessionAnalyticsRollup(
          tx,
          "iss8659-precedence",
          NOW,
          ROLLUP_OPTS
        );
      })
    );
    const [row] = await db.prisma.client.$queryRawUnsafe<
      { human_turns: number; is_human: number }[]
    >(
      "SELECT human_turns, is_human FROM session_analytics WHERE session_id = $1",
      "iss8659-precedence"
    );
    if (!row) {
      // A throw, not an assertion: this is setup failing, not the contract
      // under test, and an assertion here would sit outside any test() call.
      throw new Error("session_analytics row missing after the rollup");
    }
    return {
      humanTurns: Number(row.human_turns),
      isHuman: Number(row.is_human),
    };
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("ISS-8659: userMessages WINS over the $.messages human count", async () => {
  // The fork shape: three human messages rendered, one of them the fork's own.
  const { humanTurns, isHuman } = await rollupHumanTurns(
    JSON.stringify({ userMessages: 1, messages: THREE_HUMAN_MESSAGES })
  );
  assert.equal(
    humanTurns,
    1,
    "the parser's own count must win; counting the rendered array credits the fork with the parent's turns"
  );
  // Not incidental: the threshold is 2, so counting the array also FLIPS the
  // session's human/agent classification, not just a number on a chart.
  assert.equal(
    isHuman,
    0,
    "one genuine human turn is below the threshold, so the fork is not a human session"
  );
});

test("ISS-8659: a blob with no userMessages still counts $.messages", async () => {
  // A row persisted before `userMessages` existed. Dropping the fallback would
  // silently zero every such session's human turns and reclassify it as agent.
  const { humanTurns, isHuman } = await rollupHumanTurns(
    JSON.stringify({ messages: THREE_HUMAN_MESSAGES })
  );
  assert.equal(humanTurns, 3, "the legacy array count must still be reached");
  assert.equal(isHuman, 1, "three human turns clears the threshold");
});

test("ISS-8659: a non-numeric userMessages falls through, it does not win", async () => {
  // `validCountPredicateSql` gates the branch on a bounded non-negative integer.
  // A corrupt scalar must degrade to the array count rather than being coerced
  // to 0 human turns.
  const { humanTurns } = await rollupHumanTurns(
    JSON.stringify({ userMessages: "1", messages: THREE_HUMAN_MESSAGES })
  );
  assert.equal(
    humanTurns,
    3,
    "a string scalar is not a count; the fallback must carry it"
  );
});

test("ISS-8659: a FRACTIONAL userMessages falls through, it does not win", async () => {
  // The half of the impossible set the old `IN ('integer','real')` let through.
  // `real` is exactly what a fractional count types as, so 1.5 turns was
  // accepted and persisted as the authoritative human_turns — a measurement no
  // transcript can produce, rendered as if it had been counted.
  const { humanTurns } = await rollupHumanTurns(
    JSON.stringify({ userMessages: 1.5, messages: THREE_HUMAN_MESSAGES })
  );
  assert.equal(
    humanTurns,
    3,
    "a fractional count is corrupt, not a measurement; the fallback must carry it"
  );
});

test("ISS-8659: a NEGATIVE userMessages falls through, it does not win", async () => {
  // The other half, and the one neither `integer` nor `real` ever excluded:
  // both type checks are unsigned, so -3 turns passed as readily as 3.
  const { humanTurns } = await rollupHumanTurns(
    JSON.stringify({ userMessages: -3, messages: THREE_HUMAN_MESSAGES })
  );
  assert.equal(
    humanTurns,
    3,
    "a negative count is corrupt, not a measurement; the fallback must carry it"
  );
});

test("ISS-8659: a legitimate zero still WINS over the array", async () => {
  // The boundary the bound must not eat. A fork whose own turn count is
  // genuinely 0 is the exact session this ticket exists for, and rejecting 0
  // would send it to the array and re-credit it with every parent prompt.
  const { humanTurns } = await rollupHumanTurns(
    JSON.stringify({ userMessages: 0, messages: THREE_HUMAN_MESSAGES })
  );
  assert.equal(
    humanTurns,
    0,
    "zero is a measured count, not a missing one; it must win over the fallback"
  );
});

test("ISS-8659: the $.messages FALLBACK also skips a fork's replayed turns", async () => {
  // The docblock argues $.messages is the wrong basis for a fork, and then this
  // arm counted it unfiltered anyway. It is narrow -- it needs a userMessages
  // that is absent or corrupt -- but on a fork that combination handed back the
  // inflated array count, which is worse than the NULL that lets the caller
  // fall back. Two of the three human rows here are the parent's.
  const { humanTurns } = await rollupHumanTurns(
    JSON.stringify({
      messages: [
        { role: "human", timestamp: TS, text: "parent", isForkReplayed: true },
        { role: "human", timestamp: TS, text: "parent", isForkReplayed: true },
        { role: "human", timestamp: TS, text: "the fork's own" },
      ],
    })
  );
  assert.equal(
    humanTurns,
    1,
    "the fallback must count only the fork's own turns, not the inherited conversation"
  );
});

test("ISS-8659: only JSON `true` is the flag — a numeric 1 is an ordinary turn", async () => {
  // `json_extract` collapses JSON `true` and JSON `1` to the same integer, so a
  // predicate written on the extracted VALUE cannot tell them apart and drops a
  // numeric 1 as if it were the flag. This arm exists to read blobs written by a
  // producer this build does not control, which is exactly where a `1` would come
  // from, so the predicate tests the JSON TYPE instead. Strict `=== true`, the
  // same contract the TypeScript predicate and the Postgres twin hold.
  const { humanTurns } = await rollupHumanTurns(
    JSON.stringify({
      messages: [
        { role: "human", timestamp: TS, text: "own", isForkReplayed: 1 },
        { role: "human", timestamp: TS, text: "own", isForkReplayed: 0 },
        { role: "human", timestamp: TS, text: "own", isForkReplayed: "true" },
        { role: "human", timestamp: TS, text: "own", isForkReplayed: null },
        {
          role: "human",
          timestamp: TS,
          text: "the one real replay",
          isForkReplayed: true,
        },
      ],
    })
  );
  assert.equal(
    humanTurns,
    4,
    "every non-boolean spelling counts as an own turn; only the literal true is excluded"
  );
});
