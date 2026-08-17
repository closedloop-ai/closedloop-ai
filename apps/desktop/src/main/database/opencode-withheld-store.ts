/**
 * @file opencode-withheld-store.ts
 * @description ISS-5266: persist and read the WITHHELD OpenCode subagent
 * subtrees, so a store's under-count survives the process and can be rendered as
 * "unavailable" instead of being indistinguishable from zero.
 *
 * The write is a RECONCILE, not an append. OpenCode is a batch harness — one load
 * reads the whole `opencode.db` — so a report is the COMPLETE withhold set for
 * its `sourcePath`, and a root the current load did not re-report has started
 * parsing again. Appending would leave that healed root claiming missing data
 * forever, which is the same class of lie this ticket exists to remove, just
 * pointed the other way.
 *
 * Reconcile and upsert run in ONE transaction so a reader can never observe a
 * store with its old rows deleted and its new ones not yet written — that window
 * would read as "nothing withheld", i.e. exactly the false zero being fixed.
 */

import type {
  DiagnosticsWithheldRow,
  DiagnosticsWithheldScan,
} from "../../shared/diagnostics-contract.js";
import type {
  OpencodeWithheldSubagentReport,
  OpencodeWithheldSubagentRoot,
} from "../collectors/opencode/opencode-withheld-subagents.js";
import type { DesktopPrisma } from "./prisma-client.js";

/**
 * Replace this store's withheld set with the one the current load observed.
 *
 * `observedAt` is injected rather than read from the clock here so the caller
 * (and its tests) own the instant, matching the importer's injected-clock
 * discipline.
 */
export async function recordOpencodeWithheldSubagents(
  prisma: DesktopPrisma,
  report: OpencodeWithheldSubagentReport,
  observedAt: string
): Promise<void> {
  const keptRootIds = report.roots.map((root) => root.rootRawId);
  await prisma.write((client) =>
    client.$transaction(async (tx) => {
      // Retire every root this store no longer withholds. `notIn: []` is not a
      // universally safe no-op across query engines, so the empty case (nothing
      // withheld at all) deletes the store's rows outright.
      await tx.opencodeWithheldSubagentRoot.deleteMany({
        where:
          keptRootIds.length === 0
            ? { sourcePath: report.sourcePath }
            : {
                sourcePath: report.sourcePath,
                rootRawId: { notIn: keptRootIds },
              },
      });
      for (const root of report.roots) {
        const row = toWriteRow(root, report.sourcePath, observedAt);
        await tx.opencodeWithheldSubagentRoot.upsert({
          // Composite identity. A raw opencode session id is unique only WITHIN a
          // store, so matching on `rootRawId` alone would let this store's upsert
          // move ANOTHER store's row onto this `sourcePath` whenever the two
          // happen to share an id, silently destroying the other store's claim.
          where: {
            sourcePath_rootRawId: {
              sourcePath: report.sourcePath,
              rootRawId: root.rootRawId,
            },
          },
          create: row,
          update: row,
          select: { sourcePath: true, rootRawId: true },
        });
      }
      // The SCAN VERDICT, in the same transaction as the reconcile it describes.
      //
      // Without it an empty withhold set is ambiguous three ways (nothing
      // withheld / never imported / reconcile failed) and only the first means
      // complete. Writing it here means the verdict cannot outlive a failed
      // reconcile or arrive without one: either both land or neither does.
      await tx.opencodeWithheldScan.upsert({
        where: { sourcePath: report.sourcePath },
        create: { sourcePath: report.sourcePath, observedAt },
        update: { observedAt },
        select: { sourcePath: true },
      });
    })
  );
}

/**
 * Every subtree currently withheld, newest observation first.
 *
 * An EMPTY array means "no store is currently withholding anything" — it does
 * NOT mean "no store has been imported". That third state (unknown) belongs to
 * the ingest-progress surface, which knows whether a source was ever read; this
 * store deliberately does not guess at it.
 */
export async function listOpencodeWithheldSubagents(
  prisma: DesktopPrisma
): Promise<DiagnosticsWithheldRow[]> {
  const rows = await prisma.read((reader) =>
    reader.opencodeWithheldSubagentRoot.findMany({
      orderBy: [{ observedAt: "desc" }, { rootRawId: "asc" }],
    })
  );
  return rows.map((row) => ({
    rootRawId: row.rootRawId,
    sourcePath: row.sourcePath,
    withheldCount: row.withheldCount,
    reason: row.reason,
    withheldTokens: row.withheldTokens,
    withheldCacheTokens: row.withheldCacheTokens,
    earliestChildStartedAt: row.earliestChildStartedAt,
    latestChildEndedAt: row.latestChildEndedAt,
    windowPartial: row.windowPartial,
    observedAt: row.observedAt,
  }));
}

/**
 * Every store that has completed a full scan, newest first.
 *
 * This is what turns an empty withhold set from ambiguous into a claim. With at
 * least one scan, "nothing is withheld" is something the record actually proves
 * for the stores listed. With none, the only honest answer is that nothing has
 * reported yet, which is NOT the same as complete.
 *
 * It is also what keeps a stale claim readable: each scan carries the instant
 * its store last reported, so a store that has stopped reporting is visible as
 * an old timestamp rather than silently contributing to a total presented as
 * current.
 */
export async function listOpencodeWithheldScans(
  prisma: DesktopPrisma
): Promise<DiagnosticsWithheldScan[]> {
  const rows = await prisma.read((reader) =>
    reader.opencodeWithheldScan.findMany({
      orderBy: [{ observedAt: "desc" }, { sourcePath: "asc" }],
    })
  );
  return rows.map((row) => ({
    sourcePath: row.sourcePath,
    observedAt: row.observedAt,
  }));
}

function toWriteRow(
  root: OpencodeWithheldSubagentRoot,
  sourcePath: string,
  observedAt: string
): {
  rootRawId: string;
  sourcePath: string;
  withheldCount: number;
  reason: string;
  withheldTokens: number | null;
  withheldCacheTokens: number | null;
  earliestChildStartedAt: string | null;
  latestChildEndedAt: string | null;
  windowPartial: boolean;
  observedAt: string;
} {
  return {
    rootRawId: root.rootRawId,
    sourcePath,
    withheldCount: root.withheldCount,
    reason: root.reason,
    withheldTokens: root.withheldTokens,
    withheldCacheTokens: root.withheldCacheTokens,
    earliestChildStartedAt: root.earliestChildStartedAt,
    latestChildEndedAt: root.latestChildEndedAt,
    windowPartial: root.windowPartial,
    observedAt,
  };
}
