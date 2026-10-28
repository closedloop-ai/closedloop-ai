/**
 * @file codex-workflow-journal-token-parity.test.ts
 * @description ISS-12037: a Codex workflow journal's inner-agent spend must
 * reach `token_events` and `token_usage` at the same total. The two stores are
 * derived from one parse — the series feeds `token_events`, the aggregate feeds
 * `token_usage` — so a session that disagrees between them is a parse that
 * recorded the spend in only one of the two.
 *
 * Its own file rather than appended to `attribution-codex-parser.test.ts`,
 * which sits at the 1,000-logical-line ceiling.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { parseRolloutFile } from "../src/main/collectors/codex/codex-parser.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { writeRollout } from "./attribution-test-helpers.js";

const WORKFLOW_SESSION_ID = "44444444-4444-4444-8444-444444444444";

type TokenEventRow = {
  model: string;
  input_tokens: number | bigint;
  output_tokens: number | bigint;
  cache_read_tokens: number | bigint;
  cache_write_tokens: number | bigint;
};

test("Codex workflow journal spend reaches token_events and token_usage at the same total", async () => {
  // The rollout carries its OWN token_count events, which is what made this
  // reachable: the importer's aggregate fallback fires only for a session whose
  // tokenSeries is wholly empty, so the journal's spend reached token_usage
  // (read from tokensByModel) and was dropped from token_events.
  const filePath = writeRollout(
    `rollout-2026-05-18T10-30-00-${WORKFLOW_SESSION_ID}.jsonl`,
    [
      {
        timestamp: "2026-05-18T10:30:00.000Z",
        type: "session_meta",
        payload: { id: WORKFLOW_SESSION_ID, cwd: "/test" },
      },
      {
        timestamp: "2026-05-18T10:30:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-5-codex" },
      },
      {
        timestamp: "2026-05-18T10:30:05.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 500,
              cached_input_tokens: 100,
              output_tokens: 200,
              reasoning_output_tokens: 0,
            },
          },
          turn_context: { model: "gpt-5-codex" },
        },
      },
    ]
  );
  writeFileSync(
    path.join(path.dirname(filePath), "workflow-mixed.jsonl"),
    `${JSON.stringify({
      type: "usage",
      model: "gpt-5-codex",
      tokens_input: 10_000,
      tokens_output: 5000,
      tokens_cache_read: 70,
      tokens_cache_creation: 50,
      session_id: "workflow-inner-session",
    })}\n`,
    "utf8"
  );

  const parsed = await parseRolloutFile(filePath);
  assert.ok(parsed);
  assert.ok(
    parsed.tokenSeries.some((record) => record.model === "workflow-agent"),
    "the journal's spend is recorded in tokenSeries, not only in tokensByModel"
  );

  const dir = await mkdtemp(
    path.join(os.tmpdir(), "iss12037-workflow-sqlite-")
  );
  const db = await openTestDb(dir);

  try {
    const result = await db.importer.importSession(parsed, "codex");
    assert.equal(result.failed, undefined);

    const events = await db.prisma.client.$queryRawUnsafe<TokenEventRow[]>(
      `SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM token_events WHERE session_id = '${WORKFLOW_SESSION_ID}'`
    );
    const usage = await db.tokenUsage.getBySession(WORKFLOW_SESSION_ID);
    const eventTotal = events.reduce(
      (sum, row) =>
        sum +
        Number(row.input_tokens) +
        Number(row.output_tokens) +
        Number(row.cache_read_tokens) +
        Number(row.cache_write_tokens),
      0
    );
    const usageTotal = usage.reduce(
      (sum, row) =>
        sum +
        row.inputTokens +
        row.outputTokens +
        row.cacheReadTokens +
        row.cacheWriteTokens,
      0
    );
    assert.equal(
      eventTotal,
      usageTotal,
      `token_events total must equal token_usage total; got ${eventTotal} vs ${usageTotal} across ${JSON.stringify(events.map((row) => row.model))}`
    );
    const workflowEvents = events.filter(
      (row) => row.model === "workflow-agent"
    );
    assert.equal(
      workflowEvents.length,
      1,
      "exactly one workflow-agent token_events row — present, and not doubled"
    );
    assert.equal(Number(workflowEvents[0].input_tokens), 10_000);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
