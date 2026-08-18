/**
 * @file copilot-parser-edges.test.ts
 * @description Branch-coverage suite for the Copilot chat/CLI parser
 * (ISS-5302). `copilot-parser.ts` had no dedicated suite: the few existing
 * assertions live in `collectors-parsers.test.ts` (happy path + token shape),
 * `attribution-synthetic-fixtures.test.ts` (smoke + mtime fallback) and
 * `file-size-admission.test.ts` (the 64 MiB gate). Everything below drives the
 * two exported CHAT entrypoints — `parseChatSessionFile` and
 * `parseChatSessionFileGated` — over synthetic on-disk fixtures to reach the
 * private fallback chains, recursion cutoffs, alias tables and skip paths those
 * suites never touch. The third entrypoint, `parseCliEventFile`, has its own
 * owner in `copilot-cli-event-parser.test.ts`. Nothing here duplicates an
 * assertion that already exists elsewhere.
 *
 * Every fixture timestamp is an epoch number or a `Z`-suffixed ISO string, and
 * every asserted timestamp is a `Date#toISOString()` result, so no assertion in
 * this file depends on the host timezone — hence no `process.env.TZ` pin.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  parseChatSessionFile,
  parseChatSessionFileGated,
} from "../src/main/collectors/copilot/copilot-parser.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { makeTempDir } from "./normalized-session-test-utils.js";

type Json = Record<string, unknown>;

const T0 = "2026-03-09T16:00:00.000Z";
const T1 = "2026-03-09T16:00:30.000Z";
const T2 = "2026-03-09T16:01:00.000Z";
/** Minimal renderable request every single-request fixture is merged over. */
const BASE_REQUEST = { id: "r", timestamp: T0, message: { text: "q" } };

/** Write a Copilot chat session JSON into a fresh temp dir; returns the path. */
function writeChat(data: unknown, fileName = "session.json"): string {
  const filePath = path.join(makeTempDir("copilot-edges-"), fileName);
  writeFileSync(filePath, JSON.stringify(data), "utf8");
  return filePath;
}

function parseChat(
  data: unknown,
  workspacePath: string | null = "/workspace/proj"
): NormalizedSession | null {
  return parseChatSessionFile(writeChat(data), workspacePath);
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
  if (!parsed) {
    throw new Error(`expected the ${what} fixture to parse into a session`);
  }
  return parsed;
}

function parseChatOk(
  data: unknown,
  workspacePath: string | null = "/workspace/proj"
): NormalizedSession {
  return requireSession(parseChat(data, workspacePath), "chat");
}

/** Parse a one-request chat fixture; `req` merges over {@link BASE_REQUEST}. */
function parseRequest(req: Json, session: Json = {}): NormalizedSession {
  return parseChatOk({ requests: [{ ...BASE_REQUEST, ...req }], ...session });
}

/** Parse a chat fixture whose message array is supplied directly. */
function parseMessages(...messages: unknown[]): NormalizedSession {
  return parseChatOk({ messages });
}

/** Parse a chat fixture holding exactly one assistant message. */
function parseAssistant(message: Json): NormalizedSession {
  return parseMessages({ role: "assistant", timestamp: T0, ...message });
}

// ── parseChatSessionFile: the null paths ────────────────────────────────────
// The >64 MiB gate is already asserted in file-size-admission.test.ts and the
// missing-timestamp mtime fallback in attribution-synthetic-fixtures.test.ts;
// neither is repeated here.

test("chat parse returns null for unreadable, unparseable and non-object files", () => {
  const dir = makeTempDir("copilot-edges-null-");
  const broken = path.join(dir, "broken.json");
  writeFileSync(broken, "{ not json", "utf8");
  assert.equal(parseChatSessionFile(broken, null), null);
  // statSync throws for a path that does not exist — the same catch.
  assert.equal(parseChatSessionFile(path.join(dir, "gone.json"), null), null);
  // Valid JSON whose root is not an object.
  assert.equal(parseChat("a scalar root"), null);
  assert.equal(parseChat(null), null);
  assert.equal(parseChat(7), null);
});

test("chat parse returns null when nothing normalizes into a message", () => {
  assert.equal(parseChat({ sessionId: "empty" }), null);
  assert.equal(parseChat({ requests: [] }), null);
  // Empty candidate arrays fall through to `requests`, which is also empty.
  assert.equal(parseChat({ messages: [], turns: [], history: [] }), null);
  // Non-object requests normalize to zero entries each.
  assert.equal(parseChat({ requests: ["str", null, 42] }), null);
});

