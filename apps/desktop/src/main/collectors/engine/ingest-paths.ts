/**
 * @file ingest-paths.ts
 * @description Pure path helper for the one piece of durable collector ingest
 * state that still lives in a FILE — the OpenCode DB fingerprint (FEA-1503;
 * ported from the vendor `ingest-paths.js`). Unlike the vendor module (which
 * read `DASHBOARD_DB_PATH` from the now-removed sidecar env), it takes the
 * state directory explicitly. The SQLite runtime must use a SQLite-specific
 * state directory so legacy sidecar/SQLite ingest caches cannot suppress a fresh
 * first-start refill into a brand-new database.
 *
 * ISS-9838 moved the catchup cache, the parse quarantine and the Codex linkage
 * cache off the filesystem into the local SQLite store, and ISS-9839 moved the
 * batch-resume cursor after them, so their helpers are gone from here — this
 * module is NOT the scope list for the ingest stores.
 */
import path from "node:path";

/** Absolute path to the OpenCode DB fingerprint file (single-DB high-water-mark). */
export function ingestOpencodeFingerprintPath(stateDir: string): string {
  return path.join(stateDir, "ingest-opencode-fingerprint.txt");
}
