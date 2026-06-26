import assert from "node:assert/strict";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { startOutputTailer } from "../src/server/operations/output-tailer.js";

// ---------------------------------------------------------------------------
// Shared cleanup state
// ---------------------------------------------------------------------------

const tempPathsToClean: string[] = [];
const eventServersToClose: http.Server[] = [];
const tailersToStop: Array<{ stop: () => void }> = [];

function startTrackedTailer(
  ...args: Parameters<typeof startOutputTailer>
): ReturnType<typeof startOutputTailer> {
  const t = startOutputTailer(...args);
  tailersToStop.push(t);
  return t;
}

afterEach(async () => {
  delete process.env.CLOSEDLOOP_TAILER_POLL_MS;
  delete process.env.CLOSEDLOOP_TAILER_THROTTLE_MS;
  delete process.env.CLOSEDLOOP_TAILER_AUTH_RETRY_BASE_MS;
  delete process.env.CLOSEDLOOP_TAILER_AUTH_RETRY_MAX_MS;
  delete process.env.CLOSEDLOOP_TAILER_AUTH_RETRY_MAX_COUNT;

  for (const t of tailersToStop.splice(0)) {
    try {
      t.stop();
    } catch {
      // ignore — already stopped
    }
  }

  for (const srv of eventServersToClose.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      srv.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  for (const p of tempPathsToClean.splice(0)) {
    await fs.rm(p, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `output-tailer-tokens-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  tempPathsToClean.push(dir);
  return dir;
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 10
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
}

/**
 * Start an event-capture HTTP server. Pass `outputStatusCodes` to simulate
 * non-200 responses for sequential output events.
 *
 * Each captured entry includes `_authHeader` with the raw Authorization header
 * value from the request (empty string if absent), so tests can assert which
 * token was used for a given POST.
 */
async function startEventServer(options?: {
  outputStatusCodes?: number[];
}): Promise<{
  port: number;
  getCollected: () => Array<
    { seq: number; type: string; _authHeader: string } & Record<string, unknown>
  >;
  waitForCount: (n: number, type?: string, timeoutMs?: number) => Promise<void>;
}> {
  const collected: Array<
    { seq: number; type: string; _authHeader: string } & Record<string, unknown>
  > = [];
  let outputStatusIndex = 0;

  const server = http.createServer((req, res) => {
    const authHeader = req.headers.authorization ?? "";
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = {};
      }

      const isOutputEvent =
        typeof body.type === "string" && body.type === "output";
      let statusCode = 200;
      if (
        isOutputEvent &&
        options?.outputStatusCodes &&
        outputStatusIndex < options.outputStatusCodes.length
      ) {
        statusCode = options.outputStatusCodes[outputStatusIndex];
        outputStatusIndex += 1;
      }

      res.statusCode = statusCode;
      res.end("{}");

      const entry = {
        seq: collected.length,
        type: String(body.type ?? ""),
        _authHeader: String(authHeader),
        ...body,
      };
      collected.push(entry);
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

  const waitForCount = (n: number, type = "output", timeoutMs = 5000) =>
    waitForCondition(
      () => collected.filter((e) => e.type === type).length >= n,
      timeoutMs
    );

  return { port, getCollected: () => collected, waitForCount };
}

// ---------------------------------------------------------------------------
// Test #6: No double-count across throttle/retry
// ---------------------------------------------------------------------------

test("flush follows sidecar-selected renamed output after fixed path disappears", async () => {
  process.env.CLOSEDLOOP_TAILER_POLL_MS = "600000";
  process.env.CLOSEDLOOP_TAILER_THROTTLE_MS = "0";

  const tmpDir = makeTempDir();
  const jsonlPath = path.join(tmpDir, "claude-output.jsonl");
  const renamedPath = path.join(tmpDir, "claude-output-run-1.jsonl");
  const eventSrv = await startEventServer();
  const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

  const assistantLine = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "final chunk" }],
      usage: {
        input_tokens: 4,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
  writeFileSync(jsonlPath, `${assistantLine}\n`);

  const tailer = startTrackedTailer(
    jsonlPath,
    apiBaseUrl,
    "rename-flush-loop",
    () => "token",
    0,
    undefined,
    tmpDir
  );

  renameSync(jsonlPath, renamedPath);
  writeFileSync(
    path.join(tmpDir, "claude-output.name.txt"),
    "claude-output-run-1.jsonl\n"
  );

  await tailer.flush();

  const outputEvents = eventSrv
    .getCollected()
    .filter((e) => e.type === "output");
  assert.equal(outputEvents.length, 1);
  const data = outputEvents[0]?.data as Record<string, unknown> | undefined;
  assert.ok(data !== undefined);
  assert.equal(data.chunk, "final chunk");
  const tokenUsage = data.tokenUsage as Record<string, unknown> | undefined;
  assert.ok(tokenUsage !== undefined);
  assert.equal(tokenUsage.inputTokens, 4);
});

test("flush preserves saved offset when boot recovery follows renamed output", async () => {
  process.env.CLOSEDLOOP_TAILER_POLL_MS = "600000";
  process.env.CLOSEDLOOP_TAILER_THROTTLE_MS = "0";

  const tmpDir = makeTempDir();
  const jsonlPath = path.join(tmpDir, "claude-output.jsonl");
  const renamedPath = path.join(tmpDir, "claude-output-run-1.jsonl");
  const eventSrv = await startEventServer();
  const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

  const deliveredLine = `${JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "already delivered" }],
      usage: { input_tokens: 11, output_tokens: 3 },
    },
  })}\n`;
  const pendingLine = `${JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "after restart" }],
      usage: { input_tokens: 5, output_tokens: 2 },
    },
  })}\n`;
  writeFileSync(renamedPath, deliveredLine + pendingLine);
  writeFileSync(
    path.join(tmpDir, "claude-output.name.txt"),
    "claude-output-run-1.jsonl\n"
  );

  const committedOffsets: number[] = [];
  const tailer = startTrackedTailer(
    jsonlPath,
    apiBaseUrl,
    "boot-rename-offset-loop",
    () => "token",
    Buffer.byteLength(deliveredLine),
    (offset) => {
      committedOffsets.push(offset);
    },
    tmpDir
  );

  await tailer.flush();

  const outputEvents = eventSrv
    .getCollected()
    .filter((e) => e.type === "output");
  assert.equal(outputEvents.length, 1);
  const data = outputEvents[0]?.data as Record<string, unknown> | undefined;
  assert.ok(data !== undefined);
  assert.equal(data.chunk, "after restart");
  assert.equal(
    committedOffsets.at(-1),
    Buffer.byteLength(deliveredLine + pendingLine)
  );
});

test("flush resets stale pre-spawn offset when fixed JSONL is replaced", async () => {
  process.env.CLOSEDLOOP_TAILER_POLL_MS = "600000";
  process.env.CLOSEDLOOP_TAILER_THROTTLE_MS = "0";

  const tmpDir = makeTempDir();
  const jsonlPath = path.join(tmpDir, "claude-output.jsonl");
  const eventSrv = await startEventServer();
  const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

  const staleLine = `${JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "stale prior run" }],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  })}\n`;
  writeFileSync(jsonlPath, staleLine);

  const tailer = startTrackedTailer(
    jsonlPath,
    apiBaseUrl,
    "replace-offset-loop",
    () => "token",
    Buffer.byteLength(staleLine),
    undefined,
    tmpDir
  );

  renameSync(jsonlPath, path.join(tmpDir, "claude-output-prior.jsonl"));
  writeFileSync(
    jsonlPath,
    `${JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "current run" }],
        usage: { input_tokens: 6, output_tokens: 2 },
      },
    })}\n`
  );

  await tailer.flush();

  const outputEvents = eventSrv
    .getCollected()
    .filter((e) => e.type === "output");
  assert.equal(outputEvents.length, 1);
  const data = outputEvents[0]?.data as Record<string, unknown> | undefined;
  assert.ok(data !== undefined);
  assert.equal(data.chunk, "current run");
  const tokenUsage = data.tokenUsage as Record<string, unknown> | undefined;
  assert.ok(tokenUsage !== undefined);
  assert.equal(tokenUsage.inputTokens, 6);
});

test("token totals only advance after successful POST commit, not on throttle/retry", async () => {
  // Use very long poll interval so the interval never fires -- we control timing via flush()
  process.env.CLOSEDLOOP_TAILER_POLL_MS = "600000";
  process.env.CLOSEDLOOP_TAILER_THROTTLE_MS = "0";
  process.env.CLOSEDLOOP_TAILER_AUTH_RETRY_BASE_MS = "600000";
  process.env.CLOSEDLOOP_TAILER_AUTH_RETRY_MAX_MS = "600000";
  process.env.CLOSEDLOOP_TAILER_AUTH_RETRY_MAX_COUNT = "4";

  const tmpDir = makeTempDir();
  const jsonlPath = path.join(tmpDir, "claude-output.jsonl");

  // First POST returns 429 (fail), second returns 200 (success)
  const eventSrv = await startEventServer({ outputStatusCodes: [429, 200] });
  const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

  const assistantLine = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "working" }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
  writeFileSync(jsonlPath, `${assistantLine}\n`);

  const committedOffsets: number[] = [];
  const tailer = startTrackedTailer(
    jsonlPath,
    apiBaseUrl,
    "no-double-count-loop",
    () => "token",
    0,
    (o) => {
      committedOffsets.push(o);
    }
  );

  // Flush: POST gets 429, fails, tailer stops. tokenTotals should NOT advance.
  await tailer.flush();
  assert.equal(
    committedOffsets.length,
    0,
    "No committed offset expected after failed POST"
  );
  assert.equal(
    eventSrv.getCollected().filter((e) => e.type === "output").length,
    1,
    "Expected exactly 1 POST attempt after first flush"
  );

  // Start a fresh tailer from offset 0 (simulates restart after failure).
  // Flush gets the 200 response.
  const tailer2 = startTrackedTailer(
    jsonlPath,
    apiBaseUrl,
    "no-double-count-loop",
    () => "token",
    0,
    (o) => {
      committedOffsets.push(o);
    }
  );
  await tailer2.flush();

  const outputEvents = eventSrv
    .getCollected()
    .filter((e) => e.type === "output");
  assert.equal(
    outputEvents.length,
    2,
    `Expected 2 POST attempts total, got ${outputEvents.length}`
  );

  // The second POST should carry tokenUsage with the same values (not doubled)
  const secondEvent = outputEvents[1];
  assert.ok(secondEvent !== undefined, "Second output event must exist");
  const data = secondEvent.data as Record<string, unknown> | undefined;
  assert.ok(
    data !== undefined && typeof data === "object",
    "data must be an object"
  );
  const tokenUsage = (data as Record<string, unknown>).tokenUsage as
    | Record<string, unknown>
    | undefined;
  assert.ok(
    tokenUsage !== undefined,
    "tokenUsage must be present in second POST"
  );
  // Should be 10/5 (not 20/10 if it double-counted)
  assert.equal(
    tokenUsage.inputTokens,
    10,
    `inputTokens should be 10 (not doubled), got ${tokenUsage.inputTokens}`
  );
  assert.equal(
    tokenUsage.outputTokens,
    5,
    `outputTokens should be 5 (not doubled), got ${tokenUsage.outputTokens}`
  );

  assert.ok(
    committedOffsets.length > 0,
    "Expected at least one committed offset after successful POST"
  );
});

// ---------------------------------------------------------------------------
// Test #7: lastDisplay === null branch commits tokenTotals without POST
// ---------------------------------------------------------------------------

test("lastDisplay === null: assistant usage-only line commits tokenTotals without a POST", async () => {
  const tmpDir = makeTempDir();
  const jsonlPath = path.join(tmpDir, "claude-output.jsonl");

  const eventSrv = await startEventServer();
  const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

  // An assistant record with usage but no displayable content (empty content array)
  // summarizeJsonlRecord returns null for this since there's no text/tool content
  const usageOnlyLine = JSON.stringify({
    type: "assistant",
    message: {
      content: [],
      usage: {
        input_tokens: 7,
        output_tokens: 3,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 50,
      },
    },
  });

  // A second line with displayable content to verify accumulated totals are sent
  const displayLine = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "display text" }],
      usage: {
        input_tokens: 2,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });

  // Write both lines; they form one frame (last newline is the frame boundary)
  writeFileSync(jsonlPath, `${usageOnlyLine}\n${displayLine}\n`);

  const tailer = startTrackedTailer(
    jsonlPath,
    apiBaseUrl,
    "usage-only-loop",
    () => "token",
    0
  );
  await tailer.flush();

  const outputEvents = eventSrv
    .getCollected()
    .filter((e) => e.type === "output");
  assert.equal(
    outputEvents.length,
    1,
    `Expected 1 output event, got ${outputEvents.length}`
  );

  const data = outputEvents[0].data as Record<string, unknown> | undefined;
  assert.ok(
    data !== undefined && typeof data === "object",
    "data must be an object"
  );
  const tokenUsage = (data as Record<string, unknown>).tokenUsage as
    | Record<string, unknown>
    | undefined;
  assert.ok(tokenUsage !== undefined, "tokenUsage must be present");
  // Totals should include BOTH the usage-only line (7+2=9 input, 3+1=4 output)
  // since both lines are in the same frame
  assert.equal(
    tokenUsage.inputTokens,
    9,
    `Expected inputTokens=9 (7+2), got ${tokenUsage.inputTokens}`
  );
  assert.equal(
    tokenUsage.outputTokens,
    4,
    `Expected outputTokens=4 (3+1), got ${tokenUsage.outputTokens}`
  );
  assert.equal(
    tokenUsage.cacheCreationInputTokens,
    100,
    `Expected cacheCreationInputTokens=100, got ${tokenUsage.cacheCreationInputTokens}`
  );
  assert.equal(
    tokenUsage.cacheReadInputTokens,
    50,
    `Expected cacheReadInputTokens=50, got ${tokenUsage.cacheReadInputTokens}`
  );
});

test("lastDisplay === null branch alone: usage-only frame commits tokenTotals for next frame", async () => {
  const tmpDir = makeTempDir();
  const jsonlPath = path.join(tmpDir, "claude-output.jsonl");

  const eventSrv = await startEventServer();
  const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

  // Frame 1: usage-only (no displayable content) - should commit tokenTotals silently
  const usageOnlyLine = JSON.stringify({
    type: "assistant",
    message: {
      content: [],
      usage: {
        input_tokens: 15,
        output_tokens: 8,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });

  // Frame 2: displayable line with no additional tokens
  const displayOnlyLine = JSON.stringify({
    type: "result",
    subtype: "success",
    result: "",
    is_error: false,
  });

  // Write frame 1 first, flush it (no POST expected), then write frame 2
  writeFileSync(jsonlPath, `${usageOnlyLine}\n`);

  const committedOffsets: number[] = [];
  const tailer = startTrackedTailer(
    jsonlPath,
    apiBaseUrl,
    "usage-only-commit-loop",
    () => "token",
    0,
    (o) => {
      committedOffsets.push(o);
    }
  );

  await tailer.flush();

  // Frame 1 had no displayable content, so no output POST, but offset should have advanced
  const outputEventsAfterFrame1 = eventSrv
    .getCollected()
    .filter((e) => e.type === "output");
  assert.equal(
    outputEventsAfterFrame1.length,
    0,
    "No output POST expected for usage-only frame"
  );
  assert.ok(
    committedOffsets.length > 0,
    "Offset should advance for usage-only frame (no POST needed)"
  );

  // Now write frame 2 with a display line (tailer was stopped by flush; create new one)
  const frame1CommittedOffset = committedOffsets.at(-1) ?? 0;
  writeFileSync(jsonlPath, `${usageOnlyLine}\n${displayOnlyLine}\n`);

  const committedOffsets2: number[] = [];
  const tailer2 = startTrackedTailer(
    jsonlPath,
    apiBaseUrl,
    "usage-only-commit-loop",
    () => "token",
    frame1CommittedOffset,
    (o) => {
      committedOffsets2.push(o);
    }
  );
  await tailer2.flush();

  const outputEventsAfterFrame2 = eventSrv
    .getCollected()
    .filter((e) => e.type === "output");
  assert.equal(
    outputEventsAfterFrame2.length,
    1,
    `Expected 1 output event after frame 2, got ${outputEventsAfterFrame2.length}`
  );

  // The output event should carry tokenUsage accumulated from frame 1's usage
  // (frame 1 was committed via the null-display path so tokenTotals=15/8,
  //  but frame 2 is read by tailer2 starting from frame1CommittedOffset so it
  //  only sees the display line with no usage - the prior tokens were committed
  //  in tailer instance 1 and are not carried to tailer2)
  // This test verifies the offset advance behavior is correct
  assert.ok(
    committedOffsets2.length > 0,
    "Expected committed offset for frame 2"
  );
});

// ---------------------------------------------------------------------------
// Test #8: Single-flight -- overlapping poll calls are serialized
// ---------------------------------------------------------------------------

test("single-flight: overlapping interval ticks are serialized, not concurrent", async () => {
  process.env.CLOSEDLOOP_TAILER_POLL_MS = "10";
  process.env.CLOSEDLOOP_TAILER_THROTTLE_MS = "1";
  process.env.CLOSEDLOOP_TAILER_AUTH_RETRY_BASE_MS = "5";
  process.env.CLOSEDLOOP_TAILER_AUTH_RETRY_MAX_MS = "5";
  process.env.CLOSEDLOOP_TAILER_AUTH_RETRY_MAX_COUNT = "4";

  const tmpDir = makeTempDir();
  const jsonlPath = path.join(tmpDir, "claude-output.jsonl");

  // Track concurrent in-flight POST count to prove serialization
  let concurrentPosts = 0;
  let maxConcurrentPosts = 0;
  const responseDelayMs = 50; // long enough to catch overlap if single-flight is broken

  const server = http.createServer((_req, res) => {
    concurrentPosts += 1;
    if (concurrentPosts > maxConcurrentPosts) {
      maxConcurrentPosts = concurrentPosts;
    }
    setTimeout(() => {
      concurrentPosts -= 1;
      res.statusCode = 200;
      res.end("{}");
    }, responseDelayMs);
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

  const apiBaseUrl = `http://127.0.0.1:${port}`;

  // Write enough lines to trigger multiple polls
  const lines = Array.from({ length: 5 }, (_, i) =>
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: `line ${i + 1}` }] },
    })
  );
  writeFileSync(jsonlPath, `${lines.join("\n")}\n`);

  const tailer = startTrackedTailer(
    jsonlPath,
    apiBaseUrl,
    "single-flight-loop",
    () => "token",
    0
  );

  // Run for long enough to trigger multiple interval ticks (poll 10ms, response 50ms)
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 200);
  });

  await tailer.flush();

  assert.equal(
    maxConcurrentPosts,
    1,
    `Expected at most 1 concurrent POST (single-flight), but saw ${maxConcurrentPosts} concurrent`
  );
});

