/**
 * @file cost-source-provenance-heal.ts
 * @description ISS-7762: re-stamp rows that a pre-fix build wrote as
 * `genai_prices_v1` when the price actually came from the unknown-model fallback
 * tier.
 *
 * Before the fix, `estimateTokenCost` dropped `unknownModelFallbackApplied` and
 * every priced row was stamped `genai_prices_v1`. Correcting only the writers
 * would leave that value meaning two different things — "the library confirmed
 * this rate" for new rows, "provenance unknown" for old ones — which is worse
 * than the uniform wrongness it replaces, because a reader cannot tell them
 * apart. So the existing population is corrected here.
 *
 * ── Two independent passes, both convergent ─────────────────────────────────
 * They are deliberately NOT one pass sharing state. An earlier draft collected
 * the affected session ids WHILE re-stamping rows and re-rolled them at the end;
 * that made the session-level fix reachable only on the boot that happened to
 * find a stale row, so an interruption between the two left `sessions.cost_source`
 * permanently disagreeing with its own rows — the next boot no longer matched
 * the row predicate and never retried.
 *
 *  1. `restampFallbackPricedRows` — per-model row correction. Keyed on the
 *     MODEL: whether the fallback applied is rate-table membership, a property
 *     of the model id and not of the row, so each distinct stamped model is
 *     classified once (tens per store) instead of pricing ~110k rows.
 *  2. `rerollDisagreeingSessions` — re-rolls every session whose stored
 *     `cost_source` disagrees with the live fold over its own `token_usage`
 *     rows. Derived purely from CURRENT state, so it repairs whatever pass 1
 *     left half-done on any previous boot, including one that crashed.
 *
 * Both converge to zero work: after a clean run no model is stamped-and-
 * fallback-priced and no session disagrees with its rows, so the next boot
 * classifies the same few model ids, matches nothing, and writes nothing.
 *
 * Discovery reads `token_usage` (bounded by sessions × models — thousands of
 * rows) and never scans `token_events` (hundreds of thousands, with no index on
 * `cost_source`); `token_events` is still CORRECTED, for every model
 * `token_usage` names. `token_usage` is the right discovery surface because it
 * is the only one the session rollup folds, so it is where a wrong stamp is
 * actually read.
 *
 * ── What the heal may and may not infer from today's price table ─────────────
 * The pass classifies a stored row against the CURRENTLY pinned genai-prices
 * table, which is not the table the writer used. That asymmetry bounds what it
 * is allowed to conclude, and the bound is enforced by direction of travel:
 *
 *  - It only ever moves a stamp toward the WEAKER claim (`genai_prices_v1` →
 *    `fallback_tier_v1`, "the library confirmed this rate" → "priced, but
 *    unverified"). A restamp that a writer-era table would have disagreed with
 *    UNDERSTATES confidence in a rate; it can never manufacture a claim that the
 *    library verified something it did not. That is the honest failure mode, and
 *    it is the only one this pass can produce.
 *  - It never re-derives in the other direction. A `genai_prices_v1` row on a
 *    model today's table prices is left exactly as found, because the current
 *    table cannot witness whether the writer's table carried that id. Promoting
 *    or clearing it would be a confident statement about a write this process
 *    never observed.
 *
 * That leaves one population the heal genuinely cannot repair: rows a pre-fix
 * build stamped `genai_prices_v1` while falling back, on a model the table has
 * LEARNED since. There is no per-row record of writer-era table membership, so
 * those are indistinguishable from correctly-stamped rows and are not guessed
 * at. Where the store itself carries proof that membership moved — a model
 * holding `fallback_tier_v1` rows that the table now prices, which only a table
 * that gained the id can produce — `reportPriceTableMembershipDrift` says so on
 * the boot log instead of silently converging over it.
 *
 * The pass touches `cost_source` ONLY. It can never move a dollar figure.
 */
import { estimateTokenCost } from "../../shared/token-cost.js";
import {
  MODEL_PRICING_SOURCE_WEAKEST_FIRST,
  ModelPricingSource,
} from "../model-pricing/model-pricing-fixture.js";
import { EVENT_INSERT_PARAM_CAP } from "./db-constants.js";
import type { DesktopPrisma } from "./prisma-client.js";
import {
  costSourcePrecedenceSql,
  updateSessionCostRollupBatch,
} from "./token-cost-writes.js";

