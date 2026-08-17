/**
 * @file copilot-cli-event-parser.test.ts
 * @description Branch-coverage suite for the Copilot **CLI** entrypoint,
 * `parseCliEventFile` (ISS-5302). Split out of `copilot-parser-edges.test.ts`,
 * which owns the chat entrypoints (`parseChatSessionFile` /
 * `parseChatSessionFileGated`): this drives a different exported function over
 * a different on-disk format (JSONL event stream, not a session JSON), and
 * keeping the two apart means neither file is born near the 1,000-logical-line
 * ceiling root `AGENTS.md` sets.
 *
 * Every fixture timestamp is an epoch number or a `Z`-suffixed ISO string, and
 * every asserted timestamp is a `Date#toISOString()` result, so no assertion in
 * this file depends on the host timezone — hence no `process.env.TZ` pin.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseCliEventFile } from "../src/main/collectors/copilot/copilot-parser.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { makeTempDir, writeJsonl } from "./normalized-session-test-utils.js";

type Json = Record<string, unknown>;

const T0 = "2026-03-09T16:00:00.000Z";
const T1 = "2026-03-09T16:00:30.000Z";
const T2 = "2026-03-09T16:01:00.000Z";

/** Write a Copilot CLI JSONL event stream into a fresh temp dir. */
function writeCliEvents(lines: readonly unknown[]): string {
  return writeJsonl(makeTempDir("copilot-cli-edges-"), "events.jsonl", lines);
}

/**
 * Narrow a parse result the caller requires to be a session. Throws rather than
 * asserting so the fixture builders stay assertion-free — every assertion in
 * this file belongs to a `test()` body.
 */
function requireSession(
  parsed: NormalizedSession | null,
  what: string
): NormalizedSession {
  if (parsed === null) {
    throw new Error(`expected ${what} to parse into a session, got null`);
  }
  return parsed;
}

async function parseCliOk(
  lines: readonly unknown[],
  sessionId = "cli-edge"
): Promise<NormalizedSession> {
  const parsed = await parseCliEventFile(writeCliEvents(lines), sessionId);
  return requireSession(parsed, "CLI");
}

/** Stamp each event with a distinct ISO timestamp, one second apart. */
function stamped(events: readonly Json[]): Json[] {
  return events.map((event, index) => ({
    timestamp: `2026-03-09T16:00:${String(index).padStart(2, "0")}.000Z`,
    ...event,
  }));
}

test("CLI parse returns null when no event ever carried a timestamp, and for an empty file", async () => {
  const noTs = writeCliEvents([{ type: "user_message", payload: { t: "x" } }]);
  assert.equal(await parseCliEventFile(noTs, "no-ts"), null);
  const empty = path.join(makeTempDir("copilot-cli-edges-"), "events.jsonl");
  writeFileSync(empty, "", "utf8");
  assert.equal(await parseCliEventFile(empty, "empty"), null);
});

test("the CLI reader skips blanks, bad JSON, non-object records and unknown types — but an unknown type still bounds the window", async () => {
  const filePath = path.join(makeTempDir("copilot-cli-edges-"), "events.jsonl");
  const hi = { type: "user_message", timestamp: T1, payload: { text: "hi" } };
  writeFileSync(
    filePath,
    [
      "",
      "   ",
      "{ not json",
      "5",
      "null",
      JSON.stringify({ type: "mystery_event", timestamp: T0 }),
      JSON.stringify(hi),
      JSON.stringify({ type: "mystery_event", timestamp: T2 }),
    ].join("\n"),
    "utf8"
  );
  const parsed = requireSession(
    await parseCliEventFile(filePath, "skips"),
    "CLI skip"
  );
  assert.equal(parsed.userMessages, 1);
  assert.deepEqual(
    parsed.messages.map((m) => m.text),
    ["hi"]
  );
  // noteTimestamp runs BEFORE the handler lookup, so an unrecognized event type
  // still widens startedAt/endedAt even though it emits nothing else.
  assert.equal(parsed.startedAt, T0);
  assert.equal(parsed.endedAt, T2);
});

