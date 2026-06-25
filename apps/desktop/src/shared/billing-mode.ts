/**
 * @file billing-mode.ts
 * @description Desktop-main (ESM) TWIN of the agent-monitor sidecar's canonical
 * billing-mode engine (`scripts/agent-monitor-billing/billing-mode.js`). Same
 * classification, same dependency-injected detection, same secret-handling
 * discipline.
 *
 * ── Why a twin instead of one shared file ────────────────────────────────────
 * Identical reasoning to token-cost.ts: desktop-main is `type:module` (ESM) and
 * is the only billing path that must work when the sidecar is disabled, while
 * billing-mode.js runs inside the generated `type:commonjs` sidecar tree that is
 * not staged into desktop-main's module path. A parity test
 * (`test/billing-mode.test.ts`) imports BOTH and asserts identical output so the
 * twins cannot drift.
 *
 * ── Secret-handling rule (non-negotiable) ─────────────────────────────────────
 * Detection checks credential EXISTENCE only. It NEVER reads the contents of
 * `~/.claude/.credentials.json`, `~/.codex/auth.json`, or any API-key env var
 * beyond a non-empty check, and NEVER logs, echoes, or returns those values. The
 * only output is an opaque BillingMode string.
 *
 * ── Tier granularity ──────────────────────────────────────────────────────────
 * BillingMode carries tier-specific values (pro/max_5x/max_20x) for the
 * persisted/synced contract, but existence-only detection cannot distinguish
 * tiers (that needs `/status` parsing, out of scope — see PRD-414). OAuth-present
 * Anthropic resolves to `subscription_unknown`; finer tiers arrive later from
 * `/status` or cloud sync. The ledger mapping is total over every value.
 */
import { join } from "node:path";

/**
 * Every valid billing mode. Persisted in the sessions.billing_mode column and
 * carried on the relay sync contract, so this is a stable, additive union.
 */
export type BillingMode =
  | "api"
  | "subscription_unknown"
  | "pro"
  | "max_5x"
  | "max_20x"
  | "codex_subscription"
  | "cursor_api"
  | "cursor_pro"
  | "copilot_seat"
  | "opencode"
  | "unknown";

/** Which ledger a billing mode contributes to. */
export type BillingLedger = "metered" | "subscription" | "unknown";

/** Injected dependencies for detection — keeps the engine pure and testable. */
export type BillingModeDetectionDeps = {
  /** Process environment (existence/non-empty checks only — never logged). */
  env: Record<string, string | undefined>;
  /** Credential-file existence check (never reads contents). */
  fileExists: (path: string) => boolean;
  /** User home directory (e.g. os.homedir()). */
  homeDir: string;
};

/**
 * Every valid billing mode, as a runtime array. Kept byte-identical to
 * BILLING_MODES in billing-mode.js; the parity test fails if they diverge.
 */
export const BILLING_MODES: readonly BillingMode[] = [
  "api",
  "subscription_unknown",
  "pro",
  "max_5x",
  "max_20x",
  "codex_subscription",
  "cursor_api",
  "cursor_pro",
  "copilot_seat",
  "opencode",
  "unknown",
];

// Real per-token API spend → counts toward headline metered cost.
const METERED_MODES: ReadonlySet<BillingMode> = new Set(["api", "cursor_api"]);
// Subscription-covered → priced only as a hypothetical "would have cost"
// equivalent, NEVER summed into headline spend.
const SUBSCRIPTION_MODES: ReadonlySet<BillingMode> = new Set([
  "subscription_unknown",
  "pro",
  "max_5x",
  "max_20x",
  "codex_subscription",
  "cursor_pro",
  "copilot_seat",
]);

/**
 * Map a billing mode to its ledger. Total over the union: anything not metered
 * or subscription (opencode BYOK, the literal "unknown", or any unrecognized
 * future value read from disk/relay) lands in "unknown".
 */
export function billingLedger(mode: BillingMode): BillingLedger {
  if (METERED_MODES.has(mode)) {
    return "metered";
  }
  if (SUBSCRIPTION_MODES.has(mode)) {
    return "subscription";
  }
  return "unknown";
}

/** True when the mode represents real, per-token API spend. */
export function isMeteredApi(mode: BillingMode): boolean {
  return billingLedger(mode) === "metered";
}

/** True when the mode is covered by a flat subscription/seat. */
export function isSubscription(mode: BillingMode): boolean {
  return billingLedger(mode) === "subscription";
}

/**
 * Three-bucket cost accumulator. Shape is the wire contract for the
 * `cost_by_ledger` field on the analytics/cost endpoints.
 */
export type LedgerTotals = {
  metered: number;
  subscription: number;
  unknown: number;
};

/**
 * ── Ledger accounting (pure) ──────────────────────────────────────────────────
 * The two-ledger invariant lives here so the sidecar routes and any future
 * desktop-main caller share one definition and cannot diverge. A LedgerTotals
 * accumulator carries the three buckets; addLedgerCost() routes one priced row
 * into its bucket via billingLedger(); headlineCost() defines what counts as
 * real spend.
 *
 * Headline = metered + unknown (NOT subscription). Rationale: subscription rows
 * are a hypothetical "would have cost" and must never inflate real spend, while
 * legacy/opencode rows in the unknown bucket are pre-existing real numbers we
 * must not silently zero out. Subscription cost stays visible in its own bucket
 * for the two-ledger UI; it is simply excluded from the headline sum.
 */

