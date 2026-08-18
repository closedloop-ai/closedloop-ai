/**
 * @file billing-mode-detector.ts
 * @description Desktop-main wiring for the pure billing-mode engine
 * (`src/shared/billing-mode.ts`). Supplies the real runtime dependencies —
 * `process.env`, an `existsSync`-backed file check, and `os.homedir()` — to the
 * injectable detector so the rest of desktop-main can ask "what billing mode is
 * this harness?" without touching the secret-handling details.
 *
 * CLOSEDLOOP FEA-1434. Used as the sync-time fallback when a session row's
 * persisted billing_mode is missing/legacy/"unknown" (the sidecar importers
 * stamp the mode at ingest; this fills the gap for rows that predate the
 * column or arrive without one).
 *
 * Secret-handling: the file and Keychain checks are existence-only and never
 * read contents; no env value is logged or returned. See billing-mode.ts for
 * the full rule and anthropic-keychain.ts for the Keychain probe's specifics.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";

import {
  type BillingMode,
  type BillingModeDetectionDeps,
  detectBillingModeForHarness,
  normalizeBillingMode,
} from "../../shared/billing-mode.js";
import { computeTokenCost } from "../../shared/token-cost.js";
import {
  anthropicKeychainService,
  hasKeychainCredentialCached,
} from "./anthropic-keychain.js";

/**
 * ISS-5445 — memo for {@link isPricedModel}. Detection runs per session row and
 * a corpus repeats the same handful of model ids thousands of times, while the
 * probe itself walks the genai-prices tables.
 *
 * BOUNDED on purpose: the key is a model id read from a harness transcript, i.e.
 * external input, so an unbounded map would grow with every malformed id a
 * transcript can name. At the cap the map is cleared wholesale rather than
 * evicted one entry at a time — priceability is a pure function of the model id,
 * so a cleared entry is simply recomputed, and a plain clear cannot leak.
 */
const PRICED_MODEL_CACHE_MAX = 512;
const pricedModelCache = new Map<string, boolean>();

/**
 * ISS-5445 — does this model id resolve to REAL published provider pricing?
 *
 * Probes the same engine that prices the session's tokens, with a nominal
 * one-token usage: `priced === true` means genai-prices matched the id to a
 * provider with published per-token rates, so spend on it is real money. A
 * synthetic `*-default` key or an unrecognized id returns `no_match` ⇒ `false`,
 * which the caller must read as "no evidence", never as "free".
 *
 * Deliberately does NOT consult the FEA-3546 unknown-model fallback: that
 * fallback exists so an unpriceable model still shows a non-zero COST estimate,
 * and treating its output as proof of real billing would make every unknown
 * model look like paid API spend — exactly the confident-wrong-answer this
 * ticket set out to remove.
 */
function isPricedModel(model: string): boolean {
  const cached = pricedModelCache.get(model);
  if (cached !== undefined) {
    return cached;
  }
  const priced = safe(
    () =>
      computeTokenCost({
        model,
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }).priced
  );
  // A thrown probe is an absence of evidence, not a "free" verdict.
  const result = priced === true;
  if (pricedModelCache.size >= PRICED_MODEL_CACHE_MAX) {
    pricedModelCache.clear();
  }
  pricedModelCache.set(model, result);
  return result;
}

/** Run `fn`, returning undefined rather than throwing out of the cost path. */
function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return;
  }
}

/** Real detection deps for desktop-main. */
function realDeps(model?: string | null): BillingModeDetectionDeps {
  return {
    model,
    isPricedModel,
    env: process.env,
    // Wrap so the signature is exactly (string) => boolean and contents are
    // never read — existsSync only stats the path.
    fileExists: (p: string): boolean => existsSync(p),
    homeDir: homedir(),
    // ISS-4869: macOS keeps Claude Code's OAuth credential in the login
    // Keychain, so the file check alone left every macOS Claude session
    // "unknown". The engine hands over the profile (null = default profile, a
    // string = relocated config dir) and this adapter composes the service
    // name, because a relocated profile's name carries a crypto hash suffix.
    // Memoized behind a TTL — this is the only dep that spawns a subprocess,
    // and detection runs per session row.
    hasKeychainCredential: (configDir: string | null): boolean =>
      hasKeychainCredentialCached(anthropicKeychainService(configDir)),
  };
}

/**
 * Detect the billing mode for a harness using the live environment. Returns a
 * BillingMode; unknown/unsupported harnesses yield "unknown".
 *
 * ISS-5445 — `model` is the session's model id, and is OPTIONAL. Only the
 * bring-your-own-key OpenCode path consults it (payment follows the model, not
 * the harness); the machine-level Anthropic/OpenAI/Cursor detectors answer from
 * credential existence and ignore it. Omitting it therefore preserves the exact
 * previous behavior for every other harness, and for OpenCode it degrades to the
 * honest "unknown" rather than to a guess.
 */
export function detectBillingMode(
  harness: string,
  model?: string | null
): BillingMode {
  return detectBillingModeForHarness(harness, realDeps(model));
}

/**
 * Resolve the billing mode for a persisted session row. A stored, definite mode
 * (stamped at ingest by FEA-1434) always wins; a missing/legacy/"unknown" mode
 * falls back to best-effort detection from the live desktop environment. Shared
 * by the agent-session sync payload and the nightly cost-reconciliation worker
 * so the two never diverge on which sessions count as real metered API spend.
 */
export function resolveBillingMode(input: {
  billingMode: unknown;
  harness: string | null;
  /**
   * ISS-5445 — the row's `sessions.model`, forwarded so the OpenCode fallback can
   * classify by model. Optional: a caller that does not select the column gets
   * the honest `unknown` instead of a harness-derived guess.
   */
  model?: string | null;
}): BillingMode {
  const stored = normalizeBillingMode(input.billingMode);
  if (stored !== "unknown") {
    return stored;
  }
  return detectBillingMode(input.harness ?? "", input.model);
}
