/**
 * @file agent-dashboard-runtime-paths.ts
 * @description The two userData-rooted locations the Agent Dashboard runtime
 * owns: the SQLite database file and the collector/materializer ingest state
 * dir. Extracted out of the shrink-only grandfathered
 * `agent-dashboard-design-system-runtime.ts` so the db-host lifecycle module and
 * the IPC registration modules can each resolve them without importing the
 * runtime (which would be a cycle).
 */

import path from "node:path";
import { app } from "electron";

/**
 * Resolve the opt-in design-system dashboard database. This helper lives inside
 * the dynamic boundary so default/legacy boot never imports code that can create
 * the SQLite data directory.
 */
export function resolveAgentDashboardDatabasePath(
  userDataPath = app.getPath("userData")
): string {
  // SQLite (libSQL) is a single file, not the PGlite `.pgdata` directory. The
  // new filename also means existing PGlite installs start fresh on a clean
  // SQLite DB and re-derive everything from the on-disk raw logs.
  return path.join(userDataPath, "agent-dashboard.sqlite");
}

/**
 * The collector/materializer ingest state dir — the `agent-dashboard-ingest`
 * directory the `CollectorManager` and the OpenCode materializer both write
 * under. Single source of truth so the local-transcript read fallback binds the
 * SAME materialized-OpenCode root the sweep writes (FEA-3932).
 */
export function resolveIngestStateDir(
  userDataPath = app.getPath("userData")
): string {
  return path.join(userDataPath, "agent-dashboard-ingest");
}
