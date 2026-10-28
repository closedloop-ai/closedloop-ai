/**
 * @file onboarding-handoff-cov-iss11283-validation.test.ts
 * @description ISS-11283 lane F — branch coverage for
 * `onboarding-handoff.ts`'s field-level validation branches in
 * `parsePendingOnboardingHandoff` and the `readPendingOnboardingHandoff`
 * read-failure / delete-after-invalid-content branches that the existing
 * `onboarding-handoff.test.ts` does not reach.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import {
  parsePendingOnboardingHandoff,
  readPendingOnboardingHandoff,
} from "../src/main/onboarding/onboarding-handoff.js";

const tempDirs: string[] = [];

// chmod-based failure injection needs POSIX permission semantics, which root
// bypasses; those cases skip rather than pass vacuously there.
const PERMISSION_DENIAL_ENFORCED =
  process.platform !== "win32" && process.getuid?.() !== 0;

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.chmod(dir, 0o700).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-handoff-cov-"));
  tempDirs.push(dir);
  return dir;
}

describe("parsePendingOnboardingHandoff shape and field validation", () => {
  test("rejects a non-object payload", () => {
    assert.deepEqual(parsePendingOnboardingHandoff(null), {
      ok: false,
      reason: "invalid_shape",
    });
    assert.deepEqual(parsePendingOnboardingHandoff("a string"), {
      ok: false,
      reason: "invalid_shape",
    });
    assert.deepEqual(parsePendingOnboardingHandoff([]), {
      ok: false,
      reason: "invalid_shape",
    });
  });

  test("rejects a blank onboardingAttemptId", () => {
    const result = parsePendingOnboardingHandoff({
      onboardingAttemptId: "   ",
      webAppOrigin: "https://app.closedloop.ai",
      createdAt: "2026-04-27T11:59:00.000Z",
    });

    assert.deepEqual(result, { ok: false, reason: "invalid_shape" });
  });

  test("rejects a non-string onboardingAttemptId", () => {
    const result = parsePendingOnboardingHandoff({
      onboardingAttemptId: 12_345,
      webAppOrigin: "https://app.closedloop.ai",
      createdAt: "2026-04-27T11:59:00.000Z",
    });

    assert.deepEqual(result, { ok: false, reason: "invalid_shape" });
  });

  test("rejects a missing webAppOrigin as invalid_origin", () => {
    const result = parsePendingOnboardingHandoff({
      onboardingAttemptId: "attempt-1",
      createdAt: "2026-04-27T11:59:00.000Z",
    });

    assert.deepEqual(result, { ok: false, reason: "invalid_origin" });
  });

  test("rejects a missing createdAt as invalid_created_at", () => {
    const result = parsePendingOnboardingHandoff({
      onboardingAttemptId: "attempt-1",
      webAppOrigin: "https://app.closedloop.ai",
    });

    assert.deepEqual(result, { ok: false, reason: "invalid_created_at" });
  });

  test("rejects an unparseable createdAt string", () => {
    const result = parsePendingOnboardingHandoff({
      onboardingAttemptId: "attempt-1",
      webAppOrigin: "https://app.closedloop.ai",
      createdAt: "not-a-real-date",
    });

    assert.deepEqual(result, { ok: false, reason: "invalid_created_at" });
  });

  test("rejects a non-string sandboxBaseDirectory", () => {
    const result = parsePendingOnboardingHandoff(
      {
        onboardingAttemptId: "attempt-1",
        webAppOrigin: "https://app.closedloop.ai",
        createdAt: "2026-04-27T11:59:00.000Z",
        sandboxBaseDirectory: 42,
      },
      new Date("2026-04-27T12:00:00.000Z")
    );

    assert.deepEqual(result, { ok: false, reason: "invalid_shape" });
  });

  test("omits sandboxBaseDirectory when it normalizes to nothing", () => {
    const now = new Date("2026-04-27T12:00:00.000Z");
    const result = parsePendingOnboardingHandoff(
      {
        onboardingAttemptId: "attempt-1",
        webAppOrigin: "https://app.closedloop.ai",
        createdAt: "2026-04-27T11:59:00.000Z",
        sandboxBaseDirectory: "   ",
      },
      now
    );

    assert.equal(result.ok, true);
    assert.equal(
      result.ok ? "sandboxBaseDirectory" in result.payload : true,
      false
    );
  });
});

describe("readPendingOnboardingHandoff read failures", () => {
  test("reports absent for a file that does not exist", async () => {
    const dir = await makeTempDir();

    const result = await readPendingOnboardingHandoff(
      path.join(dir, "missing.json")
    );

    assert.deepEqual(result, { kind: "absent" });
  });

  test("reports read_failed for a non-ENOENT read error", async () => {
    const dir = await makeTempDir();
    // A directory path handed to fs.readFile fails with EISDIR, not ENOENT.
    const result = await readPendingOnboardingHandoff(dir);

    assert.deepEqual(result, { kind: "ignored", reason: "read_failed" });
  });
});

describe("readPendingOnboardingHandoff invalid content handling", () => {
  test("deletes and reports invalid_json for malformed JSON when delete succeeds", async () => {
    const dir = await makeTempDir();
    const handoffPath = path.join(dir, "pending-onboarding.json");
    await fs.writeFile(handoffPath, "{not-json", "utf-8");

    const result = await readPendingOnboardingHandoff(
      handoffPath,
      new Date("2026-04-27T12:00:00.000Z")
    );

    assert.deepEqual(result, { kind: "ignored", reason: "invalid_json" });
    await assert.rejects(fs.stat(handoffPath), { code: "ENOENT" });
  });

  test("deletes and reports the validation reason for well-formed but invalid content", async () => {
    const dir = await makeTempDir();
    const handoffPath = path.join(dir, "pending-onboarding.json");
    await fs.writeFile(
      handoffPath,
      JSON.stringify({
        onboardingAttemptId: "attempt-1",
        webAppOrigin: "https://app.closedloop.ai",
        createdAt: "2026-04-27T00:00:00.000Z",
      }),
      "utf-8"
    );

    const result = await readPendingOnboardingHandoff(
      handoffPath,
      new Date("2026-04-27T12:00:01.000Z")
    );

    assert.deepEqual(result, { kind: "ignored", reason: "stale" });
    await assert.rejects(fs.stat(handoffPath), { code: "ENOENT" });
  });

  test("reports delete_failed when a semantically-invalid file cannot be removed", {
    skip: !PERMISSION_DENIAL_ENFORCED,
  }, async () => {
    const dir = await makeTempDir();
    const handoffPath = path.join(dir, "pending-onboarding.json");
    await fs.writeFile(
      handoffPath,
      JSON.stringify({
        onboardingAttemptId: "attempt-1",
        webAppOrigin: "https://app.closedloop.ai",
        createdAt: "2026-04-27T00:00:00.000Z",
      }),
      "utf-8"
    );
    await fs.chmod(dir, 0o500);

    const result = await readPendingOnboardingHandoff(
      handoffPath,
      new Date("2026-04-27T12:00:01.000Z")
    );

    assert.deepEqual(result, { kind: "ignored", reason: "delete_failed" });
  });
});
