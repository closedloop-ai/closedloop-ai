import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  extractTextFromNdjsonLog,
  extractVerdictTag,
  streamCodexReview,
  stripCodexNonUserDiagnostics,
} from "../src/server/operations/codex.js";
import {
  createStreamState,
  processStreamEvent,
} from "../src/server/operations/stream-events.js";

const tempPaths: string[] = [];

afterEach(async () => {
  for (const tempPath of tempPaths.splice(0)) {
    await fs.rm(tempPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// extractTextFromNdjsonLog
// ---------------------------------------------------------------------------

describe("extractTextFromNdjsonLog", () => {
  test("extracts text content from NDJSON lines", () => {
    const raw = [
      JSON.stringify({ type: "sessionId", sessionId: "abc-123" }),
      JSON.stringify({ type: "text", content: "Hello " }),
      JSON.stringify({ type: "text", content: "world" }),
      JSON.stringify({ type: "result", success: true }),
    ].join("\n");

    assert.equal(extractTextFromNdjsonLog(raw), "Hello world");
  });

  test("extracts error messages", () => {
    const raw = [
      JSON.stringify({ type: "text", content: "partial review\n" }),
      JSON.stringify({ type: "error", error: "Claude encountered an error" }),
    ].join("\n");

    assert.equal(
      extractTextFromNdjsonLog(raw),
      "partial review\nClaude encountered an error"
    );
  });

  test("passes through non-JSON lines as plain text", () => {
    const raw = "some plain text\nnot json either";
    assert.equal(
      extractTextFromNdjsonLog(raw),
      "some plain textnot json either"
    );
  });

  test("ignores non-text/non-error NDJSON events", () => {
    const raw = [
      JSON.stringify({ type: "sessionId", sessionId: "abc" }),
      JSON.stringify({ type: "thinking", content: "hmm..." }),
      JSON.stringify({ type: "tool_use", name: "Read", id: "t1", input: {} }),
      JSON.stringify({ type: "usage", contextPercent: 42 }),
      JSON.stringify({ type: "text", content: "visible" }),
    ].join("\n");

    assert.equal(extractTextFromNdjsonLog(raw), "visible");
  });

  test("skips empty and whitespace-only lines", () => {
    const raw = `\n  \n${JSON.stringify({ type: "text", content: "ok" })}\n\n`;
    assert.equal(extractTextFromNdjsonLog(raw), "ok");
  });

  test("skips garbled first line when truncated", () => {
    const garbledFirst = '{"type":"text","content":"cut off mid-';
    const raw = [
      garbledFirst,
      JSON.stringify({ type: "text", content: "real content" }),
    ].join("\n");

    // Without truncation flag, garbled line is included as plain text
    assert.equal(
      extractTextFromNdjsonLog(raw, false),
      `${garbledFirst}real content`
    );

    // With truncation flag, garbled first line is skipped
    assert.equal(extractTextFromNdjsonLog(raw, true), "real content");
  });

  test("handles single-line truncated input gracefully", () => {
    const raw = '{"type":"text","content":"only line';
    // Single line + truncated: lines.length is 1, shift is skipped
    assert.equal(extractTextFromNdjsonLog(raw, true), raw);
  });

  test("returns empty string for empty input", () => {
    assert.equal(extractTextFromNdjsonLog(""), "");
    assert.equal(extractTextFromNdjsonLog("\n\n"), "");
  });

  test("returns empty string when log contains only non-text events", () => {
    const raw = [
      JSON.stringify({ type: "sessionId", sessionId: "s1" }),
      JSON.stringify({ type: "result", success: true }),
    ].join("\n");

    assert.equal(extractTextFromNdjsonLog(raw), "");
  });

  test("removes Codex rollout recorder diagnostics from stored log text", () => {
    const diagnostic =
      "2026-04-30T15:21:30.628333Z ERROR codex_core::session: failed to record rollout items: thread 019ddefa-3be6-7b32-a969-c0f364fb225c not found";
    const raw = [
      "Finding before diagnostic.",
      diagnostic,
      JSON.stringify({
        type: "text",
        content: `Finding after diagnostic.\n${diagnostic}\n`,
      }),
    ].join("\n");

    assert.equal(
      extractTextFromNdjsonLog(raw),
      "Finding before diagnostic.Finding after diagnostic.\n"
    );
  });
});

// ---------------------------------------------------------------------------
// processStreamEvent — verify it produces correct NDJSON for log storage
// ---------------------------------------------------------------------------

describe("processStreamEvent log output", () => {
  test("assistant event with multiple blocks emits multiple messages in order", () => {
    const state = createStreamState();
    const messages: string[] = [];

    processStreamEvent(
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "First paragraph." },
            { type: "text", text: "Second paragraph." },
          ],
        },
      } as never,
      state,
      (msg) => messages.push(msg)
    );

    assert.equal(messages.length, 2);
    const parsed0 = JSON.parse(messages[0]);
    const parsed1 = JSON.parse(messages[1]);
    assert.equal(parsed0.type, "text");
    assert.equal(parsed0.content, "First paragraph.");
    assert.equal(parsed1.type, "text");
    assert.equal(parsed1.content, "\n\nSecond paragraph.");
  });

  test("result event with error emits error message", () => {
    const state = createStreamState();
    const messages: string[] = [];

    processStreamEvent(
      {
        type: "result",
        is_error: true,
        result: "Something went wrong",
      } as never,
      state,
      (msg) => messages.push(msg)
    );

    assert.equal(messages.length, 1);
    const parsed = JSON.parse(messages[0]);
    assert.equal(parsed.type, "error");
    assert.equal(parsed.error, "Something went wrong");
  });

  test("content_block_delta text events emit text messages", () => {
    const state = createStreamState();
    const messages: string[] = [];

    processStreamEvent(
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "chunk" },
      } as never,
      state,
      (msg) => messages.push(msg)
    );

    assert.equal(messages.length, 1);
    const parsed = JSON.parse(messages[0]);
    assert.equal(parsed.type, "text");
    assert.equal(parsed.content, "chunk");
  });
});