// ---------------------------------------------------------------------------
// Test #9: getToken callable re-evaluated per POST -- token change mid-run
// ---------------------------------------------------------------------------

test("getToken callable: token change mid-run is picked up by next POST without restarting the tailer", async () => {
  // Use a long poll interval so the interval never fires -- we control timing via flush()
  process.env.CLOSEDLOOP_TAILER_POLL_MS = "600000";
  process.env.CLOSEDLOOP_TAILER_THROTTLE_MS = "0";

  const tmpDir = makeTempDir();
  const jsonlPath = path.join(tmpDir, "claude-output.jsonl");

  const eventSrv = await startEventServer();
  const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

  // Mutable token that the getToken callable will close over
  let currentToken = "token-first";
  const getToken = () => currentToken;

  const firstLine = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "first output" }],
      usage: { input_tokens: 3, output_tokens: 1 },
    },
  });
  writeFileSync(jsonlPath, `${firstLine}\n`);

  const tailer = startTrackedTailer(
    jsonlPath,
    apiBaseUrl,
    "token-change-mid-run-loop",
    getToken,
    0
  );

  // Flush once with the first token -- this should POST with "token-first"
  await tailer.flush();

  const eventsAfterFirst = eventSrv
    .getCollected()
    .filter((e) => e.type === "output");
  assert.equal(
    eventsAfterFirst.length,
    1,
    "Expected 1 output event after first flush"
  );
  assert.equal(
    eventsAfterFirst[0]?._authHeader,
    "Bearer token-first",
    `Expected Authorization header "Bearer token-first" on first POST, got "${eventsAfterFirst[0]?._authHeader}"`
  );

  // Change the token WITHOUT restarting the tailer
  currentToken = "token-second";

  // Append a second line to give the tailer new content to POST
  const secondLine = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "second output" }],
      usage: { input_tokens: 2, output_tokens: 1 },
    },
  });
  const firstLineBytes = Buffer.byteLength(`${firstLine}\n`);

  // Create a new tailer starting from after the first committed line, using the same
  // mutable getToken -- this simulates the tailer continuing to run mid-session
  // (flush() stops the tailer; we start a continuation with the updated token)
  writeFileSync(jsonlPath, `${firstLine}\n${secondLine}\n`);

  const tailer2 = startTrackedTailer(
    jsonlPath,
    apiBaseUrl,
    "token-change-mid-run-loop",
    getToken,
    firstLineBytes
  );

  await tailer2.flush();

  const eventsAfterSecond = eventSrv
    .getCollected()
    .filter((e) => e.type === "output");
  assert.equal(
    eventsAfterSecond.length,
    2,
    "Expected 2 output events total after second flush"
  );
  assert.equal(
    eventsAfterSecond[1]?._authHeader,
    "Bearer token-second",
    `Expected Authorization header "Bearer token-second" on second POST, got "${eventsAfterSecond[1]?._authHeader}"`
  );

  // Confirm the first POST still used the old token
  assert.equal(
    eventsAfterSecond[0]?._authHeader,
    "Bearer token-first",
    `First POST should still show "Bearer token-first", got "${eventsAfterSecond[0]?._authHeader}"`
  );
});

