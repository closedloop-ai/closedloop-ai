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
import { test } from "vitest";
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
  // ISS-6885: the two drop channels stay separate. Only `{ not json` is
  // MALFORMED; blank lines are not lines at all. `5`, `null`, and the two
  // `mystery_event` records decoded fine and were dropped for carrying nothing
  // this parser can route — conflating those with corruption would make a
  // healthy file look damaged, but leaving them in NO bucket is what let a
  // lossy parse certify itself clean.
  assert.deepEqual(parsed.parseQuality, {
    totalLines: 6,
    malformedLines: 1,
    truncatedFinalLine: false,
    unknownRecords: 4,
  });
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

/**
 * ISS-6885. Every count `parseCliEventFile` reports is a SURVIVORS-ONLY tally:
 * a line that fails `JSON.parse` is skipped, and nothing else in the returned
 * session moves. So a corrupt `events.jsonl` renders with complete-looking
 * message, token, tool, and error totals and no trace of what it lost —
 * unknown facts presenting as true zeroes. `parseQuality` is that trace, and it
 * must separate mid-file corruption from the benign torn tail of a session
 * still being written.
 */
const CLEAN_TAIL = JSON.stringify({
  type: "assistant_message",
  timestamp: T2,
  payload: { text: "a1" },
});

/** Write pre-rendered JSONL lines verbatim, so a malformed line stays malformed. */
function writeRawCliLines(lines: readonly string[]): string {
  const filePath = path.join(
    makeTempDir("copilot-cli-quality-"),
    "events.jsonl"
  );
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

test("a malformed MIDDLE CLI line is counted in parseQuality, not silently dropped", async () => {
  // The ticket's reproduction: valid, malformed, valid. The malformed line
  // carried a user message, a tool call, an API error, and the turn's real
  // token usage — every one of which vanishes from the totals below.
  const filePath = writeRawCliLines([
    JSON.stringify({
      type: "user_message",
      timestamp: T0,
      payload: { text: "u1" },
    }),
    JSON.stringify({
      type: "usage",
      timestamp: T0,
      payload: { usage: { input_tokens: 7, output_tokens: 9 } },
    }),
    '{"type":"user_message","timestamp":"2026-03-09T16:00:30.000Z","payload":{"text":"lost',
    CLEAN_TAIL,
  ]);
  const parsed = requireSession(
    await parseCliEventFile(filePath, "malformed-middle"),
    "CLI malformed-middle"
  );

  // The surviving facts still parse — a corrupt line is skipped, never fatal.
  assert.equal(parsed.userMessages, 1);
  assert.equal(parsed.assistantMessages, 1);
  assert.deepEqual(
    parsed.messages.map((m) => m.text),
    ["u1", "a1"]
  );

  // ...and the evidence of the discarded record survives with them.
  assert.deepEqual(parsed.parseQuality, {
    totalLines: 4,
    malformedLines: 1,
    truncatedFinalLine: false,
  });
  // The final line parsed, so every malformed line is mid-file corruption.
  assert.equal(
    (parsed.parseQuality?.malformedLines ?? 0) -
      (parsed.parseQuality?.truncatedFinalLine ? 1 : 0),
    1,
    "one genuinely corrupt line, not a benign torn tail"
  );
});

test("a malformed FINAL CLI line reads as a truncated tail, not corruption", async () => {
  // The same one dropped line, in the position that makes it benign: a session
  // still being written. Consumers must be able to tell these two files apart,
  // and `malformedLines` alone cannot.
  const filePath = writeRawCliLines([
    JSON.stringify({
      type: "user_message",
      timestamp: T0,
      payload: { text: "u1" },
    }),
    CLEAN_TAIL,
    '{"type":"usage","timestamp":"2026-03-09T16:01:30.000Z","payload":{"usage":{"input_to',
  ]);
  const parsed = requireSession(
    await parseCliEventFile(filePath, "truncated-tail"),
    "CLI truncated-tail"
  );

  assert.deepEqual(parsed.parseQuality, {
    totalLines: 3,
    malformedLines: 1,
    truncatedFinalLine: true,
  });
  assert.equal(
    (parsed.parseQuality?.malformedLines ?? 0) -
      (parsed.parseQuality?.truncatedFinalLine ? 1 : 0),
    0,
    "an in-progress write is not corruption"
  );
});

test("a clean CLI file reports a clean parse — a true zero, distinguishable from an absent signal", async () => {
  // The counterpart the two cases above need: `malformedLines: 0` must mean
  // "nothing was dropped", so a positive count is never ambiguous. Blank lines
  // are skipped without inflating totalLines.
  const filePath = writeRawCliLines([
    JSON.stringify({
      type: "user_message",
      timestamp: T0,
      payload: { text: "u1" },
    }),
    "",
    "   ",
    CLEAN_TAIL,
  ]);
  const parsed = requireSession(
    await parseCliEventFile(filePath, "clean"),
    "CLI clean"
  );

  assert.deepEqual(parsed.parseQuality, {
    totalLines: 2,
    malformedLines: 0,
    truncatedFinalLine: false,
  });
});

test("an events.jsonl whose every line is malformed still parses to null — the signal has nowhere to land", async () => {
  // Pins a LIMIT of this change rather than a feature. `parseCliEventFile`
  // returns null when no event supplied a timestamp, and a wholly-corrupt file
  // supplies none — so total corruption is reported as "no session", the same
  // as an empty file, and the scan's counts are discarded with it. Partial
  // corruption (the cases above) is what now carries evidence.
  //
  // Whether a wholly-corrupt file should instead import as a minimal session
  // carrying only `parseQuality` — the way `parseChatSessionFile` falls back to
  // file mtime — changes what a user sees in their session list, so it is a
  // product call and is deliberately NOT decided here.
  const filePath = writeRawCliLines([
    '{"type":"user_message","timestamp":"2026-03-09T16:00:00.000Z","payload":{"text":"lo',
    '{"type":"assistant_message","timestamp":"2026-03-09T16:00:3',
  ]);
  assert.equal(await parseCliEventFile(filePath, "all-malformed"), null);
});

test("an unrecognized CLI event type is counted, not silently dropped into a clean parse", async () => {
  // The channel `malformedLines` cannot see. Every line here is valid JSON, so
  // a malformed-only signal reports a perfect parse — while the two records the
  // alias table does not know have already widened the session window and then
  // had their content discarded. A newer Copilot CLI emitting a type this build
  // predates is exactly this shape.
  const parsed = await parseCliOk([
    { type: "user_message", timestamp: T0, payload: { text: "u1" } },
    { type: "quota_warning", timestamp: T1, payload: { remaining: 3 } },
    { type: "checkpoint_saved", timestamp: T2, payload: { id: "c1" } },
  ]);

  assert.equal(parsed.userMessages, 1);
  assert.deepEqual(parsed.parseQuality, {
    totalLines: 3,
    malformedLines: 0,
    truncatedFinalLine: false,
    unknownRecords: 2,
  });
});

test("a fully-recognized CLI file OMITS unknownRecords rather than reporting zero", async () => {
  // Absent, not `0`: the key is additive and only appears when something was
  // actually dropped, so a clean session's metadata blob is byte-identical to a
  // pre-ISS-6885 one and no golden snapshot or re-sync is provoked by it.
  const parsed = await parseCliOk([
    { type: "user_message", timestamp: T0, payload: { text: "u1" } },
    { type: "assistant_message", timestamp: T1, payload: { text: "a1" } },
  ]);

  assert.deepEqual(parsed.parseQuality, {
    totalLines: 2,
    malformedLines: 0,
    truncatedFinalLine: false,
  });
  assert.equal(
    Object.hasOwn(parsed.parseQuality ?? {}, "unknownRecords"),
    false
  );
});

/**
 * ISS-8565: the CLI assembler folded `acc.model` onto a plain `{}`, so a CLI
 * stream whose session model was literally `__proto__` lost its entire token
 * aggregate. Same defect as the chat assembler, a separate sink.
 */
test("CLI tokensByModel keeps a __proto__ session model (ISS-8565)", async () => {
  const parsed = await parseCliOk([
    { type: "session_start", timestamp: T0, payload: { model: "__proto__" } },
    {
      type: "usage",
      timestamp: T1,
      payload: { usage: { input_tokens: 1000, output_tokens: 500 } },
    },
  ]);

  assert.deepEqual(Object.keys(parsed.tokensByModel), ["__proto__"]);
  // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
  assert.equal(parsed.tokensByModel.__proto__?.input, 1000);
  assert.equal(Object.getPrototypeOf(parsed.tokensByModel), Object.prototype);
});
