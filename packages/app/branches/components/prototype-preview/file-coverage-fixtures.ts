import type { FileChange } from "./mock";

// The prototype sandbox cannot import `@repo/api` (dependency boundary), so
// these const objects mirror the canonical selected-PR response vocabulary.
// This is the consumer contract exercised by the merged PR #4700 UI matrix:
// it includes defensive response states that today's projector does not emit.

/** Prototype mirror of the real selected-PR file completeness vocabulary. */
export const PrototypeFileCompleteness = {
  Complete: "complete",
  Incomplete: "incomplete",
  Unavailable: "unavailable",
} as const;
export type PrototypeFileCompleteness =
  (typeof PrototypeFileCompleteness)[keyof typeof PrototypeFileCompleteness];

/** Prototype mirror of selected-PR gross-total availability. */
export const PrototypeGrossTotalAvailability = {
  Available: "available",
  Unavailable: "unavailable",
} as const;
export type PrototypeGrossTotalAvailability =
  (typeof PrototypeGrossTotalAvailability)[keyof typeof PrototypeGrossTotalAvailability];

/** Prototype mirror of one selected-PR additions/deletions gross total. */
export type PrototypeGrossTotal =
  | {
      availability: typeof PrototypeGrossTotalAvailability.Available;
      value: number;
      completeness:
        | typeof PrototypeFileCompleteness.Complete
        | typeof PrototypeFileCompleteness.Incomplete;
    }
  | {
      availability: typeof PrototypeGrossTotalAvailability.Unavailable;
    };

/**
 * Presentational projection of the `BranchSelectedPullRequestFilesResponse.value`
 * consumer contract. The prototype derives loaded counts and available totals
 * from shown rows while retaining the defensive state combinations required by
 * PR #4700 and ISS-5725; it is not a model of current-projector reachability.
 */
export type PrototypeFileCoverage = {
  completeness: PrototypeFileCompleteness;
  counts: {
    loaded: number;
    expected: number | null;
  };
  grossTotals: {
    additions: PrototypeGrossTotal;
    deletions: PrototypeGrossTotal;
  };
};

type FileCoverageFixture = {
  shownCount: number;
  fileChanges?: readonly FileChange[];
  expected: number | null;
  completeness: PrototypeFileCompleteness;
  grossTotals: {
    additions: PrototypeGrossTotalAvailability;
    deletions: PrototypeGrossTotalAvailability;
  };
};

const FILE_COVERAGE_FIXTURES: Readonly<Record<string, FileCoverageFixture>> = {
  br_1284: {
    shownCount: 1,
    fileChanges: [
      {
        path: "packages/database/seed/synthetic-generator.ts",
        additions: 412,
        deletions: 38,
      },
    ],
    expected: 1,
    completeness: PrototypeFileCompleteness.Complete,
    grossTotals: {
      additions: PrototypeGrossTotalAvailability.Available,
      deletions: PrototypeGrossTotalAvailability.Available,
    },
  },
  br_1281: {
    shownCount: 1,
    expected: null,
    completeness: PrototypeFileCompleteness.Unavailable,
    grossTotals: {
      additions: PrototypeGrossTotalAvailability.Unavailable,
      deletions: PrototypeGrossTotalAvailability.Unavailable,
    },
  },
  br_1270: {
    shownCount: 1,
    expected: null,
    completeness: PrototypeFileCompleteness.Incomplete,
    grossTotals: {
      additions: PrototypeGrossTotalAvailability.Available,
      deletions: PrototypeGrossTotalAvailability.Available,
    },
  },
  br_dark_mode: {
    shownCount: 1,
    expected: 1,
    completeness: PrototypeFileCompleteness.Incomplete,
    grossTotals: {
      additions: PrototypeGrossTotalAvailability.Available,
      deletions: PrototypeGrossTotalAvailability.Available,
    },
  },
  br_files_zero: {
    shownCount: 0,
    expected: 0,
    completeness: PrototypeFileCompleteness.Complete,
    grossTotals: {
      additions: PrototypeGrossTotalAvailability.Available,
      deletions: PrototypeGrossTotalAvailability.Available,
    },
  },
  br_1289: {
    shownCount: 2,
    expected: 3,
    completeness: PrototypeFileCompleteness.Incomplete,
    grossTotals: {
      additions: PrototypeGrossTotalAvailability.Available,
      deletions: PrototypeGrossTotalAvailability.Available,
    },
  },
};