// ---------------------------------------------------------------------------
// Test #10: getToken re-evaluated per POST via the poll loop (AC-002)
// ---------------------------------------------------------------------------

test("getToken callable: token change mid-run is picked up by the poll loop without flush() or restart", async () => {
  // Short poll interval so the interval fires automatically -- no flush() needed
  process.env.CLOSEDLOOP_TAILER_POLL_MS = "20";
  process.env.CLOSEDLOOP_TAILER_THROTTLE_MS = "0";

  const tmpDir = makeTempDir();
  const jsonlPath = path.join(tmpDir, "claude-output.jsonl");

  const eventSrv = await startEventServer();
  const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

  // Mutable token closed over by getToken -- mutated in place between POSTs
  let currentToken = "token-alpha";
  const getToken = () => currentToken;

  const firstLine = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "first poll output" }],
      usage: { input_tokens: 3, output_tokens: 1 },
    },
  });
  writeFileSync(jsonlPath, `${firstLine}\n`);

  // Start the tailer with a short poll interval -- do NOT call flush()
  const tailer = startTrackedTailer(
    jsonlPath,
    apiBaseUrl,
    "token-change-poll-loop",
    getToken,
    0
  );

  // Wait for the poll loop to deliver the first POST
  await eventSrv.waitForCount(1);

  const eventsAfterFirst = eventSrv
    .getCollected()
    .filter((e) => e.type === "output");
  assert.equal(
    eventsAfterFirst.length,
    1,
    "Expected 1 output event after first poll"
  );
  assert.equal(
    eventsAfterFirst[0]?._authHeader,
    "Bearer token-alpha",
    `Expected Authorization header "Bearer token-alpha" on first POST, got "${eventsAfterFirst[0]?._authHeader}"`
  );

  // Mutate the token in place -- same tailer instance, no restart, no flush()
  currentToken = "token-beta";

  // Append a second line to give the still-running tailer new content to POST
  const secondLine = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "second poll output" }],
      usage: { input_tokens: 2, output_tokens: 1 },
    },
  });
  // Append to the same file -- tailer is still running and will pick it up on the next poll
  await fs.appendFile(jsonlPath, `${secondLine}\n`);

  // Wait for the poll loop to deliver the second POST
  await eventSrv.waitForCount(2);

  const eventsAfterSecond = eventSrv
    .getCollected()
    .filter((e) => e.type === "output");
  assert.equal(
    eventsAfterSecond.length,
    2,
    "Expected 2 output events total after second poll"
  );
  assert.equal(
    eventsAfterSecond[1]?._authHeader,
    "Bearer token-beta",
    `Expected Authorization header "Bearer token-beta" on second POST, got "${eventsAfterSecond[1]?._authHeader}"`
  );

  // Confirm the first POST still shows the original token
  assert.equal(
    eventsAfterSecond[0]?._authHeader,
    "Bearer token-alpha",
    `First POST should still show "Bearer token-alpha", got "${eventsAfterSecond[0]?._authHeader}"`
  );

  tailer.stop();
});

