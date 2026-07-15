import { z } from "zod";

// Per-model token tracking
export type ModelTokenUsage = {
  input: number;
  output: number;
  cacheCreation?: number;
  cacheRead?: number;
};

export const ModelTokenUsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheCreation: z.number().optional(),
  cacheRead: z.number().optional(),
});

export type TokensByModel = Record<string, ModelTokenUsage>;

export const TokensByModelSchema = z.record(z.string(), ModelTokenUsageSchema);

// Per-event token usage (reported in output/error/completed events)
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
};

export const TokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationInputTokens: z.number().optional(),
  cacheReadInputTokens: z.number().optional(),
});

// Model pricing (USD per million tokens)
//
// ⚠️  This is a frozen fallback — a point-in-time snapshot from 2026-05-27.
//     Prefer `getModelPricing()` which checks a live-fetched cache first,
//     then falls back to this map. The live cache is populated by
//     `fetchLatestPricing()`.
//
// Sources:
//   Anthropic Claude → https://platform.claude.com/docs/en/about-claude/pricing
//   OpenAI / Codex   → https://openai.com/api/pricing/
//   OpenCode Zen     → https://opencode.ai/docs/zen/
//
export type ModelPricing = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
};

// ---------------------------------------------------------------------------
// Anthropic Claude — https://platform.claude.com/docs/en/about-claude/pricing
// ---------------------------------------------------------------------------
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Opus 4.7 / 4.6 / 4.5
  "claude-opus-4-7": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  // Opus 4.1 (deprecated Sep 2026)
  "claude-opus-4-1": {
    input: 15,
    output: 75,
    cacheWrite: 18.75,
    cacheRead: 1.5,
  },
  // Opus 4 (deprecated)
  "claude-opus-4": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  // Sonnet 4.6 / 4.5 / 4
  "claude-sonnet-4-6": {
    input: 3,
    output: 15,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  "claude-sonnet-4-5": {
    input: 3,
    output: 15,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  "claude-sonnet-4": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  // Sonnet 3.7 / 3.5
  "claude-3-7-sonnet": {
    input: 3,
    output: 15,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  "claude-3-5-sonnet": {
    input: 3,
    output: 15,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  // Haiku 4.5
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  // Haiku 3.5 (retired)
  "claude-3-5-haiku": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  // Haiku 3
  "claude-3-haiku": {
    input: 0.25,
    output: 1.25,
    cacheWrite: 0.3,
    cacheRead: 0.03,
  },
  // Opus 3
  "claude-3-opus": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },

  // -----------------------------------------------------------------------
  // OpenAI — https://openai.com/api/pricing/
  // -----------------------------------------------------------------------
  // GPT-5.5
  "gpt-5.5": { input: 5, output: 30, cacheWrite: 0, cacheRead: 0.5 },
  // GPT-5.4
  "gpt-5.4": { input: 2.5, output: 15, cacheWrite: 0, cacheRead: 0.25 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheWrite: 0, cacheRead: 0.075 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cacheWrite: 0, cacheRead: 0.02 },
  // GPT-5.3 Codex
  "gpt-5.3-codex": { input: 1.75, output: 14, cacheWrite: 0, cacheRead: 0.175 },
  // GPT-5.2
  "gpt-5.2": { input: 1.75, output: 14, cacheWrite: 0, cacheRead: 0.175 },
  "gpt-5.2-codex": { input: 1.75, output: 14, cacheWrite: 0, cacheRead: 0.175 },
  // GPT-5.1
  "gpt-5.1": { input: 1.25, output: 10, cacheWrite: 0, cacheRead: 0.125 },
  "gpt-5.1-codex": { input: 1.25, output: 10, cacheWrite: 0, cacheRead: 0.125 },
  "gpt-5.1-codex-max": {
    input: 1.25,
    output: 10,
    cacheWrite: 0,
    cacheRead: 0.125,
  },
  "gpt-5.1-codex-mini": {
    input: 0.25,
    output: 2,
    cacheWrite: 0,
    cacheRead: 0.025,
  },
  // GPT-5
  "gpt-5": { input: 1.25, output: 10, cacheWrite: 0, cacheRead: 0.125 },
  "gpt-5-codex": { input: 1.25, output: 10, cacheWrite: 0, cacheRead: 0.125 },
  "gpt-5-mini": { input: 0.25, output: 2, cacheWrite: 0, cacheRead: 0.025 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cacheWrite: 0, cacheRead: 0.005 },
  // GPT-4.1
  "gpt-4.1": { input: 2, output: 8, cacheWrite: 0, cacheRead: 0.5 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cacheWrite: 0, cacheRead: 0.1 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4, cacheWrite: 0, cacheRead: 0.025 },
  // GPT-4o
  "gpt-4o": { input: 2.5, output: 10, cacheWrite: 0, cacheRead: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cacheWrite: 0, cacheRead: 0.075 },
  // o-series reasoning models
  o1: { input: 15, output: 60, cacheWrite: 0, cacheRead: 7.5 },
  "o1-mini": { input: 1.1, output: 4.4, cacheWrite: 0, cacheRead: 0.55 },
  o3: { input: 2, output: 8, cacheWrite: 0, cacheRead: 0.5 },
  "o3-mini": { input: 1.1, output: 4.4, cacheWrite: 0, cacheRead: 0.55 },
  "o4-mini": { input: 1.1, output: 4.4, cacheWrite: 0, cacheRead: 0.275 },

  // -----------------------------------------------------------------------
  // OpenCode Zen — https://opencode.ai/docs/zen/
  // -----------------------------------------------------------------------
  "big-pickle": { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },

  // Fallback for unknown models (use Sonnet-tier pricing as default)
  default: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
};

export const DEFAULT_PRICING: ModelPricing = {
  input: 3,
  output: 15,
  cacheWrite: 3.75,
  cacheRead: 0.3,
};

const RE_DATE_SUFFIX = /-\d{8}$/;

const CANONICAL_MODEL_NAMES: Record<string, string> = {
  "claude-opus-4-7": "claude-opus-4-7",
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-opus-4-5": "claude-opus-4-5",
  "claude-opus-4-1": "claude-opus-4-1",
  "claude-opus-4": "claude-opus-4",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-sonnet-4-5": "claude-sonnet-4-5",
  "claude-sonnet-4": "claude-sonnet-4",
  "claude-haiku-4-5": "claude-haiku-4-5",
};

/** Normalize model names to canonical short forms for consistent pricing lookup. */
export function normalizeModelName(rawName: string): string {
  const stripped = rawName.replace(RE_DATE_SUFFIX, "");
  return CANONICAL_MODEL_NAMES[stripped] ?? stripped;
}

// ---------------------------------------------------------------------------
// Live pricing cache
// ---------------------------------------------------------------------------
// getModelPricing() normally reads from the frozen MODEL_PRICING map above.
// When fetchLatestPricing() succeeds, it populates this module-level cache
// and getModelPricing() prefers the live-cache entry over the static map.
// This way serverless cold-starts still have a fallback, but warm instances
// pick up fresher rates without a code deploy.
// ---------------------------------------------------------------------------

let livePricingCache: Record<string, ModelPricing> | null = null;
let livePricingCacheKey: string | null = null;
let fetchInitiated = false;

const OPENCODE_ZEN_URL = "https://opencode.ai/docs/zen/";
const LIVE_PRICING_FETCH_TIMEOUT_MS = 10_000;

/**
 * Try to load the latest pricing from known live sources.
 *
 * Currently supported sources:
 *   - opencode.ai/docs/zen/ (markdown table of per-model rates)
 *
 * On success the module-level cache is replaced so subsequent
 * `getModelPricing()` calls prefer live rates over the frozen
 * `MODEL_PRICING` fallback. On failure the static map stays in effect.
 *
 * Called automatically on the first `getModelPricing()` call.
 * Also safe to call explicitly at app startup to warm the cache.
 *
 * Once the cache has been populated (by key `"v1"`) subsequent calls
 * are no-ops for the lifetime of the module.
 */
export async function fetchLatestPricing(): Promise<void> {
  const cacheKey = "v1";
  if (livePricingCache && livePricingCacheKey === cacheKey) {
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    LIVE_PRICING_FETCH_TIMEOUT_MS
  );

  try {
    const zenText = await fetch(OPENCODE_ZEN_URL, {
      signal: controller.signal,
    }).then((r) => {
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}`);
      }
      return r.text();
    });

    const parsed = parseZenPricingTable(zenText);
    if (parsed && Object.keys(parsed).length > 0) {
      livePricingCache = { ...MODEL_PRICING, ...parsed };
      livePricingCacheKey = cacheKey;
    }
  } catch {
    fetchInitiated = false;
    // Live fetch failed — static fallback stays in effect
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Look up pricing for a model by exact or prefix match.
 *
 * Checks the live-fetched cache first (populated asynchronously by
 * `fetchLatestPricing()`), then falls back to the frozen `MODEL_PRICING`
 * map, then `DEFAULT_PRICING`. On first call triggers a fire-and-forget
 * live fetch — the current call uses the static fallback, but subsequent
 * calls pick up live rates once the fetch completes.
 */
export function getModelPricing(model: string): ModelPricing {
  if (!fetchInitiated) {
    fetchInitiated = true;
    fetchLatestPricing().catch(() => {});
  }

  const source = livePricingCache ?? MODEL_PRICING;
  if (model in source) {
    return source[model];
  }
  // Match the most-specific (longest) prefix, not merely the first one in
  // insertion order. e.g. "gpt-5-mini-2025-08-07" must resolve to "gpt-5-mini",
  // not "gpt-5" — the map defines "gpt-5" before "gpt-5-mini"/"gpt-5-nano", so a
  // first-match scan misprices dated mini/nano ids at 5×–25×.
  let bestKey: string | null = null;
  for (const key of Object.keys(source)) {
    if (key === "default" || !model.startsWith(key)) {
      continue;
    }
    if (bestKey === null || key.length > bestKey.length) {
      bestKey = key;
    }
  }
  if (bestKey !== null) {
    return source[bestKey];
  }
  return DEFAULT_PRICING;
}

/** Internal: parse the markdown pricing table from the opencode Zen docs page.
 *
 * The page has a table like:
 *   | Big Pickle | Free | Free | Free | - |
 *   | Claude Opus 4.7 | $5.00 | $25.00 | $0.50 | $6.25 |
 */
function parseZenPricingTable(
  html: string
): Record<string, ModelPricing> | null {
  const rows: Record<string, ModelPricing> = {};

  const tableRowRe =
    /\|\s*([^|]+?)\s*\|\s*\$?([\d.]+|Free)\s*\|\s*\$?([\d.]+|Free)\s*\|\s*\$?([\d.]+|Free)\s*\|\s*\$?([\d.]+|Free|-)/g;

  const matches = Array.from(html.matchAll(tableRowRe));
  for (const match of matches) {
    const name = match[1].trim();
    if (!name || name.startsWith("Model")) {
      continue;
    }

    const pricing = parseRow(match);
    if (!pricing) {
      continue;
    }

    const key = displayNameToModelKey(name);
    if (key) {
      rows[key] = pricing;
    }
  }

  return Object.keys(rows).length > 0 ? rows : null;
}

function parseRow(match: RegExpMatchArray): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} | null {
  const inputRaw = match[2].trim();
  const outputRaw = match[3].trim();
  const cachedReadRaw = match[4].trim();
  const cachedWriteRaw = match[5].trim();

  const input = parsePrice(inputRaw);
  const output = parsePrice(outputRaw);
  const cacheRead = parsePrice(cachedReadRaw);
  const cacheWrite = parsePrice(cachedWriteRaw);

  if (
    Number.isNaN(input) ||
    Number.isNaN(output) ||
    Number.isNaN(cacheRead) ||
    Number.isNaN(cacheWrite)
  ) {
    return null;
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
  };
}

function parsePrice(raw: string): number {
  if (raw === "Free" || raw === "-" || raw === "") {
    return 0;
  }
  return Number(raw);
}

/**
 * Map a display name from the Zen pricing table to a canonical model key
 * used in MODEL_PRICING. Unknown names are skipped.
 */
function displayNameToModelKey(displayName: string): string | null {
  const map: Record<string, string> = {
    "Big Pickle": "big-pickle",
    "DeepSeek V4 Flash Free": "deepseek-v4-flash-free",
    "Nemotron 3 Super Free": "nemotron-3-super-free",
    "Claude Opus 4.7": "claude-opus-4-7",
    "Claude Opus 4.6": "claude-opus-4-6",
    "Claude Opus 4.5": "claude-opus-4-5",
    "Claude Opus 4.1": "claude-opus-4-1",
    "Claude Sonnet 4.6": "claude-sonnet-4-6",
    "Claude Sonnet 4.5": "claude-sonnet-4-5",
    "Claude Sonnet 4": "claude-sonnet-4",
    "Claude Haiku 4.5": "claude-haiku-4-5",
    "GPT 5.5": "gpt-5.5",
    "GPT 5.5 Pro": "gpt-5.5-pro",
    "GPT 5.4": "gpt-5.4",
    "GPT 5.4 Pro": "gpt-5.4-pro",
    "GPT 5.4 Mini": "gpt-5.4-mini",
    "GPT 5.4 Nano": "gpt-5.4-nano",
    "GPT 5.3 Codex Spark": "gpt-5.3-codex-spark",
    "GPT 5.3 Codex": "gpt-5.3-codex",
    "GPT 5.2": "gpt-5.2",
    "GPT 5.2 Codex": "gpt-5.2-codex",
    "GPT 5.1": "gpt-5.1",
    "GPT 5.1 Codex": "gpt-5.1-codex",
    "GPT 5.1 Codex Max": "gpt-5.1-codex-max",
    "GPT 5.1 Codex Mini": "gpt-5.1-codex-mini",
    "GPT 5": "gpt-5",
    "GPT 5 Codex": "gpt-5-codex",
    "GPT 5 Mini": "gpt-5-mini",
    "GPT 5 Nano": "gpt-5-nano",
    "GPT 4o": "gpt-4o",
    "GPT 4o Mini": "gpt-4o-mini",
    "GPT 4.1": "gpt-4.1",
    "GPT 4.1 Mini": "gpt-4.1-mini",
    "GPT 4.1 Nano": "gpt-4.1-nano",
    o1: "o1",
    o3: "o3",
    "o3 Mini": "o3-mini",
    "o4 Mini": "o4-mini",
  };
  return map[displayName] ?? null;
}
