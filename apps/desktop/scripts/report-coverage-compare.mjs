// The COMPARISON half of the desktop dual-lane coverage report (ISS-4594):
// everything that judges this run against the base branch's own measurement.
// The MEASUREMENT half — partitioning, lane merge, per-partition stats, the
// markdown render, and the fingerprints this module consumes as evidence —
// is report-coverage-lib.mjs. The dependency runs one way only: this module
// imports that one, never the reverse.
import {
  DenominatorKind,
  denominatorKindOf,
  PCT_DECIMALS,
} from "./report-coverage-lib.mjs";

export const CompareOutcome = {
  Ok: "ok",
  Drop: "drop",
  Discontinuity: "discontinuity",
};

/**
 * The ceiling on a single partition's churn allowance, in percentage points.
 *
 * The arithmetic bound below is a RATIO (`d / total`), so an implausible base
 * total does not merely widen it — it hands out blanket amnesty. A base that
 * reported half the current total yields a ~50pp allowance, which forgives
 * every regression a partition can physically have. The arithmetic is only
 * meaningful in the regime it was derived from: real re-enumeration is a small
 * perturbation of a stable denominator.
 *
 * The largest re-enumeration this lane has ever observed on an untouched tree
 * is 3 branch entries out of 3297 — 0.09pp (see cause (3) on `compareToBase`).
 * One percentage point is an order of magnitude above that, so it cannot
 * plausibly clip a genuine wobble, and it bounds what ANY residual blind spot
 * in the provenance gates can cost. A dip larger than this is judged on the
 * strict ratchet no matter what the denominator did.
 */
export const MAX_CHURN_ALLOWANCE_PCT = 1;

/**
 * Compare this run against the base branch's own measurement (the artifact the
 * push-to-main coverage run uploaded), NOT a committed file. Both sides are
 * therefore real measurements of their own tree, which is what makes the
 * source-universe reasoning below possible.
 *
 * Three things can lower a partition percentage, and they are not the same
 * event:
 *
 *   1. Coverage regressed — the same code is tested less than it was.
 *   2. The source universe shrank — a file was deleted. Deleting code that was
 *      better-covered than its partition average drags the average down while
 *      nothing got worse. Deleting code is normal and healthy.
 *   3. The BRANCH universe re-enumerated. Branch identities on the node lane
 *      come from V8 block coverage, which only emits sub-ranges inside
 *      functions that actually ran: a function no run invoked contributes no
 *      branch entries at all. `branchesTotal` is therefore execution-derived,
 *      not source-derived, and two runs of the SAME tree can disagree on it.
 *      Observed on main: the `gateway` partition measured 3296, 3294 and 3297
 *      total branches across six consecutive main commits, none of which
 *      touched a single file under `src/server/**`. A percentage computed over
 *      a denominator that moved on its own is not a like-for-like comparison,
 *      and failing a branch for it is the false-red this design exists to
 *      remove.
 *
 * A committed baseline cannot tell (1) from (2) (it only knows the old numbers,
 * not the old tree), which is why the ratchet it fed needed a human to declare
 * the difference. Comparing two measurements can: `sourceFiles` is in both
 * sides, so a shrinking universe is observable and a percentage dip it explains
 * is reported as informational instead of failing.
 *
 * (3) is bounded from the numbers themselves rather than from a hand-picked
 * tolerance. The totals differ by a NET `d` branch entries, so at least `d`
 * entries entered or left the universe, each worth `100/total` percentage
 * points. Gross churn can exceed `d` (entries leaving and arriving cancel in
 * the net), so this bound UNDER-grants rather than over-grants — the safe
 * direction, and why it is stated as a bound rather than an accounting.
 *
 * That arithmetic bound is necessary but NOT sufficient, because it cannot tell
 * re-enumeration from newly-added untested code: ten branch entries that
 * appeared because a function newly ran and ten that appeared because this PR
 * wrote ten uncovered branches are the same three numbers. The bound is
 * therefore gated on PROVENANCE, and every gate fails closed:
 *
 *   - The partition's denominator must be execution-derived. A source-derived
 *     denominator (`renderer`) cannot re-enumerate by itself, so a move there is
 *     the source moving and never earns an allowance.
 *   - The partition's own source tree must be BYTE-IDENTICAL across the two
 *     runs, proven by `sourceHash` on both sides.
 *   - The TEST tree must be byte-identical across the two runs, proven by
 *     `testTreeHash` on both sides. This gate is not redundant with the one
 *     above: a branch coverage number is a property of source AND of the tests
 *     that execute it, so weakening or deleting a test moves the measurement
 *     while leaving production source byte-identical. Without this gate a real
 *     regression presents with a matching `sourceHash` and is granted the
 *     allowance — i.e. the proof would cover the wrong tree. What it proves is
 *     the test files' BYTES, not that the same tests RAN: test SELECTION lives
 *     in `vitest.node.config.ts` and `scripts/node-test-census.mjs`, and is
 *     covered by `nodeLaneSelectionHash` in the method identity above, which
 *     REFUSES the comparison rather than granting an allowance. Both halves
 *     are needed, and they fail in different directions on purpose.
 *   - Both branch totals must be positive and finite. They come from artifact
 *     JSON, which is a trust boundary: a zero or negative total is corrupt
 *     input, and turning it into a 100pp-or-more allowance would let any drop
 *     through. Bad data must make the gate refuse, never relax.
 *   - The result is capped at `MAX_CHURN_ALLOWANCE_PCT`, because the ratio is
 *     only meaningful for a small perturbation of a stable denominator.
 *
 * A missing hash on either side (an artifact published before that field
 * existed) is treated as "not proven", never as "unchanged".
 *
 * A partition whose source this PR touched therefore keeps the strict ratchet in
 * full, so does one whose tests it touched anywhere, and so does one whose
 * totals are identical (`d = 0` allows nothing).
 *
 * KNOWN RESIDUAL, not a decided trade: with both trees proven identical, the
 * remaining way to lose sub-file reach is a PRODUCTION change in a DIFFERENT
 * partition that stops calling into this one — its branch entries leave the
 * universe exactly as V8 wobble does, and the artifact carries no per-branch
 * identity to tell them apart. The cap above bounds what that can cost to
 * `MAX_CHURN_ALLOWANCE_PCT`; it does not eliminate it. Whole-file reach loss,
 * including this shape of it, is caught separately and unconditionally by the
 * unreached-remainder check below.
 *
 * Breadth uses the UNREACHED REMAINDER (`sourceFiles - executedFiles`) rather
 * than a raw `executedFiles` count: a deletion drops both by one and leaves the
 * remainder flat, while a test that stops importing a file drops only
 * `executedFiles` and grows it. The second is the real regression this guard
 * exists to catch, and only the remainder isolates it. A remainder that cannot
 * be computed at all is UNKNOWN breadth, which refuses rather than passes —
 * absent is not zero.
 *
 * @param {Record<string, unknown>} currentStats
 * @param {unknown} currentMethod
 * @param {{method: unknown, partitions: Record<string, unknown>, testTreeHash?: string}} base
 * @param {string} [currentTestTreeHash]
 */
