/**
 * ISS-12120: the main-thread billing-mode detector. It answers synchronously
 * when the Keychain needs no subprocess, returns a promise only when the probe
 * must run, and resolves a batch of rows once per distinct (stored mode,
 * harness, model) combination while keeping every row's answer in row order.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { resetKeychainCredentialCache } from "../src/main/cost/anthropic-keychain.js";
import {
  billingModeAt,
  detectBillingModeNonBlocking,
  resolveBillingModesNonBlocking,
} from "../src/main/cost/billing-mode-detector.js";
import { detectBillingModeForHarness } from "../src/shared/billing-mode.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";
import {
  FAKE_SECURITY_SUITE_TIMEOUT_MS,
  FakeSecurityMode,
  installFakeSecurity,
  resetFakeSecurity,
} from "./support/fake-security-binary.js";
import {
  isolateClaudeBillingEnv,
  restorePlatform,
  stubPlatform,
} from "./support/keychain-probe-surfaces.js";

vi.mock("node:child_process", async (importOriginal) => {
  const { redirectSecurityBinary } = await import(
    "./support/fake-security-binary.js"
  );
  return redirectSecurityBinary(await importOriginal());
});

const LOST_ALIGNMENT = /billing-mode batch lost row alignment at row 1 of 1/;

/** Arguments per `security` invocation the fake records. */
const ARGS_PER_LOOKUP = 5;

beforeEach(() => {
  resetKeychainCredentialCache();
  isolateClaudeBillingEnv();
  vi.stubEnv("OPENAI_API_KEY", undefined);
  vi.stubEnv("CODEX_HOME", makeTempDir("billing-mode-codex-home-"));
  stubPlatform("darwin");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  restorePlatform();
  resetFakeSecurity();
  resetKeychainCredentialCache();
  await cleanupTempDirs();
});

describe("the billing-mode engine", () => {
  // The non-blocking detector answers the engine's Keychain question with one
  // probe result; a second question would need a second probe.
  test("asks the Keychain at most once per detection, for every harness", () => {
    const harnesses = ["claude", "codex", "cursor", "copilot", "opencode"];
    const models = [null, "claude-sonnet-4-5", "gpt-5"];
    const askedPerDetection = harnesses.flatMap((harness) =>
      models.map((model) => {
        let asked = 0;
        detectBillingModeForHarness(harness, {
          env: {},
          fileExists: () => false,
          homeDir: "/nonexistent-home",
          model,
          isPricedModel: () => true,
          hasKeychainCredential: () => {
            asked++;
            return false;
          },
        });
        return asked;
      })
    );

    assert.ok(Math.max(...askedPerDetection) <= 1);
    assert.ok(askedPerDetection.includes(1), "no case reached the Keychain");
  });
});

describe("detectBillingModeNonBlocking", {
  timeout: FAKE_SECURITY_SUITE_TIMEOUT_MS,
}, () => {
  test("a credential signal ahead of the Keychain answers synchronously, with no probe", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "detector-test-key");
    const fake = installFakeSecurity(FakeSecurityMode.Present);

    const mode = detectBillingModeNonBlocking("claude");

    assert.equal(mode, "api");
    assert.equal(fake.started(), false);
  });

  test("a cold Keychain memo answers through the probe", async () => {
    const fake = installFakeSecurity(FakeSecurityMode.Present);

    const mode = detectBillingModeNonBlocking("claude");

    assert.ok(mode instanceof Promise);
    assert.equal(await mode, "subscription_unknown");
    assert.equal(fake.started(), true);
  });

  test("a batch keeps row order and probes once for its one Keychain question", async () => {
    const fake = installFakeSecurity(FakeSecurityMode.Present);

    const modes = await resolveBillingModesNonBlocking([
      { billingMode: "unknown", harness: "claude" },
      { billingMode: "api", harness: "claude" },
      { billingMode: null, harness: "codex" },
      { billingMode: null, harness: "claude" },
      { billingMode: "unknown", harness: "claude" },
    ]);

    assert.deepEqual(modes, [
      "subscription_unknown",
      "api",
      "unknown",
      "subscription_unknown",
      "subscription_unknown",
    ]);
    assert.equal(
      fake.args().length,
      ARGS_PER_LOOKUP,
      "more than one probe ran"
    );
  });

  test("a lost row alignment throws instead of defaulting to unknown", () => {
    assert.equal(billingModeAt(["api", "unknown"], 0), "api");
    assert.throws(() => billingModeAt(["api"], 1), LOST_ALIGNMENT);
  });
});
