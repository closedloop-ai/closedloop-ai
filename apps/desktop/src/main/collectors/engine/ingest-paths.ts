/**
 * @file ingest-paths.ts
 * @description Pure path helpers for durable collector ingest state — the
 * persisted per-source catchup caches and the OpenCode DB fingerprint
 * (FEA-1503; ported from the vendor `ingest-paths.js`). Unlike the vendor module
 * (which read `DASHBOARD_DB_PATH` from the now-removed sidecar env), these take
 * the state directory explicitly. The SQLite runtime must use a SQLite-specific
 * state directory so legacy sidecar/SQLite ingest caches cannot suppress a fresh
 * first-start refill into a brand-new database.
 */
import path from "node:path";

/** Absolute path to the persisted catchup cache for a named source. */
export function ingestCachePath(stateDir: string, name: string): string {
  return path.join(stateDir, `ingest-cache-${name}.json`);
}

/** Absolute path to the OpenCode DB fingerprint file (single-DB high-water-mark). */
export function ingestOpencodeFingerprintPath(stateDir: string): string {
  return path.join(stateDir, "ingest-opencode-fingerprint.txt");
}

/**
 * Absolute path to the persisted Codex rollout-linkage cache (FEA-2264). Stores
 * the per-rollout session_meta linkage keyed by source path + mtime + size so the
 * boot-time rollout-graph build re-reads only changed files instead of all of
 * them on every launch.
 */
export function ingestCodexLinkageCachePath(stateDir: string): string {
  return path.join(stateDir, "ingest-codex-linkage-cache.json");
}