// ── normalizeChatMessages: source precedence ────────────────────────────────

test("chat message source precedence is messages > turns > history > requests", () => {
  const messages = [{ role: "user", timestamp: T0, text: "FROM_MESSAGES" }];
  const turns = [{ role: "user", timestamp: T0, text: "FROM_TURNS" }];
  const history = [{ role: "user", timestamp: T0, text: "FROM_HISTORY" }];
  const requests = [{ ...BASE_REQUEST, message: { text: "FROM_REQUESTS" } }];
  const first = (data: Json): string | null =>
    parseChatOk(data).messages[0].text;

  assert.equal(first({ messages, turns, history, requests }), "FROM_MESSAGES");
  assert.equal(first({ turns, history, requests }), "FROM_TURNS");
  assert.equal(first({ history, requests }), "FROM_HISTORY");
  assert.equal(first({ requests }), "FROM_REQUESTS");
  // An empty or non-array candidate is skipped rather than winning the slot.
  assert.equal(first({ messages: [], turns, history }), "FROM_TURNS");
  assert.equal(first({ messages: { a: 1 }, turns }), "FROM_TURNS");
});

test("non-object entries inside a chat message array are skipped, not fatal", () => {
  const parsed = parseMessages("nope", null, 42, {
    role: "user",
    timestamp: T0,
  });
  assert.equal(parsed.userMessages, 1);
  assert.equal(parsed.messages.length, 1);
});

// ── resolveUsageObject: the 5-way fallback, asserted as precedence ──────────

function embeddedInput(message: Json): number {
  return parseAssistant(message).tokensByModel["copilot-default"].input;
}

test("embedded usage resolves usage > tokenUsage > token_count > response.usage > result.usage", () => {
  // Each arm carries a distinct input count, so the resolved value names the
  // arm that won.
  const response = { usage: { input_tokens: 4 } };
  const result = { usage: { input_tokens: 5 } };
  const tokenUsage = { input_tokens: 2 };
  const tokenCount = { input_tokens: 3 };
  const all = { tokenUsage, token_count: tokenCount, response, result };

  assert.equal(embeddedInput({ usage: { input_tokens: 1 }, ...all }), 1);
  assert.equal(embeddedInput(all), 2);
  assert.equal(embeddedInput({ token_count: tokenCount, response, result }), 3);
  assert.equal(embeddedInput({ response, result }), 4);
  assert.equal(embeddedInput({ result }), 5);
  // No usage anywhere leaves tokensByModel empty rather than emitting zeros.
  assert.deepEqual(parseAssistant({}).tokensByModel, {});
});

test("embedded usage sums across messages while a numeric token_count discards the whole chain", () => {
  const summed = parseMessages(
    { role: "assistant", timestamp: T0, usage: { input_tokens: 10 } },
    { role: "assistant", timestamp: T1, tokenUsage: { input_tokens: 5 } }
  );
  assert.equal(summed.tokensByModel["copilot-default"].input, 15);

  // SUSPECTED BUG (asserting current behavior, not endorsing it): the fallback
  // chain is built with `||`, so a NUMERIC `token_count` is truthy, wins the
  // chain, then fails the `typeof === "object"` check — discarding the
  // `response.usage` the same payload carried. The contrast below proves that
  // usage is otherwise read.
  const response = { usage: { input_tokens: 77 } };
  assert.deepEqual(
    parseAssistant({ token_count: 42, response }).tokensByModel,
    {}
  );
  assert.equal(embeddedInput({ response }), 77);
});

test("top-level session usage merges per field with max(), not addition", () => {
  const usage = { input_tokens: 100, output_tokens: 5 };
  const merged = (top: Json): unknown =>
    parseChatOk({
      messages: [{ role: "assistant", timestamp: T0, usage }],
      ...top,
    }).tokensByModel["copilot-default"];
  const counts = (input: number, output: number, cacheRead = 0) => ({
    input,
    output,
    cacheRead,
    cacheWrite: 0,
  });

  const top = { input_tokens: 40, output_tokens: 900 };
  assert.deepEqual(merged({ usage: top }), counts(100, 900));
  assert.deepEqual(
    merged({ tokenUsage: { input_tokens: 400 } }),
    counts(400, 5)
  );
  assert.deepEqual(
    merged({ token_count: { cache_read_tokens: 7 } }),
    counts(100, 5, 7)
  );
  // A non-object top-level usage is ignored entirely.
  assert.deepEqual(merged({ usage: 5 }), counts(100, 5));
});

