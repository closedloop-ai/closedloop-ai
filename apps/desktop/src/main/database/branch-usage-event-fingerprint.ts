/**
 * Stable SQL fingerprint for a Desktop token event's numeric identity.
 *
 * The Branch usage projection reads numeric rows separately from bounded
 * provenance. SQLite rowids can be reused by the replace-all write path, so
 * both reads compare this value before joining evidence back to numeric data.
 * `quote` preserves NULL and exact persisted text for legacy rows without a
 * transport id.
 */
export function branchUsageEventFingerprintSql(alias: string): string {
  return [
    "transport_id",
    "session_id",
    "model",
    "created_at",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "cache_write_5m_tokens",
    "cache_write_1h_tokens",
    "cost_usd_estimated",
  ]
    .map((column) => `quote(${alias}.${column})`)
    .join(" || '|' || ");
}
