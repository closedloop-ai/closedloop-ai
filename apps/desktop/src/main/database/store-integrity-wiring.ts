/**
 * @file store-integrity-wiring.ts
 * @description The SCHEMA-AWARE wiring of the FEA-1999 store-integrity probe,
 * lifted out of `dashboard/agent-dashboard-design-system-runtime.ts` (a file on
 * the shrink-only `noExcessiveLinesPerFile` grandfather list).
 *
 * The probe itself is schema-agnostic (`PRAGMA quick_check`, `sqlite_master`,
 * WAL depth), so every input that knows our schema is INJECTED here rather than
 * imported by `database-integrity/`:
 *
 *   - the expected-index policy derived from our migration manifest
 *     (`store-index-policy.ts`) — without it the probe would value-import that
 *     manifest and report every Closedloop index missing against any other
 *     SQLite store;
 *   - the sub-checks that read OUR tables: the `token_usage`↔`token_events`
 *     parity check (`token-parity.ts`), the ISS-4976 per-invocation telemetry
 *     tally (`invocation-telemetry-integrity.ts`), the ISS-5102 referential-
 *     integrity check (`foreign-key-integrity.ts`), and the ISS-5838 authority
 *     row-normalization check (`repository-default-authority-integrity.ts`).
 *
 * This module is that injection point, and it is where the next schema-aware
 * sub-check is added — so the runtime file stays a wiring index rather than
 * growing a check list. `test/store-integrity-wiring.test.ts` asserts that every
 * check listed below is actually registered, so dropping one fails the suite.
 */

import type { StoreIntegrityDiagnostics } from "../telemetry/telemetry-protocol.js";
import {
  createStoreIntegrityProbe,
  type StoreIntegrityProbe,
} from "./database-integrity/store-integrity-probe.js";
import { foreignKeyIntegrityCheck } from "./foreign-key-integrity.js";
import { invocationTelemetryCheck } from "./invocation-telemetry-integrity.js";
import { repositoryDefaultAuthorityIntegrityCheck } from "./repository-default-authority-integrity.js";
import { closedloopExpectedIndexNames } from "./store-index-policy.js";
import { tokenParityCheck } from "./token-parity.js";

/** The ingest progress the boot-import skip is evaluated against. */
export type StoreIntegrityIngestProgress = {
  preparing: boolean;
  total: number;
  processed: number;
};

type StoreIntegrityWiringOptions = {
  /** The db-host method proxy in production; a plain object in tests. */
  agentDatabase: Parameters<typeof createStoreIntegrityProbe>[0] &
    Parameters<typeof tokenParityCheck>[0] &
    Parameters<typeof invocationTelemetryCheck>[0] &
    Parameters<typeof foreignKeyIntegrityCheck>[0] &
    Parameters<typeof repositoryDefaultAuthorityIntegrityCheck>[0];
  /** Sink for each probe result — the Observability facade owns the cadence. */
  emit: (diagnostics: StoreIntegrityDiagnostics) => void;
  getIngestProgress: () => StoreIntegrityIngestProgress;
  log: (message: string) => void;
};

export function createWiredStoreIntegrityProbe(
  options: StoreIntegrityWiringOptions
): StoreIntegrityProbe {
  return createStoreIntegrityProbe(options.agentDatabase, {
    emit: options.emit,
    expectedIndexNames: closedloopExpectedIndexNames(),
    extraChecks: [
      tokenParityCheck(options.agentDatabase),
      invocationTelemetryCheck(options.agentDatabase),
      foreignKeyIntegrityCheck(options.agentDatabase),
      repositoryDefaultAuthorityIntegrityCheck(options.agentDatabase),
    ],
    isBootImportInProgress: () => {
      const progress = options.getIngestProgress();
      /* `preparing` covers the pre-scan phase where the source enumeration is
         running but the total is still 0, so quick_check does not contend with
         the first-launch backfill before its progress total is known. */
      return (
        progress.preparing ||
        (progress.total > 0 && progress.processed < progress.total)
      );
    },
    log: options.log,
  });
}