test("tokensByModel is keyed by the SESSION model while tokenSeries honours the per-message model", () => {
  const parsed = parseAssistant({
    model: "per-message-model",
    usage: { input_tokens: 10 },
  });
  assert.deepEqual(Object.keys(parsed.tokensByModel), ["copilot-default"]);
  assert.equal(parsed.tokenSeries[0].model, "per-message-model");
});

// ── resolveRequestModel: the 4-way fallback, asserted as precedence ─────────

test("per-request model resolves model > modelId > response.model > result.model, and flags the synthetic fallback", () => {
  const entry = (req: Json): NormalizedSession["messages"][number] =>
    parseRequest(req).messages[0];
  const response = { model: "C" };
  const result = { model: "D" };

  assert.equal(
    entry({ model: "A", modelId: "B", response, result }).model,
    "A"
  );
  assert.equal(entry({ modelId: "B", response, result }).model, "B");
  assert.equal(entry({ response, result }).model, "C");
  assert.equal(entry({ result }).model, "D");
  assert.equal(entry({}).model, null);
  // A message with no resolvable model resolves to the synthetic default key.
  assert.equal(entry({}).isSynthetic, true);
  assert.equal(entry({ model: "A" }).isSynthetic, undefined);
});

// ── hasRenderableContent: per-type arms and the depth-4 cutoff ──────────────

/**
 * With no `id`/`requestId` on the request, the user entry exists if and only if
 * `hasRenderableContent(userPayload)` is true, so `userMessages` reads that
 * predicate out directly. The response keeps the fixture parseable.
 */
function userEntryFor(message: unknown): boolean {
  const requests = [{ timestamp: T0, message, response: { markdown: "ok" } }];
  return parseChatOk({ requests }).userMessages === 1;
}

test("hasRenderableContent accepts strings/numbers/booleans, rejects blank and empty payloads, and stops past depth 4", () => {
  assert.equal(userEntryFor("hello"), true);
  assert.equal(userEntryFor("   "), false);
  assert.equal(userEntryFor(0), true, "a number is renderable, even zero");
  assert.equal(
    userEntryFor(false),
    true,
    "a boolean is renderable, even false"
  );
  assert.equal(userEntryFor(null), false);
  assert.equal(userEntryFor([]), false);
  assert.equal(userEntryFor(["", "  "]), false);
  assert.equal(userEntryFor([{ nested: "x" }]), true);
  assert.equal(userEntryFor({}), false);
  assert.equal(userEntryFor({ a: null }), false);
  assert.equal(userEntryFor({ a: { b: { c: { d: "deep" } } } }), true);
  assert.equal(userEntryFor({ a: { b: { c: { d: { e: "deep" } } } } }), false);
});

test("an id or requestId forces a user entry even when the payload is not renderable", () => {
  const forced = parseRequest({ message: {}, response: { markdown: "ok" } });
  assert.equal(forced.userMessages, 1);
  assert.equal(forced.messages[0].text, null, "no text is invented for it");
  const byRequestId = parseChatOk({
    requests: [{ requestId: "r1", timestamp: T0, message: {} }],
  });
  assert.equal(byRequestId.userMessages, 1);
});

// ── normalizeChatRequest: the assistant-entry condition ─────────────────────

test("an assistant entry is emitted for renderable content, an error, tool calls, or a merely PRESENT response/result/reply/output", () => {
  const count = (req: Json): number => parseRequest(req).assistantMessages;
  assert.equal(count({}), 0, "nothing to render, nothing emitted");
  assert.equal(count({ response: {} }), 1);
  assert.equal(count({ result: {} }), 1);
  assert.equal(count({ reply: {} }), 1);
  assert.equal(count({ output: {} }), 1);
  assert.equal(count({ reply: { markdown: "hi" } }), 1);
  assert.equal(count({ error: "boom" }), 1);
  assert.equal(count({ toolCalls: [{ name: "t" }] }), 1);
});

