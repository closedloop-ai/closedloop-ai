import { describe, expect, it } from "vitest";
import {
  CODE_REVIEW_FINDINGS_FOLD_BUDGET,
  collectCodeReviewFindings,
} from "./findings-funnel-ingest.ts";
import { CodeReviewResultEnvelopeRejection } from "./review-result-envelope.ts";

/**
 * One reviewer's two adjudicated findings, padded to `entries` total entries with
 * verdict-less filler the attributor counts and never folds into a funnel.
 *
 * The pad rides in `pending_verification` so the two REAL findings stay the whole
 * of `auditor`'s funnel: the same envelope under the budget attributes {2, 1}, so
 * a case that expects the funnel WITHHELD is falsified the moment the budget
 * stops binding.
 */
function envelopeWithEntryCount(entries: number) {
  return {
    verified: [{ reviewer: "auditor", verifier_verdict: "CONFIRMED" }],
    rejected: [{ reviewer: "auditor", verifier_verdict: "REJECTED" }],
    pending_verification: Array.from(
      { length: Math.max(0, entries - 2) },
      () => 0
    ),
  };
}

describe("collectCodeReviewFindings", () => {
  it("writes no count at all for a session with no review run", () => {
    expect(collectCodeReviewFindings([])).toEqual({
      runs: [],
      unreadableRuns: [],
      countCappedRuns: [],
      budgetSpend: [],
      unmatchedReviewerCount: 0,
      unattributedFindingCount: 0,
      fullyAdjudicated: true,
    });
  });

  it("counts a run it could not read instead of treating it as empty", () => {
    const ingest = collectCodeReviewFindings([
      { runId: "cr-1", envelope: null },
      { runId: "cr-2", envelope: { verified: 7 } },
    ]);
    expect(ingest.runs).toEqual([]);
    expect(ingest.unreadableRuns).toEqual([
      { runId: "cr-1", rejection: null },
      {
        runId: "cr-2",
        rejection: CodeReviewResultEnvelopeRejection.BucketNotAnArray,
      },
    ]);
    // A pass whose every run was unreadable has adjudicated nothing.
    expect(ingest.fullyAdjudicated).toBe(false);
  });

  it("is idempotent across a reparse that lists a run twice", () => {
    const sources = [
      {
        runId: "cr-2",
        envelope: {
          verified: [{ reviewer: "bhb", verifier_verdict: "CONFIRMED" }],
        },
      },
      {
        runId: "cr-1",
        envelope: {
          rejected: [{ reviewer: "auditor", verifier_verdict: "REJECTED" }],
        },
      },
      {
        runId: "cr-2",
        envelope: {
          verified: [
            { reviewer: "bhb", verifier_verdict: "CONFIRMED" },
            { reviewer: "bhb", verifier_verdict: "CONFIRMED" },
            { reviewer: "bhb", verifier_verdict: "CONFIRMED" },
          ],
        },
      },
    ];
    const first = collectCodeReviewFindings(sources);
    expect(first.runs.map((run) => run.runId)).toEqual(["cr-1", "cr-2"]);
    expect(
      first.runs.flatMap((run) =>
        run.matched.map((entry) => [
          run.runId,
          entry.reviewerId,
          entry.funnel?.findingsEmitted ?? null,
          entry.funnel?.findingsInvalidated ?? null,
        ])
      )
    ).toEqual([
      ["cr-1", "auditor", 1, 1],
      ["cr-2", "bhb", 1, 0],
    ]);
    expect(collectCodeReviewFindings(sources)).toEqual(first);
  });

  it("carries the join failures and the pending caveat up to the pass", () => {
    const ingest = collectCodeReviewFindings([
      {
        runId: "cr-1",
        envelope: {
          verified: [
            { reviewer: "who-is-this", verifier_verdict: "CONFIRMED" },
          ],
          pending_verification: [{ reviewer: "bhb" }],
        },
      },
      { runId: "cr-2", envelope: { rejected: [{}] } },
    ]);
    expect(ingest.unmatchedReviewerCount).toBe(1);
    expect(ingest.unattributedFindingCount).toBe(1);
    expect(ingest.fullyAdjudicated).toBe(false);
  });
});

