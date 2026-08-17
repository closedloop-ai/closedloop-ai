/**
 * ISS-5299 — branch coverage for symphony-loop.ts (gateway partition), file 2.
 *
 * Covers the pure string-processing and object-scrubbing exported functions:
 * scanJsonlForAuthChallenge, isAuthChallengeError, isSessionLimitError,
 * scrubObjectCredentials, and resolvePrimaryArtifact.
 *
 * All tests are synchronous or near-instant — no process spawning.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LoopArtifactType } from "@closedloop-ai/loops-api/artifacts";
import {
  AUTH_CHALLENGE_PATTERN,
  isAuthChallengeError,
  isSessionLimitError,
  resolvePrimaryArtifact,
  SESSION_LIMIT_PATTERN,
  scanJsonlForAuthChallenge,
  scrubObjectCredentials,
} from "../src/server/operations/symphony-loop.js";

// ---------------------------------------------------------------------------
// scanJsonlForAuthChallenge
// Covers: lines 3346 (skip empty), 3351-3357 (result entry match), 3361 (isApiErrorMessage),
//         3362-3363 (error coerce), 3364 (AUTH_STATUS_PATTERN match), 3366-3368 (status suffix),
//         3376-3381 (HTTP status fallback), 3384 (catch malformed)
// ---------------------------------------------------------------------------

describe("scanJsonlForAuthChallenge", () => {
  test("returns null for empty string", () => {
    assert.equal(scanJsonlForAuthChallenge(""), null);
  });

  test("returns null for content with only whitespace lines (line 3346 continue)", () => {
    assert.equal(scanJsonlForAuthChallenge("   \n\t\n  "), null);
  });

  test("returns null when malformed JSON lines are present (line 3384 catch)", () => {
    const content = "not-json\n{also bad\n";
    assert.equal(scanJsonlForAuthChallenge(content), null);
  });

  test("returns null when result entry type mismatches (non-auth is_error result)", () => {
    const entry = JSON.stringify({
      type: "result",
      is_error: true,
      result: "some generic error message",
    });
    assert.equal(scanJsonlForAuthChallenge(entry), null);
  });

  test("returns result text when result entry has authentication_error (line 3351-3357 match)", () => {
    const errorText = "authentication_error: invalid credentials";
    const entry = JSON.stringify({
      type: "result",
      is_error: true,
      result: errorText,
    });
    assert.equal(scanJsonlForAuthChallenge(entry), errorText);
  });

  test("skips non-matching lines before finding a matching result entry", () => {
    const noise = JSON.stringify({
      type: "system",
      is_error: false,
      result: "token expired this is noise",
    });
    const match = JSON.stringify({
      type: "result",
      is_error: true,
      result: "rate_limit_error: quota exceeded",
    });
    const result = scanJsonlForAuthChallenge(`${noise}\n${match}`);
    assert.ok(result?.includes("rate_limit_error"));
  });

  test("returns formatted string for isApiErrorMessage entry matching AUTH_STATUS_PATTERN (lines 3361, 3364)", () => {
    const entry = JSON.stringify({
      isApiErrorMessage: true,
      error: "authentication_error",
      apiErrorStatus: 401,
    });
    const result = scanJsonlForAuthChallenge(entry);
    assert.ok(result !== null);
    assert.ok(result.includes("authentication_error"));
  });

  test("returns formatted string with status suffix when apiErrorStatus is a number (line 3366 true branch)", () => {
    const entry = JSON.stringify({
      isApiErrorMessage: true,
      error: "rate_limit_error",
      apiErrorStatus: 429,
    });
    const result = scanJsonlForAuthChallenge(entry);
    assert.ok(result !== null);
    assert.ok(result.includes("429"), "status code must appear in result");
  });

  test("returns formatted string without status suffix when apiErrorStatus is absent (line 3366 false branch)", () => {
    const entry = JSON.stringify({
      isApiErrorMessage: true,
      error: "unauthorized",
      // no apiErrorStatus
    });
    const result = scanJsonlForAuthChallenge(entry);
    assert.ok(result !== null);
    assert.ok(
      !result.includes("status"),
      "result must not include status when apiErrorStatus is absent"
    );
  });

  test("falls back to 'unknown error' when error field is not a string (line 3362 false branch)", () => {
    const entry = JSON.stringify({
      isApiErrorMessage: true,
      // error is a number — not a string
      error: 401,
      apiErrorStatus: 401,
    });
    // apiErrorStatus=401 triggers the HTTP-status fallback regardless of AUTH_STATUS_PATTERN
    const result = scanJsonlForAuthChallenge(entry);
    assert.ok(result !== null);
    assert.ok(
      result.includes("unknown error"),
      "non-string error must produce 'unknown error'"
    );
  });

  test("returns HTTP-status fallback for apiErrorStatus 401 when error text does not match pattern (lines 3376-3381)", () => {
    const entry = JSON.stringify({
      isApiErrorMessage: true,
      error: "an unexpected backend error",
      apiErrorStatus: 401,
    });
    const result = scanJsonlForAuthChallenge(entry);
    assert.ok(result !== null);
    assert.ok(result.includes("401"));
  });

  test("returns HTTP-status fallback for apiErrorStatus 403 (lines 3376-3381)", () => {
    const entry = JSON.stringify({
      isApiErrorMessage: true,
      error: "some other error",
      apiErrorStatus: 403,
    });
    const result = scanJsonlForAuthChallenge(entry);
    assert.ok(result !== null);
    assert.ok(result.includes("403"));
  });

  test("returns null for isApiErrorMessage entry with non-auth error and non-special HTTP status", () => {
    const entry = JSON.stringify({
      isApiErrorMessage: true,
      error: "an unexpected 500 server error",
      apiErrorStatus: 500,
    });
    assert.equal(scanJsonlForAuthChallenge(entry), null);
  });

  test("scans multiple lines and returns the first match", () => {
    const safe = JSON.stringify({ type: "assistant", content: "hello" });
    const first = JSON.stringify({
      type: "result",
      is_error: true,
      result: "billing_error: payment required",
    });
    const second = JSON.stringify({
      type: "result",
      is_error: true,
      result: "rate_limit_error: quota",
    });
    const result = scanJsonlForAuthChallenge(`${safe}\n${first}\n${second}`);
    assert.ok(result?.includes("billing_error"));
  });
});

// ---------------------------------------------------------------------------
// isAuthChallengeError
// Single-expression function — covers the regex true and false branches
// ---------------------------------------------------------------------------

describe("isAuthChallengeError", () => {
  test("returns true when log tail contains authentication_error", () => {
    assert.equal(isAuthChallengeError("authentication_error: invalid"), true);
  });

  test("returns true when log tail contains rate_limit_error", () => {
    assert.equal(isAuthChallengeError("rate_limit_error hit"), true);
  });

  test("returns true when log tail contains token expired phrase", () => {
    assert.equal(isAuthChallengeError("your token has expired"), true);
  });

  test("returns false for unrelated error text", () => {
    assert.equal(
      isAuthChallengeError("ENOENT: no such file or directory"),
      false
    );
  });

  test("returns false for empty string", () => {
    assert.equal(isAuthChallengeError(""), false);
  });

  test("AUTH_CHALLENGE_PATTERN matches unauthorized (word boundary)", () => {
    assert.ok(AUTH_CHALLENGE_PATTERN.test("Request unauthorized by server"));
  });
});

// ---------------------------------------------------------------------------
// isSessionLimitError
// Single-expression function — covers the regex true and false branches
// ---------------------------------------------------------------------------

describe("isSessionLimitError", () => {
  test("returns true when log tail matches 'prompt is too long'", () => {
    assert.equal(
      isSessionLimitError("Prompt is too long for this model"),
      true
    );
  });

  test("returns true when log tail matches 'context limit reached'", () => {
    assert.equal(
      isSessionLimitError("Context limit reached at token 200000"),
      true
    );
  });

  test("returns true when log tail matches 'conversation too long'", () => {
    assert.equal(
      isSessionLimitError("The conversation too long to continue"),
      true
    );
  });

  test("returns true when log tail matches 'exceed context limit'", () => {
    assert.equal(isSessionLimitError("You exceed context limit"), true);
  });

  test("returns false for unrelated log text", () => {
    assert.equal(isSessionLimitError("rate_limit_error: billing"), false);
  });

  test("returns false for empty string", () => {
    assert.equal(isSessionLimitError(""), false);
  });

  test("SESSION_LIMIT_PATTERN is case-insensitive", () => {
    assert.ok(SESSION_LIMIT_PATTERN.test("PROMPT IS TOO LONG"));
    assert.ok(SESSION_LIMIT_PATTERN.test("context LIMIT reached"));
  });
});

// ---------------------------------------------------------------------------
// scrubObjectCredentials
// Covers: line 3990 (string branch), 3993 (array branch), 3996 (object branch),
//         4003 (primitive/null passthrough)
// ---------------------------------------------------------------------------

describe("scrubObjectCredentials", () => {
  test("redacts sk- API keys in a string value (line 3990 string branch)", () => {
    const result = scrubObjectCredentials(
      "API key is sk-abcdefghijklmnopqrstuvwxyz123"
    );
    assert.equal(typeof result, "string");
    assert.ok(
      !(result as string).includes("sk-abcdefghijklmno"),
      "sk- key must be redacted"
    );
    assert.ok(
      (result as string).includes("[REDACTED"),
      "redaction marker must appear"
    );
  });

  test("redacts AWS keys in a string value", () => {
    // AWS key pattern: (AKIA|ASIA|AROA) + exactly 16 uppercase alphanum + word boundary
    // AKIAIOSFODNN7EXAMPLE = AKIA(4) + IOSFODNN7EXAMPLE(16) = 20 chars, bounded by space
    const result = scrubObjectCredentials("key=AKIAIOSFODNN7EXAMPLE end");
    assert.equal(typeof result, "string");
    assert.ok(
      (result as string).includes("[REDACTED"),
      "AWS key must be redacted"
    );
  });

  test("maps over an array and scrubs each element (line 3993 array branch)", () => {
    const result = scrubObjectCredentials([
      "safe text",
      "sk-secret12345678901",
      42,
      null,
    ]) as unknown[];
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 4);
    assert.equal(result[0], "safe text");
    assert.ok((result[1] as string).includes("[REDACTED"));
    assert.equal(result[2], 42);
    assert.equal(result[3], null);
  });

  test("scrubs each value in a plain object (line 3996 object branch)", () => {
    const result = scrubObjectCredentials({
      name: "safe",
      token: "Bearer eyJhbGciOiJSUzI1NiJ9.payload.signature",
      count: 5,
    }) as Record<string, unknown>;
    assert.equal(typeof result, "object");
    assert.ok(result !== null);
    assert.equal(result.name, "safe");
    assert.ok(
      (result.token as string).includes("[REDACTED"),
      "Bearer token must be redacted"
    );
    assert.equal(result.count, 5);
  });

  test("passes null through unchanged (line 4003 primitive passthrough)", () => {
    assert.equal(scrubObjectCredentials(null), null);
  });

  test("passes numbers through unchanged (line 4003 primitive passthrough)", () => {
    assert.equal(scrubObjectCredentials(42), 42);
  });

  test("passes booleans through unchanged (line 4003 primitive passthrough)", () => {
    assert.equal(scrubObjectCredentials(true), true);
    assert.equal(scrubObjectCredentials(false), false);
  });

  test("recursively scrubs nested object fields", () => {
    const result = scrubObjectCredentials({
      outer: {
        inner: "sk-abcdefghijklmnopqrst",
      },
    }) as Record<string, Record<string, string>>;
    assert.ok(result.outer.inner.includes("[REDACTED"));
  });
});

// ---------------------------------------------------------------------------
// resolvePrimaryArtifact
// Covers: line 475 (found → return), line 478 (not found → throw)
// findPrimaryArtifact: line 491 (primaryArtifactId present → look up by ID),
//                      493 (found by ID → return), 497 (findLast by type)
// ---------------------------------------------------------------------------

describe("resolvePrimaryArtifact", () => {
  const prdArtifact = {
    id: "prd-001",
    type: LoopArtifactType.Prd,
    content: "PRD content here",
  };
  const planArtifact = {
    id: "plan-001",
    type: LoopArtifactType.ImplementationPlan,
    content: "Plan content here",
  };

  test("returns the last artifact of the requested type (line 497 findLast)", () => {
    const first = { id: "prd-a", type: LoopArtifactType.Prd, content: "first" };
    const second = {
      id: "prd-b",
      type: LoopArtifactType.Prd,
      content: "second",
    };
    const artifacts = [first, second, planArtifact];
    const result = resolvePrimaryArtifact(
      artifacts as Parameters<typeof resolvePrimaryArtifact>[0],
      LoopArtifactType.Prd
    );
    assert.equal(result.id, "prd-b");
    assert.equal(result.content, "second");
  });

  test("returns artifact by primaryArtifactId when provided and present (line 491, 493 true branches)", () => {
    const artifacts = [prdArtifact, planArtifact];
    const result = resolvePrimaryArtifact(
      artifacts as Parameters<typeof resolvePrimaryArtifact>[0],
      LoopArtifactType.Prd,
      "plan-001"
    );
    // primaryArtifactId match overrides type search
    assert.equal(result.id, "plan-001");
  });

  test("falls back to type search when primaryArtifactId has no match (line 493 false branch)", () => {
    const artifacts = [prdArtifact, planArtifact];
    const result = resolvePrimaryArtifact(
      artifacts as Parameters<typeof resolvePrimaryArtifact>[0],
      LoopArtifactType.Prd,
      "nonexistent-id"
    );
    // Falls back to findLast by type
    assert.equal(result.id, "prd-001");
  });

  test("throws when no matching artifact found (line 478 throw branch)", () => {
    const artifacts = [planArtifact];
    assert.throws(
      () =>
        resolvePrimaryArtifact(
          artifacts as Parameters<typeof resolvePrimaryArtifact>[0],
          LoopArtifactType.Prd
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("no"));
        assert.ok(err.message.includes("artifact found"));
        return true;
      }
    );
  });

  test("throws when artifact list is empty (line 478 throw branch)", () => {
    assert.throws(
      () =>
        resolvePrimaryArtifact(
          [] as Parameters<typeof resolvePrimaryArtifact>[0],
          LoopArtifactType.Prd
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );
  });
});