test("the CLI event-alias table routes every alias to its handler", async () => {
  const parsed = await parseCliOk(
    stamped([
      // "/" is not a meaningful cwd, and this event carries no version/model,
      // so the next session event supplies all three.
      { type: "session_start", payload: { cwd: "/" } },
      {
        type: "session_created",
        payload: {
          workdir: "/repos/cli project",
          cli_version: "1.2.3",
          model: "gpt-cli",
        },
      },
      // Already captured — this event must not overwrite anything.
      { type: "init", payload: { cwd: "/other", version: "9.9", model: "no" } },
      { type: "user_message", payload: { text: "u1" } },
      { type: "user_input", payload: { text: "u2" } },
      { type: "prompt", payload: { text: "u3" } },
      { type: "assistant_message", payload: { text: "a1" } },
      { type: "response", payload: { text: "a2" } },
      { type: "completion", payload: { text: "a3" } },
      { type: "tool_call", payload: { name: "a" } },
      { type: "function_call", payload: { tool: "b" } },
      { type: "command", payload: { command: "c" } },
      { type: "tool_result", payload: { name: "a", output: "A" } },
      { type: "function_result", payload: { tool: "b", result: "B" } },
      { type: "command_result", payload: { name: "c", content: "C" } },
      { type: "usage", payload: { usage: { input_tokens: 1 } } },
      { type: "token_count", payload: { usage: { input_tokens: 2 } } },
      {
        type: "metrics",
        payload: { usage: { input_tokens: 3, output_tokens: 4 } },
      },
      { type: "error", payload: { message: "e1" } },
      { type: "api_error", payload: { error: "e2" } },
      { type: "reasoning", payload: {} },
      { type: "thinking", payload: {} },
    ])
  );

  assert.equal(parsed.cwd, "/repos/cli project");
  assert.equal(parsed.name, "cli project");
  assert.equal(parsed.version, "1.2.3", "the cli_version alias, set once");
  assert.equal(parsed.model, "gpt-cli");
  assert.equal(parsed.userMessages, 3);
  assert.equal(parsed.assistantMessages, 3);
  assert.deepEqual(
    parsed.toolUses.map((t) => [t.name, t.output]),
    [
      ["a", "A"],
      ["b", "B"],
      ["c", "C"],
    ]
  );
  assert.equal(parsed.thinkingBlockCount, 2);
  assert.equal(
    parsed.messages.filter((m) => m.isThinking === true).length,
    2,
    "each reasoning alias emits a null-text thinking message"
  );
  assert.deepEqual(
    parsed.apiErrors.map((e) => [e.type, e.message]),
    [
      ["error", "e1"],
      ["api_error", "e2"],
    ]
  );
  // The three usage aliases REPLACE the running totals, so the last one wins.
  assert.deepEqual(parsed.tokensByModel["gpt-cli"], {
    input: 3,
    output: 4,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(parsed.tokenSeries.length, 3, "each usage event still appends");
});

test("CLI records read type/payload/timestamp through their aliases and fall back to the bare record", async () => {
  const parsed = await parseCliOk([
    { event: "user_message", ts: T0, data: { content: "via event/ts/data" } },
    { type: "assistant_message", created_at: T1, message: "via bare record" },
    { type: "prompt", timestamp: T2, payload: { body: "via extractText" } },
  ]);
  assert.deepEqual(
    parsed.messages.map((m) => m.text),
    ["via event/ts/data", "via bare record", "via extractText"]
  );
  assert.equal(parsed.startedAt, T0);
  assert.equal(parsed.endedAt, T2);
});

test("a CLI usage event replaces the totals, accepts an inline usage payload, and can retarget the model", async () => {
  const first = { usage: { input_tokens: 500, output_tokens: 500 } };
  const parsed = await parseCliOk([
    { type: "usage", timestamp: T0, payload: first },
    // No `usage` key: the payload IS the usage, and it names a model.
    {
      type: "usage",
      timestamp: T1,
      payload: { input_tokens: 7, model: "late" },
    },
  ]);
  assert.deepEqual(parsed.tokensByModel, {
    late: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  assert.equal(parsed.model, "late");
  assert.deepEqual(
    parsed.tokenSeries.map((r) => [r.model, r.input, r.output]),
    [
      ["copilot-default", 500, 500],
      ["late", 7, 0],
    ]
  );

  const zeroed = await parseCliOk([
    { type: "usage", timestamp: T0, payload: { usage: { input_tokens: 0 } } },
  ]);
  assert.deepEqual(zeroed.tokenSeries, [], "an all-zero usage appends nothing");
  assert.deepEqual(zeroed.tokensByModel, {});
});

test("CLI tool calls default their name, fall back to the session start for a missing timestamp, and ignore unmatched results", async () => {
  const parsed = await parseCliOk([
    { type: "tool_call", timestamp: T0, payload: {} },
    { type: "tool_call", payload: { name: "no_ts" } },
    {
      type: "tool_result",
      timestamp: T1,
      payload: { name: "nope", content: "x" },
    },
    { type: "tool_result", timestamp: T1, payload: { isError: true } },
    { type: "error", timestamp: T2, payload: {} },
  ]);
  assert.deepEqual(
    parsed.toolUses.map((t) => t.name),
    ["copilot_tool", "no_ts"]
  );
  assert.equal(
    parsed.toolUses[1].timestamp,
    T0,
    "a timestamp-less tool call inherits the session start"
  );
  assert.equal(parsed.toolUses[0].isError, true);
  assert.equal(
    parsed.toolUses[0].output,
    undefined,
    "an isError-only result sets the flag without inventing output"
  );
  assert.equal(
    parsed.toolUses.some((t) => t.output === "x"),
    false,
    "a result naming a tool that was never called is dropped"
  );
  assert.deepEqual(
    parsed.apiErrors.map((e) => [e.type, e.message]),
    [["error", "Copilot CLI error"]]
  );
});

test("CLI events fall back through their remaining alias arms", async () => {
  const parsed = await parseCliOk([
    // A session event with neither cwd nor workdir leaves cwd null.
    { type: "session_start", timestamp: T0, payload: { version: "2.0" } },
    // A record with neither type nor event stringifies to "" and is skipped.
    { timestamp: T0, payload: { text: "ignored" } },
    { type: "response", timestamp: T1, payload: { response: "via response" } },
    // None of the content/message/text/response keys: the payload itself.
    { type: "completion", timestamp: T1, payload: { body: "via payload" } },
    { type: "reasoning", timestamp: T1, payload: {} },
    { type: "usage", timestamp: T2, payload: { usage: { input_tokens: 9 } } },
  ]);
  assert.equal(parsed.cwd, null);
  assert.equal(parsed.version, "2.0");
  assert.equal(parsed.assistantMessages, 2);
  assert.deepEqual(
    parsed.messages.map((m) => m.text),
    ["via response", "via payload", null]
  );
  assert.equal(parsed.messages[2].isThinking, true);
  assert.equal(parsed.messages[2].isSynthetic, true, "no model resolves");
  // With no model anywhere the totals key on the synthetic default.
  assert.deepEqual(parsed.tokensByModel, {
    "copilot-default": { input: 9, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
});

test("CLI messages carry the per-event model and flag the synthetic fallback", async () => {
  const parsed = await parseCliOk(
    [
      { type: "prompt", timestamp: T0, payload: { text: "no model" } },
      {
        type: "user_message",
        timestamp: T1,
        payload: { text: "p", model: "mp" },
      },
      {
        type: "user_message",
        timestamp: T2,
        model: "mr",
        payload: { text: "r" },
      },
    ],
    "abcdefghijkl"
  );
  assert.deepEqual(
    parsed.messages.map((m) => [m.model, m.isSynthetic]),
    [
      [null, true],
      ["mp", undefined],
      ["mr", undefined],
    ]
  );
  assert.equal(parsed.name, "Copilot CLI abcdefgh", "id-derived name, no cwd");
  assert.equal(parsed.sessionId, "copilot-cli-abcdefghijkl");
});
