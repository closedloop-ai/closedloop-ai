/**
 * @file billing-mode.test.ts
 * @description Correctness tests for the first-party billing-mode engine
 * (`src/shared/billing-mode.ts`). FEA-1503 removed the vendor CJS twin
 * (`scripts/agent-monitor-billing/billing-mode.js`); the first-party engine is
 * now the single source of truth.
 *
 * Pins the exact ledger mapping (the reviewed invariant: which modes are metered
 * vs subscription vs unknown) and the existence-only detection rules, and asserts
 * detection never surfaces a secret value.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  addLedgerCost,
  BILLING_MODES,
  type BillingMode,
  type BillingModeDetectionDeps,
  billingLedger,
  detectBillingModeForHarness as detect,
  emptyLedgerTotals,
  headlineCost,
  isMeteredApi,
  type LedgerTotals,
  normalizeBillingMode,
} from "../src/shared/billing-mode.js";

const HOME = "/fake/home";

/** Build detection deps with an injected env + a Set of "existing" file paths. */
function makeDeps(opts: {
  env?: Record<string, string | undefined>;
  existingFiles?: string[];
  homeDir?: string;
}): BillingModeDetectionDeps {
  const set = new Set(opts.existingFiles ?? []);
  return {
    env: opts.env ?? {},
    fileExists: (p: string): boolean => set.has(p),
    homeDir: opts.homeDir ?? HOME,
  };
}

const ANTHROPIC_CRED = join(HOME, ".claude", ".credentials.json");
const CODEX_AUTH = join(HOME, ".codex", "auth.json");

test("BILLING_MODES declares the full stable domain", () => {
  assert.deepEqual([...BILLING_MODES].sort(), [
    "api",
    "codex_subscription",
    "copilot_seat",
    "cursor_api",
    "cursor_pro",
    "max_20x",
    "max_5x",
    "opencode",
    "pro",
    "subscription_unknown",
    "unknown",
  ]);
});

test("ledger mapping pins the exact reviewed invariant", () => {
  const expected: Record<BillingMode, "metered" | "subscription" | "unknown"> =
    {
      api: "metered",
      cursor_api: "metered",
      subscription_unknown: "subscription",
      pro: "subscription",
      max_5x: "subscription",
      max_20x: "subscription",
      codex_subscription: "subscription",
      cursor_pro: "subscription",
      copilot_seat: "subscription",
      opencode: "unknown",
      unknown: "unknown",
    };
  for (const mode of BILLING_MODES) {
    assert.equal(billingLedger(mode), expected[mode], `ledger for ${mode}`);
  }
  // A subscription mode must NEVER be classified as metered (the headline-spend
  // safety invariant: hypothetical cost can't leak into real spend).
  for (const mode of BILLING_MODES) {
    if (billingLedger(mode) === "subscription") {
      assert.equal(isMeteredApi(mode), false, `${mode} must not be metered`);
    }
  }
});

test("normalizeBillingMode coerces legacy/garbage to unknown, passes valid through", () => {
  for (const mode of BILLING_MODES) {
    assert.equal(normalizeBillingMode(mode), mode);
  }
  for (const junk of [null, undefined, "", "API", "max", 42, {}, []]) {
    assert.equal(normalizeBillingMode(junk), "unknown");
  }
});

// Detection fixture matrix: (harness, env, existing credential files) → mode.
const DETECTION_FIXTURES: Array<{
  name: string;
  harness: string;
  env?: Record<string, string | undefined>;
  existingFiles?: string[];
  expected: BillingMode;
}> = [
  {
    name: "claude + ANTHROPIC_API_KEY → api (metered)",
    harness: "claude",
    env: { ANTHROPIC_API_KEY: "sk-ant-secret-should-never-surface" },
    expected: "api",
  },
  {
    name: "claude + OAuth credentials file → subscription_unknown",
    harness: "claude",
    existingFiles: [ANTHROPIC_CRED],
    expected: "subscription_unknown",
  },
  {
    name: "claude + API key wins over OAuth file",
    harness: "claude",
    env: { ANTHROPIC_API_KEY: "sk-ant-x" },
    existingFiles: [ANTHROPIC_CRED],
    expected: "api",
  },
  {
    name: "claude + nothing → unknown",
    harness: "claude",
    expected: "unknown",
  },
  {
    name: "claude + empty/whitespace env is not presence",
    harness: "claude",
    env: { ANTHROPIC_API_KEY: "   " },
    expected: "unknown",
  },
  {
    name: "codex + OPENAI_API_KEY → api (metered)",
    harness: "codex",
    env: { OPENAI_API_KEY: "sk-openai-secret" },
    expected: "api",
  },
  {
    name: "codex + auth.json → codex_subscription",
    harness: "codex",
    existingFiles: [CODEX_AUTH],
    expected: "codex_subscription",
  },
  {
    name: "codex + CODEX_HOME override → checks relocated auth.json",
    harness: "codex",
    env: { CODEX_HOME: "/relocated/codex" },
    existingFiles: ["/relocated/codex/auth.json"],
    expected: "codex_subscription",
  },
  {
    name: "codex + CODEX_HOME set but default auth.json present → unknown (override respected)",
    harness: "codex",
    env: { CODEX_HOME: "/relocated/codex" },
    existingFiles: [CODEX_AUTH],
    expected: "unknown",
  },
  {
    name: "codex + nothing → unknown",
    harness: "codex",
    expected: "unknown",
  },
  {
    name: "cursor + CURSOR_API_KEY → cursor_api (metered)",
    harness: "cursor",
    env: { CURSOR_API_KEY: "cur-secret" },
    expected: "cursor_api",
  },
  {
    name: "cursor + nothing → cursor_pro (subscription, best-effort)",
    harness: "cursor",
    expected: "cursor_pro",
  },
  {
    name: "copilot → copilot_seat (always seat-based)",
    harness: "copilot",
    expected: "copilot_seat",
  },
  {
    name: "opencode → opencode (BYOK, ledger unknown)",
    harness: "opencode",
    expected: "opencode",
  },
  {
    name: "unrecognized harness → unknown",
    harness: "totally-made-up-harness",
    expected: "unknown",
  },
];

