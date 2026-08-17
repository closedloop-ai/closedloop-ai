/**
 * @file store-index-policy.ts
 * @description The Closedloop INDEX POLICY for the FEA-1999 store-integrity
 * probe — the second schema-coupled input that used to be reached for from
 * inside `database-integrity/`.
 *
 * That directory is engine-level by construction (`PRAGMA quick_check`,
 * `sqlite_master`, WAL depth, DB-file process holders) and must neither name one
 * of our tables nor import an artifact of our schema. The embedded migration
 * manifest is the most schema-specific artifact the desktop app has, so a probe
 * that value-imports it is not schema-agnostic no matter what it queries: point
 * it at any other SQLite store and every Closedloop index reports missing.
 *
 * The split is parser vs manifest. `extractExpectedIndexNames` reads index DDL,
 * not our tables, so the PARSER stays in `database-integrity/`; the MANIFEST it
 * is pointed at is ours, so it lives here and the wiring injects the result via
 * `StoreIntegrityProbeOptions.expectedIndexNames` — the same seam
 * `token-parity.ts` rides through `extraChecks`. The dependency therefore runs
 * one way only: this module imports `database-integrity/`, never the reverse.
 */

import { extractExpectedIndexNames } from "./database-integrity/store-integrity-probe.js";
import { MIGRATIONS } from "./migration/migrations-manifest.js";

/**
 * The net set of index names our migration manifest declares, in the shape the
 * probe's index-presence check consumes.
 *
 * The manifest is generated at build time from the migration files, so this is
 * derived from the SSOT and can never drift from the DDL that actually shipped.
 * `migrations` is injectable so a test can pin a fixture manifest without
 * reaching into the probe.
 */
export function closedloopExpectedIndexNames(
  migrations: readonly { readonly sql: string }[] = MIGRATIONS
): readonly string[] {
  return extractExpectedIndexNames(migrations);
}
