/**
 * ISS-12120: the Keychain credential probe must not block the Desktop main
 * event loop. Each case reaches one main-thread surface with a cold memo on
 * macOS, so the probe spawns `security`; the fake binary waits for a release
 * file that only a timer queued BEFORE the call writes, and acks it only while
 * it is still running. A synchronous probe holds the event loop for the
 * child's whole life, the timer cannot run, and no ack is written.
 *
 * Each case also checks the surface's answer, so a probe that stopped running
 * (or answered from the wrong source) cannot pass by never blocking.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { resetKeychainCredentialCache } from "../src/main/cost/anthropic-keychain.js";
import { cleanupTempDirs } from "./normalized-session-test-utils.js";
import {
  FAKE_SECURITY_SUITE_TIMEOUT_MS,
  type FakeSecurity,
  FakeSecurityMode,
  installFakeSecurity,
  resetFakeSecurity,
} from "./support/fake-security-binary.js";
import {
  BranchUsageRead,
  GROUP_COST_USD,
  isolateClaudeBillingEnv,
  observeLiveClaudeRequest,
  readBranchBillingModes,
  readSessionsUsage,
  restorePlatform,
  stubPlatform,
  unbindTelemetry,
} from "./support/keychain-probe-surfaces.js";

vi.mock("node:child_process", async (importOriginal) => {
  const { redirectSecurityBinary } = await import(
    "./support/fake-security-binary.js"
  );
  return redirectSecurityBinary(await importOriginal());
});

let fake: FakeSecurity;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

beforeEach(() => {
  resetKeychainCredentialCache();
  isolateClaudeBillingEnv();
  stubPlatform("darwin");
  fake = installFakeSecurity(FakeSecurityMode.Handshake);
});

afterEach(async () => {
  // A blocking probe leaves the release timer queued past the assertions.
  clearTimeout(releaseTimer);
  unbindTelemetry();
  vi.unstubAllEnvs();
  restorePlatform();
  resetFakeSecurity();
  resetKeychainCredentialCache();
  await cleanupTempDirs();
});

/** Queue the release before the call, so only a yielding call lets it run. */
function queueRelease(): void {
  releaseTimer = setTimeout(fake.release, 0);
}

/** Whether the probe spawned `security`, and whether that child saw the release. */
function probeHandshake(): { started: boolean; acked: boolean } {
  return { started: fake.started(), acked: fake.acked() };
}

/** A probe that held the event loop leaves `acked: false`. */
const YIELDED = { started: true, acked: true } as const;
const HELD_MESSAGE =
  "security finished without seeing the release: the probe held the main event loop";

describe("the Keychain probe yields the main event loop", {
  timeout: FAKE_SECURITY_SUITE_TIMEOUT_MS,
}, () => {
  test("live-session GenAI telemetry", async () => {
    queueRelease();

    const shipped = await observeLiveClaudeRequest();

    assert.deepEqual(probeHandshake(), YIELDED, HELD_MESSAGE);
    // The handshake fake exits 0: a present credential, a subscription span.
    assert.equal(shipped.costUsd, undefined);
  });

  test("Sessions usage summary", async () => {
    queueRelease();

    const summary = await readSessionsUsage("unknown");

    assert.deepEqual(probeHandshake(), YIELDED, HELD_MESSAGE);
    assert.equal(summary.subscriptionEstimatedCost, GROUP_COST_USD);
  });

  for (const read of Object.values(BranchUsageRead)) {
    test(`Branches usage ${read}`, async () => {
      queueRelease();

      const modes = await readBranchBillingModes(read, "unknown");

      assert.deepEqual(probeHandshake(), YIELDED, HELD_MESSAGE);
      assert.deepEqual(modes, ["subscription_unknown"]);
    });
  }
});
