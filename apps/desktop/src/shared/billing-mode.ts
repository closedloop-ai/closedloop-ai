/**
 * @file billing-mode.ts
 * @description The canonical billing-mode engine: which ledger a session's spend
 * belongs to, and how a harness's billing mode is detected from the machine's
 * credential *existence*.
 *
 * FEA-1503 removed the vendored CJS twin
 * (`scripts/agent-monitor-billing/billing-mode.js`); this module is now the
 * single source of truth and `test/billing-mode.test.ts` pins its behavior
 * directly.
 *
 * ── Purity / placement rule ───────────────────────────────────────────────────
 * This module is a pure leaf — `node:path` is its ONLY import, so it stays safe
 * to pull into browser-ish bundles and adds no boot-path weight (see the
 * SUBSCRIPTION_MODES note below re: the pglite boot regression). Detection is
 * therefore fully dependency-injected: anything needing a filesystem, a
 * subprocess, or an OS API is supplied by the caller through
 * `BillingModeDetectionDeps`, and the Node-side wiring lives in
 * `src/main/cost/billing-mode-detector.ts`.
 *
 * ── Secret-handling rule (non-negotiable) ─────────────────────────────────────
 * Detection checks credential EXISTENCE only. It NEVER reads the contents of
 * `~/.claude/.credentials.json`, `~/.codex/auth.json`, the macOS Keychain item,
 * or any API-key env var beyond a non-empty check, and NEVER logs, echoes, or
 * returns those values. The only output is an opaque BillingMode string.
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
  /**
   * ISS-4869 — OPTIONAL OS-keystore existence check, keyed by PROFILE rather
   * than by service name: `null` means the default profile, and a string is the
   * relocated Claude config dir.
   *
   * The caller composes the actual Keychain service name from that, because the
   * relocated name carries a `-<hash(configDir)>` suffix and hashing needs
   * `node:crypto`, which this pure leaf must not import. See
   * `anthropicKeychainService` in `src/main/cost/anthropic-keychain.ts`.
   *
   * Optional by design: it needs a subprocess (macOS `security`), which this
   * pure module must not spawn, and omitting it must degrade to exactly the
   * previous behavior. Absent (or any non-`true` result) means "no keystore
   * signal", never "no subscription". Wired for real in
   * `src/main/cost/billing-mode-detector.ts`; existence-only, like every other
   * detection signal here — it must never read or surface the stored secret.
   */
  hasKeychainCredential?: (configDir: string | null) => boolean;
  /**
   * ISS-5445 — OPTIONAL model evidence for the session being classified.
   *
   * Billing mode is a PAYMENT classification, and for a bring-your-own-key
   * harness the payment method follows the MODEL, not the harness. This is the
   * session's model id as stored in `sessions.model`.
   *
   * Optional by design, and absence must degrade to "unknown" rather than to a
   * guess: the machine-level detectors (Anthropic/OpenAI/Cursor) answer without
   * it, and a caller that genuinely has no model — a legacy row, a heal pass
   * over rows that predate model capture — must not be handed a confident
   * classification it has no evidence for.
   */
  model?: string | null;
  /**
   * ISS-5445 — OPTIONAL priceability probe: does this model id resolve to REAL
   * published provider pricing?
   *
   * Injected rather than imported because this module is a pure leaf (`node:path`
   * only) and the pricing engine (`@repo/cost`, wrapping `@pydantic/genai-prices`)
   * is neither pure nor bundle-safe here. The Node adapter wires it in
   * `src/main/cost/billing-mode-detector.ts`.
   *
   * `true` means the model has published per-token prices, so tokens spent on it
   * are real out-of-pocket money. Anything else — `false`, absent, or a synthetic
   * `*-default` key the library cannot map — means NO EVIDENCE, never "free".
   */
  isPricedModel?: (model: string) => boolean;
};

