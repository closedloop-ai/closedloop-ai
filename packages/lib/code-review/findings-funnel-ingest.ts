/**
 * ISS-10724 — the ingest pass: many `review_result.json` runs in, one
 * deterministic attribution set out.
 *
 * IDEMPOTENT BY CONSTRUCTION (AC6, PRD-674 NFR-5). This is a pure fold over its
 * inputs: it accumulates nothing across calls, it keys runs by `runId` so the
 * same run seen twice in one pass contributes once, and it orders its output by
 * that same key. Reparse, catch-up and a `DATA_REVISION` rebuild therefore
 * converge on byte-identical results for the same set of runs on disk.
 *
 * FILESYSTEM ACCESS IS THE CALLER'S. Sources arrive already decoded, so this
 * module stays importable from every surface and the desktop collector owns the
 * directory walk and the JSON decode. A source whose envelope could not be read
 * passes `envelope: null` and is COUNTED as unreadable rather than omitted —
 * "we could not read this run" and "this run produced no findings" are
 * different facts.
 *
 * A SESSION WITH NO CODE-REVIEW RUN (AC5) yields an empty `runs` array and
 * empty counters, so no component gets a funnel and every one of them keeps
 * reading UNKNOWN. There is no zero written anywhere on this path.
 *
 * ISS-11310 — THE FOLD IS BOUNDED BY FINDINGS COUNT, NOT ONLY BY ENVELOPE BYTES.
 * This fold and the parse beneath it are both linear in the number of bucket
 * entries, and the desktop caller runs the whole pass INSIDE the one app-wide
 * SQLite writer transaction, so a run carrying millions of entries holds the
 * only writer slot for as long as it takes to visit them. The byte gate in
 * `component-invocation-findings-attribution.ts` does not bound that: 8 MiB of
 * minimal JSON array entries is several million of them. The two gates bound
 * different failure modes and neither substitutes for the other (ISS-11310
 * Notes), so this module carries its own, spelled in the unit the work is
 * actually proportional to.
 *
 * A CAPPED RUN IS WITHHELD WHOLE, AND SAYS SO WITH AN EXACT NUMBER. Truncating
 * a run's buckets and folding the prefix would write a number smaller than the
 * run's real one into `findings_emitted`, where nothing downstream could tell it
 * apart from a genuine smaller count — a confident wrong measurement, and the
 * specific defect ISS-11310 exists to refuse. Nor is the capped run discarded
 * silently: its exact entry count is read in O(1) off the bucket lengths BEFORE
 * any linear work, so the shortfall published beside the absence is a real
 * measurement even though the per-producer split behind it is not computable
 * within the bound. That is the operand that is genuinely absent — the verdict
 * classification of each entry, which cannot be had without visiting it — and it
 * is named rather than papered over.
 *
 * WHY A PASS BUDGET RATHER THAN A PER-RUN CAP. A per-run cap bounds one run and
 * not the pass: a session naming forty runs each just under the cap costs forty
 * times the cap. The budget is therefore spent across the whole pass, in the
 * same `runId` order the output is already sorted by, so which runs fold and
 * which are withheld is a function of the source set alone and the idempotence
 * contract above still holds. A single run larger than the whole budget trips it
 * on its own, which is the pathological-run case.
 */
import {
  attributeCodeReviewFindings,
  type CodeReviewRunFindingsAttribution,
} from "./findings-funnel-attribution.ts";
import {
  type CodeReviewResultEnvelopeRejection,
  codeReviewResultBucketShapeRejection,
  codeReviewResultFindingsPresent,
  parseCodeReviewResultEnvelope,
} from "./review-result-envelope.ts";

/**
 * One review run's envelope, already decoded by the caller. `envelope` is
 * `null` when the file was missing, unreadable, or not valid JSON.
 */
export type CodeReviewRunSource = {
  /** Stable within a repository — the plugin's run directory name (`cr-60054`). */
  runId: string;
  envelope: unknown;
};

/**
 * ISS-11310: the total bucket entries one pass will fold across every run.
 *
 * Sized against the producer rather than against the column: a real
 * `review_result.json` carries tens to low hundreds of findings, and the largest
 * one in this repository's history is under 300 KB, so this is three orders of
 * magnitude of headroom and no real run reaches it. What it bounds is the
 * pathological case the byte gate cannot — 8 MiB of minimal array entries is
 * millions of them — at a cost of tens of milliseconds rather than seconds
 * inside the writer transaction.
 */