// ---------------------------------------------------------------------------
// Log write ordering — integration test with real writeStream + child process
// ---------------------------------------------------------------------------

describe("streamClaudeReview log write ordering", () => {
  test("writeStream preserves order for rapid sequential writes", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-log-order-"));
    tempPaths.push(tmpDir);
    const logPath = path.join(tmpDir, "test.log");

    const logStream = createWriteStream(logPath, {
      flags: "a",
      encoding: "utf-8",
    });

    // Simulate what streamClaudeReview does: rapid sequential writes
    for (let i = 0; i < 100; i++) {
      logStream.write(
        `${JSON.stringify({ type: "text", content: `line-${i}` })}\n`
      );
    }

    await new Promise<void>((resolve) => logStream.end(resolve));

    const content = await fs.readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 100);

    for (let i = 0; i < 100; i++) {
      const parsed = JSON.parse(lines[i]);
      assert.equal(parsed.content, `line-${i}`, `Line ${i} out of order`);
    }
  });

  test("writeStream preserves order with multi-block events", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "codex-log-multiblock-")
    );
    tempPaths.push(tmpDir);
    const logPath = path.join(tmpDir, "test.log");

    const logStream = createWriteStream(logPath, {
      flags: "a",
      encoding: "utf-8",
    });
    const state = createStreamState();

    // Simulate processing multiple Claude events rapidly
    const events = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Block A." },
            {
              type: "tool_use",
              id: "t1",
              name: "Read",
              input: { path: "/foo" },
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Block B." },
            { type: "text", text: "Block C." },
          ],
        },
      },
    ];

    for (const event of events) {
      processStreamEvent(event as never, state, (message) => {
        logStream.write(`${message}\n`);
      });
    }

    await new Promise<void>((resolve) => logStream.end(resolve));

    const content = await fs.readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");

    // Should be 4 lines: text A, tool_use, text B, text C
    assert.equal(lines.length, 4);

    const types = lines.map((l) => JSON.parse(l).type);
    assert.deepEqual(types, ["text", "tool_use", "text", "text"]);

    // Verify text content order
    const textContents = lines
      .map((l) => JSON.parse(l))
      .filter((e: { type: string }) => e.type === "text")
      .map((e: { content: string }) => e.content);
    assert.equal(textContents[0], "Block A.");
    assert.equal(textContents[1], "\n\nBlock B.");
    assert.equal(textContents[2], "\n\nBlock C.");
  });

  test("child process close event fires after all data events", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-log-close-"));
    tempPaths.push(tmpDir);
    const logPath = path.join(tmpDir, "test.log");

    const logStream = createWriteStream(logPath, {
      flags: "a",
      encoding: "utf-8",
    });

    // Spawn a child that writes multiple lines to stdout then exits
    const child = spawn("node", [
      "-e",
      `for (let i = 0; i < 20; i++) { process.stdout.write(JSON.stringify({ seq: i }) + "\\n"); }`,
    ]);

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      logStream.write(chunk);
    });

    await new Promise<void>((resolve) => {
      child.on("close", () => {
        logStream.end(resolve);
      });
    });

    const content = await fs.readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 20, `Expected 20 lines, got ${lines.length}`);

    for (let i = 0; i < 20; i++) {
      const parsed = JSON.parse(lines[i]);
      assert.equal(parsed.seq, i, `Sequence ${i} missing or out of order`);
    }
  });
});