/**
 * Every valid billing mode, as a runtime array. Kept in lockstep with the
 * BillingMode union above; `test/billing-mode.test.ts` fails if they diverge.
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
//
// ISS-4773: exported for the same reason `SUBSCRIPTION_MODES` is — the API's
// parity test binds its duplicate `METERED_BILLING_MODES` set
// (packages/api/src/types/billing-mode.ts) to this canonical one. The cloud
// producer now needs the metered/unknown distinction the desktop ledger has
// always had, so BOTH halves of the classification must be pinned, not just the
// subscription half. Consumed in a TEST only, never as a desktop-main runtime
// import.
export const METERED_MODES: ReadonlySet<BillingMode> = new Set([
  "api",
  "cursor_api",
]);
// Subscription-covered → priced only as a hypothetical "would have cost"
// equivalent, NEVER summed into headline spend.
//
// FEA-3104: exported so the API's parity test can bind its duplicate
// SUBSCRIPTION_BILLING_MODES set (packages/api/src/types/billing-mode.ts) to
// this canonical set. This module is a pure leaf (only `node:path`), so the
// export adds no boot-path dependency; the API consumes it in a TEST only —
// never as a desktop-main runtime import (that would risk the pglite boot
// regression, #1618/#1620).
//
// ISS-5445 — `opencode` is deliberately NOT in this set.
//
// An earlier revision of this ticket added it, on the premise that "OpenCode
// runs against free models, and a free subscription is still a subscription".
// Review proved the premise false as an invariant: `detectOpencodeBillingMode`
// consulted nothing but the harness name, and `test/model-pricing-sqlite.test.ts`
// imports an OpenCode session on `gpt-5` that receives a real genai-priced,
// non-zero cost. OpenCode is bring-your-own-key, so it can run a free model or a
// fully-paid one, and the HARNESS alone cannot tell you which.
//
// Operator ruling (2026-08-07): "opencode doesn't guarantee a free model — the
// cost should be associated with the model; not the harness." So the ledger is
// now derived from the session's MODEL at detection time (see
// `detectOpencodeBillingMode`), and the bare `opencode` mode means only "an
// OpenCode session whose billing we could not determine" — an unknown-ledger
// value, which is what a stored legacy `opencode` row honestly is.
export const SUBSCRIPTION_MODES: ReadonlySet<BillingMode> = new Set([
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
 * or subscription (the literal "unknown", or any unrecognized future value read
 * from disk/relay) lands in "unknown".
 *
 * ── ISS-5445: the ledger moved to the MODEL, and needs no data migration ──────
 * Operator ruling: "the cost should be associated with the model; not the
 * harness." The change is in `detectOpencodeBillingMode`, which now classifies a
 * NEW OpenCode session from its model's priceability instead of stamping the
 * constant `'opencode'`. This mapping table is unchanged — `'opencode'` was, and
 * remains, an unknown-ledger value.
 *
 * No migration is needed, and none is wanted:
 *  - Existing rows stamped `'opencode'` keep reporting in the unknown ledger,
 *    which is the honest answer: they were classified by harness, so their
 *    billing method genuinely was never determined. Re-deriving them would
 *    require re-reading each source transcript's model, and a `DATA_REVISION`
 *    bump forcing a full re-parse is far more cost than the restatement is worth.
 *  - The boot heal (`main/database/billing-mode-heal.ts`) selects only
 *    `(billing_mode IS NULL OR billing_mode = 'unknown')`, so `'opencode'` rows
 *    do not match it and are not churned.
 * The population therefore converges forward: newly imported sessions get a
 * model-derived mode, historical ones stay honestly unknown.
 *
 * ── Version skew, both directions (relay sync contract) ───────────────────────
 * `BillingMode` is a stable, additive union carried on the relay sync contract,
 * and peers update independently. This change emits NO new value — a
 * model-priced OpenCode session is stamped `'api'`, which every peer already
 * understands and already buckets as metered, so there is no skew window at all
 * for the new behavior. Independently, this function stays TOTAL over the union
 * with a plain `return "unknown"` fallthrough, and `normalizeBillingMode`
 * coerces any unrecognized value from a newer peer to `"unknown"` instead of
 * throwing. No coordinated deploy, no compatibility shim, no crash on either
 * side.
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
 * rows in the unknown bucket are pre-existing real numbers whose billing method
 * we could not determine and must not silently zero out. Subscription cost stays
 * visible in its own bucket for the two-ledger UI; it is simply excluded from
 * the headline sum.
 *
 * ISS-5445: an OpenCode session on a PRICED model is stamped `"api"`, so its
 * real out-of-pocket spend lands in the metered bucket and IS counted in the
 * headline — which is the whole point of moving classification onto the model.
 * An OpenCode session whose model yields no pricing evidence stays in the
 * unknown bucket and therefore still reaches the headline, per the clause above:
 * an undetermined row is a real number we must not silently zero out. Only
 * genuinely subscription-covered modes are excluded from the headline.
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
 * (legacy/undetermined), explicitly EXCLUDING subscription-covered cost.
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
 * Identify which Claude Code profile's Keychain item to probe: `null` for the
 * default profile, or the relocated config dir when either override is set.
 *
 * Claude Code appends a `-<hash(configDir)>` suffix to the Keychain service name
 * whenever the config dir is relocated, so a relocated profile stores its
 * credential under a DIFFERENT service than the default one. Returning the dir
 * (rather than a service name) keeps this module a pure leaf: the Node adapter
 * owns the hashing and the actual name composition.
 *
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` takes precedence when set, since it targets
 * the secure-storage location specifically; otherwise `CLAUDE_CONFIG_DIR`.
 *
 * Probing the *unsuffixed* name under a relocated profile would not merely miss:
 * it could HIT a different (default) profile's leftover item and report a
 * subscription this harness never used, moving real spend off the headline
 * ledger. Keying the probe on the profile is what prevents that.
 */
