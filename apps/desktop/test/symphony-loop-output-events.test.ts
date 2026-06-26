import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import {
  startOutputTailer,
  summarizeJsonlRecord,
} from "../src/server/operations/output-tailer.js";
import { DesktopGatewayServer } from "../src/server/server.js";
import {
  resetShellPathCache,
  setShellPathForTest,
} from "../src/server/shell-path.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";

// ---------------------------------------------------------------------------
// Shared cleanup state
// ---------------------------------------------------------------------------

const tempPathsToClean: string[] = [];
const serversToClose: DesktopGatewayServer[] = [];
const eventServersToClose: http.Server[] = [];
const originalPath = process.env.PATH;
const originalHome = process.env.HOME;

// NOTE: We do NOT set CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE globally.
// Tests that need the raw pipeline (no formatter) set it per-test.

afterEach(async () => {
  // Restore PATH
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  resetShellPathCache();

  // Restore HOME
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  // Restore raw pipeline env var and tailer overrides (tests may set individually)
  delete process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE;
  delete process.env.CLOSEDLOOP_TAILER_POLL_MS;
  delete process.env.CLOSEDLOOP_TAILER_THROTTLE_MS;
  delete process.env.CLOSEDLOOP_TAILER_AUTH_RETRY_BASE_MS;
  delete process.env.CLOSEDLOOP_TAILER_AUTH_RETRY_MAX_MS;
  delete process.env.CLOSEDLOOP_TAILER_AUTH_RETRY_MAX_COUNT;

  for (const server of serversToClose.splice(0)) {
    await server.stop();
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
    `output-events-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

function makeGatewayServer(options?: {
  allowedDirs?: string[];
  tmpDir?: string;
  getApiOrigin?: () => string;
}): DesktopGatewayServer {
  const tmpDir = options?.tmpDir ?? makeTempDir();
  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getGatewayAuthToken: () => "test-token",
    getApiOrigin: options?.getApiOrigin ?? (() => "http://127.0.0.1:49152"),
    getAllowedDirectories: () => options?.allowedDirs ?? [os.tmpdir()],
    machineName: "output-events-test-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  return server;
}

/**
 * Start an event-capture HTTP server on a random port (port 0).
 * The `collected` array tracks events in sequence order.
 * Pass `outputStatusCode` or `outputStatusCodes` to simulate non-200 output event responses.
 */
async function startEventServer(options?: {
  outputStatusCode?: number;
  outputStatusCodes?: number[];
}): Promise<{
  port: number;
  getCollected: () => Array<
    { seq: number; type: string } & Record<string, unknown>
  >;
  waitForEvent: (
    predicate: (body: Record<string, unknown>) => boolean,
    timeoutMs?: number
  ) => Promise<Record<string, unknown>>;
}> {
  const collected: Array<
    { seq: number; type: string } & Record<string, unknown>
  > = [];
  const waiters: Array<{
    predicate: (b: Record<string, unknown>) => boolean;
    resolve: (b: Record<string, unknown>) => void;
    reject: (e: Error) => void;
  }> = [];
  let outputStatusIndex = 0;

  const server = http.createServer((req, res) => {
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

      // Decide status code
      const isOutputEvent =
        typeof body.type === "string" && body.type === "output";
      let statusCode = 200;
      if (isOutputEvent) {
        if (
          options?.outputStatusCodes &&
          outputStatusIndex < options.outputStatusCodes.length
        ) {
          statusCode = options.outputStatusCodes[outputStatusIndex];
          outputStatusIndex += 1;
        } else if (options?.outputStatusCode !== undefined) {
          statusCode = options.outputStatusCode;
        }
      }

      res.statusCode = statusCode;
      res.end("{}");

      // Track the event with sequence number
      const entry = {
        seq: collected.length,
        type: String(body.type ?? ""),
        ...body,
      };
      collected.push(entry);

      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        if (waiter.predicate(entry)) {
          waiters.splice(i, 1);
          waiter.resolve(entry);
        }
      }
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

  const waitForEvent = (
    predicate: (b: Record<string, unknown>) => boolean,
    timeoutMs = 10_000
  ) => {
    const existing = collected.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) {
          waiters.splice(idx, 1);
        }
        reject(
          new Error(
            `waitForEvent timed out after ${timeoutMs}ms. Collected so far: ${JSON.stringify(collected)}`
          )
        );
      }, timeoutMs);

      waiters.push({
        predicate,
        resolve: (b) => {
          clearTimeout(timer);
          resolve(b);
        },
        reject,
      });
    });
  };

  return {
    port,
    getCollected: () => collected,
    waitForEvent,
  };
}

/** Build a valid EVALUATE_PRD request body. */
function buildLoopBody(
  overrides?: Partial<Record<string, unknown>>
): Record<string, unknown> {
  return {
    loopId: "aaaaaaaa-0000-0000-0000-000000000001",
    command: LoopCommand.EvaluatePrd,
    closedLoopAuthToken: "cl-token",
    apiBaseUrl: "https://api.example.com",
    artifacts: [{ type: "PRD", content: "PRD content for output test" }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// T-2.3: Unit tests for summarizeJsonlRecord
// ---------------------------------------------------------------------------

describe("T-2.3: summarizeJsonlRecord", () => {
  test("assistant/text: returns text content", () => {
    const record = {
      type: "assistant",
      message: { content: [{ type: "text", text: "hello world" }] },
    };
    assert.equal(summarizeJsonlRecord(record), "hello world");
  });

  test("assistant/text truncation: 201-char text ends with '...' and length 203", () => {
    const longText = "a".repeat(201);
    const record = {
      type: "assistant",
      message: { content: [{ type: "text", text: longText }] },
    };
    const result = summarizeJsonlRecord(record);
    assert.ok(result !== null, "result should not be null");
    assert.ok(
      result!.endsWith("..."),
      `Expected result to end with '...', got: ${result}`
    );
    assert.equal(result!.length, 203);
  });

  test("assistant/tool_use: returns 'Tool: <name>'", () => {
    const record = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read" }] },
    };
    assert.equal(summarizeJsonlRecord(record), "Tool: Read");
  });

  test("assistant/thinking: returns 'Thinking...'", () => {
    const record = {
      type: "assistant",
      message: { content: [{ type: "thinking" }] },
    };
    assert.equal(summarizeJsonlRecord(record), "Thinking...");
  });

  test("user/tool_result success: returns 'Tool result'", () => {
    const record = {
      type: "user",
      message: { content: [{ type: "tool_result" }] },
    };
    assert.equal(summarizeJsonlRecord(record), "Tool result");
  });

  test("user/tool_result error: returns 'Tool error'", () => {
    const record = {
      type: "user",
      message: { content: [{ type: "tool_result", is_error: true }] },
    };
    assert.equal(summarizeJsonlRecord(record), "Tool error");
  });

  test("content_block_delta/text_delta: returns delta text", () => {
    const record = {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "hi" },
    };
    assert.equal(summarizeJsonlRecord(record), "hi");
  });

  test("result/success: returns 'Turn complete'", () => {
    const record = {
      type: "result",
      subtype: "success",
      result: "",
      is_error: false,
    };
    assert.equal(summarizeJsonlRecord(record), "Turn complete");
  });

  test("result/error: returns 'Error: <message>'", () => {
    const record = {
      type: "result",
      subtype: "error",
      result: "oops",
      is_error: true,
    };
    assert.equal(summarizeJsonlRecord(record), "Error: oops");
  });

  test("unknown type: returns null", () => {
    const record = { type: "unknown_type_xyz" };
    assert.equal(summarizeJsonlRecord(record), null);
  });

  test("redaction: sensitive key is replaced with [REDACTED]", () => {
    const sensitiveText = "Here is my key: sk-ant-abc123xyz";
    const record = {
      type: "assistant",
      message: { content: [{ type: "text", text: sensitiveText }] },
    };
    const result = summarizeJsonlRecord(record);
    assert.ok(result !== null, "result should not be null");
    assert.ok(
      result!.includes("[REDACTED]"),
      `Expected [REDACTED] in result, got: ${result}`
    );
    assert.ok(
      !result!.includes("sk-ant-abc123xyz"),
      "Result should not contain original key"
    );
  });
});

// ---------------------------------------------------------------------------
// T-5.2: Output events arrive before completed
// ---------------------------------------------------------------------------

describe("T-5.2: Output events arrive before completed event", () => {
  test("(a) happy path: output event seq < completed event seq", async () => {
    // This test uses CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE=1 so the bash
    // pipeline writes the stub's JSON lines directly to the jsonl file.
    process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";

    const tmpDir = makeTempDir();
    const fakeBin = path.join(tmpDir, "fake-bin");
    await fs.mkdir(fakeBin, { recursive: true });

    const eventSrv = await startEventServer();
    const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

    // Stub claude: emit an assistant text line then a result/success line
    const stubScript = [
      "#!/bin/sh",
      `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"doing work"}]}}'`,
      `echo '{"type":"result","subtype":"success","result":"","is_error":false}'`,
      "exit 0",
    ].join("\n");
    await fs.writeFile(path.join(fakeBin, "claude"), stubScript, {
      mode: 0o755,
    });
    process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
    setShellPathForTest();

    const loopId = "bbbbbbbb-0000-0000-0000-000000000001";
    const server = makeGatewayServer({
      allowedDirs: [tmpDir],
      getApiOrigin: () => apiBaseUrl,
    });
    await server.start();

    const response = await fetch(
      `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-desktop-gateway-token": "test-token",
        },
        body: JSON.stringify(buildLoopBody({ loopId, apiBaseUrl })),
      }
    );

    assert.equal(response.status, 200, `Expected 200, got ${response.status}`);

    // Wait for completed event
    await eventSrv.waitForEvent(
      (b) => b.type === "completed" || b.type === "error",
      15_000
    );

    const collected = eventSrv.getCollected();
    const outputEvent = collected.find((e) => e.type === "output");
    const completedEvent = collected.find(
      (e) => e.type === "completed" || e.type === "error"
    );

    assert.ok(outputEvent !== undefined, "Expected at least one output event");
    assert.ok(completedEvent !== undefined, "Expected a completed event");
    assert.ok(
      outputEvent!.seq < completedEvent!.seq,
      `Output event seq (${outputEvent!.seq}) should be less than completed seq (${completedEvent!.seq})`
    );
  });

  test("(b) JSONL absent before spawn: tailer handles non-existent file gracefully", async () => {
    // Start the tailer against a non-existent file and flush — should not throw
    const tmpDir = makeTempDir();
    const nonExistentJsonl = path.join(tmpDir, "does-not-exist.jsonl");

    const eventSrv = await startEventServer();
    const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

    const tailer = startOutputTailer(
      nonExistentJsonl,
      apiBaseUrl,
      "test-loop-id",
      () => "token",
      0
    );
    await assert.doesNotReject(() => tailer.flush());

    // No output events should be posted since file doesn't exist
    const collected = eventSrv.getCollected();
    const outputEvents = collected.filter((e) => e.type === "output");
    assert.equal(
      outputEvents.length,
      0,
      "No output events expected for non-existent file"
    );
  });

  test("(c) HTTP 500 for output events: loop completes even when event server returns 500", async () => {
    process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";

    const tmpDir = makeTempDir();
    const fakeBin = path.join(tmpDir, "fake-bin");
    await fs.mkdir(fakeBin, { recursive: true });

    // Event server returns 500 for output events
    const eventSrv = await startEventServer({ outputStatusCode: 500 });
    const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

    const stubScript = [
      "#!/bin/sh",
      `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}'`,
      `echo '{"type":"result","subtype":"success","result":"","is_error":false}'`,
      "exit 0",
    ].join("\n");
    await fs.writeFile(path.join(fakeBin, "claude"), stubScript, {
      mode: 0o755,
    });
    process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
    setShellPathForTest();

    const loopId = "cccccccc-0000-0000-0000-000000000001";
    const server = makeGatewayServer({
      allowedDirs: [tmpDir],
      getApiOrigin: () => apiBaseUrl,
    });
    await server.start();

    const response = await fetch(
      `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-desktop-gateway-token": "test-token",
        },
        body: JSON.stringify(buildLoopBody({ loopId, apiBaseUrl })),
      }
    );

    assert.equal(response.status, 200, `Expected 200, got ${response.status}`);

    // Loop should still complete even when output event POSTs return 500
    const completedEvent = await eventSrv.waitForEvent(
      (b) => b.type === "completed" || b.type === "error",
      15_000
    );

    assert.ok(
      completedEvent.type === "completed" || completedEvent.type === "error",
      `Expected completed or error event, got: ${JSON.stringify(completedEvent)}`
    );
  });
});

// ---------------------------------------------------------------------------
// T-5.3: Partial JSONL writes
// ---------------------------------------------------------------------------

describe("T-5.3: Partial JSONL writes", () => {
  test("incomplete line does not call onOffset; resume from last commit still delivers output", async () => {
    const tmpDir = makeTempDir();
    const jsonlPath = path.join(tmpDir, "claude-output.jsonl");

    const eventSrv = await startEventServer();
    const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

    const committedOffsets: number[] = [];
    const tailer = startOutputTailer(
      jsonlPath,
      apiBaseUrl,
      "partial-offset-loop",
      () => "token",
      0,
      (o) => {
        committedOffsets.push(o);
      }
    );

    const incompleteLine =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hel';
    writeFileSync(jsonlPath, incompleteLine);

    await tailer.flush();

    assert.equal(
      committedOffsets.length,
      0,
      `Expected no replay-safe offset for partial line, got ${JSON.stringify(committedOffsets)}`
    );

    const rest = 'lo"}]}}\n';
    writeFileSync(jsonlPath, incompleteLine + rest);

    const resumeFrom = committedOffsets.at(-1) ?? 0;
    const tailer2 = startOutputTailer(
      jsonlPath,
      apiBaseUrl,
      "partial-offset-loop",
      () => "token",
      resumeFrom,
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
      1,
      `Expected 1 output event after resume, got ${outputEvents.length}`
    );
    assert.ok(
      committedOffsets.length > 0,
      "Expected at least one committed offset after delivering a framed line"
    );
  });

  test("HTTP 403 for output events does not advance onOffset", async () => {
    const tmpDir = makeTempDir();
    const jsonlPath = path.join(tmpDir, "claude-output.jsonl");

    const eventSrv = await startEventServer({ outputStatusCode: 403 });
    const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

    const committedOffsets: number[] = [];
    const tailer = startOutputTailer(
      jsonlPath,
      apiBaseUrl,
      "auth-reject-loop",
      () => "token",
      0,
      (o) => {
        committedOffsets.push(o);
      }
    );

    const line =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"should not commit offset"}]}}';
    writeFileSync(jsonlPath, `${line}\n`);

    await tailer.flush();

    assert.equal(
      committedOffsets.length,
      0,
      `onOffset should not run on auth failure, got ${JSON.stringify(committedOffsets)}`
    );
    const outputEvents = eventSrv
      .getCollected()
      .filter((e) => e.type === "output");
    assert.ok(
      outputEvents.length >= 1,
      "Stub server should still record the POST attempt for diagnostics"
    );
  });

  test("transient auth rejection retries and commits offset after recovery", async () => {
    process.env.CLOSEDLOOP_TAILER_POLL_MS = "20";
    process.env.CLOSEDLOOP_TAILER_THROTTLE_MS = "1";
    process.env.CLOSEDLOOP_TAILER_AUTH_RETRY_BASE_MS = "10";
    process.env.CLOSEDLOOP_TAILER_AUTH_RETRY_MAX_MS = "10";
    process.env.CLOSEDLOOP_TAILER_AUTH_RETRY_MAX_COUNT = "4";

    const tmpDir = makeTempDir();
    const jsonlPath = path.join(tmpDir, "claude-output.jsonl");
    const eventSrv = await startEventServer({ outputStatusCodes: [403, 200] });
    const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

    const committedOffsets: number[] = [];
    const tailer = startOutputTailer(
      jsonlPath,
      apiBaseUrl,
      "auth-retry-loop",
      () => "token",
      0,
      (o) => {
        committedOffsets.push(o);
      }
    );

    const line =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"recovered offset commit"}]}}';
    writeFileSync(jsonlPath, `${line}\n`);
    try {
      await eventSrv.waitForEvent(
        (b) =>
          b.type === "output" && Number((b as { seq?: unknown }).seq) === 1,
        3000
      );
      await waitForCondition(() => committedOffsets.length === 1, 3000);

      const outputEvents = eventSrv
        .getCollected()
        .filter((e) => e.type === "output");
      assert.equal(
        outputEvents.length,
        2,
        `Expected 2 output POSTs, got ${outputEvents.length}`
      );
      assert.equal(
        committedOffsets.length,
        1,
        `Expected one replay-safe offset commit after recovery, got ${JSON.stringify(committedOffsets)}`
      );
    } finally {
      tailer.stop();
    }
  });

  test("flush bypasses auth retry backoff and delivers buffered output", async () => {
    process.env.CLOSEDLOOP_TAILER_POLL_MS = "20";
    process.env.CLOSEDLOOP_TAILER_THROTTLE_MS = "1";
    process.env.CLOSEDLOOP_TAILER_AUTH_RETRY_BASE_MS = "1000";
    process.env.CLOSEDLOOP_TAILER_AUTH_RETRY_MAX_MS = "1000";
    process.env.CLOSEDLOOP_TAILER_AUTH_RETRY_MAX_COUNT = "4";

    const tmpDir = makeTempDir();
    const jsonlPath = path.join(tmpDir, "claude-output.jsonl");
    const eventSrv = await startEventServer({ outputStatusCodes: [403, 200] });
    const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

    const committedOffsets: number[] = [];
    const tailer = startOutputTailer(
      jsonlPath,
      apiBaseUrl,
      "flush-auth-retry-loop",
      () => "token",
      0,
      (o) => {
        committedOffsets.push(o);
      }
    );

    const line =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"flush should bypass backoff"}]}}';
    writeFileSync(jsonlPath, `${line}\n`);

    await eventSrv.waitForEvent(
      (b) => b.type === "output" && Number((b as { seq?: unknown }).seq) === 0,
      3000
    );
    await tailer.flush();

    const outputEvents = eventSrv
      .getCollected()
      .filter((e) => e.type === "output");
    assert.equal(
      outputEvents.length,
      2,
      `Expected flush to trigger second output POST, got ${outputEvents.length}`
    );
    assert.equal(
      committedOffsets.length,
      1,
      `Expected one replay-safe offset commit after flush recovery, got ${JSON.stringify(committedOffsets)}`
    );
  });

  test("incomplete line does not emit; completed line emits one event", async () => {
    const tmpDir = makeTempDir();
    const jsonlPath = path.join(tmpDir, "claude-output.jsonl");

    const eventSrv = await startEventServer();
    const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

    const tailer = startOutputTailer(
      jsonlPath,
      apiBaseUrl,
      "partial-test-loop",
      () => "token",
      0
    );

    // Write an incomplete line (no trailing newline)
    const incompleteLine =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hel';
    writeFileSync(jsonlPath, incompleteLine);

    // Flush: no complete lines yet — 0 events
    await tailer.flush();
    // Re-create tailer since flush() stops it
    const tailer2 = startOutputTailer(
      jsonlPath,
      apiBaseUrl,
      "partial-test-loop",
      () => "token",
      0
    );

    const collectedBeforeComplete = eventSrv
      .getCollected()
      .filter((e) => e.type === "output");
    assert.equal(
      collectedBeforeComplete.length,
      0,
      `Expected 0 output events for incomplete line, got ${collectedBeforeComplete.length}`
    );

    // Append the rest of the line to complete it
    const rest = 'lo"}]}}\n';
    writeFileSync(jsonlPath, incompleteLine + rest);

    // Flush the second tailer: now 1 complete line — 1 event
    await tailer2.flush();

    const collectedAfterComplete = eventSrv
      .getCollected()
      .filter((e) => e.type === "output");
    assert.equal(
      collectedAfterComplete.length,
      1,
      `Expected 1 output event after completing the line, got ${collectedAfterComplete.length}`
    );
  });
});

// ---------------------------------------------------------------------------
// T-5.4: Flush on exit
// ---------------------------------------------------------------------------

describe("T-5.4: Flush on exit", () => {
  test("final-before-exit output event arrives before completed event", {
    timeout: 20_000,
  }, async () => {
    process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
    // Use fast poll interval so the sleep can be short
    process.env.CLOSEDLOOP_TAILER_POLL_MS = "200";
    process.env.CLOSEDLOOP_TAILER_THROTTLE_MS = "100";

    const tmpDir = makeTempDir();
    const fakeBin = path.join(tmpDir, "fake-bin");
    await fs.mkdir(fakeBin, { recursive: true });

    const eventSrv = await startEventServer();
    const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

    // Stub claude: emit first line, sleep past the tailer's poll interval,
    // emit second line, exit — exercising the flush-on-exit path.
    // Poll interval is set to 200ms via env var above.
    const stubScript = [
      "#!/bin/sh",
      `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"first message"}]}}'`,
      "sleep 0.5",
      `echo '{"type":"result","subtype":"success","result":"","is_error":false}'`,
      "exit 0",
    ].join("\n");
    await fs.writeFile(path.join(fakeBin, "claude"), stubScript, {
      mode: 0o755,
    });
    process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
    setShellPathForTest();

    const loopId = "dddddddd-0000-0000-0000-000000000001";
    const server = makeGatewayServer({
      allowedDirs: [tmpDir],
      getApiOrigin: () => apiBaseUrl,
    });
    await server.start();

    const response = await fetch(
      `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-desktop-gateway-token": "test-token",
        },
        body: JSON.stringify(buildLoopBody({ loopId, apiBaseUrl })),
      }
    );

    assert.equal(response.status, 200, `Expected 200, got ${response.status}`);

    // Wait for the completed event
    await eventSrv.waitForEvent(
      (b) => b.type === "completed" || b.type === "error",
      18_000
    );

    const collected = eventSrv.getCollected();
    const outputEvent = collected.find((e) => e.type === "output");
    const completedEvent = collected.find(
      (e) => e.type === "completed" || e.type === "error"
    );

    assert.ok(outputEvent !== undefined, "Expected at least one output event");
    assert.ok(completedEvent !== undefined, "Expected a completed event");
    assert.ok(
      outputEvent!.seq < completedEvent!.seq,
      `Output event (seq=${outputEvent!.seq}) should arrive before completed (seq=${completedEvent!.seq})`
    );
  });
});

// ---------------------------------------------------------------------------
// T-5.5: No-formatter fallback
// ---------------------------------------------------------------------------

describe("T-5.5: No-formatter fallback", () => {
  test("JSONL file is created and output events received when formatter is absent", async () => {
    // Override HOME to an empty temp dir so getPluginCacheRoot() -> ~/.claude/plugins/cache/...
    // resolves to a non-existent path, making findStreamFormatter() return null.
    // Do NOT set CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE; we want the real
    // code path that calls findStreamFormatter() and falls back to the raw pipeline.
    const tmpDir = makeTempDir();
    const fakeHome = path.join(tmpDir, "fake-home");
    await fs.mkdir(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;

    const fakeBin = path.join(tmpDir, "fake-bin");
    await fs.mkdir(fakeBin, { recursive: true });

    const eventSrv = await startEventServer();
    const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

    const stubScript = [
      "#!/bin/sh",
      `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"no formatter output"}]}}'`,
      `echo '{"type":"result","subtype":"success","result":"","is_error":false}'`,
      "exit 0",
    ].join("\n");
    await fs.writeFile(path.join(fakeBin, "claude"), stubScript, {
      mode: 0o755,
    });
    // Include system paths so 'bash', 'grep', 'tee' are available for the pipeline
    process.env.PATH = `${fakeBin}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`;
    setShellPathForTest();

    const loopId = "eeeeeeee-0000-0000-0000-000000000001";
    const server = makeGatewayServer({
      allowedDirs: [tmpDir],
      getApiOrigin: () => apiBaseUrl,
    });
    await server.start();

    const response = await fetch(
      `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-desktop-gateway-token": "test-token",
        },
        body: JSON.stringify(buildLoopBody({ loopId, apiBaseUrl })),
      }
    );

    assert.equal(response.status, 200, `Expected 200, got ${response.status}`);

    // Loop completes and output events arrive
    await eventSrv.waitForEvent(
      (b) => b.type === "completed" || b.type === "error",
      15_000
    );

    // The JSONL file may already be cleaned up by handleProcessCompletion's fire-and-forget rm.
    // We verify output events arrived, which proves the JSONL file was created and processed.
    const outputEvents = eventSrv
      .getCollected()
      .filter((e) => e.type === "output");
    assert.ok(
      outputEvents.length > 0,
      `Expected output events with no-formatter fallback, but got none. Collected: ${JSON.stringify(eventSrv.getCollected())}`
    );
    assert.ok(
      typeof outputEvents[0].data === "object" &&
        outputEvents[0].data !== null &&
        typeof (outputEvents[0].data as Record<string, unknown>).chunk ===
          "string",
      `Expected output event to have data.chunk, got: ${JSON.stringify(outputEvents[0])}`
    );
  });
});

// ---------------------------------------------------------------------------
// T-5.6: Throttle
// ---------------------------------------------------------------------------

describe("T-5.6: Throttle", () => {
  test("5 rapid JSON lines produce at most 2 output events (throttle window)", async () => {
    const tmpDir = makeTempDir();
    const jsonlPath = path.join(tmpDir, "claude-output.jsonl");

    const eventSrv = await startEventServer();
    const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

    // Write 5 complete JSON lines with text content at once (simulating rapid output)
    const lines = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"line 1"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"line 2"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"line 3"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"line 4"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"line 5"}]}}',
    ];
    writeFileSync(jsonlPath, `${lines.join("\n")}\n`);

    const tailer = startOutputTailer(
      jsonlPath,
      apiBaseUrl,
      "throttle-test-loop",
      () => "token",
      0
    );
    await tailer.flush();

    const outputEvents = eventSrv
      .getCollected()
      .filter((e) => e.type === "output");
    assert.ok(
      outputEvents.length <= 2,
      `Expected at most 2 output events due to throttle, got ${outputEvents.length}: ${JSON.stringify(outputEvents)}`
    );
  });
});

// ---------------------------------------------------------------------------
// T-5.7: tokensUsed shape in completed event
// ---------------------------------------------------------------------------

describe("T-5.7: tokensUsed shape in completed event", () => {
  test("(a) tokensUsed has input and output fields (not inputTokens/outputTokens)", async () => {
    process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";

    const tmpDir = makeTempDir();
    const fakeBin = path.join(tmpDir, "fake-bin");
    await fs.mkdir(fakeBin, { recursive: true });

    const eventSrv = await startEventServer();
    const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

    const stubScript = [
      "#!/bin/sh",
      `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"work"}],"usage":{"input_tokens":10,"output_tokens":5}}}'`,
      `echo '{"type":"result","subtype":"success","result":"","is_error":false}'`,
      "exit 0",
    ].join("\n");
    await fs.writeFile(path.join(fakeBin, "claude"), stubScript, {
      mode: 0o755,
    });
    process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
    setShellPathForTest();

    const loopId = "ffffffff-0000-0000-0000-000000000001";
    const server = makeGatewayServer({
      allowedDirs: [tmpDir],
      getApiOrigin: () => apiBaseUrl,
    });
    await server.start();

    const response = await fetch(
      `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-desktop-gateway-token": "test-token",
        },
        body: JSON.stringify(buildLoopBody({ loopId, apiBaseUrl })),
      }
    );

    assert.equal(response.status, 200, `Expected 200, got ${response.status}`);

    const completedEvent = await eventSrv.waitForEvent(
      (b) => b.type === "completed" || b.type === "error",
      15_000
    );

    assert.equal(
      completedEvent.type,
      "completed",
      `Expected completed event, got: ${JSON.stringify(completedEvent)}`
    );
    const tokensUsed = completedEvent.tokensUsed as Record<string, unknown>;
    assert.ok(
      tokensUsed !== null && typeof tokensUsed === "object",
      "tokensUsed must be an object"
    );
    assert.equal(
      typeof tokensUsed.input,
      "number",
      "tokensUsed.input must be a number"
    );
    assert.equal(
      typeof tokensUsed.output,
      "number",
      "tokensUsed.output must be a number"
    );
    assert.equal(
      tokensUsed.inputTokens,
      undefined,
      "tokensUsed.inputTokens must be absent (old wrong field name)"
    );
    assert.equal(
      tokensUsed.outputTokens,
      undefined,
      "tokensUsed.outputTokens must be absent (old wrong field name)"
    );
  });

  test("(b) tokensUsed aggregates token counts from JSONL across multiple turns", async () => {
    process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";

    const tmpDir = makeTempDir();
    const fakeBin = path.join(tmpDir, "fake-bin");
    await fs.mkdir(fakeBin, { recursive: true });

    const eventSrv = await startEventServer();
    const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

    // Two turns: input 10+20=30, output 5+7=12
    const stubScript = [
      "#!/bin/sh",
      `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"turn 1"}],"usage":{"input_tokens":10,"output_tokens":5}}}'`,
      `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"turn 2"}],"usage":{"input_tokens":20,"output_tokens":7}}}'`,
      `echo '{"type":"result","subtype":"success","result":"","is_error":false}'`,
      "exit 0",
    ].join("\n");
    await fs.writeFile(path.join(fakeBin, "claude"), stubScript, {
      mode: 0o755,
    });
    process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
    setShellPathForTest();

    const loopId = "ffffffff-0000-0000-0000-000000000002";
    const server = makeGatewayServer({
      allowedDirs: [tmpDir],
      getApiOrigin: () => apiBaseUrl,
    });
    await server.start();

    const response = await fetch(
      `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-desktop-gateway-token": "test-token",
        },
        body: JSON.stringify(buildLoopBody({ loopId, apiBaseUrl })),
      }
    );

    assert.equal(response.status, 200, `Expected 200, got ${response.status}`);

    const completedEvent = await eventSrv.waitForEvent(
      (b) => b.type === "completed" || b.type === "error",
      15_000
    );

    assert.equal(
      completedEvent.type,
      "completed",
      `Expected completed event, got: ${JSON.stringify(completedEvent)}`
    );
    const tokensUsed = completedEvent.tokensUsed as Record<string, unknown>;
    assert.equal(
      tokensUsed.input,
      30,
      `Expected input=30, got ${tokensUsed.input}`
    );
    assert.equal(
      tokensUsed.output,
      12,
      `Expected output=12, got ${tokensUsed.output}`
    );
  });

  test("(c) cache tokens are preserved separately; input equals raw input_tokens only", async () => {
    process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";

    const tmpDir = makeTempDir();
    const fakeBin = path.join(tmpDir, "fake-bin");
    await fs.mkdir(fakeBin, { recursive: true });

    const eventSrv = await startEventServer();
    const apiBaseUrl = `http://127.0.0.1:${eventSrv.port}`;

    // Single turn with all four token types
    const assistantEntry = JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4",
        content: [{ type: "text", text: "work" }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 300,
        },
      },
    });
    const stubScript = [
      "#!/bin/sh",
      `echo '${assistantEntry}'`,
      `echo '{"type":"result","subtype":"success","result":"","is_error":false}'`,
      "exit 0",
    ].join("\n");
    await fs.writeFile(path.join(fakeBin, "claude"), stubScript, {
      mode: 0o755,
    });
    process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
    setShellPathForTest();

    const loopId = "ffffffff-0000-0000-0000-000000000003";
    const server = makeGatewayServer({
      allowedDirs: [tmpDir],
      getApiOrigin: () => apiBaseUrl,
    });
    await server.start();

    const response = await fetch(
      `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-desktop-gateway-token": "test-token",
        },
        body: JSON.stringify(buildLoopBody({ loopId, apiBaseUrl })),
      }
    );

    assert.equal(response.status, 200, `Expected 200, got ${response.status}`);

    const completedEvent = await eventSrv.waitForEvent(
      (b) => b.type === "completed" || b.type === "error",
      15_000
    );

    assert.equal(
      completedEvent.type,
      "completed",
      `Expected completed event, got: ${JSON.stringify(completedEvent)}`
    );
    const tokensUsed = completedEvent.tokensUsed as Record<string, unknown>;
    assert.ok(
      tokensUsed !== null && typeof tokensUsed === "object",
      "tokensUsed must be an object"
    );
    // input must equal raw input_tokens only (NOT the sum of all cache types)
    assert.equal(
      tokensUsed.input,
      10,
      `Expected input=10 (raw only), got ${tokensUsed.input}`
    );
    assert.equal(
      tokensUsed.output,
      5,
      `Expected output=5, got ${tokensUsed.output}`
    );
    assert.equal(
      tokensUsed.cacheCreationInputTokens,
      200,
      `Expected cacheCreationInputTokens=200, got ${tokensUsed.cacheCreationInputTokens}`
    );
    assert.equal(
      tokensUsed.cacheReadInputTokens,
      300,
      `Expected cacheReadInputTokens=300, got ${tokensUsed.cacheReadInputTokens}`
    );
    assert.equal(typeof tokensUsed.turns, "number", "turns must be a number");
    assert.equal(
      tokensUsed.turns,
      1,
      `Expected turns=1, got ${tokensUsed.turns}`
    );
    assert.ok(Array.isArray(tokensUsed.models), "models must be an array");
  });
});