test("detection matches the expected mode across the fixture matrix", () => {
  for (const fx of DETECTION_FIXTURES) {
    const deps = makeDeps({ env: fx.env, existingFiles: fx.existingFiles });
    assert.equal(detect(fx.harness, deps), fx.expected, fx.name);
  }
});

test("detection never surfaces a secret value (existence-only)", () => {
  const secret = "sk-ant-this-is-a-secret-token-value";
  const deps = makeDeps({ env: { ANTHROPIC_API_KEY: secret } });
  const mode = detect("claude", deps);
  assert.equal(mode, "api");
  assert.ok(!String(mode).includes(secret));
});

// ── Ledger accounting (FEA-1434 two-ledger invariant) ────────────────────────

test("emptyLedgerTotals is a fresh zeroed three-bucket accumulator", () => {
  assert.deepEqual(emptyLedgerTotals(), {
    metered: 0,
    subscription: 0,
    unknown: 0,
  });
  // Independent instances — mutating one must not affect the next call.
  const a = emptyLedgerTotals();
  a.metered = 99;
  assert.equal(emptyLedgerTotals().metered, 0);
});

test("addLedgerCost routes each mode's cost into its ledger bucket", () => {
  assert.deepEqual(addLedgerCost(emptyLedgerTotals(), "api", 1.5), {
    metered: 1.5,
    subscription: 0,
    unknown: 0,
  });
  assert.deepEqual(addLedgerCost(emptyLedgerTotals(), "cursor_api", 2), {
    metered: 2,
    subscription: 0,
    unknown: 0,
  });
  assert.deepEqual(addLedgerCost(emptyLedgerTotals(), "max_20x", 3), {
    metered: 0,
    subscription: 3,
    unknown: 0,
  });
  assert.deepEqual(addLedgerCost(emptyLedgerTotals(), "opencode", 4), {
    metered: 0,
    subscription: 0,
    unknown: 4,
  });
  assert.deepEqual(addLedgerCost(emptyLedgerTotals(), "unknown", 5), {
    metered: 0,
    subscription: 0,
    unknown: 5,
  });
});

test("addLedgerCost ignores non-finite costs so an unpriced row never corrupts a total", () => {
  for (const bad of [
    null,
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    "1.5",
  ]) {
    const totals = emptyLedgerTotals();
    addLedgerCost(totals, "api", bad as unknown as number);
    assert.deepEqual(totals, { metered: 0, subscription: 0, unknown: 0 });
  }
});

test("addLedgerCost accumulates across many rows and returns the same object", () => {
  const totals = emptyLedgerTotals();
  const returned = addLedgerCost(totals, "api", 1);
  assert.equal(returned, totals, "mutates and returns the same accumulator");
  addLedgerCost(totals, "api", 0.25);
  addLedgerCost(totals, "pro", 10);
  addLedgerCost(totals, "opencode", 0.5);
  assert.deepEqual(totals, { metered: 1.25, subscription: 10, unknown: 0.5 });
});

test("headlineCost = metered + unknown and EXCLUDES subscription (the safety invariant)", () => {
  const totals: LedgerTotals = { metered: 7, subscription: 1000, unknown: 3 };
  assert.equal(headlineCost(totals), 10);
  for (const mode of BILLING_MODES) {
    const t = emptyLedgerTotals();
    addLedgerCost(t, mode, 42);
    const expectedHeadline = billingLedger(mode) === "subscription" ? 0 : 42;
    assert.equal(
      headlineCost(t),
      expectedHeadline,
      `headline contribution for ${mode}`
    );
  }
});
