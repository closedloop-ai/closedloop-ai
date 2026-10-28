/**
 * @file billing-mode-detector-coverage.test.ts
 * @description ISS-8730 coverage pass for `src/main/cost/billing-mode-detector.ts`
 * — the desktop-main WIRING around the pure engine in `src/shared/billing-mode.ts`
 * (which `test/billing-mode.test.ts` already pins directly). This file exercises
 * only the two exports here, `detectBillingMode` and `resolveBillingMode`,
 * including the real `existsSync`/`homedir()`-backed file-existence wiring.
 *
 * Determinism note: `detectBillingMode("claude", …)` and `("codex", …)` walk the
 * REAL filesystem via `existsSync`/`homedir()`. To keep this hermetic regardless
 * of what credential files happen to exist on the machine running the suite, every
 * case routes through the documented `CLAUDE_CONFIG_DIR` / `CODEX_HOME` overrides,
 * pointed at a throwaway temp directory this file owns — never the real home dir.
 * The macOS Keychain signal (`hasKeychainCredential`) contributes nothing to any
 * case here on EITHER platform, but for two different reasons — the node suite
 * also runs on macOS in the nightly and release lanes, so the off-darwin
 * short-circuit is not the whole story. Off darwin, `probeKeychainCredential`
 * returns false before any lookup (`deps.platform !== "darwin"`). ON darwin, the
 * throwaway `CLAUDE_CONFIG_DIR` above is hashed into the Keychain service name
 * by `anthropicKeychainService`, so the probe asks for an item that exists on no
 * machine. That signal's own branches are covered directly against the pure
 * engine in `test/billing-mode.test.ts` and `test/anthropic-keychain.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
  detectBillingMode,
  resolveBillingMode,
} from "../src/main/cost/billing-mode-detector.js";

/** Every env var either the engine or its wiring reads for the harnesses tested here. */
const MANAGED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "OPENAI_API_KEY",
  "CODEX_HOME",
  "CURSOR_API_KEY",
] as const;

const originalEnv = new Map<string, string | undefined>();
let tempRoot = "";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }
  process.env[name] = value;
}

beforeEach(() => {
  for (const key of MANAGED_ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    Reflect.deleteProperty(process.env, key);
  }
  tempRoot = mkdtempSync(join(tmpdir(), "iss8730-billing-mode-"));
});

afterEach(() => {
  for (const key of MANAGED_ENV_KEYS) {
    restoreEnv(key, originalEnv.get(key));
  }
  originalEnv.clear();
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

/** Real, published-pricing model ids already relied on elsewhere in this suite. */
const PRICED_MODEL = "claude-opus-4-1";
const UNPRICEABLE_MODEL = "claude-sonnet-4-99-not-in-the-table";

describe("detectBillingMode — env-only harnesses (no filesystem coupling)", () => {
  test("opencode + a model with real published pricing -> api (metered, bring-your-own-key)", () => {
    assert.equal(detectBillingMode("opencode", PRICED_MODEL), "api");
  });

  test("opencode + no model recorded -> unknown (absence of evidence is not evidence of free)", () => {
    assert.equal(detectBillingMode("opencode", undefined), "unknown");
    assert.equal(detectBillingMode("opencode", null), "unknown");
  });

  test("opencode + a whitespace-only model -> unknown", () => {
    assert.equal(detectBillingMode("opencode", "   "), "unknown");
  });

  test("opencode + an unpriceable model id -> unknown, never a guess", () => {
    assert.equal(detectBillingMode("opencode", UNPRICEABLE_MODEL), "unknown");
  });

  test("cursor + CURSOR_API_KEY set -> cursor_api (metered)", () => {
    process.env.CURSOR_API_KEY = "cur-secret";
    assert.equal(detectBillingMode("cursor"), "cursor_api");
  });

  test("cursor + no key -> cursor_pro (best-effort subscription)", () => {
    assert.equal(detectBillingMode("cursor"), "cursor_pro");
  });

  test("copilot -> copilot_seat always, regardless of model or env", () => {
    assert.equal(detectBillingMode("copilot", PRICED_MODEL), "copilot_seat");
  });

  test("an unrecognized harness -> unknown rather than guessing", () => {
    assert.equal(detectBillingMode("some-future-harness"), "unknown");
  });
});

describe("detectBillingMode — claude harness (real existsSync/homedir wiring via CLAUDE_CONFIG_DIR)", () => {
  test("ANTHROPIC_API_KEY set -> api (metered), no filesystem check needed", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret";
    // Point at an empty temp dir so a real credentials file could not
    // accidentally satisfy this even if the API-key branch were skipped.
    process.env.CLAUDE_CONFIG_DIR = tempRoot;
    assert.equal(detectBillingMode("claude"), "api");
  });

  test("no credentials anywhere on disk -> unknown", () => {
    process.env.CLAUDE_CONFIG_DIR = tempRoot;
    assert.equal(detectBillingMode("claude"), "unknown");
  });

  test("a real .credentials.json file under CLAUDE_CONFIG_DIR -> subscription_unknown", () => {
    process.env.CLAUDE_CONFIG_DIR = tempRoot;
    writeFileSync(join(tempRoot, ".credentials.json"), "{}");
    assert.equal(detectBillingMode("claude"), "subscription_unknown");
  });

  test("CLAUDE_CODE_OAUTH_TOKEN set -> subscription_unknown even with no credentials file", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "headless-token";
    process.env.CLAUDE_CONFIG_DIR = tempRoot;
    assert.equal(detectBillingMode("claude"), "subscription_unknown");
  });

  test("a provider override (CLAUDE_CODE_USE_BEDROCK) beats a real credentials file on disk", () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.env.CLAUDE_CONFIG_DIR = tempRoot;
    writeFileSync(join(tempRoot, ".credentials.json"), "{}");
    assert.equal(detectBillingMode("claude"), "api");
  });
});

