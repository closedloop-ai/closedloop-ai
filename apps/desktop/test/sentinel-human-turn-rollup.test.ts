/**
 * @file sentinel-human-turn-rollup.test.ts
 * @description FEA-3595 — the `<<autonomous-loop-dynamic>>` sentinel exclusion,
 * proven through the PERSISTED consumer path rather than at the parser boundary.
 *
 * The parser-level cases live in
 * `packages/lib/harness/claude/parse-claude-sentinel.test.ts`. Those assert
 * `NormalizedSession.messages` only — they cannot prove that the exclusion
 * actually reaches `session_analytics`, which is the row every "human vs agent"
 * metric reads and the row the bug was reported against (a wg-review worker
 * stored with `is_human = 1`). This test runs the real transcript through
 * `parseClaudeTranscript` → `importSession` → the analytics rollup and asserts
 * the stored `human_turns` / `is_human`.
 *
 * The rollup derives human turns transcript-first from `$.messages` (FEA-2641),
 * so a sentinel firing the parser failed to exclude would surface here as
 * `human_turns >= 1`. Against the pre-FEA-3595 parser these assertions fail:
 * the resolved sentinel text was counted as a genuine human turn.
 *
 * Runs against an ephemeral on-disk SQLite store created by the production
 * migration runner (via openTestDb). Run: `node --import tsx --test <file>`.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseClaudeTranscript } from "@repo/lib/harness/claude/parse-claude-core";
import { Harness } from "../src/main/collectors/types.js";
import { openTestDb } from "./agent-db-test-utils.js";

const SESSION_ID = "fea-3595-sentinel-rollup";

/**
 * A scripted wg-review-shaped session: no typed human prompt anywhere. Two
 * `/loop` sentinel wake-ups are scheduled and both fire, each resolving to
 * different text than the recorded `<<autonomous-loop-dynamic>>` prompt.
 */
function sentinelTranscriptLines(sessionId: string): string[] {
  return [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-20T08:00:00.000Z",
      sessionId,
      cwd: "/home/dev/proj",
      message: {
        model: "claude-opus-4-5",
        content: [
          {
            type: "tool_use",
            id: "toolu_rollup_sentinel_1",
            name: "ScheduleWakeup",
            input: { prompt: "<<autonomous-loop-dynamic>>" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-06-20T08:05:00.000Z",
      sessionId,
      message: {
        role: "user",
        content:
          "Resolved autonomous-loop instructions for iteration one — nothing the sentinel literal matches.",
      },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-20T08:05:01.000Z",
      sessionId,
      message: {
        model: "claude-opus-4-5",
        content: [
          {
            type: "tool_use",
            id: "toolu_rollup_sentinel_2",
            name: "ScheduleWakeup",
            input: { prompt: "<<autonomous-loop-dynamic>>" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-06-20T08:10:00.000Z",
      sessionId,
      message: {
        role: "user",
        content: "Resolved autonomous-loop instructions for iteration two.",
      },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-20T08:10:30.000Z",
      sessionId,
      message: {
        model: "claude-opus-4-5",
        content: [{ type: "text", text: "Loop iteration complete." }],
      },
    }),
  ];
}

test("FEA-3595: a fully scripted sentinel session persists human_turns=0 and is_human=0", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea3595-sentinel-rollup-"));
  const db = await openTestDb(dir);
  try {
    const session = await parseClaudeTranscript(
      sentinelTranscriptLines(SESSION_ID),
      { sessionId: SESSION_ID }
    );
    assert.ok(session, "transcript must parse");

    // Parser boundary: both sentinel firings excluded from human messages.
    assert.equal(
      session.userMessages,
      0,
      "no genuine human turns in the parse"
    );

    await db.importer.importSession(session, Harness.Claude);

    const [row] = await db.prisma.client.$queryRawUnsafe<
      { human_turns: number; is_human: number }[]
    >(
      "SELECT human_turns, is_human FROM session_analytics WHERE session_id = $1",
      SESSION_ID
    );
    assert.ok(row, "session_analytics row must exist after import");
    assert.equal(
      row.human_turns,
      0,
      "scripted sentinel firings must not be credited as human turns"
    );
    assert.equal(
      row.is_human,
      0,
      "a scripted worker must never reach the is_human threshold"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3595: a real typed prompt in the same session still persists as a human turn", async () => {
  // Guards the inverse: the exclusion must be scoped to the sentinel firings,
  // not a blanket suppression that would under-count real human sessions.
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea3595-sentinel-mixed-"));
  const db = await openTestDb(dir);
  const sessionId = `${SESSION_ID}-mixed`;
  try {
    const lines = sentinelTranscriptLines(sessionId);
    lines.push(
      JSON.stringify({
        type: "user",
        timestamp: "2026-06-20T08:20:00.000Z",
        sessionId,
        message: {
          role: "user",
          content: "Stop the loop and summarize what you changed.",
        },
      })
    );

    const session = await parseClaudeTranscript(lines, { sessionId });
    assert.ok(session, "transcript must parse");
    assert.equal(
      session.userMessages,
      1,
      "exactly the one typed prompt counts"
    );

    await db.importer.importSession(session, Harness.Claude);

    const [row] = await db.prisma.client.$queryRawUnsafe<
      { human_turns: number; is_human: number }[]
    >(
      "SELECT human_turns, is_human FROM session_analytics WHERE session_id = $1",
      sessionId
    );
    assert.ok(row, "session_analytics row must exist after import");
    assert.equal(
      row.human_turns,
      1,
      "the typed prompt is a genuine human turn"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