export const CODE_REVIEW_FINDINGS_FOLD_BUDGET = 50_000;

/**
 * A run that PARSED as far as this module is concerned and was never folded,
 * because folding it would have cost more than the pass had left.
 *
 * Distinct from {@link CodeReviewUnreadableRun} on purpose, and the distinction
 * is the point (ISS-11310 AC3): an unreadable run is one we cannot say anything
 * about, while this one we can size exactly. Collapsing the two would make a
 * capped run indistinguishable from a missing, corrupt or oversize one, which is
 * the same erasure as writing a truncated count.
 */
export type CodeReviewCountCappedRun = {
  runId: string;
  /**
   * Bucket entries the envelope actually carries — the exact figure, read off
   * the bucket lengths without visiting an entry. A measurement, not an
   * estimate, and never a truncated stand-in for the funnel it replaces.
   */
  findingsPresent: number;
  /**
   * True when this run alone is larger than the WHOLE budget — the pathological
   * run — and false when it merely did not fit what earlier runs left.
   *
   * The two are different facts and a reader acts on them differently: the first
   * names an envelope to go and look at, the second says the pass ran out and
   * this run happened to be after the ones that spent it. A report that said
   * "exceeded the budget" of both would be telling an operator to inspect a
   * 200-entry envelope. `findingsPresent` is exact either way; this is the
   * causal half of the same statement, and without it the sentence a consumer
   * writes is wrong for one of the two cases.
   */
  exceedsWholeBudget: boolean;
};

/**
 * One run that was CHARGED against the fold budget, and what it cost.
 *
 * The other half of a starved-cap report. A run withheld with
 * `exceedsWholeBudget` false did not overrun the budget — it arrived after the
 * runs that had — so a report carrying only the capped runs names the victim and
 * leaves the envelope actually worth opening out of every list (tamsinb on
 * #7993). Charged rather than folded: a run the parse then refused spent the
 * budget too, and a reader chasing where it went must see that.
 */
export type CodeReviewBudgetSpend = {
  runId: string;
  /** Bucket entries this run was charged — its {@link CodeReviewCountCappedRun.findingsPresent} twin. */
  findingsCharged: number;
};

export type CodeReviewUnreadableRun = {
  runId: string;
  /** `null` when the caller could not produce a value at all. */
  rejection: CodeReviewResultEnvelopeRejection | null;
};

export type CodeReviewFindingsIngest = {
  /** One per run whose envelope parsed, ordered by `runId`. */
  runs: readonly (CodeReviewRunFindingsAttribution & { runId: string })[];
  /** Runs we could not read. Counted so they are never read as empty runs. */
  unreadableRuns: readonly CodeReviewUnreadableRun[];
  /**
   * ISS-11310: runs the fold budget refused, each with the exact number of
   * entries it carries. Their producers get NO funnel — absent, never a
   * truncated count and never a zero — and the shortfall travels with them.
   */
  countCappedRuns: readonly CodeReviewCountCappedRun[];
  /**
   * ISS-11310: the runs that SPENT the budget, largest charge first, so a
   * starved cap can name them. Ordered by charge and then by `runId`, a total
   * order, so the idempotence contract above still holds.
   */
  budgetSpend: readonly CodeReviewBudgetSpend[];
  /** Producers no join covers, summed across every parsed run. */
  unmatchedReviewerCount: number;
  /** Findings no producer claimed, summed across every parsed run. */
  unattributedFindingCount: number;
  /**
   * True only when every run in the pass was READ AND FOLDED and every finding
   * in it reached a verdict. A pass whose runs were all unreadable is not
   * adjudicated — we cannot say what those runs contained, so `unreadableRuns`
   * is folded in here rather than left for a consumer to remember to check, and
   * ISS-11310's `countCappedRuns` folds in for the same reason: a run we sized
   * and declined to fold has adjudicated none of its findings.
   */
  fullyAdjudicated: boolean;
};

/**
 * Fold every run's envelope into per-producer funnels.
 *
 * Duplicate `runId`s collapse to the FIRST occurrence IN `sources` ORDER, so a
 * caller that lists a directory twice in one pass cannot double a component's
 * findings. Deduplication happens before the sort for exactly that reason — a
 * sort cannot be relied on to keep two equal-keyed entries in their original
 * order unless its comparator returns 0 for them, and the winner must not
 * depend on that.
 */
