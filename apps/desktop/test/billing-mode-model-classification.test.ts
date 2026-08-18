/**
 * @file billing-mode-model-classification.test.ts
 * @description ISS-5445 — billing mode follows the MODEL, not the harness.
 *
 * Operator ruling (2026-08-07): *"opencode doesn't guarantee a free model — the
 * cost should be associated with the model; not the harness."*
 *
 * `detectOpencodeBillingMode` previously returned the constant `"opencode"` and
 * discarded its deps, encoding WHICH HARNESS RAN into a column that records HOW
 * THE SESSION WAS PAID FOR. Because OpenCode is bring-your-own-key it can run a
 * free model or a fully-paid one, so that constant reported a real `gpt-5` BYOK
 * session as subscription-covered and dropped its cost out of headline spend.
 *
 * These tests pin the replacement contract at the pure-engine seam, where the
 * priceability probe is injected, so no pricing library or database is needed.
 * The end-to-end evidence that an OpenCode `gpt-5` session really is priced
 * lives in `test/model-pricing-sqlite.test.ts`.
 *
 * Kept in its own file rather than appended to `billing-mode.test.ts` so the
 * ruling's contract reads as one unit.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type BillingModeDetectionDeps,
  billingLedger,
  detectBillingModeForHarness,
  detectOpencodeBillingMode,
} from "../src/shared/billing-mode.js";

/** Models the real probe prices; everything else is treated as unpriceable. */
const PRICED_MODELS = new Set(["gpt-5", "claude-opus-4-5"]);

function deps(
  overrides: Partial<BillingModeDetectionDeps> = {}
): BillingModeDetectionDeps {
  return {
    env: {},
    fileExists: (): boolean => false,
    homeDir: "/home/tester",
    isPricedModel: (model: string): boolean => PRICED_MODELS.has(model),
    ...overrides,
  };
}

test("ISS-5445: a PRICED-model OpenCode session is metered API spend, not subscription", () => {
  // The exact case review caught. `gpt-5` has published per-token pricing, so
  // tokens spent on it are real out-of-pocket money and must reach the headline.
  const mode = detectOpencodeBillingMode(deps({ model: "gpt-5" }));
  assert.equal(mode, "api");
  assert.equal(billingLedger(mode), "metered");
  // The whole point of the ruling: this must NOT be subscription-covered.
  assert.notEqual(billingLedger(mode), "subscription");
});

test("ISS-5445: an UNPRICEABLE-model OpenCode session degrades to unknown, never to a guess", () => {
  // A model the pricing library cannot map is an ABSENCE of evidence. It must
  // not be guessed into either bucket — not "free ⇒ subscription" (the premise
  // this ticket overturned) and not "ran tokens ⇒ metered".
  for (const model of ["opencode-default", "some-local-llama", "grok-code"]) {
    const mode = detectOpencodeBillingMode(deps({ model }));
    assert.equal(mode, "unknown", model);
    assert.equal(billingLedger(mode), "unknown", model);
  }
});

test("ISS-5445: absent, blank, or null model evidence yields unknown", () => {
  // A legacy row, or any caller that does not supply the model, must get the
  // honest answer rather than the old harness-shaped constant.
  assert.equal(
    detectOpencodeBillingMode(deps({ model: undefined })),
    "unknown"
  );
  assert.equal(detectOpencodeBillingMode(deps({ model: null })), "unknown");
  assert.equal(detectOpencodeBillingMode(deps({ model: "   " })), "unknown");
});

test("ISS-5445: an absent priceability probe degrades to unknown and never throws", () => {
  // `isPricedModel` is an OPTIONAL dep, exactly like `hasKeychainCredential`. A
  // caller that omits it (or whose probe throws) must not crash the ingest path
  // and must not be handed a confident classification.
  const withoutProbe: BillingModeDetectionDeps = {
    env: {},
    fileExists: (): boolean => false,
    homeDir: "/home/tester",
    model: "gpt-5",
  };
  assert.doesNotThrow(() => detectOpencodeBillingMode(withoutProbe));
  assert.equal(detectOpencodeBillingMode(withoutProbe), "unknown");
});

test("ISS-5445: the harness no longer decides — same harness, two ledgers", () => {
  // The single clearest statement of the ruling: holding the harness constant
  // and varying ONLY the model must change the ledger. Driven through the real
  // dispatch entry point (`detectBillingModeForHarness`), not the leaf, so the
  // switch arm is exercised too.
  const priced = detectBillingModeForHarness(
    "opencode",
    deps({ model: "gpt-5" })
  );
  const unpriced = detectBillingModeForHarness(
    "opencode",
    deps({ model: "opencode-default" })
  );
  assert.equal(billingLedger(priced), "metered");
  assert.equal(billingLedger(unpriced), "unknown");
  assert.notEqual(billingLedger(priced), billingLedger(unpriced));
});

test("ISS-5445: model evidence does NOT leak into the credential-based detectors", () => {
  // Anthropic/OpenAI/Cursor/Copilot classify from credential EXISTENCE, which is
  // a machine-level fact. Supplying a priced model must not perturb them, or the
  // new dep would silently re-classify every other harness.
  const priced = deps({ model: "gpt-5" });
  assert.equal(
    detectBillingModeForHarness("claude", {
      ...priced,
      env: { ANTHROPIC_API_KEY: "sk-ant-x" },
    }),
    "api"
  );
  assert.equal(detectBillingModeForHarness("claude", priced), "unknown");
  assert.equal(detectBillingModeForHarness("cursor", priced), "cursor_pro");
  assert.equal(detectBillingModeForHarness("copilot", priced), "copilot_seat");
  assert.equal(detectBillingModeForHarness("codex", priced), "unknown");
});

test("ISS-5445: the legacy stored `opencode` value stays valid and unknown-ledger", () => {
  // Wire/compat: older peers and every already-persisted row still carry
  // `'opencode'`. It must remain a recognized member of the union mapping to the
  // unknown ledger — an honest "billing never determined" — rather than becoming
  // unrecognized or being re-read as subscription-covered.
  assert.equal(billingLedger("opencode"), "unknown");
});