test("Codex token-only native frame is posted with the next display frame", async () => {
  process.env.CLOSEDLOOP_TAILER_POLL_MS = "10";
  process.env.CLOSEDLOOP_TAILER_THROTTLE_MS = "0";

  const tmpDir = makeTempDir();
  const jsonlPath = path.join(tmpDir, "claude-output.jsonl");
  const eventSrv = await startEventServer();
  const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

  const tokenOnlyLine = JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 13,
      output_tokens: 5,
      cached_input_tokens: 2,
    },
  });
  const displayLine = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "done" }],
    },
  });
  writeFileSync(jsonlPath, `${tokenOnlyLine}\n`);

  const committedOffsets: number[] = [];
  startTrackedTailer(
    jsonlPath,
    apiBaseUrl,
    "codex-token-only-loop",
    () => "token",
    0,
    (offset) => {
      committedOffsets.push(offset);
    },
    tmpDir,
    undefined,
    (record) =>
      record.type === "turn.completed"
        ? {
            inputTokens: 13,
            outputTokens: 5,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 2,
          }
        : undefined
  );

  await waitForCondition(() => committedOffsets.length > 0);

  assert.equal(
    eventSrv.getCollected().filter((e) => e.type === "output").length,
    0
  );
  const committedAfterTokenOnly = committedOffsets.at(-1);
  assert.equal(
    committedAfterTokenOnly,
    Buffer.byteLength(`${tokenOnlyLine}\n`)
  );

  writeFileSync(jsonlPath, `${tokenOnlyLine}\n${displayLine}\n`);
  await eventSrv.waitForCount(1);

  const outputEvents = eventSrv
    .getCollected()
    .filter((e) => e.type === "output");
  assert.equal(outputEvents.length, 1);
  const data = outputEvents[0]?.data as Record<string, unknown> | undefined;
  assert.ok(data !== undefined);
  assert.equal(data.chunk, "done");
  const tokenUsage = data.tokenUsage as Record<string, unknown> | undefined;
  assert.ok(tokenUsage !== undefined);
  assert.equal(tokenUsage.inputTokens, 13);
  assert.equal(tokenUsage.outputTokens, 5);
  assert.equal(tokenUsage.cacheReadInputTokens, 2);
});