/**
 * Token counts used only to ask "can the library price this model id?". The
 * answer is rate-table membership, independent of the counts, so these are
 * arbitrary non-zero values — the pass never writes a cost derived from them.
 */
const PROBE_COUNTS = {
  inputTokens: 1000,
  outputTokens: 1000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
} as const;

/** Sessions are re-rolled in bounded batches so one UPDATE never binds an
 *  unbounded parameter list. */
const SESSION_ROLLUP_CHUNK = 200;

/**
 * Models bound per restamp UPDATE. The statement binds two fixed `cost_source`
 * parameters ahead of the id list, so the chunk reserves those two out of the
 * shared `EVENT_INSERT_PARAM_CAP` bind budget — the same conservative cap the
 * import path chunks against, which stays under `SQLITE_MAX_VARIABLE_NUMBER` on
 * builds that pin it to 999.
 */
const RESTAMP_MODEL_CHUNK = EVENT_INSERT_PARAM_CAP - 2;

export async function healFallbackCostSourceStamps(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = SESSION_ROLLUP_CHUNK
): Promise<void> {
  const { fallbackModels, membershipDriftModels } =
    await classifyStampedModels(prisma);
  reportPriceTableMembershipDrift(membershipDriftModels, log);
  const restamped = await restampFallbackPricedRows(prisma, fallbackModels);
  const rerolled = await rerollDisagreeingSessions(prisma, log, chunkSize);
  if (restamped === 0 && rerolled === 0) {
    return;
  }
  log(
    `cost-source-provenance-heal: re-stamped ${restamped} fallback-priced model(s), re-rolled ${rerolled} session(s)`
  );
}

type StampedModelRow = {
  model: string;
  library_rows: unknown;
  fallback_rows: unknown;
};

/**
 * Partition the stamped model ids `token_usage` names into the two sets this
 * pass treats differently:
 *
 *  - `fallbackModels` — carries `genai_prices_v1` rows AND the current engine
 *    prices it only from the unknown-model fallback tier. Restamped, because
 *    that moves the claim to the weaker of the two and cannot overstate.
 *  - `membershipDriftModels` — carries `fallback_tier_v1` rows AND the current
 *    table prices it. Only a table that GAINED the id can produce that pair, so
 *    it is positive evidence that writer-era membership differed from today's.
 *    Reported, never restamped: which of its `genai_prices_v1` rows predate the
 *    gain is not recorded anywhere, and picking either answer would assert a
 *    provenance nothing observed.
 */
async function classifyStampedModels(prisma: DesktopPrisma): Promise<{
  fallbackModels: string[];
  membershipDriftModels: string[];
}> {
  const stamped = await prisma.read((reader) =>
    reader.$queryRawUnsafe<StampedModelRow[]>(
      `SELECT model,
              MAX(CASE WHEN cost_source = $1 THEN 1 ELSE 0 END) AS library_rows,
              MAX(CASE WHEN cost_source = $2 THEN 1 ELSE 0 END) AS fallback_rows
         FROM token_usage
        WHERE cost_source IN ($1, $2)
        GROUP BY model`,
      ModelPricingSource.GenaiPricesV1,
      ModelPricingSource.FallbackTierV1
    )
  );
  const fallbackModels: string[] = [];
  const membershipDriftModels: string[] = [];
  for (const row of stamped) {
    if (row.model.length === 0) {
      continue;
    }
    const fallbackPriced = isFallbackPriced(row.model);
    if (fallbackPriced && Number(row.library_rows) === 1) {
      fallbackModels.push(row.model);
    }
    if (!fallbackPriced && Number(row.fallback_rows) === 1) {
      membershipDriftModels.push(row.model);
    }
  }
  return { fallbackModels, membershipDriftModels };
}

/**
 * Surface the models whose price-table membership provably moved under the
 * store. The heal cannot repair their pre-fix rows and must not pretend
 * otherwise, so the unreconcilable state goes to the boot log the rest of the
 * maintenance chain reports through rather than being coerced away.
 */
function reportPriceTableMembershipDrift(
  models: string[],
  log: (message: string) => void
): void {
  if (models.length === 0) {
    return;
  }
  log(
    `cost-source-provenance-heal: price-table membership moved for ${models.length} model(s) (${models.join(", ")}); their genai_prices_v1 rows are left as written — writer-era provenance is not recorded and is not inferable from the current table`
  );
}