test("the assistant error resolves responseError > error > result.error > response.error and lands in apiErrors", () => {
  assert.deepEqual(parseRequest({ error: "boom" }).apiErrors, [
    { type: "error", message: "boom", timestamp: T0 },
  ]);
  const message = (req: Json): string | null | undefined =>
    parseRequest(req).apiErrors[0].message;
  const result = { error: "from result" };
  const response = { error: "from response" };

  assert.equal(message({ responseError: "from rE", error: "e" }), "from rE");
  assert.equal(message({ error: "from error", result }), "from error");
  assert.equal(message({ result, response }), "from result");
  assert.equal(message({ response }), "from response");
});

test("a thinking request emits an assistant entry with null text and bumps thinkingBlockCount", () => {
  const response = { markdown: "visible answer" };
  const plain = parseRequest({ response });
  assert.equal(plain.messages[1].text, "visible answer");
  assert.equal(plain.messages[1].isThinking, undefined);
  assert.equal(plain.thinkingBlockCount, 0);

  for (const req of [
    { thinking: true },
    { reasoning: { summary: "why" } },
    { response: { ...response, thinking: true } },
    { response: { ...response, reasoning: "why" } },
    { result: { thinking: true } },
    { result: { reasoning: "why" } },
  ]) {
    const parsed = parseRequest({ response, ...req });
    assert.equal(parsed.messages[1].isThinking, true);
    assert.equal(parsed.messages[1].text, null, "thinking suppresses the text");
    assert.equal(parsed.thinkingBlockCount, 1);
  }
});

test("chat request/response timestamps walk their full fallback chains", () => {
  const window = (req: Json, session: Json = {}): Array<string | null> => {
    const base = { message: { text: "q" }, response: { markdown: "a" } };
    const parsed = parseChatOk({ requests: [{ ...base, ...req }], ...session });
    return [parsed.startedAt, parsed.endedAt];
  };
  const bounds = [T0, T2];

  assert.deepEqual(window({ timestamp: T0, responseTimestamp: T2 }), bounds);
  assert.deepEqual(window({ created_at: T0, responseDate: T2 }), bounds);
  assert.deepEqual(window({ createdAt: T0, updatedAt: T2 }), bounds);
  const responded = { requestDate: T0, response: { timestamp: T2 } };
  assert.deepEqual(window(responded), bounds);
  const viaMessage = { message: { timestamp: T0 }, result: { timestamp: T2 } };
  assert.deepEqual(window(viaMessage), bounds);
  const viaCreatedAt = { message: { text: "q", createdAt: T0 } };
  assert.deepEqual(window(viaCreatedAt, { lastMessageDate: T2 }), bounds);
  const session = { creationDate: T0, lastMessageDate: T2 };
  assert.deepEqual(window({}, session), bounds);
  // Nothing resolves the response timestamp, so it mirrors the request's.
  assert.deepEqual(window({ timestamp: T1 }), [T1, T1]);
});

// ── chat role dispatch ──────────────────────────────────────────────────────

test("chat message fields fall back through their remaining alias arms", () => {
  // extractText's OpenAI-style content-parts arm, mixing strings, {text},
  // {content} and an unusable entry.
  const parts = ["a", { text: "b" }, { content: "c" }, 5];
  const withParts = parseMessages({
    role: "user",
    timestamp: T0,
    content: parts,
  });
  assert.equal(withParts.messages[0].text, "a\nb\nc");

  // Per-message timestamp aliases, plus a message carrying no role/author/type.
  const aliases = parseMessages(
    { role: "user", created_at: T0, text: "x" },
    { role: "user", createdAt: T1, text: "y" },
    { role: "user", date: T2, text: "z" },
    { text: "roleless" }
  );
  assert.equal(aliases.userMessages, 3);
  assert.deepEqual([aliases.startedAt, aliases.endedAt], [T0, T2]);

  // A tool call on a timestamp-less message inherits the session start, and an
  // unnamed call/result pair both fall back to the generic tool name.
  const inherited = parseMessages(
    { role: "user", timestamp: T1, text: "x" },
    { role: "assistant", toolCalls: [{}], toolResults: [{ content: "out" }] }
  );
  assert.deepEqual(
    inherited.toolUses.map((t) => [t.name, t.timestamp, t.output]),
    [["copilot_tool", T1, "out"]]
  );
  const unnamed = parseRequest({
    toolCalls: [{}],
    response: { toolResults: [{ content: "generic" }] },
  });
  assert.equal(unnamed.toolUses[0].output, "generic");

  // With no request date anywhere the request timestamp resolves to null, and
  // the session still starts via the file-mtime fallback.
  const undated = parseChatOk({
    requests: [{ id: "r", message: { text: "q" } }],
  });
  assert.equal(undated.messages[0].timestamp, null);
  assert.ok(undated.startedAt, "the mtime fallback still supplies startedAt");
});

