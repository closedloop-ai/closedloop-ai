/**
 * Unit tests for session/context limit detection in the symphony loop.
 *
 * Covers:
 * - detectSessionLimitFromJsonl: JSONL-based detection
 * - isSessionLimitError: log-tail-based detection
 * - SESSION_LIMIT_PATTERN: shared regex correctness
 *
 * These tests verify that only genuine session/context limit errors are
 * classified as CONTEXT_LIMIT_EXCEEDED, and that unrelated errors (API
 * auth failures, tool errors, generic crashes) are NOT misclassified.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  AUTH_CHALLENGE_PATTERN,
  AUTH_STATUS_PATTERN,
  detectAuthChallengeFromJsonl,
  detectSessionLimitFromJsonl,
  isAuthChallengeError,
  isSessionLimitError,
  SESSION_LIMIT_PATTERN,
} from "../src/server/operations/symphony-loop.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-limit-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(
  lines: Record<string, unknown>[],
  filename = "claude-output.jsonl"
): void {
  const content = lines.map((l) => JSON.stringify(l)).join("\n");
  fs.writeFileSync(path.join(tmpDir, filename), content);
}

// ---------------------------------------------------------------------------
// detectSessionLimitFromJsonl
// ---------------------------------------------------------------------------

describe("detectSessionLimitFromJsonl", () => {
  test("returns null when JSONL file does not exist", () => {
    assert.strictEqual(detectSessionLimitFromJsonl(tmpDir), null);
  });

  test("returns null for empty JSONL file", () => {
    fs.writeFileSync(path.join(tmpDir, "claude-output.jsonl"), "");
    assert.strictEqual(detectSessionLimitFromJsonl(tmpDir), null);
  });

  test("returns null for successful result (is_error: false)", () => {
    writeJsonl([
      { type: "result", subtype: "success", result: "", is_error: false },
    ]);
    assert.strictEqual(detectSessionLimitFromJsonl(tmpDir), null);
  });

  test("returns null for is_error: true with NON-session-limit message", () => {
    writeJsonl([
      {
        type: "result",
        subtype: "error",
        result: "Authentication failed: invalid API key",
        is_error: true,
      },
    ]);
    assert.strictEqual(detectSessionLimitFromJsonl(tmpDir), null);
  });

  test("returns null for generic tool error (not a session limit)", () => {
    writeJsonl([
      {
        type: "result",
        subtype: "error",
        result: "Command failed with exit code 1",
        is_error: true,
      },
    ]);
    assert.strictEqual(detectSessionLimitFromJsonl(tmpDir), null);
  });

  test("returns null for unknown error without result string", () => {
    writeJsonl([{ type: "result", is_error: true, result: 42 }]);
    assert.strictEqual(detectSessionLimitFromJsonl(tmpDir), null);
  });

  test("returns null for non-result record with is_error", () => {
    writeJsonl([
      { type: "assistant", is_error: true, result: "Prompt is too long" },
    ]);
    assert.strictEqual(detectSessionLimitFromJsonl(tmpDir), null);
  });

  test('detects "Prompt is too long" as session limit', () => {
    writeJsonl([
      {
        type: "result",
        subtype: "error",
        result: "Prompt is too long",
        is_error: true,
      },
    ]);
    assert.strictEqual(
      detectSessionLimitFromJsonl(tmpDir),
      "Prompt is too long"
    );
  });

  test('detects "context limit reached" as session limit', () => {
    writeJsonl([
      {
        type: "result",
        subtype: "error",
        result: "Error: context limit reached, please start a new conversation",
        is_error: true,
      },
    ]);
    assert.strictEqual(
      detectSessionLimitFromJsonl(tmpDir),
      "Error: context limit reached, please start a new conversation"
    );
  });

  test('detects "conversation too long" as session limit', () => {
    writeJsonl([
      {
        type: "result",
        subtype: "error",
        result: "The conversation too long to continue",
        is_error: true,
      },
    ]);
    assert.strictEqual(
      detectSessionLimitFromJsonl(tmpDir),
      "The conversation too long to continue"
    );
  });

  test('detects "exceed context limit" as session limit', () => {
    writeJsonl([
      {
        type: "result",
        subtype: "error",
        result: "Messages exceed context limit for this model",
        is_error: true,
      },
    ]);
    assert.strictEqual(
      detectSessionLimitFromJsonl(tmpDir),
      "Messages exceed context limit for this model"
    );
  });

  test("detection is case-insensitive", () => {
    writeJsonl([
      {
        type: "result",
        subtype: "error",
        result: "PROMPT IS TOO LONG",
        is_error: true,
      },
    ]);
    assert.strictEqual(
      detectSessionLimitFromJsonl(tmpDir),
      "PROMPT IS TOO LONG"
    );
  });

  test("skips non-error records and finds session limit later in file", () => {
    writeJsonl([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      },
      { type: "result", subtype: "success", result: "", is_error: false },
      {
        type: "result",
        subtype: "error",
        result: "Prompt is too long",
        is_error: true,
      },
    ]);
    assert.strictEqual(
      detectSessionLimitFromJsonl(tmpDir),
      "Prompt is too long"
    );
  });

  test("skips malformed JSON lines gracefully", () => {
    const content = [
      "not valid json",
      JSON.stringify({
        type: "result",
        subtype: "error",
        result: "context limit reached",
        is_error: true,
      }),
    ].join("\n");
    fs.writeFileSync(path.join(tmpDir, "claude-output.jsonl"), content);
    assert.strictEqual(
      detectSessionLimitFromJsonl(tmpDir),
      "context limit reached"
    );
  });

  test("ignores blank lines", () => {
    const content = [
      "",
      JSON.stringify({
        type: "result",
        subtype: "error",
        result: "Prompt is too long",
        is_error: true,
      }),
      "",
    ].join("\n");
    fs.writeFileSync(path.join(tmpDir, "claude-output.jsonl"), content);
    assert.strictEqual(
      detectSessionLimitFromJsonl(tmpDir),
      "Prompt is too long"
    );
  });

  test("reads a sidecar-selected renamed JSONL file", () => {
    writeJsonl(
      [
        {
          type: "result",
          subtype: "error",
          result: "Prompt is too long",
          is_error: true,
        },
      ],
      "claude-output-run-1.jsonl"
    );
    fs.writeFileSync(
      path.join(tmpDir, "claude-output.name.txt"),
      "claude-output-run-1.jsonl\n"
    );

    assert.strictEqual(
      detectSessionLimitFromJsonl(tmpDir),
      "Prompt is too long"
    );
  });

  test("empty sidecar reads fixed-path current JSONL instead of stale renamed output", () => {
    writeJsonl(
      [
        {
          type: "result",
          subtype: "error",
          result: "authentication_error: stale prior run",
          is_error: true,
        },
      ],
      "claude-output-stale.jsonl"
    );
    writeJsonl([
      {
        type: "result",
        subtype: "error",
        result: "context limit reached",
        is_error: true,
      },
    ]);
    fs.writeFileSync(path.join(tmpDir, "claude-output.name.txt"), "");

    assert.strictEqual(
      detectSessionLimitFromJsonl(tmpDir),
      "context limit reached"
    );
  });
});

// ---------------------------------------------------------------------------
// isSessionLimitError
// ---------------------------------------------------------------------------

describe("isSessionLimitError", () => {
  test("returns false for empty string", () => {
    assert.strictEqual(isSessionLimitError(""), false);
  });

  test("returns false for generic error output", () => {
    assert.strictEqual(
      isSessionLimitError("Error: ENOENT: no such file or directory"),
      false
    );
  });

  test("returns false for API auth error", () => {
    assert.strictEqual(
      isSessionLimitError("Authentication error: Invalid API key provided"),
      false
    );
  });

  test('detects "prompt is too long"', () => {
    assert.strictEqual(
      isSessionLimitError("Error: prompt is too long for this model"),
      true
    );
  });

  test('detects "exceed context limit"', () => {
    assert.strictEqual(
      isSessionLimitError("Messages exceed context limit"),
      true
    );
  });

  test('detects "context limit reached"', () => {
    assert.strictEqual(
      isSessionLimitError(
        "context limit reached, please start a new conversation"
      ),
      true
    );
  });

  test('detects "conversation too long"', () => {
    assert.strictEqual(
      isSessionLimitError("The conversation too long to continue processing"),
      true
    );
  });

  test("detection is case-insensitive", () => {
    assert.strictEqual(isSessionLimitError("PROMPT IS TOO LONG"), true);
  });

  test("detects pattern embedded in multiline log tail", () => {
    const logTail = [
      "Running claude code...",
      "Processing files...",
      "Error: prompt is too long",
      "Process exited with code 2",
    ].join("\n");
    assert.strictEqual(isSessionLimitError(logTail), true);
  });
});

// ---------------------------------------------------------------------------
// SESSION_LIMIT_PATTERN
// ---------------------------------------------------------------------------

describe("SESSION_LIMIT_PATTERN", () => {
  const positives = [
    "prompt is too long",
    "Prompt is too long",
    "exceed context limit",
    "Messages exceed context limit for this model",
    "context limit reached",
    "Context limit reached, please start a new conversation",
    "conversation too long",
    "The conversation too long to continue",
  ];

  const negatives = [
    "Authentication failed",
    "Rate limit exceeded",
    "Command failed with exit code 1",
    "Something went wrong",
    "ENOENT: no such file or directory",
    "timeout after 300000ms",
    "",
  ];

  for (const input of positives) {
    test(`matches: "${input}"`, () => {
      assert.strictEqual(SESSION_LIMIT_PATTERN.test(input), true);
      // Reset lastIndex since the regex has no /g flag but just in case
    });
  }

  for (const input of negatives) {
    test(`does not match: "${input || "(empty)"}"`, () => {
      assert.strictEqual(SESSION_LIMIT_PATTERN.test(input), false);
    });
  }
});

// ---------------------------------------------------------------------------
// AUTH_CHALLENGE_PATTERN
// ---------------------------------------------------------------------------

describe("AUTH_CHALLENGE_PATTERN", () => {
  const positives = [
    "authentication_error",
    "Invalid bearer token",
    "invalid token",
    "authentication required",
    "rate_limit_error",
    "Rate limit reached for model claude-3-5-sonnet",
    "Claude usage limit reached. Your limit will reset at 2pm.",
    "Usage limit exceeded",
    "billing_error: payment required",
    "permission_error: forbidden",
    "overloaded_error",
    "API overloaded, try again",
    "unauthorized",
    "OAuth token expired, please re-authenticate",
  ];

  const negatives = [
    "Prompt is too long",
    "context limit reached",
    "conversation too long",
    "Command failed with exit code 1",
    "ENOENT: no such file or directory",
    "File content exceeds maximum allowed tokens",
    "session",
    "new session started",
    "session data",
    // Generic permission/forbidden phrasing must NOT match the narrow pattern
    // applied to raw stderr — these terms can appear in filesystem, git, or
    // network errors and would cause false-positive auth-challenge recovery.
    "forbidden",
    "access denied",
    "access denied opening /Users/foo/.config",
    "git: forbidden by remote",
    "",
  ];

  for (const input of positives) {
    test(`matches: "${input}"`, () => {
      assert.ok(AUTH_CHALLENGE_PATTERN.test(input));
    });
  }

  for (const input of negatives) {
    test(`does not match: "${input || "(empty)"}"`, () => {
      assert.strictEqual(AUTH_CHALLENGE_PATTERN.test(input), false);
    });
  }
});

// ---------------------------------------------------------------------------
// AUTH_STATUS_PATTERN — broader pattern, only applied to synthetic
// `isApiErrorMessage` entries from the Claude CLI.
// ---------------------------------------------------------------------------

describe("AUTH_STATUS_PATTERN", () => {
  const positives = [
    "authentication_error",
    "Invalid bearer token",
    "rate_limit_error",
    // Bare `rate_limit` token — Claude CLI emits this in the synthetic
    // `error` field for HTTP 429 entries. Must match without `_error` suffix.
    "rate_limit",
    "forbidden",
    "access denied",
    "unauthorized",
  ];

  const negatives = [
    "Prompt is too long",
    "context limit reached",
    "Command failed with exit code 1",
    // Defensive: `rate_limit` must be a whole token, not a substring of an
    // unrelated key like `rate_limited` or `rate_limit_window`.
    "rate_limited",
    "rate_limit_window=60",
    "",
  ];

  for (const input of positives) {
    test(`matches: "${input}"`, () => {
      assert.ok(AUTH_STATUS_PATTERN.test(input));
    });
  }

  for (const input of negatives) {
    test(`does not match: "${input || "(empty)"}"`, () => {
      assert.strictEqual(AUTH_STATUS_PATTERN.test(input), false);
    });
  }
});

// ---------------------------------------------------------------------------
// detectAuthChallengeFromJsonl
// ---------------------------------------------------------------------------

describe("detectAuthChallengeFromJsonl", () => {
  test("returns null when JSONL file does not exist", () => {
    assert.strictEqual(detectAuthChallengeFromJsonl(tmpDir), null);
  });

  test("returns null for successful result", () => {
    writeJsonl([
      { type: "result", subtype: "success", result: "", is_error: false },
    ]);
    assert.strictEqual(detectAuthChallengeFromJsonl(tmpDir), null);
  });

  test("returns null for context limit error (not auth)", () => {
    writeJsonl([
      {
        type: "result",
        subtype: "error",
        result: "Prompt is too long",
        is_error: true,
      },
    ]);
    assert.strictEqual(detectAuthChallengeFromJsonl(tmpDir), null);
  });

  test("detects authentication_error", () => {
    writeJsonl([
      {
        type: "result",
        subtype: "error",
        result: "authentication_error: Invalid bearer token",
        is_error: true,
      },
    ]);
    const result = detectAuthChallengeFromJsonl(tmpDir);
    assert.ok(result);
    assert.ok(result.includes("authentication_error"));
  });

  test("detects rate limit error", () => {
    writeJsonl([
      {
        type: "result",
        subtype: "error",
        result: "rate_limit_error: Rate limit reached",
        is_error: true,
      },
    ]);
    assert.ok(detectAuthChallengeFromJsonl(tmpDir));
  });

  test("detects usage limit", () => {
    writeJsonl([
      {
        type: "result",
        subtype: "error",
        result: "Claude usage limit reached",
        is_error: true,
      },
    ]);
    assert.ok(detectAuthChallengeFromJsonl(tmpDir));
  });

  test("detects billing error", () => {
    writeJsonl([
      {
        type: "result",
        subtype: "error",
        result: "billing_error: payment required",
        is_error: true,
      },
    ]);
    assert.ok(detectAuthChallengeFromJsonl(tmpDir));
  });

  test("no overlap: session limit errors are not detected as auth", () => {
    writeJsonl([
      {
        type: "result",
        subtype: "error",
        result: "Error: context limit reached, please start a new conversation",
        is_error: true,
      },
    ]);
    assert.strictEqual(detectAuthChallengeFromJsonl(tmpDir), null);
  });

  // Synthetic API-error entries (isApiErrorMessage: true)

  test("detects synthetic rate_limit_error entry", () => {
    writeJsonl([
      {
        type: "assistant",
        isApiErrorMessage: true,
        error: "rate_limit_error",
        apiErrorStatus: 429,
      },
    ]);
    const result = detectAuthChallengeFromJsonl(tmpDir);
    assert.ok(result);
    assert.ok(result.includes("rate_limit_error"));
  });

  test("detects synthetic authentication_error entry", () => {
    writeJsonl([
      {
        type: "assistant",
        isApiErrorMessage: true,
        error: "authentication_error",
        apiErrorStatus: 401,
      },
    ]);
    const result = detectAuthChallengeFromJsonl(tmpDir);
    assert.ok(result);
    assert.ok(result.includes("authentication_error"));
  });

  test("ignores synthetic entry without isApiErrorMessage flag", () => {
    writeJsonl([
      { type: "assistant", error: "rate_limit_error", apiErrorStatus: 429 },
    ]);
    assert.strictEqual(detectAuthChallengeFromJsonl(tmpDir), null);
  });

  test("ignores synthetic entry when isApiErrorMessage is false", () => {
    writeJsonl([
      {
        type: "assistant",
        isApiErrorMessage: false,
        error: "rate_limit_error",
        apiErrorStatus: 429,
      },
    ]);
    assert.strictEqual(detectAuthChallengeFromJsonl(tmpDir), null);
  });

  test("ignores synthetic entry with non-auth error", () => {
    writeJsonl([
      {
        type: "assistant",
        isApiErrorMessage: true,
        error: "Prompt is too long",
      },
    ]);
    assert.strictEqual(detectAuthChallengeFromJsonl(tmpDir), null);
  });

  // apiErrorStatus-based detection (HTTP 401/403 regardless of error text)

  test("detects apiErrorStatus=401 even when error text does not match AUTH_STATUS_PATTERN", () => {
    writeJsonl([
      {
        type: "assistant",
        isApiErrorMessage: true,
        error: "something went wrong",
        apiErrorStatus: 401,
      },
    ]);
    const result = detectAuthChallengeFromJsonl(tmpDir);
    assert.ok(result);
    assert.ok(result.includes("401"));
    assert.ok(result.includes("something went wrong"));
  });

  test("detects apiErrorStatus=403 even when error text does not match AUTH_STATUS_PATTERN", () => {
    writeJsonl([
      {
        type: "assistant",
        isApiErrorMessage: true,
        error: "generic error",
        apiErrorStatus: 403,
      },
    ]);
    const result = detectAuthChallengeFromJsonl(tmpDir);
    assert.ok(result);
    assert.ok(result.includes("403"));
    assert.ok(result.includes("generic error"));
  });

  test("does NOT detect apiErrorStatus=500 when error text does not match AUTH_STATUS_PATTERN", () => {
    writeJsonl([
      {
        type: "assistant",
        isApiErrorMessage: true,
        error: "something went wrong",
        apiErrorStatus: 500,
      },
    ]);
    assert.strictEqual(detectAuthChallengeFromJsonl(tmpDir), null);
  });

  // Regression: real-world synthetic entry observed from Claude CLI 2.1.126
  // carries `error: "rate_limit"` (bare token, no `_error` suffix) with
  // `apiErrorStatus: 429`. Both the widened text pattern and the 429 status
  // fallback must independently catch it.
  test("detects synthetic rate_limit entry (bare token, no _error suffix)", () => {
    writeJsonl([
      {
        type: "assistant",
        isApiErrorMessage: true,
        error: "rate_limit",
        apiErrorStatus: 429,
      },
    ]);
    const result = detectAuthChallengeFromJsonl(tmpDir);
    assert.ok(result);
    assert.ok(result.includes("rate_limit"));
  });

  test("detects apiErrorStatus=429 even when error text does not match AUTH_STATUS_PATTERN", () => {
    writeJsonl([
      {
        type: "assistant",
        isApiErrorMessage: true,
        error: "quota exceeded",
        apiErrorStatus: 429,
      },
    ]);
    const result = detectAuthChallengeFromJsonl(tmpDir);
    assert.ok(result);
    assert.ok(result.includes("429"));
    assert.ok(result.includes("quota exceeded"));
  });

  test("detects synthetic entry in mixed JSONL alongside success result", () => {
    writeJsonl([
      { type: "result", subtype: "success", result: "", is_error: false },
      {
        type: "assistant",
        isApiErrorMessage: true,
        error: "rate_limit_error",
        apiErrorStatus: 429,
      },
    ]);
    const result = detectAuthChallengeFromJsonl(tmpDir);
    assert.ok(result);
    assert.ok(result.includes("rate_limit_error"));
  });

  test("reads a sidecar-selected renamed JSONL file", () => {
    writeJsonl(
      [
        {
          type: "result",
          subtype: "error",
          result: "authentication_error: Invalid bearer token",
          is_error: true,
        },
      ],
      "claude-output-run-1.jsonl"
    );
    fs.writeFileSync(
      path.join(tmpDir, "claude-output.name.txt"),
      "claude-output-run-1.jsonl\n"
    );

    assert.strictEqual(
      detectAuthChallengeFromJsonl(tmpDir),
      "authentication_error: Invalid bearer token"
    );
  });

  test("stale sidecar falls back to newest renamed JSONL file", () => {
    const older = path.join(tmpDir, "claude-output-old.jsonl");
    const newer = path.join(tmpDir, "claude-output-new.jsonl");
    writeJsonl(
      [
        {
          type: "result",
          subtype: "error",
          result: "authentication_error: old",
          is_error: true,
        },
      ],
      path.basename(older)
    );
    writeJsonl(
      [
        {
          type: "result",
          subtype: "error",
          result: "rate_limit_error: newest",
          is_error: true,
        },
      ],
      path.basename(newer)
    );
    fs.utimesSync(older, new Date(1000), new Date(1000));
    fs.utimesSync(newer, new Date(2000), new Date(2000));
    fs.writeFileSync(
      path.join(tmpDir, "claude-output.name.txt"),
      "claude-output-missing.jsonl\n"
    );

    assert.strictEqual(
      detectAuthChallengeFromJsonl(tmpDir),
      "rate_limit_error: newest"
    );
  });
});

// ---------------------------------------------------------------------------
// isAuthChallengeError
// ---------------------------------------------------------------------------

describe("isAuthChallengeError", () => {
  test("returns false for empty string", () => {
    assert.strictEqual(isAuthChallengeError(""), false);
  });

  test("returns false for context limit", () => {
    assert.strictEqual(isAuthChallengeError("Prompt is too long"), false);
  });

  test("detects auth error in log tail", () => {
    assert.ok(
      isAuthChallengeError("Error: authentication_error - Invalid bearer token")
    );
  });

  test("detects rate limit in multiline log", () => {
    const logTail =
      "Starting...\nProcessing...\nrate_limit_error: Rate limit reached\nExiting";
    assert.ok(isAuthChallengeError(logTail));
  });

  test("detection is case-insensitive", () => {
    assert.ok(isAuthChallengeError("RATE_LIMIT_ERROR"));
  });
});
