import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  getCanonicalOnboardingHandoffPath,
  isCanonicalOnboardingHandoffPath,
  OnboardingHandoffQueue,
  parsePendingOnboardingHandoff,
  readPendingOnboardingHandoff,
} from "../src/main/onboarding-handoff.js";

test("parsePendingOnboardingHandoff accepts the exact fresh payload shape", () => {
  const now = new Date("2026-04-27T12:00:00.000Z");
  const result = parsePendingOnboardingHandoff(
    {
      onboardingAttemptId: " attempt-1 ",
      webAppOrigin: "https://app.closedloop.ai/onboarding",
      sandboxBaseDirectory: "~/Source",
      createdAt: "2026-04-27T11:59:00.000Z",
    },
    now
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.payload : null, {
    onboardingAttemptId: "attempt-1",
    webAppOrigin: "https://app.closedloop.ai",
    sandboxBaseDirectory: path.join(os.homedir(), "Source"),
    createdAt: "2026-04-27T11:59:00.000Z",
  });
});

test("parsePendingOnboardingHandoff rejects unexpected fields", () => {
  const result = parsePendingOnboardingHandoff({
    onboardingAttemptId: "attempt-1",
    webAppOrigin: "https://app.closedloop.ai",
    createdAt: "2026-04-27T11:59:00.000Z",
    apiOrigin: "https://api.closedloop.ai",
  });

  assert.deepEqual(result, { ok: false, reason: "invalid_shape" });
});

test("parsePendingOnboardingHandoff rejects stale files", () => {
  const result = parsePendingOnboardingHandoff(
    {
      onboardingAttemptId: "attempt-1",
      webAppOrigin: "https://app.closedloop.ai",
      createdAt: "2026-04-27T10:00:00.000Z",
    },
    new Date("2026-04-27T12:00:01.000Z")
  );

  assert.deepEqual(result, { ok: false, reason: "stale" });
});

test("parsePendingOnboardingHandoff rejects future-dated files", () => {
  const result = parsePendingOnboardingHandoff(
    {
      onboardingAttemptId: "attempt-1",
      webAppOrigin: "https://app.closedloop.ai",
      createdAt: "2026-04-27T12:00:01.000Z",
    },
    new Date("2026-04-27T12:00:00.000Z")
  );

  assert.deepEqual(result, { ok: false, reason: "invalid_created_at" });
});

test("readPendingOnboardingHandoff deletes valid files after validation", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-handoff-"));
  const handoffPath = path.join(tmpDir, "pending-onboarding.json");
  try {
    await fs.writeFile(
      handoffPath,
      JSON.stringify({
        onboardingAttemptId: "attempt-1",
        webAppOrigin: "https://app.closedloop.ai",
        createdAt: "2026-04-27T11:59:00.000Z",
      }),
      "utf-8"
    );

    const result = await readPendingOnboardingHandoff(
      handoffPath,
      new Date("2026-04-27T12:00:00.000Z")
    );

    assert.equal(result.kind, "loaded");
    await assert.rejects(fs.stat(handoffPath), { code: "ENOENT" });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("OnboardingHandoffQueue coalesces handoffs received while busy", () => {
  const queue = new OnboardingHandoffQueue();

  assert.equal(queue.hasPendingCanonicalOpenFile(), false);
  assert.equal(queue.drainCanonicalOpenFile(), false);

  queue.enqueueCanonicalOpenFile();
  queue.enqueueCanonicalOpenFile();

  assert.equal(queue.hasPendingCanonicalOpenFile(), true);
  assert.equal(queue.drainCanonicalOpenFile(), true);
  assert.equal(queue.hasPendingCanonicalOpenFile(), false);
  assert.equal(queue.drainCanonicalOpenFile(), false);
});

test("readPendingOnboardingHandoff rejects valid files when delete fails", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-handoff-"));
  const handoffPath = path.join(tmpDir, "pending-onboarding.json");
  await fs.writeFile(
    handoffPath,
    JSON.stringify({
      onboardingAttemptId: "attempt-1",
      webAppOrigin: "https://app.closedloop.ai",
      createdAt: "2026-04-27T11:59:00.000Z",
    }),
    "utf-8"
  );
  await fs.chmod(tmpDir, 0o500);

  try {
    const result = await readPendingOnboardingHandoff(
      handoffPath,
      new Date("2026-04-27T12:00:00.000Z")
    );

    assert.deepEqual(result, { kind: "ignored", reason: "delete_failed" });
  } finally {
    await fs.chmod(tmpDir, 0o700);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("readPendingOnboardingHandoff rejects invalid JSON when delete fails", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-handoff-"));
  const handoffPath = path.join(tmpDir, "pending-onboarding.json");
  await fs.writeFile(handoffPath, "{", "utf-8");
  await fs.chmod(tmpDir, 0o500);

  try {
    const result = await readPendingOnboardingHandoff(
      handoffPath,
      new Date("2026-04-27T12:00:00.000Z")
    );

    assert.deepEqual(result, { kind: "ignored", reason: "delete_failed" });
  } finally {
    await fs.chmod(tmpDir, 0o700);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("canonical handoff path matches the product-specified location", () => {
  const homeDir = "/Users/example";
  const expected =
    "/Users/example/Library/Application Support/Closedloop Desktop/pending-onboarding.json";

  assert.equal(getCanonicalOnboardingHandoffPath(homeDir), expected);
  assert.equal(isCanonicalOnboardingHandoffPath(expected, expected), true);
  assert.equal(
    isCanonicalOnboardingHandoffPath(
      "/Users/example/Library/Application Support/Closedloop/pending-onboarding.json",
      expected
    ),
    false
  );
});