function keychainProfileConfigDir(
  deps: BillingModeDetectionDeps
): string | null {
  if (hasNonEmptyEnv(deps.env, "CLAUDE_SECURESTORAGE_CONFIG_DIR")) {
    return deps.env.CLAUDE_SECURESTORAGE_CONFIG_DIR as string;
  }
  if (hasNonEmptyEnv(deps.env, "CLAUDE_CONFIG_DIR")) {
    return deps.env.CLAUDE_CONFIG_DIR as string;
  }
  return null;
}

/**
 * Resolve the Claude Code config dir, honoring the documented $CLAUDE_CONFIG_DIR
 * override — the same shape as codexHomeDir()/$CODEX_HOME above. Claude Code
 * stores its plaintext OAuth credential at `<configDir>/.credentials.json`, so a
 * relocated config dir moved that file out from under a hardcoded `~/.claude`.
 */
function claudeConfigDir(deps: BillingModeDetectionDeps): string {
  if (hasNonEmptyEnv(deps.env, "CLAUDE_CONFIG_DIR")) {
    return deps.env.CLAUDE_CONFIG_DIR as string;
  }
  return join(deps.homeDir, ".claude");
}

/**
 * Env flags that switch Claude Code onto a third-party model provider. Spend
 * then lands on that provider's bill (AWS / GCP), never on an Anthropic
 * subscription.
 */
const ANTHROPIC_PROVIDER_OVERRIDE_FLAGS: readonly string[] = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];

/** Values a provider flag can carry that mean "off" rather than "enabled". */
const DISABLED_FLAG_VALUES: ReadonlySet<string> = new Set(["0", "false"]);

/** True when an env flag is present AND not explicitly disabled. */
function isEnabledEnvFlag(
  env: Record<string, string | undefined>,
  key: string
): boolean {
  if (!hasNonEmptyEnv(env, key)) {
    return false;
  }
  return !DISABLED_FLAG_VALUES.has((env[key] as string).trim().toLowerCase());
}

/**
 * True when Claude Code is pointed at a different provider or a different auth
 * path than an Anthropic subscription.
 *
 * Claude Code resolves its provider and auth override BEFORE it ever consults
 * subscription credentials, so a machine carrying one of these alongside a
 * leftover OAuth token, credentials file, or Keychain item is NOT spending on
 * the subscription — it is spending on Bedrock, Vertex, or whatever gateway
 * `ANTHROPIC_AUTH_TOKEN` authenticates against. Classifying that as
 * `subscription_unknown` would move real, separately-billed spend off the
 * headline ledger, which is the precise failure the ledger split exists to
 * prevent. Detection therefore mirrors the CLI's own precedence.
 */
function usesProviderOrAuthOverride(deps: BillingModeDetectionDeps): boolean {
  if (hasNonEmptyEnv(deps.env, "ANTHROPIC_AUTH_TOKEN")) {
    return true;
  }
  return ANTHROPIC_PROVIDER_OVERRIDE_FLAGS.some((flag) =>
    isEnabledEnvFlag(deps.env, flag)
  );
}

