import { clampStorageTokenCount } from "../cost/token-counts.js";
import { writePersistentLog } from "../logging/persistent-log.js";

type StoredUsageTokenCounts = {
  input_tokens: unknown;
  output_tokens: unknown;
  cache_read_tokens: unknown;
  cache_write_tokens: unknown;
};

/** Read one stored Branch token counter without letting corrupt data crash the view. */
export function branchUsageTokenCount(
  value: unknown,
  fieldName: string
): number {
  return branchUsageTokenCountResult(value, fieldName).value;
}

/** Map the four core counters and retain whether any value required clamping. */
export function mapBranchUsageTokenCounts(
  row: StoredUsageTokenCounts,
  fieldPrefix: string
) {
  const input = branchUsageTokenCountResult(
    row.input_tokens,
    `${fieldPrefix}.input_tokens`
  );
  const output = branchUsageTokenCountResult(
    row.output_tokens,
    `${fieldPrefix}.output_tokens`
  );
  const cacheRead = branchUsageTokenCountResult(
    row.cache_read_tokens,
    `${fieldPrefix}.cache_read_tokens`
  );
  const cacheWrite = branchUsageTokenCountResult(
    row.cache_write_tokens,
    `${fieldPrefix}.cache_write_tokens`
  );
  const tokenCountsInvalid = [input, output, cacheRead, cacheWrite].some(
    (result) => result.clamped
  );
  return {
    inputTokens: input.value,
    outputTokens: output.value,
    cacheReadTokens: cacheRead.value,
    cacheWriteTokens: cacheWrite.value,
    ...(tokenCountsInvalid ? { tokenCountsInvalid: true as const } : {}),
  };
}

/**
 * Map the two optional cache-write tier counters, preserving `null` as "this
 * tier was never reported" (distinct from a reported 0). Shared by the aggregate
 * `token_usage` and per-event `token_events` branch reads, which differ only in
 * their `fieldPrefix`.
 */
export function mapBranchUsageCacheWriteTiers(
  row: { cache_write_5m_tokens: unknown; cache_write_1h_tokens: unknown },
  fieldPrefix: string
) {
  return {
    cacheWrite5mTokens:
      row.cache_write_5m_tokens == null
        ? null
        : branchUsageTokenCount(
            row.cache_write_5m_tokens,
            `${fieldPrefix}.cache_write_5m_tokens`
          ),
    cacheWrite1hTokens:
      row.cache_write_1h_tokens == null
        ? null
        : branchUsageTokenCount(
            row.cache_write_1h_tokens,
            `${fieldPrefix}.cache_write_1h_tokens`
          ),
  };
}

function branchUsageTokenCountResult(value: unknown, fieldName: string) {
  const result = clampStorageTokenCount(value, fieldName);
  if (result.clamped) {
    writePersistentLog(
      "warn",
      "branch-reads",
      `Clamped invalid token count for ${fieldName} to 0 (raw=${String(value)}); degrading Branches display read instead of failing the view`
    );
  }
  return result;
}