/** Applies one selectable Branch fixture without mutating its source scenario. */
export function applyFileCoverageFixture(
  branchId: string,
  scenarioFiles: readonly FileChange[]
): { files: FileChange[]; coverage: PrototypeFileCoverage } {
  const fixture = FILE_COVERAGE_FIXTURES[branchId];
  if (!fixture) {
    return completeFileEvidence(scenarioFiles);
  }
  if (fixture.shownCount > scenarioFiles.length) {
    throw new Error(
      `File coverage fixture ${branchId} requests ${fixture.shownCount} rows from ${scenarioFiles.length}`
    );
  }
  const files = fixture.fileChanges
    ? [...fixture.fileChanges]
    : scenarioFiles.slice(0, fixture.shownCount);
  if (files.length !== fixture.shownCount) {
    throw new Error(
      `File coverage fixture ${branchId} declares ${fixture.shownCount} rows but supplies ${files.length}`
    );
  }
  return {
    files,
    coverage: {
      completeness: fixture.completeness,
      counts: { loaded: files.length, expected: fixture.expected },
      grossTotals: {
        additions: projectGrossTotal(
          files,
          "additions",
          fixture.completeness,
          fixture.grossTotals.additions
        ),
        deletions: projectGrossTotal(
          files,
          "deletions",
          fixture.completeness,
          fixture.grossTotals.deletions
        ),
      },
    },
  };
}

/** Projects an ordinary scenario as a complete file response. */
export function completeFileEvidence(scenarioFiles: readonly FileChange[]): {
  files: FileChange[];
  coverage: PrototypeFileCoverage;
} {
  const files = [...scenarioFiles];
  return {
    files,
    coverage: {
      completeness: PrototypeFileCompleteness.Complete,
      counts: { loaded: files.length, expected: files.length },
      grossTotals: {
        additions: projectGrossTotal(
          files,
          "additions",
          PrototypeFileCompleteness.Complete,
          PrototypeGrossTotalAvailability.Available
        ),
        deletions: projectGrossTotal(
          files,
          "deletions",
          PrototypeFileCompleteness.Complete,
          PrototypeGrossTotalAvailability.Available
        ),
      },
    },
  };
}

/** Formats the production-parity Files changed count label. */
export function fileCountLabel(coverage: PrototypeFileCoverage): string {
  const { loaded, expected } = coverage.counts;
  if (coverage.completeness === PrototypeFileCompleteness.Incomplete) {
    return expected === null
      ? `${loaded} ${fileNoun(loaded)} shown*`
      : `${loaded} of ${expected} ${fileNoun(expected)} shown*`;
  }
  if (coverage.completeness === PrototypeFileCompleteness.Unavailable) {
    return `${loaded} verified ${fileNoun(loaded)}`;
  }
  return `${loaded} ${fileNoun(loaded)}`;
}

function fileNoun(count: number): "file" | "files" {
  return count === 1 ? "file" : "files";
}

function projectGrossTotal(
  files: readonly FileChange[],
  field: "additions" | "deletions",
  completeness: PrototypeFileCompleteness,
  availability: PrototypeGrossTotalAvailability
): PrototypeGrossTotal {
  if (availability === PrototypeGrossTotalAvailability.Unavailable) {
    return { availability };
  }
  return {
    availability,
    value: files.reduce((total, file) => total + file[field], 0),
    completeness:
      completeness === PrototypeFileCompleteness.Complete
        ? PrototypeFileCompleteness.Complete
        : PrototypeFileCompleteness.Incomplete,
  };
}
