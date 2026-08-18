/**
 * @file reconciliation-cause-hint.ts
 * @description Desktop-main (ESM) heuristic that explains WHY a day×model's local
 * genai-prices estimate drifted from what the vendor actually billed (FEA-1436).
 * Pure function, no I/O — it takes already-computed drift features and returns a
 * ranked list of plausible human-readable causes for the Diagnostics "explain"
 * expander.
 *
 * ── This is a hint, not a verdict ────────────────────────────────────────────
 * Drift is INFORMATIONAL. We never re-price old sessions or "correct" the local
 * estimate from these hints (explicit non-goal). The point is to tell the user
 * the most likely benign explanation first so a small expected drift doesn't read
 * as a billing bug.
 *
 * ── The permanent, expected gap ──────────────────────────────────────────────
 * `cache_write_1h_unmodeled` is a KNOWN, permanent under-estimate, not a
 * transient anomaly: genai-prices does not model Anthropic's 1-hour cache-write
 * pricing tier, so any day that wrote 1h cache entries will show local < vendor.
 * Its hint links to the upstream genai-prices project (the package's declared
 * homepage) rather than a fabricated issue number, and is flagged `permanent` so
 * the UI can label it "expected" instead of actionable.
 */

/** Upstream project home for the known cache-write pricing gap. */
const GENAI_PRICES_PROJECT_URL = "https://github.com/pydantic/genai-prices";

export type DriftCauseId =
  | "cache_write_1h_unmodeled"
  | "server_side_tool_use"
  | "batch_api_discount"
  | "trial_credit"
  | "unknown";

/** Signals derived from the reconciliation row + the day's local token usage. */
export type DriftCauseFeatures = {
  /** Vendor id, e.g. "anthropic" or "openai". */
  vendor: string;
  /** local − vendor, in micro-cents (see cost-math.computeDrift). */
  driftMicroCents: number;
  /** Local estimate for the day×model, in micro-cents. */
  localMicroCents: number;
  /** Vendor-billed amount for the day×model, in micro-cents. */
  vendorMicroCents: number;
  /** True when the day×model recorded any cache-write tokens locally. */
  hasCacheWriteTokens: boolean;
  /**
   * True when the day×model used server-side tools that bill separately from
   * token counts (e.g. web search, code execution). Optional — absent means
   * "no signal", not "known false".
   */
  hasServerSideToolUse?: boolean;
};

export type DriftCauseHint = {
  cause: DriftCauseId;
  /** Short label for the ranked list. */
  title: string;
  /** One-sentence plain explanation of the mechanism. */
  detail: string;
  /** Optional external link for known gaps. */
  link?: string;
  /**
   * True for known/expected gaps that re-pricing would NOT close (so the UI can
   * present them as "expected" rather than something to chase).
   */
  permanent: boolean;
};

const CACHE_WRITE_1H_HINT: DriftCauseHint = {
  cause: "cache_write_1h_unmodeled",
  title: "1-hour cache write not modeled",
  detail:
    "genai-prices does not price Anthropic's 1-hour cache-write tier, so days that wrote 1h cache entries are billed slightly higher than the local estimate.",
  link: GENAI_PRICES_PROJECT_URL,
  permanent: true,
};

const SERVER_SIDE_TOOL_HINT: DriftCauseHint = {
  cause: "server_side_tool_use",
  title: "Server-side tool use billed separately",
  detail:
    "Server-side tools (e.g. web search or code execution) are charged on top of token usage and are not captured by the local token-based estimate.",
  permanent: false,
};

const BATCH_DISCOUNT_HINT: DriftCauseHint = {
  cause: "batch_api_discount",
  title: "Batch API discount applied",
  detail:
    "The vendor billed less than the local estimate, consistent with a batch/async discount that the local per-request pricing does not apply.",
  permanent: false,
};

const TRIAL_CREDIT_HINT: DriftCauseHint = {
  cause: "trial_credit",
  title: "Covered by credit or trial",
  detail:
    "The vendor billed nothing for usage the local estimate priced, consistent with promotional credit, a free trial, or a not-yet-posted invoice.",
  permanent: false,
};

const UNKNOWN_HINT: DriftCauseHint = {
  cause: "unknown",
  title: "Cause not determined",
  detail:
    "The drift does not match a known pattern. Use Export for support to share this day×model for investigation.",
  permanent: false,
};

/**
 * Rank the plausible causes of a drift, most-likely first. Returns an empty list
 * when there is no drift (callers only explain rows above the notice threshold).
 *
 * Direction matters:
 *   • UNDER-estimate (local < vendor, driftMicroCents < 0): the vendor charged
 *     more than we modeled → the Anthropic 1h cache-write gap (permanent) ranks
 *     first when applicable, then server-side tool use, then unknown.
 *   • OVER-estimate (local > vendor, driftMicroCents > 0): the vendor charged
 *     less → a $0 vendor bill points to credit/trial, otherwise a batch discount;
 *     unknown is always retained as a fallback.
 */
export function rankDriftCauses(
  features: DriftCauseFeatures
): DriftCauseHint[] {
  const hints: DriftCauseHint[] = [];
  const drift = features.driftMicroCents;

  if (drift < 0) {
    // Vendor billed MORE than the local estimate.
    if (features.vendor === "anthropic" && features.hasCacheWriteTokens) {
      hints.push(CACHE_WRITE_1H_HINT);
    }
    if (features.hasServerSideToolUse === true) {
      hints.push(SERVER_SIDE_TOOL_HINT);
    }
    hints.push(UNKNOWN_HINT);
    return hints;
  }

  if (drift > 0) {
    // Vendor billed LESS than the local estimate.
    if (features.vendorMicroCents === 0 && features.localMicroCents > 0) {
      hints.push(TRIAL_CREDIT_HINT);
    } else {
      hints.push(BATCH_DISCOUNT_HINT);
    }
    hints.push(UNKNOWN_HINT);
    return hints;
  }

  // drift === 0 → nothing to explain.
  return hints;
}