// ---------------------------------------------------------------------------
// streamCodexReview flush-gate — verify log is fully written before resolve
// ---------------------------------------------------------------------------

describe("streamCodexReview flush-gate pattern", () => {
  test("does not emit Codex stderr diagnostics as review text", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "codex-stderr-diagnostic-")
    );
    tempPaths.push(tmpDir);
    const logPath = path.join(tmpDir, "codex-review.log");
    const diagnostic =
      "2026-04-30T15:21:30.714121Z ERROR codex_core::session: failed to record rollout items: thread 019ddefa-3a0e-78e2-90fa-c7c3e7bcc247 not found";

    const child = spawn("node", [
      "-e",
      `process.stdout.write("review finding\\n"); process.stderr.write(${JSON.stringify(`${diagnostic}\n`)});`,
    ]);

    const events: Record<string, unknown>[] = [];
    const response = {
      destroyed: false,
      writable: true,
      write: (payload: string) => {
        events.push(JSON.parse(payload) as Record<string, unknown>);
        return true;
      },
    } as unknown as ServerResponse;
    const stderrHolder = { value: "" };

    await streamCodexReview(
      child,
      response,
      logPath,
      { value: undefined },
      stderrHolder
    );

    assert.deepEqual(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.content),
      ["review finding\n"]
    );
    assert.equal(
      events.some((event) =>
        String(event.content ?? "").includes("failed to record rollout items")
      ),
      false
    );
    assert.match(stderrHolder.value, /failed to record rollout items/);

    const logContent = await fs.readFile(logPath, "utf-8");
    assert.match(logContent, /review finding/);
    assert.match(logContent, /failed to record rollout items/);
  });

  test("stripCodexNonUserDiagnostics preserves real stderr failures", () => {
    const diagnostic =
      "2026-04-30T15:21:30.628333Z ERROR codex_core::session: failed to record rollout items: thread 019ddefa-3be6-7b32-a969-c0f364fb225c not found";
    const raw = `${diagnostic}\nreal failure\n${diagnostic}\n`;

    assert.equal(stripCodexNonUserDiagnostics(raw), "real failure\n");
  });

  test("log finish resolves only after all data is flushed from child stdout", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "codex-flush-gate-")
    );
    tempPaths.push(tmpDir);
    const logPath = path.join(tmpDir, "codex-review.log");

    // Spawn a child that outputs many lines — simulates codex review output
    const child = spawn("node", [
      "-e",
      `for (let i = 0; i < 50; i++) { process.stdout.write("line " + i + "\\n"); }`,
    ]);

    // Replicate the streamCodexReview pattern: createWriteStream + close→end + finish→resolve
    const logStream = createWriteStream(logPath, {
      flags: "a",
      encoding: "utf-8",
    });

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      logStream.write(chunk);
    });

    child.on("close", () => {
      logStream.end();
    });

    // This is the key assertion: the promise should not resolve until finish fires,
    // which means all data is flushed to disk.
    await new Promise<void>((resolve, reject) => {
      logStream.once("finish", resolve);
      logStream.once("error", reject);
    });

    const content = await fs.readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 50, `Expected 50 lines, got ${lines.length}`);
    assert.equal(lines[0], "line 0");
    assert.equal(lines[49], "line 49");
  });

  test("logStream error rejects the promise instead of hanging", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "codex-flush-error-")
    );
    tempPaths.push(tmpDir);

    // Point logStream at a path inside a non-existent directory to trigger an error
    const badLogPath = path.join(
      tmpDir,
      "nonexistent-dir",
      "subdir",
      "codex-review.log"
    );
    const logStream = createWriteStream(badLogPath, {
      flags: "a",
      encoding: "utf-8",
    });

    const result = await new Promise<"error" | "finish">((resolve) => {
      logStream.once("finish", () => resolve("finish"));
      logStream.once("error", () => resolve("error"));
    });

    assert.equal(result, "error", "Expected error event for invalid log path");
  });
});

