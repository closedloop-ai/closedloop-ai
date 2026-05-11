import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";

import {
  readUserVisibleLoopFailure,
  signUserVisibleLoopFailure,
  USER_VISIBLE_LOOP_FAILURE_FILE,
  USER_VISIBLE_LOOP_FAILURE_MAX_BYTES,
} from "./user-visible-loop-failure.mjs";

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

const TEST_SECRET = "test-signing-secret-abc123";

const VALID_PAYLOAD = {
  code: LoopErrorCode.RunnerError,
  message: "Claude rate limit reached.",
  result: { subcode: "CLAUDE_RATE_LIMIT" },
};

function writeValidMarker(
  claudeWorkDir,
  payload = VALID_PAYLOAD,
  secret = TEST_SECRET
) {
  const signature = signUserVisibleLoopFailure(payload, secret);
  fs.writeFileSync(
    path.join(claudeWorkDir, USER_VISIBLE_LOOP_FAILURE_FILE),
    JSON.stringify({ ...payload, signature }),
    "utf-8"
  );
  return { ...payload, signature };
}

describe("readUserVisibleLoopFailure", () => {
  test("returns the parsed failure for a valid signed marker", () => {
    const workDir = makeTempDir();
    const expected = writeValidMarker(workDir);

    const result = readUserVisibleLoopFailure({
      claudeWorkDir: workDir,
      signingSecret: TEST_SECRET,
    });

    assert.ok(result !== null);
    assert.equal(result.code, expected.code);
    assert.equal(result.message, expected.message);
    assert.equal(result.result.subcode, expected.result.subcode);
    assert.equal(result.signature, expected.signature);
  });

  test("returns null when the signature is tampered", () => {
    const workDir = makeTempDir();
    const marker = writeValidMarker(workDir);
    const tampered =
      marker.signature.slice(0, -1) +
      (marker.signature.endsWith("0") ? "1" : "0");
    fs.writeFileSync(
      path.join(workDir, USER_VISIBLE_LOOP_FAILURE_FILE),
      JSON.stringify({ ...VALID_PAYLOAD, signature: tampered }),
      "utf-8"
    );

    assert.equal(
      readUserVisibleLoopFailure({
        claudeWorkDir: workDir,
        signingSecret: TEST_SECRET,
      }),
      null
    );
  });

  test("returns null when the payload is modified after signing", () => {
    const workDir = makeTempDir();
    const marker = writeValidMarker(workDir);
    fs.writeFileSync(
      path.join(workDir, USER_VISIBLE_LOOP_FAILURE_FILE),
      JSON.stringify({
        ...VALID_PAYLOAD,
        message: "Injected message.",
        signature: marker.signature,
      }),
      "utf-8"
    );

    assert.equal(
      readUserVisibleLoopFailure({
        claudeWorkDir: workDir,
        signingSecret: TEST_SECRET,
      }),
      null
    );
  });

  test("returns null when the marker file exceeds the size limit", () => {
    const workDir = makeTempDir();
    fs.writeFileSync(
      path.join(workDir, USER_VISIBLE_LOOP_FAILURE_FILE),
      Buffer.alloc(USER_VISIBLE_LOOP_FAILURE_MAX_BYTES + 1, "x")
    );

    assert.equal(
      readUserVisibleLoopFailure({
        claudeWorkDir: workDir,
        signingSecret: TEST_SECRET,
      }),
      null
    );
  });

  test("returns null when the marker mtime is older than markerNotBeforeMs", () => {
    const workDir = makeTempDir();
    writeValidMarker(workDir);
    const markerPath = path.join(workDir, USER_VISIBLE_LOOP_FAILURE_FILE);
    const farPast = new Date(Date.now() - 60_000);
    fs.utimesSync(markerPath, farPast, farPast);

    assert.equal(
      readUserVisibleLoopFailure({
        claudeWorkDir: workDir,
        markerNotBeforeMs: Date.now(),
        signingSecret: TEST_SECRET,
      }),
      null
    );
  });

  test("returns the failure when the marker mtime meets the threshold", () => {
    const workDir = makeTempDir();
    writeValidMarker(workDir);

    const result = readUserVisibleLoopFailure({
      claudeWorkDir: workDir,
      markerNotBeforeMs: Date.now() - 30_000,
      signingSecret: TEST_SECRET,
    });

    assert.ok(result !== null);
  });

  test("returns null when the marker file does not exist", () => {
    const workDir = makeTempDir();

    assert.equal(
      readUserVisibleLoopFailure({
        claudeWorkDir: workDir,
        signingSecret: TEST_SECRET,
      }),
      null
    );
  });

  for (const secret of [undefined, ""]) {
    test(`returns null when signingSecret is ${JSON.stringify(secret)}`, () => {
      const workDir = makeTempDir();
      writeValidMarker(workDir);

      assert.equal(
        readUserVisibleLoopFailure({
          claudeWorkDir: workDir,
          signingSecret: secret,
        }),
        null
      );
    });
  }
});
