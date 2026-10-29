/**
 * @file component-usage.ts
 * @description ISS-7261: per-invocation {@link NormalizedComponentUsage} folds.
 *
 * The per-subagent fold reads the ROOT session's `tokenSeries` rather than
 * `NormalizedSubagent.tokensByModel`, because the stamped series is the one
 * shape all three harness families share (Claude never populates the latter).
 * A folded root's records are not time-ordered, so this only ever sums.
 */
import { addStorageTokenCounts } from "./token-counts";
import type {
  CacheWriteTtl,
  NormalizedComponentUsage,
  NormalizedTokenCounts,
  NormalizedTokenRecord,
  NormalizedTokenSeriesTruncation,
} from "./types";
import { accumulateCacheWriteTtl } from "./usage-dedup";

/**
 * Sum a per-model count map into one invocation-grain usage row. `model` is
 * `null` for a mixed-model row — an admission, not a pick. An empty map yields
 * `undefined`: "no telemetry", never a measured zero.
 *
 * The cache-write TTL split rides along, because it is priced: folding it away
 * would charge one-hour writes at the five-minute rate.
 */
export function foldComponentUsage(
  tokensByModel: Readonly<Record<string, NormalizedTokenCounts>>
): NormalizedComponentUsage | undefined {
  const models = Object.keys(tokensByModel);
  if (models.length === 0) {
    return undefined;
  }
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  const ttlCarrier: { cacheWriteTtl?: CacheWriteTtl } = {};
  for (const model of models) {
    const counts = tokensByModel[model];
    inputTokens = addStorageTokenCounts(inputTokens, counts.input, "input");
    outputTokens = addStorageTokenCounts(outputTokens, counts.output, "output");
    cacheReadTokens = addStorageTokenCounts(
      cacheReadTokens,
      counts.cacheRead,
      "cacheRead"
    );
    cacheWriteTokens = addStorageTokenCounts(
      cacheWriteTokens,
      counts.cacheWrite,
      "cacheWrite"
    );
    if (counts.cacheWriteTtl) {
      accumulateCacheWriteTtl(ttlCarrier, counts.cacheWriteTtl);
    }
  }
  return {
    model: models.length === 1 ? models[0] : null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(ttlCarrier.cacheWriteTtl
      ? { cacheWriteTtl: ttlCarrier.cacheWriteTtl }
      : {}),
  };
}

/**
 * Split a session's token series apart by the subagent each round-trip belongs
 * to, then sum each subagent's records into one usage row. Composes the two
 * halves below; a caller that also needs the records themselves (the pricing
 * layer does — see `usageRecords` on the desktop's invocation cost input) calls
 * them separately so the series is grouped once.
 */
export function foldSubagentComponentUsage(
  tokenSeries: readonly NormalizedTokenRecord[] | undefined,
  truncation?: NormalizedTokenSeriesTruncation
): Map<string, NormalizedComponentUsage> {
  return foldSubagentTokenRecords(
    groupSubagentTokenRecords(tokenSeries, truncation)
  );
}

/**
 * Group a session's token series by the subagent each round-trip belongs to,
 * keeping every record whole. A record with no `subagentId` is the PARENT's
 * own; dropping it is what keeps a subagent's total its own rather than the
 * session's. Keys are raw `subagentId` values including
 * `UNATTRIBUTED_SUBAGENT_ID`, which the invocation lane never looks up (it
 * emits no delegation row for the provenance anchor). Records keep their series
 * order, which a folded root does not guarantee is time order.
 */
export function groupSubagentTokenRecords(
  tokenSeries: readonly NormalizedTokenRecord[] | undefined,
  /**
   * ISS-7534's marker that the budget cut the series short. Present means any
   * sum is an undercount, so this attributes NOTHING rather than a partial
   * total a caller would stamp `measured`.
   */
  truncation?: NormalizedTokenSeriesTruncation
): Map<string, NormalizedTokenRecord[]> {
  if (truncation) {
    return new Map();
  }
  const recordsBySubagent = new Map<string, NormalizedTokenRecord[]>();
  for (const record of tokenSeries ?? []) {
    const subagentId = record.subagentId;
    if (subagentId === undefined || subagentId.length === 0) {
      continue;
    }
    let records = recordsBySubagent.get(subagentId);
    if (records === undefined) {
      records = [];
      recordsBySubagent.set(subagentId, records);
    }
    records.push(record);
  }
  return recordsBySubagent;
}

/** Fold each grouped subagent's records into its one usage row. */
export function foldSubagentTokenRecords(
  recordsBySubagent: ReadonlyMap<string, readonly NormalizedTokenRecord[]>
): Map<string, NormalizedComponentUsage> {
  const usageBySubagent = new Map<string, NormalizedComponentUsage>();
  for (const [subagentId, records] of recordsBySubagent) {
    const usage = foldTokenRecords(records);
    if (usage) {
      usageBySubagent.set(subagentId, usage);
    }
  }
  return usageBySubagent;
}

/**
 * Sum one invocation's records per model, then fold the per-model map into one
 * usage row. `model` is an untrusted transcript string, so the accumulator is a
 * Map: a plain object indexed by it writes counters onto `Object.prototype`
 * for a `__proto__` model id.
 */
export function foldTokenRecords(
  records: readonly NormalizedTokenRecord[]
): NormalizedComponentUsage | undefined {
  const byModel = new Map<string, NormalizedTokenCounts>();
  for (const record of records) {
    let counts = byModel.get(record.model);
    if (counts === undefined) {
      counts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      byModel.set(record.model, counts);
    }
    counts.input = addStorageTokenCounts(counts.input, record.input, "input");
    counts.output = addStorageTokenCounts(
      counts.output,
      record.output,
      "output"
    );
    counts.cacheRead = addStorageTokenCounts(
      counts.cacheRead,
      record.cacheRead,
      "cacheRead"
    );
    counts.cacheWrite = addStorageTokenCounts(
      counts.cacheWrite,
      record.cacheWrite,
      "cacheWrite"
    );
    if (record.cacheWriteTtl) {
      accumulateCacheWriteTtl(counts, record.cacheWriteTtl);
    }
  }
  // `Object.fromEntries` DEFINES each key, so `__proto__` stays a real key.
  return foldComponentUsage(Object.fromEntries(byModel));
}