test("chat roles dispatch on user/human and assistant/copilot/bot, read from role, author or type", () => {
  const parsed = parseMessages(
    { role: "user", timestamp: T0, text: "u" },
    { author: "human", timestamp: T0, text: "h" },
    { type: "assistant", timestamp: T1, text: "a" },
    { role: "copilot", timestamp: T1, text: "c" },
    { role: "bot", timestamp: T1, text: "b" }
  );
  assert.equal(parsed.userMessages, 2);
  assert.equal(parsed.assistantMessages, 3);
  assert.deepEqual(
    parsed.messages.map((m) => m.role),
    ["human", "human", "assistant", "assistant", "assistant"]
  );
});

test("an unknown or non-string chat role emits no message but still feeds tools, errors, usage and the session window", () => {
  const parsed = parseMessages(
    {
      role: "system",
      timestamp: T0,
      toolCalls: [{ name: "grep" }],
      error: "nope",
      usage: { input_tokens: 12 },
    },
    { role: 7, timestamp: T2, toolCalls: [{ name: "sed" }] }
  );
  assert.equal(parsed.userMessages, 0);
  assert.equal(parsed.assistantMessages, 0);
  assert.deepEqual(parsed.messages, []);
  assert.deepEqual(
    parsed.toolUses.map((t) => t.name),
    ["grep", "sed"]
  );
  assert.deepEqual(
    parsed.apiErrors.map((e) => e.message),
    ["nope"]
  );
  assert.equal(parsed.tokensByModel["copilot-default"].input, 12);
  assert.equal(parsed.startedAt, T0);
  assert.equal(parsed.endedAt, T2);
});

// ── collectToolCalls / accumulateChatToolCalls ──────────────────────────────

test("chat tool calls read the toolCalls/tool_calls/functionCalls aliases and fall back to a nested scan", () => {
  const parsed = parseMessages(
    ...[
      { toolCalls: [{ name: "a", arguments: '{"q":1}' }] },
      { tool_calls: [{ name: "b", input: { q: 2 } }] },
      { functionCalls: [{ function: { name: "c" }, parameters: { q: 3 } }] },
      // No alias key at all → the whole message is walked for nested calls, and
      // a call with no name falls back to the generic tool name.
      { response: { result: { toolCalls: [{}] } } },
      { toolCalls: "not-an-array" },
      { toolCalls: [null, { name: "d" }] },
    ].map((m) => ({ role: "assistant", timestamp: T0, ...m }))
  );
  assert.deepEqual(
    parsed.toolUses.map((t) => t.name),
    ["a", "b", "c", "copilot_tool", "d"]
  );
  assert.deepEqual(parsed.toolUses[0].input, { q: 1 }, "a JSON string parses");
  assert.deepEqual(parsed.toolUses[1].input, { q: 2 });
  assert.deepEqual(parsed.toolUses[2].input, { q: 3 });
});

test("chat tool-call output and isError extraction", () => {
  const parsed = parseAssistant({
    toolCalls: [
      { name: "str", result: "ok" },
      { name: "obj", output: { rows: 2 } },
      { name: "resp", response: "via response" },
      { name: "bare" },
      { name: "failed", result: "nope", isError: true },
      { name: "failed_snake", result: "nope", is_error: true },
    ],
  });
  assert.equal(parsed.toolUses[0].output, "ok");
  assert.deepEqual(parsed.toolUses[1].output, { rows: 2 }, "raw passthrough");
  assert.equal(parsed.toolUses[2].output, "via response");
  assert.equal(
    "output" in parsed.toolUses[3],
    false,
    "no output key at all when the call carried none"
  );
  assert.equal(parsed.toolUses[0].isError, undefined);
  assert.equal(parsed.toolUses[4].isError, true);
  assert.equal(parsed.toolUses[5].isError, true);
});

