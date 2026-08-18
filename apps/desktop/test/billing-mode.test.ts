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

/** Fixture sentinel for "the Keychain item belongs to the DEFAULT profile". */
const DEFAULT_PROFILE = "<default>";

/**
 * Build detection deps with an injected env + a Set of "existing" file paths.
 * `keychainProfiles` is only wired when provided, so the default fixture shape
 * still exercises the pre-ISS-4869 caller contract (dep absent entirely).
 *
 * The dep is keyed by PROFILE, not service name: the engine passes `null` for
 * the default profile and the relocated config dir otherwise, and the real Node
 * adapter composes the (hash-suffixed) service name from that. Fixtures name
 * profiles with DEFAULT_PROFILE or the relocated dir.
 */
function makeDeps(opts: {
  env?: Record<string, string | undefined>;
  existingFiles?: string[];
  homeDir?: string;
  keychainProfiles?: string[];
}): BillingModeDetectionDeps {
  const set = new Set(opts.existingFiles ?? []);
  const deps: BillingModeDetectionDeps = {
    env: opts.env ?? {},
    fileExists: (p: string): boolean => set.has(p),
    homeDir: opts.homeDir ?? HOME,
  };
  if (opts.keychainProfiles) {
    const profiles = new Set(opts.keychainProfiles);
    deps.hasKeychainCredential = (configDir: string | null): boolean =>
      profiles.has(configDir ?? DEFAULT_PROFILE);
  }
  return deps;
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
      // ISS-5445: the stored `opencode` value means "an OpenCode session whose
      // billing we could not determine" — it records the HARNESS, not a payment
      // method — so it belongs in the unknown ledger. New sessions no longer
      // receive it: `detectOpencodeBillingMode` classifies from the MODEL.
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
  keychainProfiles?: string[];
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
  // ── ISS-4869: macOS keeps the OAuth credential in the login Keychain ───────
  {
    name: "claude + macOS Keychain credential (no file, no env) → subscription_unknown",
    harness: "claude",
    keychainProfiles: [DEFAULT_PROFILE],
    expected: "subscription_unknown",
  },
  {
    name: "claude + Keychain probe wired but item absent → unknown",
    harness: "claude",
    keychainProfiles: [],
    expected: "unknown",
  },
  {
    name: "claude + Keychain holds some OTHER profile's item → unknown",
    harness: "claude",
    keychainProfiles: ["/some/other/profile"],
    expected: "unknown",
  },
  {
    name: "claude + API key wins over a Keychain credential",
    harness: "claude",
    env: { ANTHROPIC_API_KEY: "sk-ant-x" },
    keychainProfiles: [DEFAULT_PROFILE],
    expected: "api",
  },
  {
    name: "claude + CLAUDE_CODE_OAUTH_TOKEN → subscription_unknown (headless/CI token)",
    harness: "claude",
    env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret-should-never-surface" },
    expected: "subscription_unknown",
  },
  // ── Provider / auth overrides outrank subscription credentials ─────────────
  // Claude Code resolves provider + auth BEFORE subscription credentials, so a
  // leftover OAuth token / credentials file / Keychain item on a Bedrock,
  // Vertex, or gateway-authenticated machine must NOT hide separately-billed
  // spend from the headline ledger.
  {
    name: "claude + CLAUDE_CODE_USE_BEDROCK → api (metered on AWS)",
    harness: "claude",
    env: { CLAUDE_CODE_USE_BEDROCK: "1" },
    expected: "api",
  },
  {
    name: "claude + CLAUDE_CODE_USE_VERTEX → api (metered on GCP)",
    harness: "claude",
    env: { CLAUDE_CODE_USE_VERTEX: "true" },
    expected: "api",
  },
  {
    name: "claude + ANTHROPIC_AUTH_TOKEN → api (custom gateway auth)",
    harness: "claude",
    env: { ANTHROPIC_AUTH_TOKEN: "gateway-secret-should-never-surface" },
    expected: "api",
  },
  {
    name: "claude + Bedrock override BEATS a leftover OAuth token",
    harness: "claude",
    env: {
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "stale-oauth-token",
    },
    expected: "api",
  },
  {
    name: "claude + Bedrock override BEATS a leftover credentials file",
    harness: "claude",
    env: { CLAUDE_CODE_USE_BEDROCK: "1" },
    existingFiles: [ANTHROPIC_CRED],
    expected: "api",
  },
  {
    name: "claude + Bedrock override BEATS a leftover Keychain item",
    harness: "claude",
    env: { CLAUDE_CODE_USE_BEDROCK: "1" },
    keychainProfiles: [DEFAULT_PROFILE],
    expected: "api",
  },
  {
    name: "claude + ANTHROPIC_AUTH_TOKEN BEATS a leftover Keychain item",
    harness: "claude",
    env: { ANTHROPIC_AUTH_TOKEN: "gateway-token" },
    keychainProfiles: [DEFAULT_PROFILE],
    expected: "api",
  },
  {
    name: "claude + Vertex override BEATS a relocated-profile Keychain item",
    harness: "claude",
    env: {
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CONFIG_DIR: "/relocated/claude",
    },
    keychainProfiles: ["/relocated/claude"],
    expected: "api",
  },
  {
    name: "claude + CLAUDE_CODE_USE_BEDROCK=0 is OFF, so the subscription still wins",
    harness: "claude",
    env: { CLAUDE_CODE_USE_BEDROCK: "0" },
    keychainProfiles: [DEFAULT_PROFILE],
    expected: "subscription_unknown",
  },
  {
    name: "claude + CLAUDE_CODE_USE_BEDROCK=false is OFF, so the subscription still wins",
    harness: "claude",
    env: { CLAUDE_CODE_USE_BEDROCK: "false" },
    existingFiles: [ANTHROPIC_CRED],
    expected: "subscription_unknown",
  },
  {
    name: "claude + empty/whitespace override flag is not presence",
    harness: "claude",
    env: { CLAUDE_CODE_USE_BEDROCK: "  ", ANTHROPIC_AUTH_TOKEN: "  " },
    keychainProfiles: [DEFAULT_PROFILE],
    expected: "subscription_unknown",
  },
  {
    name: "claude + empty CLAUDE_CODE_OAUTH_TOKEN is not presence",
    harness: "claude",
    env: { CLAUDE_CODE_OAUTH_TOKEN: "  " },
    expected: "unknown",
  },
  {
    name: "claude + CLAUDE_CONFIG_DIR override → checks relocated credentials file",
    harness: "claude",
    env: { CLAUDE_CONFIG_DIR: "/relocated/claude" },
    existingFiles: ["/relocated/claude/.credentials.json"],
    expected: "subscription_unknown",
  },
  {
    name: "claude + CLAUDE_CONFIG_DIR set but only default file present → unknown (override respected)",
    harness: "claude",
    env: { CLAUDE_CONFIG_DIR: "/relocated/claude" },
    existingFiles: [ANTHROPIC_CRED],
    expected: "unknown",
  },
  {
    name: "claude + CLAUDE_CONFIG_DIR set → default-profile Keychain item is NOT claimed",
    harness: "claude",
    env: { CLAUDE_CONFIG_DIR: "/relocated/claude" },
    keychainProfiles: [DEFAULT_PROFILE],
    expected: "unknown",
  },
  {
    name: "claude + CLAUDE_SECURESTORAGE_CONFIG_DIR set → default-profile Keychain item is NOT claimed",
    harness: "claude",
    env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/relocated/secure" },
    keychainProfiles: [DEFAULT_PROFILE],
    expected: "unknown",
  },
  // A relocated profile still uses the Keychain, under its own hash-suffixed
  // service. Before ISS-4869's review pass the probe was skipped outright
  // whenever a config-dir override was set, leaving these sessions "unknown".
  {
    name: "claude + relocated CLAUDE_CONFIG_DIR, Keychain-only → subscription_unknown",
    harness: "claude",
    env: { CLAUDE_CONFIG_DIR: "/relocated/claude" },
    keychainProfiles: ["/relocated/claude"],
    expected: "subscription_unknown",
  },
  {
    name: "claude + relocated CLAUDE_SECURESTORAGE_CONFIG_DIR, Keychain-only → subscription_unknown",
    harness: "claude",
    env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/relocated/secure" },
    keychainProfiles: ["/relocated/secure"],
    expected: "subscription_unknown",
  },
  {
    name: "claude + securestorage dir wins over config dir when both are set",
    harness: "claude",
    env: {
      CLAUDE_CONFIG_DIR: "/relocated/claude",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/relocated/secure",
    },
    keychainProfiles: ["/relocated/secure"],
    expected: "subscription_unknown",
  },
  {
    name: "claude + relocated profile does not claim a DIFFERENT relocated profile's item",
    harness: "claude",
    env: { CLAUDE_CONFIG_DIR: "/relocated/claude" },
    keychainProfiles: ["/relocated/elsewhere"],
    expected: "unknown",
  },
  {
    name: "claude + relocated config dir WITH its own credentials file → subscription_unknown",
    harness: "claude",
    env: { CLAUDE_CONFIG_DIR: "/relocated/claude" },
    existingFiles: ["/relocated/claude/.credentials.json"],
    keychainProfiles: [DEFAULT_PROFILE],
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
    // ISS-5445 — OpenCode is bring-your-own-key, so the harness alone proves
    // nothing about payment. With no model evidence the honest answer is
    // "unknown"; it must NOT fall back to the old harness-shaped constant.
    // The model-driven branches are covered in
    // test/billing-mode-model-classification.test.ts.
    name: "opencode + no model → unknown (no evidence, never a guess)",
    harness: "opencode",
    expected: "unknown",
  },
  {
    name: "unrecognized harness → unknown",
    harness: "totally-made-up-harness",
    expected: "unknown",
  },
];