/**
 * Anthropic (Claude Code harness): an ANTHROPIC_API_KEY — or any provider/auth
 * override (Bedrock, Vertex, a custom `ANTHROPIC_AUTH_TOKEN` gateway) — means
 * real metered billing; otherwise any present OAuth credential means a Pro/Max
 * subscription (tier undeterminable here → subscription_unknown). No path reads
 * a secret's contents — every check is existence/non-empty only.
 *
 * Order is load-bearing: the metered signals are checked FIRST, matching the
 * CLI's own resolution order, so a leftover subscription credential can never
 * mask separately-billed spend. See `usesProviderOrAuthOverride`.
 *
 * ISS-4869: Claude Code keeps that OAuth credential in ONE of three places, and
 * before this change only the second was checked — so on macOS, where the
 * Keychain is the default store, every Claude session fell through to "unknown"
 * and its cost was summed into headline "real spend" (measured: 1,270 sessions /
 * $17.9k of phantom out-of-pocket on a fully subscription-covered machine).
 *
 *   1. `CLAUDE_CODE_OAUTH_TOKEN` — the long-lived token `claude setup-token`
 *      mints for headless/CI use.
 *   2. `<configDir>/.credentials.json` — the plaintext store. Still the norm on
 *      Linux/WSL, and the macOS fallback when the Keychain is unavailable.
 *   3. The macOS login Keychain, service `Claude Code-credentials` — the DEFAULT
 *      on macOS, hence the gap. Probed whenever the caller injects
 *      `hasKeychainCredential`. A relocated config dir stores its item under a
 *      hash-suffixed service name, so the probe is keyed on the profile's config
 *      dir (`keychainProfileConfigDir`) and the Node adapter composes the name;
 *      relocated Keychain-only profiles are detected rather than skipped.
 *
 * Verified against the shipped Claude Code CLI (v2.1.220), whose own credential
 * loader reads `<CLAUDE_CONFIG_DIR ?? ~/.claude>/.credentials.json` and then,
 * when neither `CLAUDE_CONFIG_DIR` nor an API-key/OAuth-token env var is set,
 * falls back to the Keychain via
 * `security find-generic-password -a <$USER> -w -s "Claude Code-credentials"`
 * (it stores the item with the matching
 * `add-generic-password -U -a <$USER> -s "Claude Code-credentials"`). Our probe
 * issues the same lookup MINUS `-w`, so it reads the item's existence and never
 * its secret. It stays scoped to both `-a` and `-s` — see
 * `main/cost/anthropic-keychain.ts` for why the account filter is never widened.
 */
export function detectAnthropicBillingMode(
  deps: BillingModeDetectionDeps
): BillingMode {
  if (hasNonEmptyEnv(deps.env, "ANTHROPIC_API_KEY")) {
    return "api";
  }
  if (usesProviderOrAuthOverride(deps)) {
    return "api";
  }
  if (hasNonEmptyEnv(deps.env, "CLAUDE_CODE_OAUTH_TOKEN")) {
    return "subscription_unknown";
  }
  if (deps.fileExists(join(claudeConfigDir(deps), ".credentials.json"))) {
    return "subscription_unknown";
  }
  if (deps.hasKeychainCredential?.(keychainProfileConfigDir(deps)) === true) {
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

/**
 * OpenCode harness: bring-your-own-key, so the payment method follows the MODEL,
 * not the harness.
 *
 * ── ISS-5445, the operator ruling this implements ─────────────────────────────
 * "opencode doesn't guarantee a free model — the cost should be associated with
 * the model; not the harness."
 *
 * This function previously returned the constant `"opencode"` and discarded its
 * deps entirely, which encoded WHICH HARNESS RAN into a column that is supposed
 * to record HOW IT WAS PAID FOR. The harness is already its own column; conflating
 * the two is what let a fully-paid `gpt-5` OpenCode session be reported as
 * subscription-covered (`test/model-pricing-sqlite.test.ts` proves such a session
 * receives a real genai-priced, non-zero cost).
 *
 * ── The rule, and why the fallthrough is `unknown` and not `opencode` ─────────
 *  - Model resolves to REAL published provider pricing ⇒ tokens spent on it are
 *    genuine out-of-pocket money ⇒ `"api"` (metered ledger, counted in headline
 *    spend). This is the case review caught.
 *  - Anything else ⇒ `"unknown"`. No model recorded, a synthetic `*-default` key,
 *    or a model the pricing library cannot map — all of these are an ABSENCE of
 *    evidence, and absence of evidence is not evidence of "free".
 *
 * There is deliberately NO "free model ⇒ subscription" branch. The repo has no
 * free-model registry — nothing anywhere enumerates which model ids are free —
 * so such a branch could only be implemented by guessing, and a confident wrong
 * classification is strictly worse than an honest `unknown`. When a registry
 * exists, it belongs here as an explicit third branch, injected the same way
 * `isPricedModel` is.
 *
 * Note this returns `"api"`/`"unknown"` and never `"opencode"`. That value stays
 * in {@link BILLING_MODES} because stored rows and older peers still carry it —
 * it means "an OpenCode session whose billing we could not determine", which maps
 * to the unknown ledger. Reusing the existing `"api"` rather than minting an
 * `opencode_byok` value keeps this free of wire skew: every peer already
 * understands `"api"` and already buckets it as metered.
 */
export function detectOpencodeBillingMode(
  deps: BillingModeDetectionDeps
): BillingMode {
  const model = typeof deps.model === "string" ? deps.model.trim() : "";
  if (model.length === 0) {
    return "unknown";
  }
  return deps.isPricedModel?.(model) === true ? "api" : "unknown";
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