test("collectToolCalls walks containers to depth 4, drops depth 5, recurses arrays and ignores scalars", () => {
  const names = (req: Json): string[] =>
    parseRequest(req).toolUses.map((t) => t.name);
  const deep4 = { reply: { output: { toolCalls: [{ name: "d4" }] } } };
  const deep5 = { reply: { output: { response: { toolCalls: [{}] } } } };

  assert.deepEqual(names({ response: { result: deep4 } }), ["d4"]);
  assert.deepEqual(names({ response: { result: deep5 } }), [], "past cutoff");
  const inArray = [{ toolCalls: [{ name: "in_array" }] }];
  assert.deepEqual(names({ response: inArray }), ["in_array"]);
  assert.deepEqual(names({ response: "plain text" }), []);
});

// ── collectToolResults and the back-link ────────────────────────────────────

test("tool results back-link onto the LAST matching tool use still missing output", () => {
  const parsed = parseRequest({
    toolCalls: [{ name: "grep", result: "first output" }, { name: "grep" }],
    response: { toolResults: [{ name: "grep", content: "second output" }] },
  });
  assert.equal(parsed.toolUses[0].output, "first output", "resolved one kept");
  assert.equal(parsed.toolUses[1].output, "second output");
});

test("tool results are read from response/result/reply/output under all three key spellings", () => {
  const output = (req: Json): unknown =>
    parseRequest({ toolCalls: [{ name: "t" }], ...req }).toolUses[0].output;

  assert.equal(
    output({ response: { toolResults: [{ name: "t", content: "A" }] } }),
    "A"
  );
  assert.equal(
    output({ result: { tool_results: [{ toolName: "t", result: "B" }] } }),
    "B"
  );
  assert.equal(
    output({ reply: { functionResults: [{ tool: "t", output: "C" }] } }),
    "C"
  );
  assert.equal(
    output({ output: { toolResults: [{ name: "t", content: "D" }] } }),
    "D"
  );
  // Non-object containers, non-array key values and non-object entries skip.
  const malformed = {
    response: "text",
    result: { toolResults: {} },
    reply: { toolResults: [null, 5] },
  };
  assert.equal(output(malformed), undefined);
});

test("an isError tool result flags the tool use without inventing output, and an unmatched result changes nothing", () => {
  for (const entry of [
    { name: "t", isError: true },
    { name: "t", is_error: true },
    { name: "t", error: "exploded" },
  ]) {
    const parsed = parseRequest({
      toolCalls: [{ name: "t" }],
      response: { toolResults: [entry] },
    });
    assert.equal(parsed.toolUses[0].isError, true);
    assert.equal(parsed.toolUses[0].output, undefined);
  }

  const orphaned = parseRequest({
    toolCalls: [{ name: "t", result: "done" }],
    response: { toolResults: [{ name: "other", content: "orphan" }] },
  });
  assert.deepEqual(
    orphaned.toolUses.map((t) => [t.name, t.output, t.isError]),
    [["t", "done", undefined]]
  );
});

test("a message-level toolResults array back-links directly, honouring is_error and skipping malformed shapes", () => {
  const output = (
    toolResults: unknown
  ): NormalizedSession["toolUses"][number] =>
    parseAssistant({ toolCalls: [{ name: "t" }], toolResults }).toolUses[0];

  const snake = output([{ name: "t", content: "raw", is_error: true }]);
  assert.equal(snake.output, "raw");
  assert.equal(snake.isError, true);
  assert.equal(output("nope").output, undefined);
  assert.equal(output([null, 5]).output, undefined);
  // truncateText maps "" to null, so an empty tool result leaves output unset
  // rather than recording an empty output.
  assert.equal(output([{ name: "t", content: "" }]).output, undefined);
});

// ── raw-request tokenSeries: dedup, timestamp chain, guards ─────────────────

