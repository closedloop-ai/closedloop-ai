/**
 * ISS-5299 — Covers uncovered branches in output-tailer.ts (summarizeJsonlRecord +
 * startOutputTailer edge paths) and stream-events.ts (processStreamEvent).
 * Sibling of the grandfathered output-tailer-tokens.test.ts; do NOT merge into it.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  startOutputTailer,
  summarizeJsonlRecord,
} from "../src/server/operations/output-tailer.js";
import {
  createStreamState,
  processStreamEvent,
} from "../src/server/operations/stream-events.js";
import { restoreEnvVars, saveEnvVars } from "./symphony-test-utils.js";
import { TAILER_ENV_KEYS } from "./tailer-env-keys.js";

// Shared cleanup registries — drained in a single afterEach
const tempPathsToClean: string[] = [];
const eventServersToClose: http.Server[] = [];
const originalTailerEnv = saveEnvVars(TAILER_ENV_KEYS);

const tailersToStop: Array<{ stop: () => void }> = [];

afterEach(async () => {
  // Restore, not delete: an unconditional delete would clear a value the host
  // environment had set before this suite ran.
  restoreEnvVars(originalTailerEnv);

  // Tailers
  for (const t of tailersToStop.splice(0)) {
    try {
      t.stop();
    } catch {
      /* already stopped */
    }
  }

  // HTTP servers
  for (const srv of eventServersToClose.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      srv.close((err) => (err ? reject(err) : resolve()));
    });
  }

  // Temp dirs
  for (const p of tempPathsToClean.splice(0)) {
    await fs.rm(p, { recursive: true, force: true });
  }
});

// Helpers
function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "output-tailer-ops-test-"));
  tempPathsToClean.push(dir);
  return dir;
}

async function startEventServer(): Promise<{
  port: number;
  getCollected: () => Array<{ type: string } & Record<string, unknown>>;
}> {
  const collected: Array<{ type: string } & Record<string, unknown>> = [];

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* ignore malformed */
      }
      res.statusCode = 200;
      res.end("{}");
      collected.push({ type: String(body.type ?? ""), ...body });
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Could not get server address"));
        return;
      }
      resolve(addr.port);
    });
    server.once("error", reject);
  });

  eventServersToClose.push(server);
  return { port, getCollected: () => collected };
}

function trackTailer(t: { stop: () => void; flush: () => Promise<void> }) {
  tailersToStop.push(t);
  return t;
}

