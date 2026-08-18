/**
 * @file store-health-methods.ts
 * @description ISS-4824 / ISS-4976 — the STORE-HEALTH slice of the desktop
 * agent-database surface, lifted out of the `sqlite.ts` monolith (a file on the
 * shrink-only `noExcessiveLinesPerFile` grandfather list).
 *
 * Every method here exists solely to feed the FEA-1999 store-integrity probe,
 * which runs in the MAIN process and therefore cannot pass a `prisma.read`
 * callback across the db-host method proxy (a function can't be structured-
 * cloned over IPC). Each is CLONE-SAFE by construction — plain rows, plain
 * scalars, bounded counts — and each is a thin delegation to the module that
 * owns the read, so the proxy keeps forwarding them unchanged.
 *
 * They are grouped because they share exactly that contract, and because
 * `SqliteAgentDatabase` intersects this type rather than restating the group:
 * one place to add the next store-health read, and `sqlite.ts` gets smaller
 * instead of larger each time one is added.
 */

import { DATA_REVISION_IMPORT_PENDING } from "../collectors/engine/data-revision.js";
import {
  readWalProbeHealth as readWalProbeHealthRead,
  runStoreIntegrityCheck as runStoreIntegrityCheckRead,
} from "./database-integrity/store-integrity-reads.js";
import {
  type ForeignKeyIntegrityResult,
  runForeignKeyIntegrityCheck as runForeignKeyIntegrityCheckRead,
} from "./foreign-key-integrity.js";
import {
  type InvocationTelemetryIntegrityCounts,
  runInvocationTelemetryIntegrityCheck as runInvocationTelemetryIntegrityCheckRead,
} from "./invocation-telemetry-integrity.js";
import type { DesktopPrisma, WalProbeHealth } from "./prisma-client.js";
import {
  type RepositoryDefaultAuthorityIntegrityResult,
  runRepositoryDefaultAuthorityIntegrityCheck as runRepositoryDefaultAuthorityIntegrityCheckRead,
} from "./repository-default-authority-integrity.js";
import {
  runTokenParityCheck as runTokenParityCheckRead,
  type TokenParityResult,
} from "./token-parity.js";

export type StoreHealthMethods = {
  /**
   * FEA-1999 store-integrity read: run `PRAGMA quick_check` plus the
   * index-presence query on the reader pool and return their rows. Engine-level
   * only — see `database-integrity/store-integrity-probe.ts`.
   */
  runStoreIntegrityCheck(maxErrors: number): Promise<{
    quickRows: Record<string, unknown>[];
    indexRows: { name: string }[];
  }>;
  /** FEA-2345 store-health read: `token_usage` vs `token_events` totals. */
  runTokenParityCheck(): Promise<TokenParityResult>;
  /**
   * ISS-4976 store-health read: count the stored invocation rows whose
   * per-invocation telemetry is impossible rather than absent (three plain
   * counts, never a row value). See invocation-telemetry-integrity.ts.
   */
  runInvocationTelemetryIntegrityCheck(): Promise<InvocationTelemetryIntegrityCounts>;
  /**
   * ISS-5102 store-health read: bounded `PRAGMA foreign_key_check` counts plus
   * the ISS-5098 FK-less orphan `events.agent_id` count (SQL aggregates only,
   * never a violating row). See foreign-key-integrity.ts.
   */
  runForeignKeyIntegrityCheck(): Promise<ForeignKeyIntegrityResult>;
  /** ISS-5838: count malformed persisted authority rows in bounded pages. */
  runRepositoryDefaultAuthorityIntegrityCheck(): Promise<RepositoryDefaultAuthorityIntegrityResult>;
  /**
   * ISS-4818 store-health read: the WAL-depth probe's anomaly tally for this
   * client lifetime. The counters themselves live in the child, next to the
   * boundary that produced them. See prisma-client.ts `walSizeVerdict`.
   */
  readWalProbeHealth(): Promise<WalProbeHealth>;
  /**
   * ISS-5103 store-health read: ids of sessions currently at the
   * `DATA_REVISION_IMPORT_PENDING` sentinel, capped at `limit`.
   *
   * Ids, not a count, and deliberately not filtered by `updated_at`: the
   * revision-only heal path in write-core stamps the sentinel WITHOUT bumping
   * `updated_at` (it is the sync watermark), so a timestamp filter also matches
   * a session being imported right now. The caller instead compares consecutive
   * snapshots and counts only the ids present in both, which is what "stuck"
   * actually means.
   */
  listImportPendingSessionIds(limit: number): Promise<string[]>;
};

export function createStoreHealthMethods(
  prisma: DesktopPrisma
): StoreHealthMethods {
  return {
    runStoreIntegrityCheck(maxErrors: number): Promise<{
      quickRows: Record<string, unknown>[];
      indexRows: { name: string }[];
    }> {
      return runStoreIntegrityCheckRead(prisma, maxErrors);
    },
    runTokenParityCheck(): Promise<TokenParityResult> {
      return runTokenParityCheckRead(prisma);
    },
    runInvocationTelemetryIntegrityCheck(): Promise<InvocationTelemetryIntegrityCounts> {
      return runInvocationTelemetryIntegrityCheckRead(prisma);
    },
    runForeignKeyIntegrityCheck(): Promise<ForeignKeyIntegrityResult> {
      return runForeignKeyIntegrityCheckRead(prisma);
    },
    runRepositoryDefaultAuthorityIntegrityCheck(): Promise<RepositoryDefaultAuthorityIntegrityResult> {
      return runRepositoryDefaultAuthorityIntegrityCheckRead(prisma);
    },
    readWalProbeHealth(): Promise<WalProbeHealth> {
      return readWalProbeHealthRead(prisma);
    },
    async listImportPendingSessionIds(limit: number): Promise<string[]> {
      // Ordered by id so a capped snapshot is stable between ticks: an unordered
      // cap could return disjoint subsets of the same backlog and report zero
      // survivors while the backlog sits there.
      const rows = await prisma.read((reader) =>
        reader.session.findMany({
          where: { dataRevision: DATA_REVISION_IMPORT_PENDING },
          select: { id: true },
          orderBy: { id: "asc" },
          take: Math.max(1, limit),
        })
      );
      return rows.map((row) => row.id);
    },
  };
}
