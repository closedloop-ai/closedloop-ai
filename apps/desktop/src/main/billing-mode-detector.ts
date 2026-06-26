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
 * Secret-handling: the file check is existence-only and never reads contents;
 * no env value is logged or returned. See billing-mode.ts for the full rule.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";

import {
  type BillingMode,
  type BillingModeDetectionDeps,
  detectBillingModeForHarness,
  normalizeBillingMode,
} from "../shared/billing-mode.js";

/** Real detection deps for desktop-main. */
function realDeps(): BillingModeDetectionDeps {
  return {
    env: process.env,
    // Wrap so the signature is exactly (string) => boolean and contents are
    // never read — existsSync only stats the path.
    fileExists: (p: string): boolean => existsSync(p),
    homeDir: homedir(),
  };
}

/**
 * Detect the billing mode for a harness using the live environment. Returns a
 * BillingMode; unknown/unsupported harnesses yield "unknown".
 */
export function detectBillingMode(harness: string): BillingMode {
  return detectBillingModeForHarness(harness, realDeps());
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
}): BillingMode {
  const stored = normalizeBillingMode(input.billingMode);
  if (stored !== "unknown") {
    return stored;
  }
  return detectBillingMode(input.harness ?? "");
}