test("a raw request at a timestamp already in tokenSeries does not add a second entry", () => {
  const parsed = parseChatOk({
    messages: [
      {
        role: "assistant",
        timestamp: T1,
        model: "m-msg",
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    ],
    requests: [{ responseTimestamp: T1, usage: { input_tokens: 999 } }],
  });
  assert.equal(parsed.tokenSeries.length, 1);
  assert.deepEqual(parsed.tokenSeries[0], {
    timestamp: T1,
    model: "m-msg",
    input: 10,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("a raw request at a fresh timestamp adds its own entry, keyed by the request then session model", () => {
  const parsed = parseChatOk({
    model: "session-model",
    messages: [
      { role: "assistant", timestamp: T1, usage: { input_tokens: 10 } },
    ],
    requests: [
      {
        responseTimestamp: T2,
        usage: { input_tokens: 20 },
        modelId: "req-model",
      },
    ],
  });
  assert.deepEqual(
    parsed.tokenSeries.map((r) => [r.timestamp, r.model, r.input]),
    [
      [T1, "session-model", 10],
      [T2, "req-model", 20],
    ]
  );
});

test("the raw-request tokenSeries timestamp walks its full fallback chain", () => {
  const seriesTs = (req: Json, session: Json = {}): string | undefined =>
    parseChatOk({
      messages: [{ role: "assistant", timestamp: T1, text: "a" }],
      requests: [{ usage: { input_tokens: 5 }, ...req }],
      ...session,
    }).tokenSeries[0]?.timestamp;

  assert.equal(seriesTs({ responseTimestamp: T2, updatedAt: T0 }), T2);
  assert.equal(seriesTs({ responseDate: T2, updatedAt: T0 }), T2);
  assert.equal(seriesTs({ updatedAt: T2, timestamp: T0 }), T2);
  assert.equal(seriesTs({ response: { timestamp: T2 }, timestamp: T0 }), T2);
  assert.equal(seriesTs({ result: { timestamp: T2 }, timestamp: T0 }), T2);
  assert.equal(seriesTs({ timestamp: T2 }), T2);
  assert.equal(seriesTs({ created_at: T2 }), T2);
  assert.equal(seriesTs({ createdAt: T2 }), T2);
  assert.equal(seriesTs({}, { lastMessageDate: T2 }), T2);
});

test("a raw request contributes nothing without usage, without a timestamp, or with all-zero counts", () => {
  const series = (requests: unknown[]): unknown[] =>
    parseChatOk({
      messages: [{ role: "assistant", timestamp: T1, text: "a" }],
      requests,
    }).tokenSeries;

  assert.deepEqual(series([{ responseTimestamp: T2 }]), []);
  assert.deepEqual(series([{ usage: { input_tokens: 5 } }]), []);
  const zeroed = { responseTimestamp: T2, usage: { input_tokens: 0 } };
  assert.deepEqual(series([zeroed]), []);
  assert.deepEqual(series(["x", null]), []);
});

// ── cwd, project name and session id ────────────────────────────────────────

test("cwd takes the first MEANINGFUL candidate across workspacePath, data.cwd and data.workspaceFolder", () => {
  const base = { messages: [{ role: "user", timestamp: T0, text: "q" }] };
  const both = { ...base, cwd: "/data/cwd", workspaceFolder: "/data/folder" };
  assert.equal(parseChatOk(both, "/ws/path").cwd, "/ws/path");
  assert.equal(parseChatOk(both, null).cwd, "/data/cwd");
  const rootCwd = { ...base, cwd: "/", workspaceFolder: "/data/folder" };
  assert.equal(parseChatOk(rootCwd, "/").cwd, "/data/folder", "/ is not a cwd");
  assert.equal(parseChatOk({ ...base, cwd: 5 }, null).cwd, null);
});

test("the session id falls back to the file basename and drives the generic project name", () => {
  const base = { messages: [{ role: "user", timestamp: T0, text: "q" }] };
  assert.equal(parseChatOk(base, "/repos/my project").name, "my project");
  const named = parseChatOk({ ...base, sessionId: "abcdefghijkl" }, null);
  assert.equal(named.name, "Copilot Chat abcdefgh");
  const byId = parseChatOk({ ...base, id: "id-fallback" }, null);
  assert.equal(byId.sessionId, "copilot-chat-id-fallback");
  const file = writeChat(base, "0123456789abc.json");
  const parsed = requireSession(parseChatSessionFile(file, null), "basename");
  assert.equal(parsed.sessionId, "copilot-chat-0123456789abc");
  assert.equal(parsed.name, "Copilot Chat 01234567");
});

// ── parseChatSessionFileGated ───────────────────────────────────────────────

test("parseChatSessionFileGated returns exactly what the ungated parse returns", async () => {
  const response = { markdown: "a", usage: { input_tokens: 3 } };
  const filePath = writeChat({ requests: [{ ...BASE_REQUEST, response }] });
  const direct = requireSession(parseChatSessionFile(filePath, "/ws"), "gated");
  assert.deepEqual(await parseChatSessionFileGated(filePath, "/ws"), direct);
  assert.equal(
    await parseChatSessionFileGated(writeChat("a scalar root"), null),
    null,
    "the gate passes a null decision through unchanged"
  );
});
