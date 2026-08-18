/**
 * @file diagnostics-methods.ts
 * @description ISS-5266 — the DIAGNOSTICS slice of the desktop agent-database
 * surface, lifted out of the `sqlite.ts` monolith (a file on the shrink-only
 * `noExcessiveLinesPerFile` grandfather list).
 *
 * Same shape and same reason as its `store-health-methods.ts` sibling: these
 * methods share one contract — clone-safe args and results, so the db-host
 * method proxy forwards them unchanged across IPC — and each is a thin
 * delegation to the module that owns the read or write. Grouping them means
 * `SqliteAgentDatabase` intersects this type instead of restating the group, so
 * the next diagnostics read makes `sqlite.ts` smaller rather than larger.
 */

import type { DiagnosticsData } from "../../shared/diagnostics-contract.js";
import type { OpencodeWithheldSubagentReport } from "../collectors/opencode/opencode-withheld-subagents.js";
import { getDiagnosticsData } from "./diagnostics-store.js";
import {
  listOpencodeWithheldScans,
  recordOpencodeWithheldSubagents,
} from "./opencode-withheld-store.js";
import type { DesktopPrisma } from "./prisma-client.js";

export type DiagnosticsMethods = {
  diagnostics: {
    getData(): Promise<DiagnosticsData>;
    /**
     * ISS-5266: replace one OpenCode store's WITHHELD-subagent set with what the
     * current batch load observed. Reconciles rather than appends — see
     * `opencode-withheld-store.ts`.
     */
    recordOpencodeWithheld(
      report: OpencodeWithheldSubagentReport,
      observedAt: string
    ): Promise<void>;
    /**
     * ISS-5266: the `sourcePath` of every OpenCode store that has already
     * recorded a withheld-scan verdict.
     *
     * Read ONCE at boot, before the collectors are constructed, to answer "does
     * this install still owe a reconciliation pass?" — the upgrade case, where
     * an unchanged store plus a matching fingerprint means the verdict would
     * otherwise never be produced. Returns paths rather than a predicate so the
     * result is a clone-safe array across the db-host method proxy.
     */
    listOpencodeWithheldScanPaths(): Promise<string[]>;
  };
};

export function createDiagnosticsMethods(
  prisma: DesktopPrisma
): DiagnosticsMethods {
  return {
    diagnostics: {
      getData: () => getDiagnosticsData(prisma),
      recordOpencodeWithheld: (report, observedAt) =>
        recordOpencodeWithheldSubagents(prisma, report, observedAt),
      listOpencodeWithheldScanPaths: async () => {
        const scans = await listOpencodeWithheldScans(prisma);
        return scans.map((scan) => scan.sourcePath);
      },
    },
  };
}
