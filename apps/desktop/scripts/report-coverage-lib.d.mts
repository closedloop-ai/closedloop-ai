// Hand-maintained declarations for report-coverage-lib.mjs (ISS-4594) so the
// desktop node:test suite and the coverage lane consume it typed. The
// comparison half is declared in report-coverage-compare.d.mts.
export declare const DenominatorKind: {
  Execution: "execution";
  Source: "source";
};
export type DenominatorKind =
  (typeof DenominatorKind)[keyof typeof DenominatorKind];

/** The source/test split. Lives here, not in the CLI — see the .mjs comment. */
export declare const TEST_FILE_PATTERN: RegExp;

export type PartitionRule = {
  name: string;
  prefix: string;
  denominator: DenominatorKind;
};
export declare const PARTITION_RULES: PartitionRule[];

export declare const PCT_DECIMALS: number;

export type PartitionStats = {
  branchesCovered: number;
  branchesTotal: number;
  branchPct: number;
  executedFiles: number;
  sourceFiles: number;
  /** Assigned by report-coverage.mjs, which owns filesystem access. */
  sourceHash?: string;
};

export type CoverageRecord = {
  kind: string;
  slots: Map<string, number>;
  summaryTotal: number;
  summaryCovered: number;
  labels: Set<string>;
};

export declare const STATIC_VALIDITY_LEDGER: Array<{
  id: string;
  reason: string;
}>;

export declare function stableContentHash(content: string): string;
export declare function partitionOf(relativePath: string): string | null;
export declare function mergeLaneMaps(input: {
  nodeMap: object | null;
  rendererMap: object | null;
  canonicalPath: (rawPath: string) => string | null;
}): {
  files: Map<string, CoverageRecord>;
  rejections: Array<{ label: string; path: string | null; reason: string }>;
};
export declare function computePartitionStats(
  files: Map<string, CoverageRecord>,
  sourceUniverse: string[]
): Record<string, PartitionStats>;
export declare function derivePct(covered: number, total: number): number;
export declare function partitionRulesHash(rules: PartitionRule[]): string;

export declare function denominatorKindOf(
  partitionName?: string
): DenominatorKind | null;

/**
 * Per-partition fingerprint of the production source tree. A partition is
 * `undefined` when it has no files or one of them could not be read: unproven
 * must read as changed, so the churn allowance is withheld rather than assumed.
 */
export declare function computePartitionSourceHashes(
  sourceUniverse: string[],
  readSourceText: (relativePath: string) => string | null
): Record<string, string | undefined>;

/**
 * Fingerprint of the whole test tree. Deliberately not per-partition: any test
 * file may exercise any partition, so only "no test changed at all" is a claim
 * this can honestly make.
 */
export declare function computeTestTreeHash(
  testUniverse: string[],
  readSourceText: (relativePath: string) => string | null
): string | undefined;

export declare function renderMarkdown(
  stats: Record<string, PartitionStats>,
  context: {
    generatedAt: string;
    validityLedger: Array<{ id: string; reason: string }>;
  }
): string;