/**
 * Correct `token_usage` + `token_events` rows stamped as library-priced whose
 * model the library cannot actually price. Returns how many models were
 * corrected. Both tables move in ONE transaction per chunk so the two stores can
 * never be left disagreeing about the same estimate.
 *
 * The model set is bound into ONE `IN (…)` update per table rather than one
 * update per model: `token_events` is indexed on session/timestamp/transport
 * identity and not on `model` or `cost_source`, so every statement here scans
 * the whole event corpus. Chunking exists only for the bind-parameter cap.
 */
async function restampFallbackPricedRows(
  prisma: DesktopPrisma,
  fallbackModels: string[]
): Promise<number> {
  for (
    let start = 0;
    start < fallbackModels.length;
    start += RESTAMP_MODEL_CHUNK
  ) {
    const chunk = fallbackModels.slice(start, start + RESTAMP_MODEL_CHUNK);
    const placeholders = chunk.map((_, index) => `$${index + 3}`).join(", ");
    await prisma.write((writer) =>
      writer.$transaction(async (tx) => {
        for (const table of ["token_usage", "token_events"]) {
          await tx.$executeRawUnsafe(
            `UPDATE ${table} SET cost_source = $1
              WHERE cost_source = $2 AND model IN (${placeholders})`,
            ModelPricingSource.FallbackTierV1,
            ModelPricingSource.GenaiPricesV1,
            ...chunk
          );
        }
      })
    );
  }
  return fallbackModels.length;
}

/**
 * Re-roll every session whose stored `cost_source` disagrees with the live
 * weakest-first fold over its own `token_usage` rows. Returns how many sessions
 * were re-rolled.
 *
 * Restricted to sessions that HAVE a folded source (`tok.cost_source IS NOT
 * NULL`): a session priced only by the session-level web-search line item
 * legitimately carries a stamp its token rows cannot account for, and including
 * it would make this pass re-roll the same rows on every boot forever.
 */
async function rerollDisagreeingSessions(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number
): Promise<number> {
  const disagreeing = await prisma.read((reader) =>
    reader.$queryRawUnsafe<{ id: string }[]>(
      `SELECT src.id AS id
         FROM sessions src
         JOIN (
           SELECT session_id, ${costSourcePrecedenceSql(1)} AS cost_source
             FROM token_usage
            GROUP BY session_id
         ) tok ON tok.session_id = src.id
        WHERE tok.cost_source IS NOT NULL
          AND COALESCE(src.cost_source, '') != tok.cost_source`,
      ...MODEL_PRICING_SOURCE_WEAKEST_FIRST
    )
  );
  const ids = disagreeing.map((row) => row.id);
  const safeChunkSize = Math.max(1, Math.floor(chunkSize));
  let rerolled = 0;
  for (let start = 0; start < ids.length; start += safeChunkSize) {
    const chunk = ids.slice(start, start + safeChunkSize);
    // Per-chunk isolation, matching the sibling boot heals: a transient failure
    // logs and the remaining chunks still run. Anything missed is re-selected
    // next boot, because the predicate is derived from current state.
    try {
      await prisma.write((writer) =>
        writer.$transaction((tx) => updateSessionCostRollupBatch(tx, chunk))
      );
      rerolled += chunk.length;
    } catch (error) {
      log(
        `cost-source-provenance-heal: session re-roll failed for chunk [${start}, ${start + chunk.length}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return rerolled;
}

/**
 * True when the current engine prices this model id from the unknown-model
 * fallback tier rather than a library rate. A model the engine cannot price at
 * all yields `undefined` and is NOT treated as fallback — such a row should
 * never have carried a source stamp, and re-stamping it would assert a
 * provenance for a cost that does not exist.
 *
 * Deliberately passes no `observedAt`, and that is safe: genai-prices decides
 * whether it HAS an entry by model id, not by date. Measured across
 * 2020-01-01 / 2024-06-01 / 2026-08-22 and unstamped, `claude-opus-4-8`,
 * `claude-haiku-4-5-20251001`, `gpt-5.5` and `claude-sonnet-4-6` all classify
 * library-priced at every point — the timestamp selects a RATE within a matched
 * entry, it cannot turn a match into a `no_match`. So a row priced long ago
 * classifies the same way today. (Checked because the reverse would silently
 * leave an old fallback-priced row stamped as library-priced, defeating the
 * whole pass.)
 */
function isFallbackPriced(model: string): boolean {
  const estimate = estimateTokenCost({ model, ...PROBE_COUNTS });
  return estimate?.unknownModelFallbackApplied === true;
}