/** Fresh zeroed accumulator. Shape is the wire contract for cost_by_ledger. */
export function emptyLedgerTotals(): LedgerTotals {
  return { metered: 0, subscription: 0, unknown: 0 };
}

/**
 * Add one priced row's cost to the bucket its billing mode maps to. Non-finite
 * costs (null/undefined/NaN from an unpriced row) are ignored so an unpriced
 * model never corrupts a ledger total — it simply does not contribute. Mutates
 * and returns `totals` for fold-style accumulation.
 */
export function addLedgerCost(
  totals: LedgerTotals,
  billingMode: BillingMode,
  costUsd: number
): LedgerTotals {
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) {
    return totals;
  }
  totals[billingLedger(billingMode)] += costUsd;
  return totals;
}

/**
 * The headline "real spend" number: metered API spend plus unknown-ledger rows
 * (legacy/opencode), explicitly EXCLUDING subscription-covered cost.
 */
export function headlineCost(totals: LedgerTotals): number {
  return totals.metered + totals.unknown;
}

/**
 * Coerce a possibly-null/legacy/garbage value (e.g. a DB read from a row written
 * before this column existed, or a relay payload from an older build) to a valid
 * BillingMode. Unrecognized → "unknown".
 */
export function normalizeBillingMode(value: unknown): BillingMode {
  return typeof value === "string" &&
    (BILLING_MODES as readonly string[]).includes(value)
    ? (value as BillingMode)
    : "unknown";
}

/** Non-empty string presence check for an env var (existence only — never logged). */
function hasNonEmptyEnv(
  env: Record<string, string | undefined>,
  key: string
): boolean {
  const v = env && typeof env === "object" ? env[key] : undefined;
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Resolve the Codex home dir, honoring the documented $CODEX_HOME override (same
 * precedence the codex importer's codex-home.js uses) so a relocated Codex
 * install is classified correctly rather than falling through to unknown.
 */
function codexHomeDir(deps: BillingModeDetectionDeps): string {
  if (hasNonEmptyEnv(deps.env, "CODEX_HOME")) {
    return deps.env.CODEX_HOME as string;
  }
  return join(deps.homeDir, ".codex");
}

/**
 * Anthropic (Claude Code harness): an ANTHROPIC_API_KEY means real metered API
 * billing; otherwise a present OAuth credential file means a Pro/Max
 * subscription (tier undeterminable here → subscription_unknown). Neither path
 * reads the secret's contents.
 */
export function detectAnthropicBillingMode(
  deps: BillingModeDetectionDeps
): BillingMode {
  if (hasNonEmptyEnv(deps.env, "ANTHROPIC_API_KEY")) {
    return "api";
  }
  if (deps.fileExists(join(deps.homeDir, ".claude", ".credentials.json"))) {
    return "subscription_unknown";
  }
  return "unknown";
}

/**
 * OpenAI/Codex harness: an OPENAI_API_KEY means metered API billing; otherwise a
 * present Codex OAuth file means a ChatGPT/Codex subscription.
 */
export function detectOpenAiBillingMode(
  deps: BillingModeDetectionDeps
): BillingMode {
  if (hasNonEmptyEnv(deps.env, "OPENAI_API_KEY")) {
    return "api";
  }
  if (deps.fileExists(join(codexHomeDir(deps), "auth.json"))) {
    return "codex_subscription";
  }
  return "unknown";
}

/**
 * Cursor harness: a CURSOR_API_KEY means metered API billing; otherwise a
 * tracked Cursor session (the importer only runs when transcripts exist) is a
 * Pro/Business seat. Seat-share allocation math is out of scope (PRD-414).
 */
export function detectCursorBillingMode(
  deps: BillingModeDetectionDeps
): BillingMode {
  if (hasNonEmptyEnv(deps.env, "CURSOR_API_KEY")) {
    return "cursor_api";
  }
  return "cursor_pro";
}

/** GitHub Copilot is always a seat-based subscription (no per-token API). */
export function detectCopilotBillingMode(
  _deps: BillingModeDetectionDeps
): BillingMode {
  return "copilot_seat";
}

/** OpenCode is bring-your-own-key; per-call billing attribution is deferred. */
export function detectOpencodeBillingMode(
  _deps: BillingModeDetectionDeps
): BillingMode {
  return "opencode";
}

/**
 * Detect the billing mode for a harness from injected deps. Unknown harnesses
 * resolve to "unknown" (ledger: unknown) rather than guessing.
 */
export function detectBillingModeForHarness(
  harness: string,
  deps: BillingModeDetectionDeps
): BillingMode {
  switch (harness) {
    case "claude":
      return detectAnthropicBillingMode(deps);
    case "codex":
      return detectOpenAiBillingMode(deps);
    case "cursor":
      return detectCursorBillingMode(deps);
    case "copilot":
      return detectCopilotBillingMode(deps);
    case "opencode":
      return detectOpencodeBillingMode(deps);
    default:
      return "unknown";
  }
}
