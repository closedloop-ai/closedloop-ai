/**
 * @file session-analytics-population-split.test.ts
 * @description ISS-7737 — the parent-only turn count and the subagent-folded
 * token rollup, proven on the row that PERSISTS THEM SIDE BY SIDE rather than
 * at the parser boundary.
 *
 * The parser-level cases live in `claude-turn-rollup-coherence.test.ts`. They
 * stop at `parseSessionFile()` and assert `NormalizedSession` fields, so they
 * cannot see `session_analytics` — the row that carries `agent_turns` and the
 * four token columns in one tuple, and the row every "per-turn" reading of this
 * session is taken from. Nothing there constrains this SQL: a regression that
 * switched `agent_turns` onto the folded population (the round-trip count, the
 * `token_usage` row count, `$.tokenSeries`) leaves every parser-level case
 * green, because the parse it asserts against never changed.
 *
 * So this drives the real path — `parseSessionFile` → `importSession` → the
 * analytics rollup — and reads the stored row once: `agent_turns` must equal
 * the PARENT transcript's own billable turn count, while the token columns must
 * equal the totals folded across every `subagents/agent-*.jsonl`. The fixture
 * makes those two populations different numbers on purpose, so neither
 * assertion can be satisfied by the other's value.
 *
 * Fixture pattern follows the sibling persisted-boundary suite
 * `sentinel-human-turn-rollup.test.ts`: an ephemeral on-disk SQLite store built
 * by the production migration runner via `openTestDb`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { parseSessionFile as parseClaudeFile } from "../src/main/collectors/claude/claude-parser.js";
import { Harness } from "../src/main/collectors/types.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { writeClaudeTranscript } from "./normalized-session-test-utils.js";

const SESSION_ID = "iss-7737-population-split";
const MODEL = "claude-opus-4-5";
const INPUT_PER_ROUND_TRIP = 10;
const OUTPUT_PER_ROUND_TRIP = 20;
const CACHE_READ_PER_ROUND_TRIP = 200_000;
const CACHE_WRITE_PER_ROUND_TRIP = 1000;
const PARENT_ROUND_TRIPS = 2;
const SUBAGENT_FILES = 3;
const RECORDS_PER_SUBAGENT_FILE = 4;
const FOLDED_ROUND_TRIPS =
  PARENT_ROUND_TRIPS + SUBAGENT_FILES * RECORDS_PER_SUBAGENT_FILE;

/** SQLite hands these back as BigInt; the reader coerces once. */
type RawAnalyticsRow = {
  agent_turns: number | bigint;
  input_tokens: number | bigint;
  output_tokens: number | bigint;
  cache_read_tokens: number | bigint;
  cache_write_tokens: number | bigint;
};

/** One billable assistant round-trip, uniquely keyed so dedup keeps it. */
function assistantRecord(id: string, minute: number): unknown {
  return {
    type: "assistant",
    timestamp: `2026-08-16T10:${String(minute).padStart(2, "0")}:00.000Z`,
    uuid: `uuid-${id}`,
    requestId: `req-${id}`,
    message: {
      id: `msg-${id}`,
      model: MODEL,
      usage: {
        input_tokens: INPUT_PER_ROUND_TRIP,
        output_tokens: OUTPUT_PER_ROUND_TRIP,
        cache_read_input_tokens: CACHE_READ_PER_ROUND_TRIP,
        cache_creation_input_tokens: CACHE_WRITE_PER_ROUND_TRIP,
      },
      content: [{ type: "text", text: id }],
    },
  };
}

/** The 795c67ae shape in miniature: a small parent, several subagent FILES. */
function delegatingSubagentFiles(): Record<string, unknown[]> {
  const files: Record<string, unknown[]> = {};
  for (let file = 0; file < SUBAGENT_FILES; file++) {
    files[`f${file}`] = Array.from(
      { length: RECORDS_PER_SUBAGENT_FILE },
      (_, index) => assistantRecord(`s${file}-${index}`, 20 + index)
    );
  }
  return files;
}

test("ISS-7737: session_analytics stores parent-only agent_turns beside the subagent-folded token totals", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "iss7737-population-split-")
  );
  const db = await openTestDb(dir);
  try {
    const filePath = writeClaudeTranscript(
      SESSION_ID,
      [
        { type: "user", timestamp: "2026-08-16T10:00:00.000Z", cwd: "/test" },
        assistantRecord("p1", 1),
        assistantRecord("p2", 2),
      ],
      { subagents: delegatingSubagentFiles() }
    );

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "transcript must parse");
    // The fixture must actually delegate, or the persisted assertions below
    // would agree for the trivial reason that the two populations coincide.
    assert.equal(
      parsed.assistantMessages,
      PARENT_ROUND_TRIPS,
      "the parse states the parent transcript's own turn count"
    );
    assert.equal(
      parsed.tokenSeries.length,
      FOLDED_ROUND_TRIPS,
      "the parse folded every subagent round-trip into the token population"
    );

    await db.importer.importSession(parsed, Harness.Claude);

    const [raw] = await db.prisma.client.$queryRawUnsafe<RawAnalyticsRow[]>(
      `SELECT agent_turns, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
       FROM session_analytics WHERE session_id = $1`,
      SESSION_ID
    );
    assert.ok(raw, "session_analytics row must exist after import");
    const row = {
      agentTurns: Number(raw.agent_turns),
      inputTokens: Number(raw.input_tokens),
      outputTokens: Number(raw.output_tokens),
      cacheReadTokens: Number(raw.cache_read_tokens),
      cacheWriteTokens: Number(raw.cache_write_tokens),
    };

    // The split, on the persisted row. `agent_turns` is the PARENT transcript's
    // own count and must not move when subagent transcripts are folded in.
    assert.equal(
      row.agentTurns,
      PARENT_ROUND_TRIPS,
      "agent_turns must stay the parent transcript's own turn count"
    );
    // ...while all four token columns span the folded population.
    assert.equal(
      row.inputTokens,
      FOLDED_ROUND_TRIPS * INPUT_PER_ROUND_TRIP,
      "input_tokens spans parent + every folded subagent round-trip"
    );
    assert.equal(
      row.outputTokens,
      FOLDED_ROUND_TRIPS * OUTPUT_PER_ROUND_TRIP,
      "output_tokens spans parent + every folded subagent round-trip"
    );
    assert.equal(
      row.cacheReadTokens,
      FOLDED_ROUND_TRIPS * CACHE_READ_PER_ROUND_TRIP,
      "cache_read_tokens spans parent + every folded subagent round-trip"
    );
    assert.equal(
      row.cacheWriteTokens,
      FOLDED_ROUND_TRIPS * CACHE_WRITE_PER_ROUND_TRIP,
      "cache_write_tokens spans parent + every folded subagent round-trip"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