describe("summarizeJsonlRecord — branch coverage", () => {
  // ── assistant / user ──────────────────────────────────────────────────────

  test("returns null when message is not a record (covers 155/156 false→null path)", () => {
    // message is a string, not a record → isRecord() false → null → !message → return null
    const result = summarizeJsonlRecord({
      type: "assistant",
      message: "not an object",
    });
    assert.equal(result, null);
  });

  test("skips non-record blocks in content (covers 163 true → continue)", () => {
    // First block is a primitive (not isRecord), second is a valid text block
    const result = summarizeJsonlRecord({
      type: "assistant",
      message: {
        content: [
          "primitive-string-not-a-record",
          { type: "text", text: "real content" },
        ],
      },
    });
    assert.equal(result, "real content");
  });

  test("user type produces same result as assistant (user branch exercised)", () => {
    const result = summarizeJsonlRecord({
      type: "user",
      message: {
        content: [{ type: "text", text: "user text" }],
      },
    });
    assert.equal(result, "user text");
  });

  // ── tool_use ──────────────────────────────────────────────────────────────

  test("tool_use: no file_path/path → falls to command check (covers 112 false)", () => {
    // No file_path, no path, has command → covers 112 false, 115 true
    const result = summarizeJsonlRecord({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
        ],
      },
    });
    assert.ok(result !== null);
    assert.ok(result.startsWith("Tool: Bash(ls -la)"));
  });

  test("tool_use: pattern-only input (covers 115 false, 118 true)", () => {
    const result = summarizeJsonlRecord({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Search", input: { pattern: "*.ts" } },
        ],
      },
    });
    assert.ok(result !== null);
    assert.ok(result.includes("*.ts"));
  });

  test("tool_use: no file_path/command/pattern → fallback 'Tool: name' (covers 118 false)", () => {
    const result = summarizeJsonlRecord({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "DoSomething", input: {} }],
      },
    });
    assert.equal(result, "Tool: DoSomething");
  });

  test("tool_use: non-record input falls back to empty input (covers 169 false)", () => {
    // input is null (not a record) → isRecord false → {}
    const result = summarizeJsonlRecord({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read", input: null }],
      },
    });
    // With empty input, no file_path/command/pattern → "Tool: Read"
    assert.equal(result, "Tool: Read");
  });

  test("tool_use: null name falls back to 'unknown' (covers b.name ?? 'unknown')", () => {
    const result = summarizeJsonlRecord({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: null, input: {} }],
      },
    });
    assert.equal(result, "Tool: unknown");
  });

  // ── text ──────────────────────────────────────────────────────────────────

  test("text block: null text falls back to empty string (covers text ?? '' branch)", () => {
    const result = summarizeJsonlRecord({
      type: "assistant",
      message: {
        content: [{ type: "text", text: null }],
      },
    });
    // summarizeJsonlRecord returns "" via truncate(String(null ?? ""), 200)
    // then redactSensitive("") = ""
    assert.equal(result, "");
  });

  // ── thinking ─────────────────────────────────────────────────────────────

  test("thinking block → 'Thinking...' (covers thinking case)", () => {
    const result = summarizeJsonlRecord({
      type: "assistant",
      message: {
        content: [{ type: "thinking" }],
      },
    });
    assert.equal(result, "Thinking...");
  });

  // ── tool_result ───────────────────────────────────────────────────────────

  test("tool_result: empty string content → 'Tool result' (covers 129 content.length > 0 false)", () => {
    const result = summarizeJsonlRecord({
      type: "assistant",
      message: {
        content: [{ type: "tool_result", is_error: false, content: "" }],
      },
    });
    assert.equal(result, "Tool result");
  });

  test("tool_result: array content with text part → 'Tool result: <text>' (covers 132 true)", () => {
    const result = summarizeJsonlRecord({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_result",
            is_error: false,
            content: [{ type: "text", text: "file contents" }],
          },
        ],
      },
    });
    assert.equal(result, "Tool result: file contents");
  });

  test("tool_result: array with no text parts → 'Tool result' fallback", () => {
    const result = summarizeJsonlRecord({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_result",
            is_error: false,
            content: [{ type: "image", data: "base64..." }],
          },
        ],
      },
    });
    assert.equal(result, "Tool result");
  });

  // ── content_block_delta ───────────────────────────────────────────────────

  test("content_block_delta: non-record delta → null (covers 189 isRecord false)", () => {
    const result = summarizeJsonlRecord({
      type: "content_block_delta",
      delta: "not-a-record",
    });
    assert.equal(result, null);
  });

  test("content_block_delta: delta null text falls back to '' (covers 196 ?? '')", () => {
    // delta IS a record with type text_delta but text is null
    const result = summarizeJsonlRecord({
      type: "content_block_delta",
      delta: { type: "text_delta", text: null },
    });
    assert.equal(result, "");
  });

  test("content_block_delta: delta type not text_delta → null (covers 201 return null)", () => {
    const result = summarizeJsonlRecord({
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: "{}" },
    });
    assert.equal(result, null);
  });

  // ── result ────────────────────────────────────────────────────────────────

  test("result: is_error=true with no result or error field → 'Error: '", () => {
    const result = summarizeJsonlRecord({
      type: "result",
      subtype: "error",
      is_error: true,
      // no result or error field → r.result ?? r.error ?? "" = ""
    });
    assert.ok(result !== null);
    assert.ok(result.startsWith("Error:"));
  });

  test("result: no subtype and not is_error → null (covers 213 return null)", () => {
    const result = summarizeJsonlRecord({
      type: "result",
      // no subtype, is_error undefined
    });
    assert.equal(result, null);
  });

  // ── default ───────────────────────────────────────────────────────────────

  test("unknown type → null (covers default case)", () => {
    const result = summarizeJsonlRecord({ type: "some_future_event" });
    assert.equal(result, null);
  });
});

