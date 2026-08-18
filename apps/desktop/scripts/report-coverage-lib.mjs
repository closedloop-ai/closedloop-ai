// Pure helpers for the desktop dual-lane coverage report (ISS-4594). Merge and
// branch-count semantics are OWNED by the trace-test-coverage census module —
// summaries are never unioned, branch slots are identity-keyed — and this file
// only layers desktop partitioning, baseline shape, and the fingerprints that
// prove what a run measured. Judging one run against another is the other half,
// and lives in report-coverage-compare.mjs so that neither file carries both.
import {
  CoverageRejectionReason,
  mergeCoverageMaps,
  providerBranchCounts,
} from "../../../.agents/skills/trace-test-coverage/scripts/trace-coverage-census.mjs";

function isSummaryMap(parsed) {
  return parsed?.total?.branches !== undefined;
}

// Where a partition's branch DENOMINATOR comes from, which decides whether a
// moving denominator can be re-enumeration at all (see cause (3) on
// `compareToBase`). The node lane reports only what executed, so its totals are
// execution-derived and can move on their own; the renderer lane's
// `coverage.include` is all-files (vitest.renderer.config.ts), so its
// denominator tracks the SOURCE and a move there means the source moved.
export const DenominatorKind = {
  Execution: "execution",
  Source: "source",
};

// Ordered first-match-wins: collectors must precede main (it is a subtree of
// src/main/), and every prefix is desktop-relative with a trailing slash so
// e.g. src/mainframe/ can never match src/main/.
export const PARTITION_RULES = [
  {
    name: "collectors",
    prefix: "src/main/collectors/",
    denominator: DenominatorKind.Execution,
  },
  {
    name: "gateway",
    prefix: "src/server/",
    denominator: DenominatorKind.Execution,
  },
  {
    name: "renderer",
    prefix: "src/renderer/",
    denominator: DenominatorKind.Source,
  },
  {
    name: "shared",
    prefix: "src/shared/",
    denominator: DenominatorKind.Execution,
  },
  { name: "main", prefix: "src/main/", denominator: DenominatorKind.Execution },
  {
    name: "tooling",
    prefix: "scripts/",
    denominator: DenominatorKind.Execution,
  },
];

export const PCT_DECIMALS = 2;

// The source/test split, shared with `scripts/coverage/aggregate-lib.mjs`.
//
// It lives HERE rather than in `report-coverage.mjs` because that file is an
// executable CLI with no import guard: importing it to read this constant runs
// the whole reporter — three full tree walks, ~10s, `process.exitCode = 1`, and
// an overwrite of `coverage/merged/` from whatever single lane happens to be on
// disk. This module is side-effect-free, which is what makes the constant
// importable by a test at all.
//
// The optional `-<kind>` arm covers the repo's test-SUPPORT suffixes —
// `.test-fixtures`, `.test-helpers`, `.test-mocks`, `.test-harness`, `.test-db`
// (see `apps/api/AGENTS.md`). Most such files sit under `__tests__/` and were
// already excluded by the directory rule; the ones that CANNOT live there are
// why the suffix now carries weight. A fixture shared by `apps/api` and
// `apps/desktop` has to sit in a package both import, and no `__tests__/`
// directory is importable across that boundary — so it lands beside production
// source and, without this arm, counts as production source.
export const TEST_FILE_PATTERN =
  /(\.test(-[a-z0-9]+(-[a-z0-9]+)*)?\.[cm]?[jt]sx?|\.d\.[cm]?ts)$/;

export function partitionOf(relativePath) {
  const rule = PARTITION_RULES.find((candidate) =>
    relativePath.startsWith(candidate.prefix)
  );
  return rule ? rule.name : null;
}