export function compareToBase(
  currentStats,
  currentMethod,
  base,
  currentTestTreeHash
) {
  if (!methodIdentityEquals(currentMethod, base.method)) {
    return {
      outcome: CompareOutcome.Discontinuity,
      drops: [],
      notes: [],
      detail:
        "method identity differs from the base run (provider, node major, partition rules, lane implementation, or test selection drifted); comparison refused",
    };
  }
  const provenance = {
    currentTestTreeHash,
    baseTestTreeHash: base.testTreeHash,
  };
  const drops = [];
  const notes = [];
  for (const [name, baseEntry] of Object.entries(base.partitions)) {
    const current = currentStats[name];
    if (!current) {
      drops.push({ partition: name, reason: "partition missing from run" });
      continue;
    }
    const delta = classifyPartitionDelta(name, current, baseEntry, provenance);
    const pctDelta = {
      partition: name,
      basePct: delta.basePct,
      currentPct: delta.currentPct,
    };
    if (delta.pctKind === PartitionDeltaKind.Drop) {
      drops.push(pctDelta);
    } else if (delta.pctReason) {
      notes.push({ ...pctDelta, reason: delta.pctReason });
    }
    if (delta.breadthUnknown) {
      drops.push({
        partition: name,
        reason:
          "file reach is unknown on one side (sourceFiles/executedFiles absent or non-finite) — breadth cannot be proven flat, so it is not assumed flat",
      });
    }
    if (delta.unreachedGrew) {
      drops.push({
        partition: name,
        reason: `unreached files grew: ${delta.baseUnreached} → ${delta.currentUnreached} (of ${current.sourceFiles} source files) — a file stopped being executed`,
      });
    }
  }
  return {
    outcome: drops.length > 0 ? CompareOutcome.Drop : CompareOutcome.Ok,
    drops,
    notes,
    detail:
      drops.length > 0
        ? "partitions below the base branch"
        : "all partitions at or above the base branch",
  };
}