describe("startOutputTailer — edge-case branch coverage", () => {
  test("handles empty lines and invalid JSON in JSONL gracefully (covers 499, 505, 508)", {
    timeout: 10_000,
  }, async () => {
    const tmpDir = makeTempDir();
    const jsonlPath = path.join(tmpDir, "output.jsonl");
    const srv = await startEventServer();
    const apiBase = `http://127.0.0.1:${srv.port}`;

    // Mix of: empty line, invalid JSON, null (parsed non-record), valid assistant line
    const validLine = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "hello" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    writeFileSync(jsonlPath, `\n{not valid json}\nnull\n${validLine}\n`);

    const t = trackTailer(
      startOutputTailer(jsonlPath, apiBase, "edge-loop", () => "tok", 0)
    );
    await t.flush();

    const outputEvents = srv.getCollected().filter((e) => e.type === "output");
    // Only the valid assistant line should produce an output event
    assert.equal(outputEvents.length, 1);
    const data = outputEvents[0]?.data as Record<string, unknown> | undefined;
    assert.ok(data !== undefined);
    assert.equal(data.chunk, "hello");
  });

  test("assistant with non-record message produces no token accumulation (covers 513 false)", {
    timeout: 10_000,
  }, async () => {
    const tmpDir = makeTempDir();
    const jsonlPath = path.join(tmpDir, "output.jsonl");
    const srv = await startEventServer();
    const apiBase = `http://127.0.0.1:${srv.port}`;

    // parsed.type === "assistant" but parsed.message is a string (not a record)
    // → isRecord(parsed.message) = false → message = null → usage = null → no token accum
    // But summarizeJsonlRecord sees no valid content → lastDisplay = null → commitFrame but no POST
    const badMessageLine = JSON.stringify({
      type: "assistant",
      message: "not a record at all",
    });
    const displayLine = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "visible" }],
        usage: { input_tokens: 5, output_tokens: 3 },
      },
    });
    writeFileSync(jsonlPath, `${badMessageLine}\n${displayLine}\n`);

    const t = trackTailer(
      startOutputTailer(jsonlPath, apiBase, "bad-msg-loop", () => "tok", 0)
    );
    await t.flush();

    const outputEvents = srv.getCollected().filter((e) => e.type === "output");
    assert.equal(outputEvents.length, 1);
    const data = outputEvents[0]?.data as Record<string, unknown> | undefined;
    assert.ok(data !== undefined);
    // The visible line should be posted with its own usage (5/3 only, not counting bad line)
    const tokenUsage = data.tokenUsage as Record<string, unknown> | undefined;
    assert.ok(tokenUsage !== undefined);
    assert.equal(tokenUsage.inputTokens, 5);
  });

  test("assistant with non-numeric token fields uses zero fallback (covers 518, 520 false)", {
    timeout: 10_000,
  }, async () => {
    const tmpDir = makeTempDir();
    const jsonlPath = path.join(tmpDir, "output.jsonl");
    const srv = await startEventServer();
    const apiBase = `http://127.0.0.1:${srv.port}`;

    // input_tokens and output_tokens are strings, not numbers → 0 fallback
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "text" }],
        usage: {
          input_tokens: "not-a-number",
          output_tokens: "also-not-a-number",
        },
      },
    });
    writeFileSync(jsonlPath, `${line}\n`);

    const t = trackTailer(
      startOutputTailer(jsonlPath, apiBase, "non-numeric-loop", () => "tok", 0)
    );
    await t.flush();

    const outputEvents = srv.getCollected().filter((e) => e.type === "output");
    assert.equal(outputEvents.length, 1);
    const data = outputEvents[0]?.data as Record<string, unknown> | undefined;
    assert.ok(data !== undefined);
    // Non-numeric usage → zero totals → hasAnyTokenTotals=false → tokenUsage=undefined
    assert.equal(data.tokenUsage, undefined);
  });

  test("getToken returning null triggers auth-kind failure (covers shouldRetryOnResult auth case, line 399)", {
    timeout: 10_000,
  }, async () => {
    const tmpDir = makeTempDir();
    const jsonlPath = path.join(tmpDir, "output.jsonl");

    // apiBase can be anything since getToken=null short-circuits before HTTP fetch
    const apiBase = "http://127.0.0.1:1";

    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "visible" }],
        usage: { input_tokens: 2, output_tokens: 1 },
      },
    });
    writeFileSync(jsonlPath, `${line}\n`);

    const committedOffsets: number[] = [];
    const t = trackTailer(
      startOutputTailer(
        jsonlPath,
        apiBase,
        "auth-null-loop",
        () => null, // getToken returns null → kind="auth" failure
        0,
        (o) => {
          committedOffsets.push(o);
        }
      )
    );
    await t.flush();

    // Auth failure → no commit (the frame was not accepted)
    assert.equal(
      committedOffsets.length,
      0,
      "No commit expected when auth fails"
    );
  });

  test("exhausting max auth retries sets authRetriesExhausted (covers scheduleAuthRetry line 419)", {
    timeout: 10_000,
  }, async () => {
    // maxCount=0 → first failure exhausts retries immediately
    process.env.CLOSEDLOOP_TAILER_AUTH_RETRY_MAX_COUNT = "0";
    process.env.CLOSEDLOOP_TAILER_AUTH_RETRY_BASE_MS = "600000";
    process.env.CLOSEDLOOP_TAILER_POLL_MS = "600000";

    const tmpDir = makeTempDir();
    const jsonlPath = path.join(tmpDir, "output.jsonl");
    const apiBase = "http://127.0.0.1:1"; // unreachable; getToken=null short-circuits

    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "visible" }],
        usage: { input_tokens: 3, output_tokens: 1 },
      },
    });
    writeFileSync(jsonlPath, `${line}\n`);

    const committedOffsets: number[] = [];
    const t = trackTailer(
      startOutputTailer(
        jsonlPath,
        apiBase,
        "exhaust-retry-loop",
        () => null, // → auth failure → scheduleAuthRetry → attempt 1 > maxCount 0 → exhausted
        0,
        (o) => {
          committedOffsets.push(o);
        }
      )
    );
    await t.flush(); // first flush: fails, exhausts retries

    assert.equal(
      committedOffsets.length,
      0,
      "Nothing committed when auth exhausted"
    );

    // Second flush with forceAttempt=true: auth retries exhausted but forceAttempt overrides
    // → tries again, still fails (getToken=null), still no commit
    await t.flush();
    assert.equal(committedOffsets.length, 0, "Still no commit on second flush");
  });

  test("stopped tailer skips pollOnce body (covers stopped early-return at line 441)", {
    timeout: 10_000,
  }, async () => {
    const tmpDir = makeTempDir();
    const jsonlPath = path.join(tmpDir, "output.jsonl");
    const srv = await startEventServer();
    const apiBase = `http://127.0.0.1:${srv.port}`;

    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "should not appear" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    writeFileSync(jsonlPath, `${line}\n`);

    const t = trackTailer(
      startOutputTailer(jsonlPath, apiBase, "stopped-loop", () => "tok", 0)
    );
    // stop() before flush() sets stopped=true; flush() calls pollOnce which returns at line 441
    t.stop();
    await t.flush();

    const outputEvents = srv.getCollected().filter((e) => e.type === "output");
    assert.equal(
      outputEvents.length,
      0,
      "Stopped tailer should not post any events"
    );
  });

  test("non-existent file with no claudeWorkDir causes early return (covers line 451)", {
    timeout: 10_000,
  }, async () => {
    const srv = await startEventServer();
    const apiBase = `http://127.0.0.1:${srv.port}`;

    const nonExistentPath = path.join(
      os.tmpdir(),
      "output-tailer-ops-does-not-exist.jsonl"
    );

    const t = trackTailer(
      startOutputTailer(
        nonExistentPath,
        apiBase,
        "no-file-loop",
        () => "tok",
        0
        // no claudeWorkDir → resolveReadableJsonlPath returns null → pollOnce returns early
      )
    );
    await t.flush();

    const outputEvents = srv.getCollected().filter((e) => e.type === "output");
    assert.equal(outputEvents.length, 0, "No events when file does not exist");
  });

  test("jsonlPath pointing to a directory causes updateActiveJsonlPath to return false (covers 321, 349, 454)", {
    timeout: 10_000,
  }, async () => {
    const tmpDir = makeTempDir();
    // A subdirectory as the jsonlPath: existsSync returns true, but isFile() is false
    const dirAsJsonlPath = path.join(tmpDir, "subdir");
    mkdirSync(dirAsJsonlPath);

    const srv = await startEventServer();
    const apiBase = `http://127.0.0.1:${srv.port}`;

    const t = trackTailer(
      startOutputTailer(
        dirAsJsonlPath, // directory → readFileIdentity returns null → updateActiveJsonlPath false
        apiBase,
        "dir-as-file-loop",
        () => "tok",
        0
      )
    );
    await t.flush();

    const outputEvents = srv.getCollected().filter((e) => e.type === "output");
    assert.equal(
      outputEvents.length,
      0,
      "No events when jsonlPath is a directory"
    );
  });

  test("observability sink that throws does not crash the tailer (covers line 558 catch)", {
    timeout: 10_000,
  }, async () => {
    const tmpDir = makeTempDir();
    const jsonlPath = path.join(tmpDir, "output.jsonl");
    const srv = await startEventServer();
    const apiBase = `http://127.0.0.1:${srv.port}`;

    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "surviving" }],
        usage: { input_tokens: 4, output_tokens: 2 },
      },
    });
    writeFileSync(jsonlPath, `${line}\n`);

    const t = trackTailer(
      startOutputTailer(
        jsonlPath,
        apiBase,
        "sink-throws-loop",
        () => "tok",
        0,
        undefined,
        undefined,
        undefined,
        () => {
          throw new Error("sink intentionally throws");
        }
      )
    );
    await t.flush();

    // The tailer must survive the throwing sink and still post the output event
    const outputEvents = srv.getCollected().filter((e) => e.type === "output");
    assert.equal(
      outputEvents.length,
      1,
      "Output event must be posted even when observability sink throws"
    );
    const data = outputEvents[0]?.data as Record<string, unknown> | undefined;
    assert.ok(data !== undefined);
    assert.equal(data.chunk, "surviving");
  });
});

