/**
 * @file opencode-withheld-reconciliation.ts
 * @description ISS-5266 (wongk review): the boot-time answer to "does this
 * install still owe an OpenCode withheld-subagent reconciliation pass?"
 *
 * An install upgrading from a release that predates the withheld record has an
 * unchanged `opencode.db` and a persisted fingerprint that already matches, so
 * the collector never re-reads it and no verdict is ever produced. The new table
 * would stay empty forever — and an empty table reads as the "nothing is
 * withheld" claim the record exists to stop the product making. A store with no
 * recorded scan therefore re-reads exactly once, on the first launch after
 * upgrade, and converges as soon as that scan commits.
 *
 * Extracted from `agent-dashboard-design-system-runtime.ts` rather than inlined
 * there: that runtime is on the shrink-only `noExcessiveLinesPerFile`
 * grandfather list, so a new cohesive unit belongs in its own module.
 */

/** The collector-manager option slice this reconciliation contributes. */
export type OpencodeWithheldReconciliationOptions = {
  hasRecordedOpencodeWithheldScan?: (dbPath: string) => boolean;
};

export type OpencodeWithheldReconciliationInput = {
  /** Reads the `sourcePath` of every store that already recorded a verdict. */
  listRecordedScanPaths: () => Promise<string[]>;
  log: (message: string) => void;
};

/**
 * Resolve the upgrade guard once, before the collectors are built.
 *
 * Synchronous at the collector (`listSources` cannot await), so the answer is
 * read here and closed over. A FAILED read yields an empty option slice, which
 * the collector reads as "already scanned": degrading the other way would make a
 * transient DB error cost a full store re-read on every boot, forever.
 */
export async function resolveOpencodeWithheldReconciliation(
  input: OpencodeWithheldReconciliationInput
): Promise<OpencodeWithheldReconciliationOptions> {
  try {
    const recordedScanPaths = await input.listRecordedScanPaths();
    return {
      hasRecordedOpencodeWithheldScan: (dbPath: string) =>
        recordedScanPaths.includes(dbPath),
    };
  } catch (error) {
    input.log(
      `opencode withheld-scan lookup failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return {};
  }
}
