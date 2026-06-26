/**
 * @file baseline-schema.ts
 * @description SQLite migration baselining — inert on SQLite; the genesis
 * migration is idempotent, so it self-heals any untracked pre-existing store.
 *
 * A fresh SQLite install starts from an empty file and migrates cleanly via the
 * single `0001_init` migration. An untracked pre-existing store can also occur:
 * a SQLite file whose schema was created by an interim/pre-runner build that
 * never recorded migration history — and which may be only PARTIALLY populated
 * (e.g. `sessions` present but `model_pricing` missing). Recording such a store
 * as already-at-`0001_init` would be wrong (the missing tables never get
 * created, and the boot fails later with `no such table: …`).
 *
 * Instead, `0001_init` is written idempotently (`CREATE TABLE/INDEX IF NOT
 * EXISTS`), so the runner can simply (re-)apply it against any untracked store:
 * existing objects are skipped, missing ones are created, and the migration is
 * recorded. `BASELINE_MIGRATIONS` is therefore EMPTY — nothing is recorded as
 * applied-without-executing; the idempotent migration runs and reconciles the
 * schema. The SQLite-era frozen-snapshot baselining is gone with the engine.
 *
 * If a future migration must re-assert idempotent DDL during baselining,
 * populate `LEGACY_SCHEMA_REASSERT_SEQUENCE` and `BASELINE_MIGRATIONS` here.
 */

/**
 * Frozen legacy schema snapshot. Empty under SQLite: there is no pre-runner
 * SQLite snapshot to re-assert.
 */
export const SQLITE_SCHEMA = "";

/**
 * The ordered, idempotent statement sequence the runner re-asserts when
 * baselining. Empty under SQLite: the idempotent `0001_init` migration is the
 * reconciliation mechanism, so there is nothing extra to re-assert here.
 */
export const LEGACY_SCHEMA_REASSERT_SEQUENCE: readonly string[] = [];

/**
 * Migration names recorded as applied WITHOUT executing during baselining.
 * Empty under SQLite: recording-without-executing would leave a partial
 * untracked store half-created. The idempotent `0001_init` migration is applied
 * normally instead, which safely reconciles complete and partial stores alike.
 */
export const BASELINE_MIGRATIONS: readonly string[] = [];

/**
 * FEA-2038: migrations 0002–0005 were folded into the `0001_init` genesis (commit
 * dba5ad9f6) AFTER they had already been applied to developer SQLite databases.
 * The PGlite→SQLite cutover never shipped, so only dev machines ran them as
 * separate steps; a fresh install now runs a single migration. But a dev DB that
 * recorded `0001_init` + all four is schema-identical to a fresh `0001_init` (the
 * fold preserved their SQL verbatim under `IF NOT EXISTS` / `ADD COLUMN`) while
 * the genesis checksum changed — which the runner would otherwise reject as
 * `ChecksumDrift`, bricking the DB. Declaring the fold here lets the runner
 * self-heal such a DB on next launch: it rewrites the stale tracking rows to the
 * collapsed genesis without executing any DDL. Safe to remove once no pre-collapse
 * dev database remains in circulation.
 */
export const COLLAPSED_MIGRATIONS = [
  {
    genesisName: "0001_init",
    supersededNames: [
      "0002_insights_covering_index",
      "0003_dashboard_analytics_indexes",
      "0004_session_analytics",
      "0005_commit_lifecycle_metadata",
    ],
  },
] as const;