test("detection matches the expected mode across the fixture matrix", () => {
  for (const fx of DETECTION_FIXTURES) {
    const deps = makeDeps({
      env: fx.env,
      existingFiles: fx.existingFiles,
      keychainProfiles: fx.keychainProfiles,
    });
    assert.equal(detect(fx.harness, deps), fx.expected, fx.name);
  }
});

test("ISS-4869: the Keychain dep is additive — omitting it preserves the old contract", () => {
  // Old callers construct deps WITHOUT hasKeychainCredential. That must still
  // typecheck and behave exactly as before: file present → subscription,
  // nothing present → unknown. Asserted against the real detection entry point.
  const withoutDep: BillingModeDetectionDeps = {
    env: {},
    fileExists: (p: string): boolean => p === ANTHROPIC_CRED,
    homeDir: HOME,
  };
  assert.equal(detect("claude", withoutDep), "subscription_unknown");

  const bare: BillingModeDetectionDeps = {
    env: {},
    fileExists: (): boolean => false,
    homeDir: HOME,
  };
  assert.equal(detect("claude", bare), "unknown");
  assert.equal(bare.hasKeychainCredential, undefined);
});

test("ISS-4869: a non-boolean-true Keychain result is treated as no signal, not as a subscription", () => {
  // A probe that throws, or returns a truthy non-`true` value, must never be
  // read as "subscription covered" — that would move real spend off the
  // headline ledger on a machine we could not actually verify.
  const truthyNonBoolean: BillingModeDetectionDeps = {
    env: {},
    fileExists: (): boolean => false,
    homeDir: HOME,
    hasKeychainCredential: (): boolean => "yes" as unknown as boolean,
  };
  assert.equal(detect("claude", truthyNonBoolean), "unknown");
});