// The two lanes instrument with different pipelines (c8/v8-to-istanbul vs
// @vitest/coverage-v8), so the same file seen by both could carry mismatched
// branch identities and double-count under union. Each lane therefore owns a
// disjoint slice: the renderer map contributes only src/renderer/ files, the
// node map everything else — the union below can never see one file twice.
export function mergeLaneMaps({ nodeMap, rendererMap, canonicalPath }) {
  const rendererOwned = (relativePath) =>
    partitionOf(relativePath) === "renderer";
  const merged = new Map();
  const rejections = [];
  const lanes = [
    {
      label: "node",
      parsed: nodeMap,
      isSourceFile: (relativePath) =>
        partitionOf(relativePath) !== null && !rendererOwned(relativePath),
    },
    {
      label: "renderer",
      parsed: rendererMap,
      isSourceFile: rendererOwned,
    },
  ];
  for (const lane of lanes) {
    if (!lane.parsed) {
      continue;
    }
    if (isSummaryMap(lane.parsed)) {
      rejections.push({
        label: lane.label,
        path: null,
        reason: CoverageRejectionReason.SummaryNotUnionable,
      });
      continue;
    }
    const result = mergeCoverageMaps(
      [{ label: lane.label, parsed: lane.parsed }],
      {
        isSourceFile: lane.isSourceFile,
        canonicalPath,
      }
    );
    rejections.push(...result.rejections);
    for (const [relativePath, record] of result.files) {
      merged.set(relativePath, record);
    }
  }
  return { files: merged, rejections };
}

export function computePartitionStats(files, sourceUniverse) {
  const stats = {};
  for (const rule of PARTITION_RULES) {
    stats[rule.name] = {
      branchesCovered: 0,
      branchesTotal: 0,
      branchPct: 0,
      executedFiles: 0,
      sourceFiles: 0,
    };
  }
  for (const relativePath of sourceUniverse) {
    const partition = partitionOf(relativePath);
    if (partition) {
      stats[partition].sourceFiles += 1;
    }
  }
  for (const [relativePath, record] of files) {
    const partition = partitionOf(relativePath);
    if (!partition) {
      continue;
    }
    const counts = providerBranchCounts(record);
    stats[partition].branchesCovered += counts.covered;
    stats[partition].branchesTotal += counts.total;
    stats[partition].executedFiles += 1;
  }
  for (const rule of PARTITION_RULES) {
    const entry = stats[rule.name];
    entry.branchPct = derivePct(entry.branchesCovered, entry.branchesTotal);
  }
  return stats;
}

export function derivePct(covered, total) {
  if (total === 0) {
    return 0;
  }
  return Number(((covered / total) * 100).toFixed(PCT_DECIMALS));
}

// Small stable content hash (not cryptographic — a drift detector, not a
// security boundary). Plain arithmetic: hash*31 + code stays far below
// Number.MAX_SAFE_INTEGER before the modulus.
export function stableContentHash(content) {
  const modulus = 4_294_967_296;
  let hash = 7;
  for (let index = 0; index < content.length; index += 1) {
    hash = (hash * 31 + content.charCodeAt(index)) % modulus;
  }
  return `h${hash.toString(16)}`;
}

export function partitionRulesHash(rules) {
  return `p${stableContentHash(JSON.stringify(rules))}`;
}

// The structural, always-true validity-ledger entries. Every emitted summary
// carries them, so a report never presents numbers without naming what they
// DON'T measure — and the base run and the PR run therefore disclose the same
// limitations when they are compared.
export const STATIC_VALIDITY_LEDGER = [
  {
    id: "prisma-baseline-lane-excluded",
    reason:
      "test:prisma-baseline (schema-equivalence guard) runs outside run-node-tests.mjs by design and is not instrumented; its executions do not contribute coverage.",
  },
  {
    id: "node-lane-executed-files-only",
    reason:
      "The c8 node lane reports only files loaded at runtime (tsx transpiles in-memory; never-imported TS files cannot be safely stubbed into the map). sourceFiles vs executedFiles per partition quantifies the unreached remainder.",
  },
  {
    id: "renderer-lane-all-files",
    reason:
      "The renderer vitest lane uses an all-files coverage.include, so never-imported renderer files count as uncovered.",
  },
  {
    id: "lane-ownership-disjoint",
    reason:
      "src/renderer/** branch counts come exclusively from the renderer lane and all other partitions exclusively from the node lane; the two providers' branch identities are not mixable for one file.",
  },
];

