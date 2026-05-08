import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";

import {
  clearUserVisibleLoopFailureMarker,
  readUserVisibleLoopFailure,
  signUserVisibleLoopFailure,
  USER_VISIBLE_LOOP_FAILURE_FILE,
  USER_VISIBLE_LOOP_FAILURE_MAX_BYTES,
} from "./user-visible-loop-failure.mjs";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uvlf-test-"));
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-signing-secret-abc123";

const VALID_PAYLOAD = {
  code: LoopErrorCode.RunnerError,
  message: "Claude rate limit reached.",
  result: { subcode: "CLAUDE_RATE_LIMIT" },
};

/**
 * Write a properly signed marker file into claudeWorkDir and return the full
 * object (including the signature) that should come back from readUserVisibleLoopFailure.
 */
function writeValidMarker(
  claudeWorkDir,
  payload = VALID_PAYLOAD,
  secret = TEST_SECRET
) {
  const signature = signUserVisibleLoopFailure(payload, secret);
  const markerContent = JSON.stringify({ ...payload, signature });
  fs.writeFileSync(
    path.join(claudeWorkDir, USER_VISIBLE_LOOP_FAILURE_FILE),
    markerContent,
    "utf-8"
  );
  return { ...payload, signature };
}

// ---------------------------------------------------------------------------
// readUserVisibleLoopFailure — valid marker read
// ---------------------------------------------------------------------------

describe("readUserVisibleLoopFailure", () => {
  test("returns the parsed failure for a valid signed marker", () => {
    const workDir = makeTempDir();
    const expected = writeValidMarker(workDir);

    const result = readUserVisibleLoopFailure({
      claudeWorkDir: workDir,
      signingSecret: TEST_SECRET,
    });

    assert.ok(result !== null, "expected a non-null result for a valid marker");
    assert.equal(result.code, expected.code);
    assert.equal(result.message, expected.message);
    assert.equal(result.result.subcode, expected.result.subcode);
    assert.equal(result.signature, expected.signature);
  });

  // -------------------------------------------------------------------------
  // Tampered signature rejection
  // -------------------------------------------------------------------------

  test("returns null when the signature is tampered", () => {
    const workDir = makeTempDir();
    const marker = writeValidMarker(workDir);

    // Flip the last hex char of the signature to produce an invalid but
    // format-valid signature string.
    const tampered =
      marker.signature.slice(0, -1) +
      (marker.signature.endsWith("0") ? "1" : "0");
    const markerPath = path.join(workDir, USER_VISIBLE_LOOP_FAILURE_FILE);
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ ...VALID_PAYLOAD, signature: tampered }),
      "utf-8"
    );

    const result = readUserVisibleLoopFailure({
      claudeWorkDir: workDir,
      signingSecret: TEST_SECRET,
    });

    assert.equal(result, null, "tampered signature must be rejected");
  });

  test("returns null when the payload is modified after signing", () => {
    const workDir = makeTempDir();
    const marker = writeValidMarker(workDir);

    // Use the valid signature but change the message field.
    const markerPath = path.join(workDir, USER_VISIBLE_LOOP_FAILURE_FILE);
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        ...VALID_PAYLOAD,
        message: "Injected message.",
        signature: marker.signature,
      }),
      "utf-8"
    );

    const result = readUserVisibleLoopFailure({
      claudeWorkDir: workDir,
      signingSecret: TEST_SECRET,
    });

    assert.equal(
      result,
      null,
      "modified payload with original signature must be rejected"
    );
  });

  // -------------------------------------------------------------------------
  // Oversized file handling
  // -------------------------------------------------------------------------

  test("returns null when the marker file exceeds the size limit", () => {
    const workDir = makeTempDir();
    const markerPath = path.join(workDir, USER_VISIBLE_LOOP_FAILURE_FILE);

    // Write a file that is one byte over the limit. Content does not matter —
    // the size check fires before JSON parsing.
    const oversized = Buffer.alloc(
      USER_VISIBLE_LOOP_FAILURE_MAX_BYTES + 1,
      "x"
    );
    fs.writeFileSync(markerPath, oversized);

    const result = readUserVisibleLoopFailure({
      claudeWorkDir: workDir,
      signingSecret: TEST_SECRET,
    });

    assert.equal(result, null, "oversized marker must be ignored");
  });

  // -------------------------------------------------------------------------
  // Stale mtime handling
  // -------------------------------------------------------------------------

  test("returns null when the marker mtime is older than markerNotBeforeMs", () => {
    const workDir = makeTempDir();
    writeValidMarker(workDir);
    const markerPath = path.join(workDir, USER_VISIBLE_LOOP_FAILURE_FILE);

    // Back-date the file to a time well before the threshold we will pass.
    const farPast = new Date(Date.now() - 60_000);
    fs.utimesSync(markerPath, farPast, farPast);

    const result = readUserVisibleLoopFailure({
      claudeWorkDir: workDir,
      markerNotBeforeMs: Date.now(), // threshold is "now" — file is older
      signingSecret: TEST_SECRET,
    });

    assert.equal(result, null, "stale marker must be ignored");
  });

  test("returns the failure when the marker mtime meets the threshold", () => {
    const workDir = makeTempDir();
    writeValidMarker(workDir);

    // Set threshold to 30 seconds ago — the file was just written so it is newer.
    const result = readUserVisibleLoopFailure({
      claudeWorkDir: workDir,
      markerNotBeforeMs: Date.now() - 30_000,
      signingSecret: TEST_SECRET,
    });

    assert.ok(
      result !== null,
      "fresh marker at or after threshold must be returned"
    );
  });

  // -------------------------------------------------------------------------
  // Missing file handling
  // -------------------------------------------------------------------------

  test("returns null when the marker file does not exist", () => {
    const workDir = makeTempDir();
    // No marker written — directory is empty.

    const result = readUserVisibleLoopFailure({
      claudeWorkDir: workDir,
      signingSecret: TEST_SECRET,
    });

    assert.equal(result, null, "missing marker must return null");
  });

  // -------------------------------------------------------------------------
  // Missing secret handling
  // -------------------------------------------------------------------------

  test("returns null when signingSecret is undefined", () => {
    const workDir = makeTempDir();
    writeValidMarker(workDir);

    const result = readUserVisibleLoopFailure({
      claudeWorkDir: workDir,
      signingSecret: undefined,
    });

    assert.equal(
      result,
      null,
      "absent secret must prevent marker from being trusted"
    );
  });

  test("returns null when signingSecret is an empty string", () => {
    const workDir = makeTempDir();
    writeValidMarker(workDir);

    const result = readUserVisibleLoopFailure({
      claudeWorkDir: workDir,
      signingSecret: "",
    });

    assert.equal(result, null, "empty string secret must be treated as absent");
  });
});

// ---------------------------------------------------------------------------
// clearUserVisibleLoopFailureMarker
// ---------------------------------------------------------------------------

describe("clearUserVisibleLoopFailureMarker", () => {
  test("removes the marker file when it exists", () => {
    const workDir = makeTempDir();
    writeValidMarker(workDir);
    const markerPath = path.join(workDir, USER_VISIBLE_LOOP_FAILURE_FILE);

    assert.ok(
      fs.existsSync(markerPath),
      "pre-condition: marker must exist before clear"
    );

    clearUserVisibleLoopFailureMarker(workDir);

    assert.ok(!fs.existsSync(markerPath), "marker must not exist after clear");
  });

  test("does not throw when the marker file is already absent", () => {
    const workDir = makeTempDir();
    // No marker written.

    assert.doesNotThrow(() => {
      clearUserVisibleLoopFailureMarker(workDir);
    });
  });
});