test("ISS-4869: a Keychain-detected subscription lands in the subscription ledger, off the headline", () => {
  // The whole point of the fix: these sessions must stop inflating headline
  // "real spend". Drive the production detection path, then assert the ledger.
  const mode = detect(
    "claude",
    makeDeps({ keychainProfiles: [DEFAULT_PROFILE] })
  );
  assert.equal(billingLedger(mode), "subscription");
  const totals = emptyLedgerTotals();
  addLedgerCost(totals, mode, 17_915.67);
  assert.equal(headlineCost(totals), 0);
  assert.equal(totals.subscription, 17_915.67);
});

test("a provider override keeps separately-billed spend ON the headline ledger", () => {
  // The mirror of the Keychain test above. A Bedrock machine that also carries a
  // stale Keychain credential must still report real spend: classifying it as
  // subscription would silently zero out a live AWS bill.
  const mode = detect(
    "claude",
    makeDeps({
      env: { CLAUDE_CODE_USE_BEDROCK: "1" },
      keychainProfiles: [DEFAULT_PROFILE],
    })
  );
  assert.equal(mode, "api");
  assert.equal(billingLedger(mode), "metered");
  const totals = emptyLedgerTotals();
  addLedgerCost(totals, mode, 4213.5);
  assert.equal(headlineCost(totals), 4213.5);
  assert.equal(totals.subscription, 0);
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
  addLedgerCost(totals, "unknown", 0.5);
  assert.deepEqual(totals, { metered: 1.25, subscription: 10, unknown: 1 });
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