// ---------------------------------------------------------------------------
// extractVerdictTag
// ---------------------------------------------------------------------------

describe("extractVerdictTag", () => {
  test("extracts valid verdict from raw output", () => {
    const raw = `Some analysis...\n<pr_verdict>{"verdict":"approve","reason":"No blocking issues found"}</pr_verdict>`;
    const result = extractVerdictTag(raw);
    assert.deepEqual(result, {
      verdict: "approve",
      reason: "No blocking issues found",
    });
  });

  test("extracts decline verdict", () => {
    const raw = `<pr_verdict>{"verdict":"decline","reason":"Bug fix is unnecessary"}</pr_verdict>`;
    const result = extractVerdictTag(raw);
    assert.deepEqual(result, {
      verdict: "decline",
      reason: "Bug fix is unnecessary",
    });
  });

  test("extracts needs_attention verdict", () => {
    const raw = `<pr_verdict>{"verdict":"needs_attention","reason":"High-priority perf issue"}</pr_verdict>`;
    const result = extractVerdictTag(raw);
    assert.deepEqual(result, {
      verdict: "needs_attention",
      reason: "High-priority perf issue",
    });
  });

  test("returns undefined for missing tag", () => {
    assert.equal(extractVerdictTag("no tag here"), undefined);
  });

  test("returns undefined for invalid verdict value", () => {
    const raw = `<pr_verdict>{"verdict":"reject","reason":"bad"}</pr_verdict>`;
    assert.equal(extractVerdictTag(raw), undefined);
  });

  test("returns undefined for empty reason", () => {
    const raw = `<pr_verdict>{"verdict":"approve","reason":""}</pr_verdict>`;
    assert.equal(extractVerdictTag(raw), undefined);
  });

  test("returns undefined for malformed JSON inside tag", () => {
    const raw = "<pr_verdict>{not valid json}</pr_verdict>";
    assert.equal(extractVerdictTag(raw), undefined);
  });

  test("returns undefined when reason is missing", () => {
    const raw = `<pr_verdict>{"verdict":"approve"}</pr_verdict>`;
    assert.equal(extractVerdictTag(raw), undefined);
  });

  test("returns undefined when verdict is missing", () => {
    const raw = `<pr_verdict>{"reason":"some reason"}</pr_verdict>`;
    assert.equal(extractVerdictTag(raw), undefined);
  });
});