describe("processStreamEvent — branch coverage", () => {
  // ── init ──────────────────────────────────────────────────────────────────

  test("init event without sessionId produces no enqueue call (covers 37 false)", () => {
    const state = createStreamState();
    const messages: string[] = [];

    processStreamEvent({ type: "init" } as never, state, (m) =>
      messages.push(m)
    );

    assert.equal(messages.length, 0);
    assert.equal(state.capturedSessionId, null);
  });

  test("init event with sessionId sets state and enqueues sessionId message (covers 37 true)", () => {
    const state = createStreamState();
    const messages: string[] = [];

    processStreamEvent(
      { type: "init", sessionId: "sess-abc" } as never,
      state,
      (m) => messages.push(m)
    );

    assert.equal(messages.length, 1);
    const parsed = JSON.parse(messages[0]) as Record<string, unknown>;
    assert.equal(parsed.type, "sessionId");
    assert.equal(parsed.sessionId, "sess-abc");
    assert.equal(state.capturedSessionId, "sess-abc");
  });

  // ── assistant blocks ──────────────────────────────────────────────────────

  test("assistant message with tool_result block enqueues tool_result event (covers 64 true)", () => {
    const state = createStreamState();
    const messages: string[] = [];

    processStreamEvent(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tid-1",
              content: "output text",
              is_error: false,
            },
          ],
        },
      } as never,
      state,
      (m) => messages.push(m)
    );

    assert.equal(messages.length, 1);
    const parsed = JSON.parse(messages[0]) as Record<string, unknown>;
    assert.equal(parsed.type, "tool_result");
    assert.equal(parsed.id, "tid-1");
  });

  test("assistant message with thinking block (non-empty) enqueues thinking event (covers 83 true×2)", () => {
    const state = createStreamState();
    const messages: string[] = [];

    processStreamEvent(
      {
        type: "assistant",
        message: {
          content: [{ type: "thinking", thinking: "Let me reason..." }],
        },
      } as never,
      state,
      (m) => messages.push(m)
    );

    assert.equal(messages.length, 1);
    const parsed = JSON.parse(messages[0]) as Record<string, unknown>;
    assert.equal(parsed.type, "thinking");
    assert.equal(parsed.content, "Let me reason...");
  });

  test("assistant message with empty thinking skips enqueue (covers 83 second-condition false)", () => {
    const state = createStreamState();
    const messages: string[] = [];

    processStreamEvent(
      {
        type: "assistant",
        message: {
          content: [{ type: "thinking", thinking: "" }],
        },
      } as never,
      state,
      (m) => messages.push(m)
    );

    assert.equal(
      messages.length,
      0,
      "Empty thinking block should not produce an enqueued message"
    );
  });

  // ── user ──────────────────────────────────────────────────────────────────

  test("user event with tool_result block enqueues tool_result event (covers 105 true)", () => {
    const state = createStreamState();
    const messages: string[] = [];

    processStreamEvent(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "uid-1",
              content: "result",
              is_error: false,
            },
          ],
        },
      } as never,
      state,
      (m) => messages.push(m)
    );

    assert.equal(messages.length, 1);
    const parsed = JSON.parse(messages[0]) as Record<string, unknown>;
    assert.equal(parsed.type, "tool_result");
    assert.equal(parsed.id, "uid-1");
  });

  test("user event with non-tool_result blocks produces no output (covers 107 true → continue)", () => {
    const state = createStreamState();
    const messages: string[] = [];

    processStreamEvent(
      {
        type: "user",
        message: {
          content: [{ type: "text", text: "human message" }],
        },
      } as never,
      state,
      (m) => messages.push(m)
    );

    assert.equal(
      messages.length,
      0,
      "Non-tool_result user blocks should be skipped"
    );
  });

  // ── content_block_delta ───────────────────────────────────────────────────

  test("content_block_delta with empty/null text produces no enqueue (covers 126 false)", () => {
    const state = createStreamState();
    const messages: string[] = [];

    // delta.text is falsy ("")
    processStreamEvent(
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "" },
      } as never,
      state,
      (m) => messages.push(m)
    );

    assert.equal(
      messages.length,
      0,
      "Empty text delta should not enqueue anything"
    );
  });

  // ── result ────────────────────────────────────────────────────────────────

  test("result: session_id captured from result event when capturedSessionId is null (covers 134 true)", () => {
    const state = createStreamState();
    const messages: string[] = [];

    processStreamEvent(
      {
        type: "result",
        session_id: "sess-from-result",
        subtype: "success",
      } as never,
      state,
      (m) => messages.push(m)
    );

    assert.equal(state.capturedSessionId, "sess-from-result");
    const sessionMsg = messages
      .map((m) => JSON.parse(m) as Record<string, unknown>)
      .find((p) => p.type === "sessionId");
    assert.ok(sessionMsg !== undefined);
    assert.equal(sessionMsg.sessionId, "sess-from-result");
  });

  test("result: session_id ignored when capturedSessionId already set (covers 134 false)", () => {
    const state = createStreamState();
    state.capturedSessionId = "already-set";
    const messages: string[] = [];

    processStreamEvent(
      {
        type: "result",
        session_id: "different-session",
        subtype: "success",
      } as never,
      state,
      (m) => messages.push(m)
    );

    assert.equal(
      state.capturedSessionId,
      "already-set",
      "capturedSessionId must not be overwritten"
    );
    const sessionMsg = messages
      .map((m) => JSON.parse(m) as Record<string, unknown>)
      .find((p) => p.type === "sessionId");
    assert.equal(
      sessionMsg,
      undefined,
      "No sessionId event should be enqueued when one is already captured"
    );
  });

  test("result: is_error with non-string result uses fallback error text (covers 145 false→fallback)", () => {
    const state = createStreamState();
    const messages: string[] = [];

    processStreamEvent(
      { type: "result", is_error: true, result: 42 } as never,
      state,
      (m) => messages.push(m)
    );

    assert.equal(messages.length, 1);
    const parsed = JSON.parse(messages[0]) as Record<string, unknown>;
    assert.equal(parsed.type, "error");
    assert.equal(parsed.error, "Claude encountered an error");
  });

  test("result: is_error with AUTH_CHALLENGE_PATTERN match sets authChallengeDetected (covers 147 true)", () => {
    const state = createStreamState();
    const messages: string[] = [];

    processStreamEvent(
      {
        type: "result",
        is_error: true,
        result: "authentication required: invalid bearer token",
      } as never,
      state,
      (m) => messages.push(m)
    );

    assert.equal(
      state.authChallengeDetected,
      true,
      "authChallengeDetected must be set when error matches AUTH_CHALLENGE_PATTERN"
    );
  });

  test("result: is_error=false with no subtype → success:false result (covers 145 false, 157 false, 171)", () => {
    const state = createStreamState();
    const messages: string[] = [];

    processStreamEvent({ type: "result" } as never, state, (m) =>
      messages.push(m)
    );

    assert.equal(messages.length, 1);
    const parsed = JSON.parse(messages[0]) as Record<string, unknown>;
    assert.equal(parsed.type, "result");
    assert.equal(parsed.success, false);
  });

  test("result: subtype='success' with no usage skips usage enqueue (covers 158 false)", () => {
    const state = createStreamState();
    const messages: string[] = [];

    processStreamEvent(
      { type: "result", subtype: "success" } as never,
      state,
      (m) => messages.push(m)
    );

    const types = messages.map(
      (m) => (JSON.parse(m) as Record<string, unknown>).type
    );
    assert.ok(
      !types.includes("usage"),
      "No usage event when event.usage is absent"
    );
    assert.ok(types.includes("result"), "result event must still be emitted");
    const resultMsg = messages
      .map((m) => JSON.parse(m) as Record<string, unknown>)
      .find((p) => p.type === "result");
    assert.ok(resultMsg !== undefined);
    assert.equal(resultMsg.success, true);
  });

  test("result: subtype='success' with contextWindow=0 sets contextPercent=0 (covers 163 false)", () => {
    const state = createStreamState();
    const messages: string[] = [];

    processStreamEvent(
      {
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        context_window: 0, // causes contextWindow > 0 to be false → percent = 0
      } as never,
      state,
      (m) => messages.push(m)
    );

    assert.equal(state.contextPercent, 0);
    const usageMsg = messages
      .map((m) => JSON.parse(m) as Record<string, unknown>)
      .find((p) => p.type === "usage");
    assert.ok(usageMsg !== undefined);
    assert.equal(usageMsg.contextPercent, 0);
  });
});
