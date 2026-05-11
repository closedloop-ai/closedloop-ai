import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import {
  detectAuthChallengeFromJsonl,
  detectAuthChallengeFromJsonlFile,
} from "./auth-challenge-detection.mjs";

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-challenge-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeJsonlOutput(workDir, lines) {
  fs.writeFileSync(
    path.join(workDir, "claude-output.jsonl"),
    `${lines.join("\n")}\n`,
    "utf-8"
  );
}

// ---------------------------------------------------------------------------
// detectAuthChallengeFromJsonl — primary scanner-behavior suite
// ---------------------------------------------------------------------------

describe("detectAuthChallengeFromJsonl", () => {
  test("returns null when the output file does not exist", () => {
    const workDir = makeTempDir();
    assert.equal(detectAuthChallengeFromJsonl(workDir), null);
  });

  test("returns null for healthy JSONL output", () => {
    const workDir = makeTempDir();
    writeJsonlOutput(workDir, [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello" }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Task completed.",
      }),
    ]);
    assert.equal(detectAuthChallengeFromJsonl(workDir), null);
  });

  test("returns null for is_error result with non-auth message", () => {
    const workDir = makeTempDir();
    writeJsonlOutput(workDir, [
      JSON.stringify({
        type: "result",
        is_error: true,
        result: "file not found: /workspace/missing.ts",
      }),
    ]);
    assert.equal(detectAuthChallengeFromJsonl(workDir), null);
  });

  const authResultStrings = [
    "authentication_error: invalid api key",
    "rate_limit_error: quota exceeded",
    "your token has expired",
    "unauthorized access",
    "invalid bearer token",
    "billing_error: payment required",
    "overloaded_error: server busy",
    "usage limit reached",
  ];

  for (const text of authResultStrings) {
    test(`detects is_error result with auth text: "${text}"`, () => {
      const workDir = makeTempDir();
      writeJsonlOutput(workDir, [
        JSON.stringify({ type: "result", is_error: true, result: text }),
      ]);
      const result = detectAuthChallengeFromJsonl(workDir);
      assert.ok(result !== null, `expected detection for: ${text}`);
      assert.equal(result, text);
    });
  }

  const nonAuthResultStrings = [
    "task completed successfully",
    "file not found",
    "syntax error at line 42",
    "permission denied by filesystem",
  ];

  for (const text of nonAuthResultStrings) {
    test(`does not detect non-auth is_error text: "${text}"`, () => {
      const workDir = makeTempDir();
      writeJsonlOutput(workDir, [
        JSON.stringify({ type: "result", is_error: true, result: text }),
      ]);
      assert.equal(detectAuthChallengeFromJsonl(workDir), null);
    });
  }

  for (const status of [401, 403, 429]) {
    test(`detects isApiErrorMessage with apiErrorStatus ${status}`, () => {
      const workDir = makeTempDir();
      writeJsonlOutput(workDir, [
        JSON.stringify({
          isApiErrorMessage: true,
          error: "some error",
          apiErrorStatus: status,
        }),
      ]);
      const result = detectAuthChallengeFromJsonl(workDir);
      assert.ok(result !== null);
      assert.ok(
        result.includes(String(status)),
        `result must mention status ${status}, got: ${result}`
      );
    });
  }

  test("detects isApiErrorMessage with auth text and no recognized status", () => {
    const workDir = makeTempDir();
    writeJsonlOutput(workDir, [
      JSON.stringify({
        isApiErrorMessage: true,
        error: "forbidden",
        apiErrorStatus: 999,
      }),
    ]);
    const result = detectAuthChallengeFromJsonl(workDir);
    assert.ok(result !== null);
    assert.ok(result.includes("forbidden"));
  });

  test("does not detect isApiErrorMessage with non-auth text and non-4xx status", () => {
    const workDir = makeTempDir();
    writeJsonlOutput(workDir, [
      JSON.stringify({
        isApiErrorMessage: true,
        error: "internal_server_error",
        apiErrorStatus: 500,
      }),
    ]);
    assert.equal(detectAuthChallengeFromJsonl(workDir), null);
  });

  test("skips malformed JSONL lines without throwing", () => {
    const workDir = makeTempDir();
    fs.writeFileSync(
      path.join(workDir, "claude-output.jsonl"),
      [
        "this is not json {{{",
        "another bad line",
        JSON.stringify({ type: "result", is_error: false, result: "ok" }),
      ].join("\n"),
      "utf-8"
    );
    assert.doesNotThrow(() => {
      assert.equal(detectAuthChallengeFromJsonl(workDir), null);
    });
  });

  test("detects auth errors even when malformed lines precede them", () => {
    const workDir = makeTempDir();
    fs.writeFileSync(
      path.join(workDir, "claude-output.jsonl"),
      [
        "not valid json at all",
        JSON.stringify({
          type: "result",
          is_error: true,
          result: "rate_limit_error: quota exceeded",
        }),
      ].join("\n"),
      "utf-8"
    );
    const result = detectAuthChallengeFromJsonl(workDir);
    assert.ok(result !== null);
    assert.ok(result.includes("rate_limit_error"));
  });

  test("handles empty/whitespace-only files gracefully", () => {
    const workDir = makeTempDir();
    fs.writeFileSync(
      path.join(workDir, "claude-output.jsonl"),
      "\n\n\n",
      "utf-8"
    );
    assert.equal(detectAuthChallengeFromJsonl(workDir), null);
  });
});

// ---------------------------------------------------------------------------
// detectAuthChallengeFromJsonlFile — path-resolution differences only.
// The underlying scanner is exercised exhaustively by the suite above.
// ---------------------------------------------------------------------------

describe("detectAuthChallengeFromJsonlFile", () => {
  test("returns null for missing/empty/null path", () => {
    const dir = makeTempDir();
    assert.equal(
      detectAuthChallengeFromJsonlFile(path.join(dir, "missing.jsonl")),
      null
    );
    assert.equal(detectAuthChallengeFromJsonlFile(""), null);
    assert.equal(detectAuthChallengeFromJsonlFile(null), null);
    assert.equal(detectAuthChallengeFromJsonlFile(undefined), null);
  });

  test("detects an auth signal from a transcript at a direct path", () => {
    const dir = makeTempDir();
    const transcriptPath = path.join(dir, "session-abc123.jsonl");
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        isApiErrorMessage: true,
        error: "rate_limit_error",
        apiErrorStatus: 429,
      })}\n`,
      "utf-8"
    );
    const result = detectAuthChallengeFromJsonlFile(transcriptPath);
    assert.ok(result !== null);
    assert.ok(result.includes("429"));
  });

  test("returns null for healthy transcript", () => {
    const dir = makeTempDir();
    const transcriptPath = path.join(dir, "healthy.jsonl");
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "result",
        is_error: false,
        result: "Task completed.",
      })}\n`,
      "utf-8"
    );
    assert.equal(detectAuthChallengeFromJsonlFile(transcriptPath), null);
  });
});
