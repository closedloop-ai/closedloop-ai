/**
 * @file opencode-tokens-by-model.ts
 * @description The OpenCode per-model session token fold, split out of
 * `opencode-parser.ts` (ISS-8565). That file sits 983 logical lines under a hard
 * 1,000-line ceiling, and root `AGENTS.md` requires factoring a cohesive piece
 * out rather than piling onto a file already near the ceiling.
 */
import { OpencodeDefaultModel } from "@repo/lib/harness/synthetic-model-keys";
import {
  addStorageTokenCounts,
  readStorageTokenCount,
} from "../../cost/token-counts.js";
import type { NormalizedTokenCounts, NormalizedTokenRecord } from "../types.js";

/**
 * FEA-4183: fall back to the accumulated per-message/step token series when the
 * session-row aggregate carried no usage. `importPhaseTokenUsage` writes the
 * `token_usage` rows (and thus the authoritative `sessions.cost_usd_estimated`
 * rollup, which `updateSessionCostRollup` derives EXCLUSIVELY from
 * `token_usage`) from `tokensByModel` — NOT from `tokenSeries`. So a session
 * whose only usage lives in message/step rows (zero session token columns)
 * would still record a null cost even though the series captured the tokens.
 * Summing the series under the single synthetic `opencode-default` key (matching
 * the series' own fallback attribution) gives that session a priceable
 * `token_usage` row so a non-zero cost derives. Marked `inferred` because the
 * key is a synthetic fallback, not a model id read from the store.
 */
function tokensByModelFromSeries(
  tokenSeries: readonly NormalizedTokenRecord[]
): Record<string, NormalizedTokenCounts> {
  const tokensByModel: Record<string, NormalizedTokenCounts> = {};
  if (tokenSeries.length === 0) {
    return tokensByModel;
  }
  const total: NormalizedTokenCounts = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    inferred: true,
  };
  for (const record of tokenSeries) {
    total.input += record.input;
    total.output += record.output;
    total.cacheRead += record.cacheRead;
    total.cacheWrite += record.cacheWrite;
  }
  if (total.input || total.output || total.cacheRead || total.cacheWrite) {
    tokensByModel[OpencodeDefaultModel] = total;
  }
  return tokensByModel;
}

/**
 * Build the per-model session-level token totals (5 token-column reads), falling
 * back to the accumulated token series when the session-row aggregate is empty
 * (see {@link tokensByModelFromSeries}).
 */
export function buildTokensByModel(
  sessionRow: Record<string, unknown>,
  sessionModel: string | null,
  tokenSeries: readonly NormalizedTokenRecord[]
): Record<string, NormalizedTokenCounts> {
  // ISS-8565: fold into a null-prototype object so a model literally named
  // `__proto__` becomes an own property instead of hitting the inherited
  // `__proto__` setter, which creates no own key and silently drops that
  // model's whole spend. Same shape as `parse-codex.ts` (ISS-7959).
  const tokensByModel: Record<string, NormalizedTokenCounts> =
    Object.create(null);
  const tokenInput = readStorageTokenCount(
    sessionRow.tokens_input,
    "opencode.session.input"
  );
  const tokenOutput = readStorageTokenCount(
    sessionRow.tokens_output,
    "opencode.session.output"
  );
  const tokenReasoning = readStorageTokenCount(
    sessionRow.tokens_reasoning,
    "opencode.session.reasoning"
  );
  const tokenCacheRead = readStorageTokenCount(
    sessionRow.tokens_cache_read,
    "opencode.session.cache_read"
  );
  const tokenCacheWrite = readStorageTokenCount(
    sessionRow.tokens_cache_write,
    "opencode.session.cache_write"
  );
  if (
    tokenInput ||
    tokenOutput ||
    tokenReasoning ||
    tokenCacheRead ||
    tokenCacheWrite
  ) {
    const agent =
      typeof sessionRow.agent === "string" ? sessionRow.agent : null;
    const key = sessionModel || agent || OpencodeDefaultModel;
    tokensByModel[key] = {
      input: tokenInput,
      output: addStorageTokenCounts(
        tokenOutput,
        tokenReasoning,
        "opencode.session.output_with_reasoning"
      ),
      cacheRead: tokenCacheRead,
      cacheWrite: tokenCacheWrite,
    };
    // Spread restores a normal prototype for downstream consumers (object
    // spread defines rather than assigns, so an own `__proto__` key survives).
    return { ...tokensByModel };
  }
  // The fallback keys off `OpencodeDefaultModel`, a module constant, so its
  // plain-literal container is not reachable by a transcript-controlled name.
  return tokensByModelFromSeries(tokenSeries);
}