export function renderMarkdown(stats, { generatedAt, validityLedger }) {
  const lines = [
    "# Desktop branch coverage (ISS-4594)",
    "",
    `Generated: ${generatedAt}`,
    "",
    "| Partition | Branches | Branch % | Executed files | Source files |",
    "|---|---|---|---|---|",
  ];
  for (const rule of PARTITION_RULES) {
    const entry = stats[rule.name];
    lines.push(
      `| ${rule.name} | ${entry.branchesCovered}/${entry.branchesTotal} | ${entry.branchPct}% | ${entry.executedFiles} | ${entry.sourceFiles} |`
    );
  }
  lines.push("", "## Validity ledger", "");
  for (const entry of validityLedger) {
    lines.push(`- **${entry.id}**: ${entry.reason}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Per-partition fingerprint of the PRODUCTION source tree the partition is
 * measured over — half of the provenance `branchChurnAllowancePct` requires
 * before it will treat a moving denominator as re-enumeration. Path AND
 * content, so a rename, an addition, a deletion, or an edit all change it.
 *
 * Uses the same `stableContentHash` drift detector the method identity already
 * relies on for `run-node-tests.mjs`; it is not a security boundary.
 *
 * A partition whose files could not all be read, or that has no files at all,
 * gets no fingerprint — see `fingerprintFiles`.
 *
 * @param {string[]} sourceUniverse
 * @param {(relativePath: string) => string | null} readSourceText
 * @returns {Record<string, string | undefined>}
 */
export function computePartitionSourceHashes(sourceUniverse, readSourceText) {
  const grouped = {};
  for (const rule of PARTITION_RULES) {
    grouped[rule.name] = [];
  }
  for (const relativePath of sourceUniverse) {
    const partition = partitionOf(relativePath);
    if (partition) {
      grouped[partition].push(relativePath);
    }
  }
  const hashes = {};
  for (const rule of PARTITION_RULES) {
    hashes[rule.name] = fingerprintFiles(grouped[rule.name], readSourceText);
  }
  return hashes;
}

/**
 * Fingerprint of the TEST tree — the other half of that provenance, and the
 * half a per-partition source hash structurally cannot supply.
 *
 * A branch-coverage number is a property of the source AND of the tests that
 * execute it, so a weakened or deleted test moves the measurement while every
 * production file stays byte-identical. Attribution is deliberately NOT
 * per-partition: any test file may exercise any partition, so claiming a test
 * belongs to one partition would be a guess. One fingerprint over the whole
 * test tree is therefore the finest claim that is honest.
 *
 * Its scope is exactly the test files' BYTES, and no more. It does NOT prove
 * the same tests RAN: which files the node lane selects is decided by
 * `vitest.node.config.ts` and `scripts/node-test-census.mjs`, neither of which
 * this tree reaches. That half of the proof is `nodeLaneSelectionHash` in the
 * method identity, where a change refuses the comparison outright rather than
 * being forgiven as churn.
 *
 * An unreadable test file, or an empty test tree, gets no fingerprint — see
 * `fingerprintFiles`.
 *
 * @param {string[]} testUniverse
 * @param {(relativePath: string) => string | null} readSourceText
 * @returns {string | undefined}
 */
export function computeTestTreeHash(testUniverse, readSourceText) {
  return fingerprintFiles(testUniverse, readSourceText);
}

/** The declared denominator provenance of a partition, or null if unknown. */
export function denominatorKindOf(partitionName) {
  const rule = PARTITION_RULES.find(
    (candidate) => candidate.name === partitionName
  );
  return rule ? rule.denominator : null;
}

/**
 * Path-and-content fingerprint of a file set, order-independent, or `undefined`
 * when the set cannot honestly be fingerprinted at all.
 *
 * The paths are sorted so that two runs which walked the tree in different
 * directory orders still agree, and each entry joins its path to its content
 * hash with a NUL — a byte no path or hash can contain, so no pair of distinct
 * (path, content) sets can be flattened into the same string.
 *
 * Two cases are UNPROVEN rather than merely different, and both withhold the
 * fingerprint so `fingerprintsAgree` refuses and the allowance is not granted:
 * a file whose bytes could not be read (any reader result that is not a
 * string), and an empty set — hashing nothing yields a constant that agrees
 * with itself, so "there was nothing to compare" would otherwise read as proof.
 */
function fingerprintFiles(paths, readSourceText) {
  if (paths.length === 0) {
    return undefined;
  }
  const entries = [];
  for (const relativePath of [...paths].sort()) {
    const content = readSourceText(relativePath);
    if (typeof content !== "string") {
      return undefined;
    }
    entries.push(`${relativePath}\u0000${stableContentHash(content)}`);
  }
  return stableContentHash(entries.join("\n"));
}
