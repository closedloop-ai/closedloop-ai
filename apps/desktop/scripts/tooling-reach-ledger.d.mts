export declare const TOOLING_PARTITION: "tooling";

export type ToolingReachLedgerEntry = {
  /** Desktop-relative path, e.g. "scripts/dev-launch.mjs". */
  path: string;
  /** Why the node lane cannot execute this file. Never a percentage. */
  reason: string;
};

export declare const TOOLING_REACH_LEDGER: readonly ToolingReachLedgerEntry[];

export type StaleLedgerEntry = {
  path: string;
  kind: "missingFromSource" | "actuallyExecuted";
};

export type ToolingReachDiff = {
  /** Unreached files nobody declared — the silent gap. Should always be empty. */
  unledgeredUnreached: string[];
  /** Entries whose justification has rotted. */
  staleLedgered: StaleLedgerEntry[];
  /** Unreached files that ARE declared — the legitimate exclusions. */
  ledgeredUnreached: string[];
  reconciled: boolean;
  counts: {
    sourceFiles: number;
    executedFiles: number;
    ledgered: number;
    unreached: number;
  };
};

export declare function diffToolingReach(
  ledger: readonly ToolingReachLedgerEntry[],
  sourceFiles: readonly string[],
  executedFiles: readonly string[]
): ToolingReachDiff;

export declare function formatToolingReachGap(diff: ToolingReachDiff): string[];
