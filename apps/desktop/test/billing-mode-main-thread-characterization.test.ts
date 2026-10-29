/**
 * ISS-12120 characterization: what each Desktop main-thread caller of the
 * Keychain-backed billing-mode detector gets back, for every way the probe can
 * answer. The three surfaces are live-session GenAI telemetry (a span carries a
 * cost only off the subscription ledger, ISS-11347), the Sessions usage summary
 * (which ledger a token group's cost lands in) and the Branches usage reads (the
 * billing mode each row carries).
 *
 * Every assertion is an outcome at the caller's surface, plus whether the probe
 * spawned at all (the memo contract), and each case waits on that outcome
 * itself (the shipped span, the awaited read), so this file runs unchanged
 * against the synchronous probe and against a non-blocking one.
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
  primeKeychainMemo,
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

/** The ledger a Claude session lands on. */
const Ledger = {
  Subscription: "subscription",
  Unknown: "unknown",
  Api: "api",
} as const;
type Ledger = (typeof Ledger)[keyof typeof Ledger];

type Scenario = {
  name: string;
  platform: NodeJS.Platform;
  /** Seed the memo with this answer before the call. */
  primed?: boolean;
  /** How the fake `security` answers if the probe runs. */
  fake: FakeSecurityMode;
  /** A definite mode ahead of the Keychain (API key env, or a stored mode). */
  definiteApi?: boolean;
  expected: Ledger;
  /** Whether the probe must spawn the binary. */
  probes: boolean;
};

const SCENARIOS: readonly Scenario[] = [
  {
    name: "a memo primed PRESENT answers subscription without a spawn",
    platform: "darwin",
    primed: true,
    fake: FakeSecurityMode.Absent,
    expected: Ledger.Subscription,
    probes: false,
  },
  {
    name: "a memo primed ABSENT answers unknown without a spawn",
    platform: "darwin",
    primed: false,
    fake: FakeSecurityMode.Present,
    expected: Ledger.Unknown,
    probes: false,
  },
  {
    name: "a cold memo with the item present answers subscription",
    platform: "darwin",
    fake: FakeSecurityMode.Present,
    expected: Ledger.Subscription,
    probes: true,
  },
  {
    name: "a cold memo with the item absent answers unknown",
    platform: "darwin",
    fake: FakeSecurityMode.Absent,
    expected: Ledger.Unknown,
    probes: true,
  },
  {
    name: "a probe that outlives its timeout answers unknown",
    platform: "darwin",
    fake: FakeSecurityMode.Hang,
    expected: Ledger.Unknown,
    probes: true,
  },
  {
    name: "off macOS the probe never runs and the answer is unknown",
    platform: "linux",
    fake: FakeSecurityMode.Present,
    expected: Ledger.Unknown,
    probes: false,
  },
  {
    name: "a definite API mode never reaches the probe",
    platform: "darwin",
    fake: FakeSecurityMode.Present,
    definiteApi: true,
    expected: Ledger.Api,
    probes: false,
  },
];

let fake: FakeSecurity;

function arrange(scenario: Scenario): void {
  const { service } = isolateClaudeBillingEnv();
  stubPlatform(scenario.platform);
  if (scenario.primed !== undefined) {
    primeKeychainMemo(service, scenario.primed);
  }
  fake = installFakeSecurity(scenario.fake);
}

beforeEach(() => {
  resetKeychainCredentialCache();
});

afterEach(async () => {
  unbindTelemetry();
  vi.unstubAllEnvs();
  restorePlatform();
  resetFakeSecurity();
  resetKeychainCredentialCache();
  await cleanupTempDirs();
});

describe("live-session GenAI telemetry", {
  timeout: FAKE_SECURITY_SUITE_TIMEOUT_MS,
}, () => {
  for (const scenario of SCENARIOS) {
    test(scenario.name, async () => {
      arrange(scenario);
      if (scenario.definiteApi) {
        vi.stubEnv("ANTHROPIC_API_KEY", "characterization-api-key");
      }

      const shipped = await observeLiveClaudeRequest();

      // ISS-11347: only a subscription session's span goes without a cost.
      assert.equal(
        shipped.costUsd === undefined,
        scenario.expected === Ledger.Subscription
      );
      assert.equal(shipped.inputTokens, 10);
      assert.equal(fake.started(), scenario.probes);
    });
  }
});

describe("Sessions usage summary", {
  timeout: FAKE_SECURITY_SUITE_TIMEOUT_MS,
}, () => {
  for (const scenario of SCENARIOS) {
    test(scenario.name, async () => {
      arrange(scenario);

      const summary = await readSessionsUsage(
        scenario.definiteApi ? "api" : "unknown"
      );

      const byLedger: Record<Ledger, number> = {
        subscription: summary.subscriptionEstimatedCost,
        unknown: summary.unknownEstimatedCost ?? Number.NaN,
        api: summary.meteredEstimatedCost ?? Number.NaN,
      };
      for (const ledger of Object.values(Ledger)) {
        assert.equal(
          byLedger[ledger],
          ledger === scenario.expected ? GROUP_COST_USD : 0,
          `${ledger} ledger`
        );
      }
      assert.equal(fake.started(), scenario.probes);
    });
  }
});

describe("Branches usage reads", {
  timeout: FAKE_SECURITY_SUITE_TIMEOUT_MS,
}, () => {
  const expectedMode: Record<Ledger, string> = {
    subscription: "subscription_unknown",
    unknown: "unknown",
    api: "api",
  };
  for (const read of Object.values(BranchUsageRead)) {
    for (const scenario of SCENARIOS) {
      test(`${read}: ${scenario.name}`, async () => {
        arrange(scenario);

        const modes = await readBranchBillingModes(
          read,
          scenario.definiteApi ? "api" : "unknown"
        );

        assert.deepEqual(modes, [expectedMode[scenario.expected]]);
        assert.equal(fake.started(), scenario.probes);
      });
    }
  }
});
