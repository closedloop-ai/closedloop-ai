import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import {
  AUTH_CHALLENGE_PATTERN,
  AUTH_STATUS_PATTERN,
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

/**
 * Write lines to `claude-output.jsonl` in the given work directory.
 *
 * @param {string} workDir
 * @param {string[]} lines - Array of raw line strings (already serialized).
 */
function writeJsonlOutput(workDir, lines) {
  fs.writeFileSync(
    path.join(workDir, "claude-output.jsonl"),
    `${lines.join("\n")}\n`,
    "utf-8"
  );
}

// ---------------------------------------------------------------------------
// AUTH_CHALLENGE_PATTERN — pattern matching
// ---------------------------------------------------------------------------

describe("AUTH_CHALLENGE_PATTERN", () => {
  const matches = [
    "authentication_error: not authorized",
    "Authentication required to proceed",
    "invalid bearer token provided",
    "invalid token in request",
    "rate_limit_error hit",
    "rate limit reached for model",
    "usage limit exceeded",
    "billing_error: payment required",
    "permission_error on resource",
    "overloaded_error: server busy",
    "api overloaded, try later",
    "unauthorized access",
    "your token has expired",
  ];

  for (const str of matches) {
    test(`matches known auth challenge string: "${str}"`, () => {
      assert.ok(
        AUTH_CHALLENGE_PATTERN.test(str),
        `AUTH_CHALLENGE_PATTERN should match: ${str}`
      );
    });
  }

  const nonMatches = [
    "task completed successfully",
    "file not found",
    "syntax error at line 42",
    "permission denied by filesystem",
  ];

  for (const str of nonMatches) {
    test(`does not match non-auth string: "${str}"`, () => {
      assert.ok(
        !AUTH_CHALLENGE_PATTERN.test(str),
        `AUTH_CHALLENGE_PATTERN should not match: ${str}`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// AUTH_STATUS_PATTERN — pattern matching (broader, for isApiErrorMessage)
// ---------------------------------------------------------------------------

describe("AUTH_STATUS_PATTERN", () => {
  const extraMatches = [
    "forbidden resource",
    "access denied to endpoint",
    "rate_limit without _error suffix",
  ];

  for (const str of extraMatches) {
    test(`matches broader auth status string: "${str}"`, () => {
      assert.ok(
        AUTH_STATUS_PATTERN.test(str),
        `AUTH_STATUS_PATTERN should match: ${str}`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// detectAuthChallengeFromJsonl — missing file
// ---------------------------------------------------------------------------

describe("detectAuthChallengeFromJsonl — missing file", () => {
  test("returns null when the output file does not exist", () => {
    const workDir = makeTempDir();
    // No claude-output.jsonl written — directory is empty.

    const result = detectAuthChallengeFromJsonl(workDir);

    assert.equal(result, null, "missing output file must return null");
  });
});

// ---------------------------------------------------------------------------
// detectAuthChallengeFromJsonl — healthy JSONL (no false positives)
// ---------------------------------------------------------------------------

describe("detectAuthChallengeFromJsonl — healthy JSONL", () => {
  test("returns null for normal JSONL output with no auth errors", () => {
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

    const result = detectAuthChallengeFromJsonl(workDir);

    assert.equal(result, null, "healthy JSONL output must return null");
  });

  test("returns null for result entry with is_error true but non-auth message", () => {
    const workDir = makeTempDir();
    writeJsonlOutput(workDir, [
      JSON.stringify({
        type: "result",
        is_error: true,
        result: "file not found: /tmp/missing.txt",
      }),
    ]);

    const result = detectAuthChallengeFromJsonl(workDir);

    assert.equal(
      result,
      null,
      "non-auth error must not trigger auth challenge detection"
    );
  });
});

// ---------------------------------------------------------------------------
// detectAuthChallengeFromJsonl — 429 status detection
// ---------------------------------------------------------------------------

describe("detectAuthChallengeFromJsonl — 429 status detection", () => {
  test("returns error string for isApiErrorMessage entry with apiErrorStatus 429", () => {
    const workDir = makeTempDir();
    writeJsonlOutput(workDir, [
      JSON.stringify({
        isApiErrorMessage: true,
        error: "some_unknown_error",
        apiErrorStatus: 429,
      }),
    ]);

    const result = detectAuthChallengeFromJsonl(workDir);

    assert.ok(
      result !== null,
      "429 status must be detected as an auth challenge"
    );
    assert.ok(
      result.includes("429"),
      `result must mention the HTTP status 429, got: ${result}`
    );
  });

  test("returns error string for isApiErrorMessage entry with apiErrorStatus 401", () => {
    const workDir = makeTempDir();
    writeJsonlOutput(workDir, [
      JSON.stringify({
        isApiErrorMessage: true,
        error: "unauthorized",
        apiErrorStatus: 401,
      }),
    ]);

    const result = detectAuthChallengeFromJsonl(workDir);

    assert.ok(
      result !== null,
      "401 status must be detected as an auth challenge"
    );
    assert.ok(
      result.includes("401"),
      `result must mention the HTTP status 401, got: ${result}`
    );
  });

  test("returns error string for isApiErrorMessage entry with apiErrorStatus 403", () => {
    const workDir = makeTempDir();
    writeJsonlOutput(workDir, [
      JSON.stringify({
        isApiErrorMessage: true,
        error: "forbidden",
        apiErrorStatus: 403,
      }),
    ]);

    const result = detectAuthChallengeFromJsonl(workDir);

    assert.ok(
      result !== null,
      "403 status must be detected as an auth challenge"
    );
    assert.ok(
      result.includes("403"),
      `result must mention the HTTP status 403, got: ${result}`
    );
  });

  test("returns error string for isApiErrorMessage with error text matching AUTH_STATUS_PATTERN", () => {
    const workDir = makeTempDir();
    writeJsonlOutput(workDir, [
      JSON.stringify({
        isApiErrorMessage: true,
        error: "rate_limit_error",
        apiErrorStatus: 200,
      }),
    ]);

    const result = detectAuthChallengeFromJsonl(workDir);

    assert.ok(
      result !== null,
      "rate_limit_error text must be detected even without a 4xx status"
    );
    assert.ok(
      result.includes("rate_limit_error"),
      `result must include the error text, got: ${result}`
    );
  });

  test("does not return error for isApiErrorMessage with non-auth error and non-4xx status", () => {
    const workDir = makeTempDir();
    writeJsonlOutput(workDir, [
      JSON.stringify({
        isApiErrorMessage: true,
        error: "internal_server_error",
        apiErrorStatus: 500,
      }),
    ]);

    const result = detectAuthChallengeFromJsonl(workDir);

    assert.equal(
      result,
      null,
      "non-auth 500 error must not be detected as an auth challenge"
    );
  });
});

// ---------------------------------------------------------------------------
// detectAuthChallengeFromJsonl — malformed lines
// ---------------------------------------------------------------------------

describe("detectAuthChallengeFromJsonl — malformed lines", () => {
  test("skips malformed non-JSON lines without throwing", () => {
    const workDir = makeTempDir();
    writeJsonlOutput(workDir, [
      "this is not json {{{",
      "another bad line",
      JSON.stringify({ type: "result", is_error: false, result: "ok" }),
    ]);

    assert.doesNotThrow(() => {
      const result = detectAuthChallengeFromJsonl(workDir);
      assert.equal(
        result,
        null,
        "malformed lines must be skipped and healthy result returned"
      );
    });
  });

  test("still detects auth errors when valid entries follow malformed lines", () => {
    const workDir = makeTempDir();
    writeJsonlOutput(workDir, [
      "not valid json at all",
      JSON.stringify({
        type: "result",
        is_error: true,
        result: "authentication_error: invalid credentials",
      }),
    ]);

    const result = detectAuthChallengeFromJsonl(workDir);

    assert.ok(
      result !== null,
      "auth error after malformed line must still be detected"
    );
    assert.ok(
      result.includes("authentication_error"),
      `result must contain the error text, got: ${result}`
    );
  });

  test("handles empty lines in the JSONL file without throwing", () => {
    const workDir = makeTempDir();
    // Write file with blank lines interspersed.
    fs.writeFileSync(
      path.join(workDir, "claude-output.jsonl"),
      "\n\n" +
        JSON.stringify({ type: "result", is_error: false, result: "done" }) +
        "\n\n",
      "utf-8"
    );

    assert.doesNotThrow(() => {
      const result = detectAuthChallengeFromJsonl(workDir);
      assert.equal(result, null);
    });
  });
});

// ---------------------------------------------------------------------------
// detectAuthChallengeFromJsonlFile — direct file path variant (LLM-commit
// tertiary guard: scans native Claude session transcripts)
// ---------------------------------------------------------------------------

describe("detectAuthChallengeFromJsonlFile — transcript detection (auth challenge present)", () => {
  test("returns error string when transcript contains isApiErrorMessage with 429 status", () => {
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

    assert.ok(
      result !== null,
      "429 rate_limit_error must be detected as auth challenge"
    );
    assert.ok(
      result.includes("429"),
      `result must mention HTTP status 429, got: ${result}`
    );
  });

  test("returns error string when transcript contains result entry with auth error text", () => {
    const dir = makeTempDir();
    const transcriptPath = path.join(dir, "session-def456.jsonl");
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "result",
        is_error: true,
        result: "authentication_error: invalid api key",
      })}\n`,
      "utf-8"
    );

    const result = detectAuthChallengeFromJsonlFile(transcriptPath);

    assert.ok(
      result !== null,
      "authentication_error result must be detected as auth challenge"
    );
    assert.ok(
      result.includes("authentication_error"),
      `result must contain the error text, got: ${result}`
    );
  });

  test("returns error string when transcript contains isApiErrorMessage with 401 status", () => {
    const dir = makeTempDir();
    const transcriptPath = path.join(dir, "session-401.jsonl");
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        isApiErrorMessage: true,
        error: "unauthorized",
        apiErrorStatus: 401,
      })}\n`,
      "utf-8"
    );

    const result = detectAuthChallengeFromJsonlFile(transcriptPath);

    assert.ok(
      result !== null,
      "401 unauthorized must be detected as auth challenge"
    );
    assert.ok(
      result.includes("401"),
      `result must mention HTTP status 401, got: ${result}`
    );
  });
});

describe("detectAuthChallengeFromJsonlFile — missing session ID / missing file", () => {
  test("returns null when file path does not exist", () => {
    const dir = makeTempDir();
    const nonExistentPath = path.join(dir, "no-such-session.jsonl");

    const result = detectAuthChallengeFromJsonlFile(nonExistentPath);

    assert.equal(result, null, "non-existent transcript path must return null");
  });

  test("returns null when called with empty string", () => {
    const result = detectAuthChallengeFromJsonlFile("");

    assert.equal(result, null, "empty file path must return null");
  });

  test("returns null when called with null/undefined", () => {
    const result = detectAuthChallengeFromJsonlFile(null);

    assert.equal(result, null, "null file path must return null");
  });
});

describe("detectAuthChallengeFromJsonlFile — unreadable transcript file", () => {
  test("returns null gracefully when file exists but is empty", () => {
    const dir = makeTempDir();
    const transcriptPath = path.join(dir, "empty-session.jsonl");
    fs.writeFileSync(transcriptPath, "", "utf-8");

    const result = detectAuthChallengeFromJsonlFile(transcriptPath);

    assert.equal(
      result,
      null,
      "empty transcript file must return null without throwing"
    );
  });

  test("returns null gracefully when file contains only whitespace/newlines", () => {
    const dir = makeTempDir();
    const transcriptPath = path.join(dir, "whitespace-session.jsonl");
    fs.writeFileSync(transcriptPath, "\n\n\n", "utf-8");

    const result = detectAuthChallengeFromJsonlFile(transcriptPath);

    assert.equal(result, null, "whitespace-only transcript must return null");
  });
});

describe("detectAuthChallengeFromJsonlFile — healthy transcript (no-signal case)", () => {
  test("returns null for normal transcript with only successful assistant messages", () => {
    const dir = makeTempDir();
    const transcriptPath = path.join(dir, "healthy-session.jsonl");
    fs.writeFileSync(
      transcriptPath,
      `${[
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Analyzing code..." }] },
        }),
        JSON.stringify({
          type: "tool_use",
          name: "Read",
          input: { file_path: "/workspace/foo.ts" },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Task completed.",
        }),
      ].join("\n")}\n`,
      "utf-8"
    );

    const result = detectAuthChallengeFromJsonlFile(transcriptPath);

    assert.equal(result, null, "healthy transcript must return null");
  });

  test("returns null for result entry with is_error true but non-auth message", () => {
    const dir = makeTempDir();
    const transcriptPath = path.join(dir, "non-auth-error-session.jsonl");
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "result",
        is_error: true,
        result: "file not found: /workspace/missing.ts",
      })}\n`,
      "utf-8"
    );

    const result = detectAuthChallengeFromJsonlFile(transcriptPath);

    assert.equal(result, null, "non-auth error transcript must return null");
  });

  test("returns null for isApiErrorMessage with non-auth error and non-4xx status", () => {
    const dir = makeTempDir();
    const transcriptPath = path.join(dir, "server-error-session.jsonl");
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        isApiErrorMessage: true,
        error: "internal_server_error",
        apiErrorStatus: 500,
      })}\n`,
      "utf-8"
    );

    const result = detectAuthChallengeFromJsonlFile(transcriptPath);

    assert.equal(
      result,
      null,
      "500 internal_server_error must not be detected as auth challenge"
    );
  });
});

describe("detectAuthChallengeFromJsonlFile — malformed JSONL lines", () => {
  test("handles malformed JSONL gracefully and returns null when no auth signals", () => {
    const dir = makeTempDir();
    const transcriptPath = path.join(dir, "malformed-session.jsonl");
    fs.writeFileSync(
      transcriptPath,
      `${[
        "this is not json {{{",
        "another bad line",
        JSON.stringify({ type: "result", is_error: false, result: "ok" }),
      ].join("\n")}\n`,
      "utf-8"
    );

    assert.doesNotThrow(() => {
      const result = detectAuthChallengeFromJsonlFile(transcriptPath);
      assert.equal(
        result,
        null,
        "malformed lines must be skipped and healthy result returned null"
      );
    });
  });

  test("still detects auth errors when valid auth entries follow malformed lines", () => {
    const dir = makeTempDir();
    const transcriptPath = path.join(dir, "malformed-then-auth-session.jsonl");
    fs.writeFileSync(
      transcriptPath,
      `${[
        "not valid json at all",
        JSON.stringify({
          type: "result",
          is_error: true,
          result: "rate_limit_error: quota exceeded",
        }),
      ].join("\n")}\n`,
      "utf-8"
    );

    const result = detectAuthChallengeFromJsonlFile(transcriptPath);

    assert.ok(
      result !== null,
      "auth error after malformed line must still be detected"
    );
    assert.ok(
      result.includes("rate_limit_error"),
      `result must contain the error text, got: ${result}`
    );
  });
});