describe("detectBillingMode — codex harness (real existsSync/homedir wiring via CODEX_HOME)", () => {
  test("OPENAI_API_KEY set -> api (metered)", () => {
    process.env.OPENAI_API_KEY = "sk-openai-secret";
    process.env.CODEX_HOME = tempRoot;
    assert.equal(detectBillingMode("codex"), "api");
  });

  test("a real auth.json under CODEX_HOME -> codex_subscription", () => {
    process.env.CODEX_HOME = tempRoot;
    writeFileSync(join(tempRoot, "auth.json"), "{}");
    assert.equal(detectBillingMode("codex"), "codex_subscription");
  });

  test("no auth.json on disk -> unknown", () => {
    process.env.CODEX_HOME = tempRoot;
    assert.equal(detectBillingMode("codex"), "unknown");
  });
});

describe("resolveBillingMode", () => {
  test("a stored, definite mode wins outright and skips detection entirely", () => {
    // If detection ran here it would return "api" (opencode + a priced model),
    // not "pro" — a different, detectable result. Getting "pro" back proves the
    // stored value short-circuited before `detectBillingMode` was ever called.
    const mode = resolveBillingMode({
      billingMode: "pro",
      harness: "opencode",
      model: PRICED_MODEL,
    });
    assert.equal(mode, "pro");
  });

  test("a null stored mode falls back to detection using harness + model", () => {
    const mode = resolveBillingMode({
      billingMode: null,
      harness: "opencode",
      model: PRICED_MODEL,
    });
    assert.equal(mode, "api");
  });

  test("a legacy/garbage stored mode falls back to detection, same as null", () => {
    const mode = resolveBillingMode({
      billingMode: "some-legacy-value-not-in-BILLING_MODES",
      harness: "copilot",
    });
    assert.equal(mode, "copilot_seat");
  });

  test("a stored literal 'unknown' falls back to detection too, not just null/legacy", () => {
    const mode = resolveBillingMode({
      billingMode: "unknown",
      harness: "cursor",
    });
    assert.equal(mode, "cursor_pro");
  });

  test("harness: null on fallback defaults to the empty string -> unknown, not a crash", () => {
    const mode = resolveBillingMode({ billingMode: "unknown", harness: null });
    assert.equal(mode, "unknown");
  });

  test("model omitted on fallback -> honest unknown rather than a guess (opencode)", () => {
    const mode = resolveBillingMode({
      billingMode: "unknown",
      harness: "opencode",
    });
    assert.equal(mode, "unknown");
  });
});
