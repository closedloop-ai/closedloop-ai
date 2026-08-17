/**
 * @file store-integrity-reads.ts
 * @description ISS-4824 — the clone-safe STORE-HEALTH reads, extracted out of the
 * `sqlite.ts` monolith (a file on the shrink-only `noExcessiveLinesPerFile`
 * grandfather list) into the module that owns the concern.
 *
 * Both exist solely to feed the FEA-1999 store-integrity probe, both are
 * deliberately CLONE-SAFE (plain rows / plain scalars, no `prisma.read` callback)
 * so the MAIN-process probe can call them across the db-host method proxy, and
 * neither is used by any other caller. They sit next to
 * `store-integrity-probe.ts`, which consumes them, while `sqlite.ts` keeps only
 * the thin delegating methods on the runtime object.
 *
 * Both reads are ENGINE-level: a `quick_check` PRAGMA, SQLite's own
 * `sqlite_master` catalog, and in-process WAL counters. The third read that used
 * to live here — `runTokenParityCheck`, which aggregates `token_usage` against
 * `token_events` — is schema-coupled and moved to `../token-parity.ts` when this
 * module became part of `database-integrity/`.
 */

import type { DesktopPrisma, WalProbeHealth } from "../prisma-client.js";
import {
  STORE_INTEGRITY_INDEX_SQL,
  storeIntegrityQuickCheckSql,
} from "./store-integrity-sql.js";

export function runStoreIntegrityCheck(
  prisma: DesktopPrisma,
  maxErrors: number
): Promise<{
  quickRows: Record<string, unknown>[];
  indexRows: { name: string }[];
}> {
  // Both reads run in ONE reader-pool dispatch so quick_check and the
  // index-presence query observe the SAME committed WAL snapshot.
  return prisma.read(async (reader) => ({
    quickRows: await reader.$queryRawUnsafe<Record<string, unknown>[]>(
      storeIntegrityQuickCheckSql(maxErrors)
    ),
    indexRows: await reader.$queryRawUnsafe<{ name: string }[]>(
      STORE_INTEGRITY_INDEX_SQL
    ),
  }));
}

export function readWalProbeHealth(
  prisma: DesktopPrisma
): Promise<WalProbeHealth> {
  // Purely in-process counters — no store read, so nothing to run on the
  // reader pool. Async only to satisfy the clone-safe proxy contract (every
  // forwarded op resolves a promise).
  return Promise.resolve(prisma.readWalProbeHealth());
}