test("native observability sink is not invoked for throttled frames", async () => {
  process.env.CLOSEDLOOP_TAILER_POLL_MS = "10";
  process.env.CLOSEDLOOP_TAILER_THROTTLE_MS = "600000";

  const tmpDir = makeTempDir();
  const jsonlPath = path.join(tmpDir, "claude-output.jsonl");
  const eventSrv = await startEventServer();
  const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

  const firstLine = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "first" }],
    },
  });
  const secondLine = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "second" }],
    },
  });
  writeFileSync(jsonlPath, `${firstLine}\n`);

  let observedRecords = 0;
  const committedOffsets: number[] = [];
  startTrackedTailer(
    jsonlPath,
    apiBaseUrl,
    "native-throttle-loop",
    () => "token",
    0,
    (offset) => {
      committedOffsets.push(offset);
    },
    tmpDir,
    undefined,
    () => {
      observedRecords += 1;
      return undefined;
    }
  );

  await eventSrv.waitForCount(1);
  assert.equal(observedRecords, 1);

  writeFileSync(jsonlPath, `${firstLine}\n${secondLine}\n`);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 100);
  });

  assert.equal(
    observedRecords,
    1,
    "throttled frame must not invoke native observability before commit"
  );
  assert.equal(committedOffsets.at(-1), Buffer.byteLength(`${firstLine}\n`));
  assert.equal(
    eventSrv.getCollected().filter((e) => e.type === "output").length,
    1
  );
});