/** Total order over run ids: equal ids must compare 0, or the sort may reorder them. */
function compareRunIds(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export function collectCodeReviewFindings(
  sources: readonly CodeReviewRunSource[]
): CodeReviewFindingsIngest {
  const runs: (CodeReviewRunFindingsAttribution & { runId: string })[] = [];
  const unreadableRuns: CodeReviewUnreadableRun[] = [];
  const countCappedRuns: CodeReviewCountCappedRun[] = [];
  const budgetSpend: CodeReviewBudgetSpend[] = [];
  const seenRunIds = new Set<string>();
  let unmatchedReviewerCount = 0;
  let unattributedFindingCount = 0;
  let fullyAdjudicated = true;
  let remainingBudget = CODE_REVIEW_FINDINGS_FOLD_BUDGET;
  const firstBySourceOrder: CodeReviewRunSource[] = [];
  for (const source of sources) {
    if (seenRunIds.has(source.runId)) {
      continue;
    }
    seenRunIds.add(source.runId);
    firstBySourceOrder.push(source);
  }
  const ordered = [...firstBySourceOrder].sort((left, right) =>
    compareRunIds(left.runId, right.runId)
  );
  for (const source of ordered) {
    if (source.envelope === null || source.envelope === undefined) {
      unreadableRuns.push({ runId: source.runId, rejection: null });
      continue;
    }
    // SHAPE BEFORE SIZE. The count gate below skips the parse, and the parse is
    // the only other place a misshapen bucket is refused, so without this an
    // envelope that is both corrupt and over-budget would be classified by its
    // size — published as a capped run of an exact size when one of its buckets
    // was never counted and the value was never readable (codex on #7993). O(1)
    // per bucket, so it neither spends the budget nor needs bounding by it.
    const shapeRejection = codeReviewResultBucketShapeRejection(
      source.envelope
    );
    if (shapeRejection !== null) {
      unreadableRuns.push({ runId: source.runId, rejection: shapeRejection });
      continue;
    }
    // The count gate runs on the RAW value, ahead of the parse: both the parse
    // and the fold are linear in the entries, so a budget checked afterwards
    // would have already been overspent by the thing it is meant to bound.
    const findingsPresent = codeReviewResultFindingsPresent(source.envelope);
    if (findingsPresent > remainingBudget) {
      countCappedRuns.push({
        runId: source.runId,
        findingsPresent,
        exceedsWholeBudget: findingsPresent > CODE_REVIEW_FINDINGS_FOLD_BUDGET,
      });
      continue;
    }
    // Spent before the parse, not after: `parseCodeReviewResultEnvelope` is
    // itself linear in the entries, so a run it goes on to REFUSE has already
    // cost the budget what it cost. The shape check above turned away the one
    // refusal that could follow a large count, so every refusal still reachable
    // here describes a value of counted size 0 — the charge stays ahead of the
    // parse regardless, so that a refusal added later cannot become a way to
    // spend the bound for free.
    remainingBudget -= findingsPresent;
    budgetSpend.push({ runId: source.runId, findingsCharged: findingsPresent });
    const parsed = parseCodeReviewResultEnvelope(source.envelope);
    if (!parsed.ok) {
      unreadableRuns.push({
        runId: source.runId,
        rejection: parsed.rejection,
      });
      continue;
    }
    const attribution = attributeCodeReviewFindings(parsed.envelope);
    unmatchedReviewerCount += attribution.unmatched.length;
    unattributedFindingCount += attribution.unattributedFindings;
    if (!attribution.fullyAdjudicated) {
      fullyAdjudicated = false;
    }
    runs.push({ runId: source.runId, ...attribution });
  }
  return {
    runs,
    unreadableRuns,
    countCappedRuns,
    budgetSpend: budgetSpend.sort(compareBudgetSpend),
    unmatchedReviewerCount,
    unattributedFindingCount,
    fullyAdjudicated:
      fullyAdjudicated &&
      unreadableRuns.length === 0 &&
      countCappedRuns.length === 0,
  };
}

/** Largest charge first, `runId` breaking ties so the order is total. */
function compareBudgetSpend(
  left: CodeReviewBudgetSpend,
  right: CodeReviewBudgetSpend
): number {
  if (left.findingsCharged !== right.findingsCharged) {
    return right.findingsCharged - left.findingsCharged;
  }
  return compareRunIds(left.runId, right.runId);
}