describe("collectCodeReviewFindings findings-count bound (ISS-11310)", () => {
  it("folds a run that sits inside the budget, funnel and all", () => {
    const ingest = collectCodeReviewFindings([
      {
        runId: "cr-under",
        envelope: envelopeWithEntryCount(CODE_REVIEW_FINDINGS_FOLD_BUDGET),
      },
    ]);
    // The PRESENCE half of ISS-11310 AC4: the disclosure must not be
    // unconditional decoration, so an uncapped run says nothing about a cap.
    expect(ingest.countCappedRuns).toEqual([]);
    expect(
      ingest.runs.flatMap((run) =>
        run.matched.map((entry) => [
          entry.reviewerId,
          entry.funnel?.findingsEmitted ?? null,
          entry.funnel?.findingsInvalidated ?? null,
        ])
      )
    ).toEqual([["auditor", 2, 1]]);
  });

  it("withholds the funnel of a run past the budget and reports its exact size", () => {
    const entries = CODE_REVIEW_FINDINGS_FOLD_BUDGET + 1;
    const ingest = collectCodeReviewFindings([
      { runId: "cr-over", envelope: envelopeWithEntryCount(entries) },
    ]);
    expect(ingest.countCappedRuns).toEqual([
      { runId: "cr-over", findingsPresent: entries, exceedsWholeBudget: true },
    ]);
    // No funnel anywhere, and in particular not a {2, 1} folded off a prefix.
    expect(ingest.runs).toEqual([]);
    expect(ingest.unreadableRuns).toEqual([]);
    expect(ingest.fullyAdjudicated).toBe(false);
  });

  it("keeps a capped run distinguishable from an unreadable one in one pass", () => {
    const ingest = collectCodeReviewFindings([
      { runId: "cr-gone", envelope: null },
      {
        runId: "cr-huge",
        envelope: envelopeWithEntryCount(CODE_REVIEW_FINDINGS_FOLD_BUDGET + 5),
      },
    ]);
    expect(ingest.unreadableRuns).toEqual([
      { runId: "cr-gone", rejection: null },
    ]);
    expect(ingest.countCappedRuns.map((run) => run.runId)).toEqual(["cr-huge"]);
  });

  it("spends one budget across the pass rather than one per run", () => {
    const half = Math.floor(CODE_REVIEW_FINDINGS_FOLD_BUDGET / 2) + 2;
    const sources = [
      { runId: "cr-1", envelope: envelopeWithEntryCount(half) },
      { runId: "cr-2", envelope: envelopeWithEntryCount(half) },
    ];
    const ingest = collectCodeReviewFindings(sources);
    // Each run clears the budget alone; together they do not. The first in
    // `runId` order folds, the second is withheld — deterministically, so the
    // idempotence contract survives the bound.
    expect(ingest.runs.map((run) => run.runId)).toEqual(["cr-1"]);
    /* `exceedsWholeBudget: false` is the load-bearing half: this run fits the
       budget on its own and was withheld only because `cr-1` spent it. A report
       that called it oversized would send a reader to inspect a fine envelope. */
    expect(ingest.countCappedRuns).toEqual([
      { runId: "cr-2", findingsPresent: half, exceedsWholeBudget: false },
    ]);
    expect(collectCodeReviewFindings([...sources].reverse())).toEqual(ingest);
  });

  /* The starved case's other half. `cr-2` above is withheld with
     `exceedsWholeBudget: false`, which says the pass ran out but not who ran it
     out — so a consumer reporting the cap names the victim and leaves the
     envelope actually worth opening out of every list (tamsinb on #7993). */
  it("names the runs that spent the budget a later run was starved by", () => {
    const spender = Math.floor(CODE_REVIEW_FINDINGS_FOLD_BUDGET * 0.9);
    const starved = CODE_REVIEW_FINDINGS_FOLD_BUDGET - spender + 1;
    const ingest = collectCodeReviewFindings([
      { runId: "cr-1", envelope: envelopeWithEntryCount(spender) },
      { runId: "cr-2", envelope: envelopeWithEntryCount(starved) },
    ]);
    expect(ingest.countCappedRuns).toEqual([
      { runId: "cr-2", findingsPresent: starved, exceedsWholeBudget: false },
    ]);
    // The spender, with what it cost — not merely the fact that something did.
    expect(ingest.budgetSpend).toEqual([
      { runId: "cr-1", findingsCharged: spender },
    ]);
    // And a withheld run is never charged, or the spend would blame the victim.
    expect(ingest.budgetSpend.map((run) => run.runId)).not.toContain("cr-2");
  });

  it("orders the spend largest first so the biggest spender reads first", () => {
    const small = 10;
    const large = CODE_REVIEW_FINDINGS_FOLD_BUDGET - 2 * small;
    const ingest = collectCodeReviewFindings([
      { runId: "cr-1", envelope: envelopeWithEntryCount(small) },
      { runId: "cr-2", envelope: envelopeWithEntryCount(large) },
      { runId: "cr-3", envelope: envelopeWithEntryCount(small) },
    ]);
    /* `cr-2` folds second in runId order and spent the most, so it must lead:
       an insertion-ordered list would read `cr-1` first and point a reader at a
       ten-entry envelope. The tie between cr-1 and cr-3 breaks on runId, so the
       order is total and the idempotence contract survives it. */
    expect(ingest.budgetSpend).toEqual([
      { runId: "cr-2", findingsCharged: large },
      { runId: "cr-1", findingsCharged: small },
      { runId: "cr-3", findingsCharged: small },
    ]);
    expect(ingest.countCappedRuns).toEqual([]);
  });

  /* A run that is BOTH corrupt and over-budget. The count gate skips the parse,
     so without a shape check ahead of it this envelope is classified by its size
     — reported as a capped run carrying an exact 50,001 findings, when `rejected`
     was never counted and the value was never readable at all (codex on #7993).
     The same envelope UNDER the budget has always been `BucketNotAnArray`. */
  it("refuses a corrupt bucket by shape rather than sizing it as a capped run", () => {
    const entries = CODE_REVIEW_FINDINGS_FOLD_BUDGET + 1;
    const ingest = collectCodeReviewFindings([
      {
        runId: "cr-corrupt-huge",
        envelope: {
          verified: Array.from({ length: entries }, () => 0),
          rejected: 7,
        },
      },
    ]);
    expect(ingest.unreadableRuns).toEqual([
      {
        runId: "cr-corrupt-huge",
        rejection: CodeReviewResultEnvelopeRejection.BucketNotAnArray,
      },
    ]);
    // Not sized, not published as a measurement, and not folded.
    expect(ingest.countCappedRuns).toEqual([]);
    expect(ingest.runs).toEqual([]);
    /* And refusing it in O(1) costs the budget nothing, so a stream of corrupt
       envelopes cannot starve a readable run that follows them. */
    expect(ingest.budgetSpend).toEqual([]);
  });
});