// Method identity: numbers are only comparable when produced the same way.
// A provider upgrade, node major bump, partition-rule change, or lane change
// makes old-vs-new comparison meaningless — compare must refuse, not guess.
export function methodIdentityEquals(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** How a partition's percentage moved against the base, as one decision. */
export const PartitionDeltaKind = {
  AtOrAbove: "at-or-above",
  UniverseShrank: "universe-shrank",
  BranchChurn: "branch-churn",
  Drop: "drop",
};

/**
 * The percentage points of a partition's dip that branch-universe churn alone
 * can account for — see cause (3) on `compareToBase` for why each gate exists.
 *
 * Every path that is not a PROVEN re-enumeration returns 0, which reinstates the
 * strict ratchet: identical totals, a partition whose denominator is
 * source-derived, a partition whose source changed (or cannot be proven
 * unchanged), a TEST TREE that changed (or cannot be proven unchanged), and a
 * total that artifact JSON reported as absent, non-finite, or non-positive.
 *
 * @param {{branchesTotal?: number, sourceHash?: string}} current
 * @param {{branchesTotal?: number, sourceHash?: string}} baseEntry
 * @param {string} [partitionName]
 * @param {{currentTestTreeHash?: string, baseTestTreeHash?: string}} [provenance]
 * @returns {number}
 */
export function branchChurnAllowancePct(
  current,
  baseEntry,
  partitionName,
  provenance
) {
  const currentTotal = current.branchesTotal;
  const baseTotal = baseEntry.branchesTotal;
  if (!(isPositiveFinite(currentTotal) && isPositiveFinite(baseTotal))) {
    return 0;
  }
  if (denominatorKindOf(partitionName) !== DenominatorKind.Execution) {
    return 0;
  }
  if (!fingerprintsAgree(current.sourceHash, baseEntry.sourceHash)) {
    return 0;
  }
  if (
    !fingerprintsAgree(
      provenance?.currentTestTreeHash,
      provenance?.baseTestTreeHash
    )
  ) {
    return 0;
  }
  return Math.min(
    MAX_CHURN_ALLOWANCE_PCT,
    (Math.abs(currentTotal - baseTotal) * 100) / currentTotal
  );
}

/**
 * The ONE classifier behind both surfaces that judge a partition against main:
 * the compare step (`compareToBase`, authoritative, sets the exit code) and the
 * #symphony-dev report (`scripts/coverage/slack-report-lib.mjs`, glanceable).
 * They render it differently — exit codes vs a ✅/⚠️ list — but they must never
 * disagree about WHAT HAPPENED, which is what two parallel ladders over the same
 * numbers had already drifted into.
 *
 * @param {string} partitionName
 * @param {Record<string, unknown>} current
 * @param {Record<string, unknown>} baseEntry
 * @param {{currentTestTreeHash?: string, baseTestTreeHash?: string}} [provenance]
 */
export function classifyPartitionDelta(
  partitionName,
  current,
  baseEntry,
  provenance
) {
  const baseUnreached = unreachedRemainder(baseEntry);
  const currentUnreached = unreachedRemainder(current);
  const churnAllowancePct = branchChurnAllowancePct(
    current,
    baseEntry,
    partitionName,
    provenance
  );
  return {
    partition: partitionName,
    basePct: baseEntry.branchPct,
    currentPct: current.branchPct,
    baseUnreached,
    currentUnreached,
    breadthUnknown: baseUnreached === null || currentUnreached === null,
    unreachedGrew:
      baseUnreached !== null &&
      currentUnreached !== null &&
      currentUnreached > baseUnreached,
    churnAllowancePct,
    ...classifyPctMove(current, baseEntry, churnAllowancePct),
  };
}

function isPositiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}

// Absent unless BOTH sides published a fingerprint and they agree. An artifact
// from before a field existed proves nothing about its tree, and "unproven"
// must read as "changed" so the allowance is withheld rather than assumed.
function fingerprintsAgree(currentHash, baseHash) {
  return (
    typeof currentHash === "string" &&
    currentHash.length > 0 &&
    currentHash === baseHash
  );
}

function unreachedRemainder(entry) {
  if (
    !(
      Number.isFinite(entry?.sourceFiles) &&
      Number.isFinite(entry?.executedFiles)
    )
  ) {
    return null;
  }
  return entry.sourceFiles - entry.executedFiles;
}

function classifyPctMove(current, baseEntry, churnAllowancePct) {
  if (current.branchPct >= baseEntry.branchPct) {
    return { pctKind: PartitionDeltaKind.AtOrAbove, pctReason: null };
  }
  if (current.sourceFiles < baseEntry.sourceFiles) {
    return {
      pctKind: PartitionDeltaKind.UniverseShrank,
      pctReason:
        `source universe shrank (${baseEntry.sourceFiles} → ${current.sourceFiles} files); ` +
        "the dip is explained by deleted code, not by less testing",
    };
  }
  if (baseEntry.branchPct - current.branchPct <= churnAllowancePct) {
    return {
      pctKind: PartitionDeltaKind.BranchChurn,
      pctReason:
        `branch universe re-enumerated (${baseEntry.branchesTotal} → ${current.branchesTotal} branch entries); ` +
        `the dip is within the ${churnAllowancePct.toFixed(PCT_DECIMALS)}pp that churn alone accounts for`,
    };
  }
  return { pctKind: PartitionDeltaKind.Drop, pctReason: null };
}
