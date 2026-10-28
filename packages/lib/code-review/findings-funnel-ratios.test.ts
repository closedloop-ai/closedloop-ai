import {
  AgentComponentFindingsRatioOperand,
  AgentComponentFindingsRatioUnknownReason,
  type AgentComponentInvocationSpend,
} from "@repo/api/src/types/agent-component-findings-ratios";
import { AgentComponentInvocationUsageMeasurement } from "@repo/api/src/types/agent-component-invocation";
import { describe, expect, it } from "vitest";
import {
  CodeReviewComponentAssociation,
  CodeReviewReviewerAttribution,
} from "./findings-funnel-attribution.ts";
import {
  CODE_REVIEW_FINDINGS_FOLD_BUDGET,
  collectCodeReviewFindings,
} from "./findings-funnel-ingest.ts";
import {
  type CodeReviewInvocationSpendQuery,
  codeReviewFindingsRatios,
} from "./findings-funnel-ratios.ts";

const CONFIRMED = "CONFIRMED";
const REJECTED = "REJECTED";
/** Alone in a run, this reviewer's single candidate key IS its invocation. */
const EXACT_REVIEWER = "bha_p0";
const EXACT_COMPONENT_KEY = "code-review:code-review-worker";
/** A graph role spans two worker keys across releases: never exact. */
const AMBIGUOUS_REVIEWER = "bhb";
/** Shares `EXACT_REVIEWER`'s primary key, which makes BOTH ambiguous. */
const SHARING_REVIEWER = "auditor";

function findings(
  reviewer: string,
  count: number,
  verdict: string
): { reviewer: string; verifier_verdict: string }[] {
  return Array.from({ length: count }, () => ({
    reviewer,
    verifier_verdict: verdict,
  }));
}

/**
 * One run, two matched producers with the SAME confirmed count and very
 * different emitted populations, plus one deterministic helper and one producer
 * the join does not know.
 */
function twoProducerRun(): { runId: string; envelope: unknown } {
  return {
    runId: "cr-1",
    envelope: {
      review_id: "rev-1",
      verified: [
        ...findings(EXACT_REVIEWER, 3, CONFIRMED),
        ...findings(AMBIGUOUS_REVIEWER, 3, CONFIRMED),
        ...findings("hygiene", 1, CONFIRMED),
      ],
      justified: [],
      rejected: [
        ...findings(AMBIGUOUS_REVIEWER, 27, REJECTED),
        ...findings("nobody_knows_me", 1, REJECTED),
      ],
      pending_verification: [],
    },
  };
}

/** A second run whose producer left two findings without a verdict. */
function pendingRun(): { runId: string; envelope: unknown } {
  return {
    runId: "cr-2",
    envelope: {
      review_id: "rev-2",
      verified: [],
      justified: [],
      rejected: findings(EXACT_REVIEWER, 3, REJECTED),
      pending_verification: [
        { reviewer: EXACT_REVIEWER },
        { reviewer: EXACT_REVIEWER },
      ],
    },
  };
}

/** Two reviewers the plugin spawns as the SAME subagent type, in one run. */
function sharedKeyRun(): { runId: string; envelope: unknown } {
  return {
    runId: "cr-3",
    envelope: {
      review_id: "rev-3",
      verified: findings(EXACT_REVIEWER, 2, CONFIRMED),
      justified: [],
      rejected: findings(SHARING_REVIEWER, 4, REJECTED),
      pending_verification: [],
    },
  };
}

function producerNamed(
  ratios: ReturnType<typeof codeReviewFindingsRatios>,
  reviewerId: string
) {
  const producer = ratios.producers.find(
    (candidate) => candidate.reviewerId === reviewerId
  );
  if (!producer) {
    throw new Error(`no ratios produced for ${reviewerId}`);
  }
  return producer;
}

const A_DOLLAR: AgentComponentInvocationSpend = {
  estimatedCost: 1,
  measurement: AgentComponentInvocationUsageMeasurement.Measured,
};

describe("codeReviewFindingsRatios", () => {
  it("separates two producers that confirmed the same number of findings", () => {
    const ratios = codeReviewFindingsRatios(
      collectCodeReviewFindings([twoProducerRun()])
    );
    const careful = producerNamed(ratios, EXACT_REVIEWER).precision;
    const noisy = producerNamed(ratios, AMBIGUOUS_REVIEWER).precision;
    if (!(careful.known && noisy.known)) {
      throw new Error("both producers emitted adjudicated findings");
    }
    expect(careful.findingsConfirmed).toBe(noisy.findingsConfirmed);
    expect(careful.precision).toBe(1);
    expect(careful.falsePositiveRate).toBe(0);
    expect(noisy.precision).toBe(0.1);
    expect(noisy.falsePositiveRate).toBe(0.9);
  });

  it("reports carried over confirmed as unknown naming its missing operand", () => {
    const ratios = codeReviewFindingsRatios(
      collectCodeReviewFindings([twoProducerRun()])
    );
    expect(producerNamed(ratios, AMBIGUOUS_REVIEWER).carriedRate).toEqual({
      known: false,
      reason: AgentComponentFindingsRatioUnknownReason.CarriedNotProduced,
      absentOperand: AgentComponentFindingsRatioOperand.FindingsCarried,
    });
  });

  it("asks for spend ONLY where the key identifies one invocation", () => {
    const asked: CodeReviewInvocationSpendQuery[] = [];
    const ratios = codeReviewFindingsRatios(
      collectCodeReviewFindings([twoProducerRun()]),
      {
        resolveSpend: (query): AgentComponentInvocationSpend | undefined => {
          asked.push(query);
          return { ...A_DOLLAR, estimatedCost: 4.5 };
        },
      }
    );
    // The graph role resolves to two candidate worker keys, so no query could
    // name its invocation; asking anyway would either hand back another
    // reviewer's dollars or bury it in `invocationsWithoutSpend`.
    expect(asked).toEqual([
      {
        runId: "cr-1",
        reviewerId: EXACT_REVIEWER,
        componentKey: EXACT_COMPONENT_KEY,
      },
    ]);
    expect(ratios.ambiguousProducers).toBe(1);
    expect(producerNamed(ratios, AMBIGUOUS_REVIEWER).association).toBe(
      CodeReviewComponentAssociation.Ambiguous
    );
    const { waste } = ratios;
    if (!waste.known) {
      throw new Error("the exactly matched producer reported both operands");
    }
    expect(waste.reportingInvocations).toBe(1);
    expect(waste.populationInvocations).toBe(1);
  });

  it("keeps two reviewers sharing one subagent type out of the dollar arms", () => {
    const asked: CodeReviewInvocationSpendQuery[] = [];
    const ratios = codeReviewFindingsRatios(
      collectCodeReviewFindings([sharedKeyRun()]),
      {
        resolveSpend: (query) => {
          asked.push(query);
          return A_DOLLAR;
        },
      }
    );
    // Both roles are spawned as `code-review:code-review-worker`, as separate
    // invocations. One query per reviewer against one key would return the
    // same row's dollars twice and double the waste.
    expect(asked).toEqual([]);
    expect(ratios.ambiguousProducers).toBe(2);
    for (const reviewerId of [EXACT_REVIEWER, SHARING_REVIEWER]) {
      expect(producerNamed(ratios, reviewerId).association).toBe(
        CodeReviewComponentAssociation.Ambiguous
      );
      expect(producerNamed(ratios, reviewerId).precision.known).toBe(true);
    }
    expect(ratios.waste).toEqual({
      known: false,
      reason: AgentComponentFindingsRatioUnknownReason.NoAttributedCost,
      absentOperand: AgentComponentFindingsRatioOperand.EstimatedCost,
      invocationsWithUnknownFunnel: 0,
      invocationsWithoutSpend: 0,
      invocationsWithInadmissibleSpend: 0,
      populationInvocations: 0,
    });
  });

  it("asks for a carried count for EVERY producer, invocation or not", () => {
    const asked: CodeReviewInvocationSpendQuery[] = [];
    const ratios = codeReviewFindingsRatios(
      collectCodeReviewFindings([twoProducerRun()]),
      {
        resolveFindingsCarried: (query) => {
          asked.push(query);
          return query.reviewerId === AMBIGUOUS_REVIEWER ? 1 : undefined;
        },
      }
    );
    // Deliberately unlike `resolveSpend`: carried findings belong to the
    // findings, so a deterministic helper and an unmatched reviewer are both
    // asked, with a null key.
    expect(asked).toEqual([
      {
        runId: "cr-1",
        reviewerId: EXACT_REVIEWER,
        componentKey: EXACT_COMPONENT_KEY,
      },
      {
        runId: "cr-1",
        reviewerId: AMBIGUOUS_REVIEWER,
        componentKey: "code-review:code-review-worker-graph",
      },
      { runId: "cr-1", reviewerId: "hygiene", componentKey: null },
      { runId: "cr-1", reviewerId: "nobody_knows_me", componentKey: null },
    ]);
    const noisy = producerNamed(ratios, AMBIGUOUS_REVIEWER).carriedRate;
    if (!noisy.known) {
      throw new Error("a carried count was supplied for this producer");
    }
    expect(noisy.findingsCarried).toBe(1);
    expect(noisy.findingsConfirmed).toBe(3);
    expect(noisy.carriedRate).toBeCloseTo(1 / 3, 12);
    // The producer the callback declined still reads unknown, so one answer
    // cannot stand in for the whole run.
    expect(producerNamed(ratios, EXACT_REVIEWER).carriedRate).toEqual({
      known: false,
      reason: AgentComponentFindingsRatioUnknownReason.CarriedNotProduced,
      absentOperand: AgentComponentFindingsRatioOperand.FindingsCarried,
    });
  });

  it("folds every run and bounds an unadjudicated producer rather than settling it", () => {
    const ratios = codeReviewFindingsRatios(
      collectCodeReviewFindings([twoProducerRun(), pendingRun()]),
      { resolveSpend: () => A_DOLLAR }
    );
    expect(ratios.producers.map((producer) => producer.runId)).toEqual([
      "cr-1",
      "cr-1",
      "cr-1",
      "cr-1",
      "cr-2",
    ]);
    expect(ratios.fullyAdjudicated).toBe(false);
    expect(producerNamed(ratios, EXACT_REVIEWER).fullyAdjudicated).toBe(true);
    const pendingProducer = ratios.producers.find(
      (producer) => producer.runId === "cr-2"
    );
    expect(pendingProducer?.fullyAdjudicated).toBe(false);
    const { waste } = ratios;
    if (!waste.known) {
      throw new Error("both exactly matched producers were given a spend");
    }
    // cr-2's producer refuted all three adjudicated findings but has two
    // without a verdict, so its dollar goes to the bound rather than to waste.
    expect(waste.whollyRefutedInvocations).toBe(0);
    expect(waste.invocationsAwaitingVerdict).toBe(1);
    expect(waste.boundedWasteInvocations).toBe(1);
    expect(waste.boundedWasteCostMeasured).toBe(1);
    expect(waste.reportingInvocations).toBe(2);
    expect(waste.populationInvocations).toBe(2);
  });

  it("keeps producers with no invocation out of the waste population but still rates them", () => {
    const ratios = codeReviewFindingsRatios(
      collectCodeReviewFindings([twoProducerRun()])
    );
    expect(ratios.deterministicProducers).toBe(1);
    expect(ratios.unmatchedProducers).toBe(1);
    expect(producerNamed(ratios, "nobody_knows_me").attribution).toBe(
      CodeReviewReviewerAttribution.Unmatched
    );
    const helper = producerNamed(ratios, "hygiene");
    expect(helper.attribution).toBe(
      CodeReviewReviewerAttribution.Deterministic
    );
    expect(helper.componentKey).toBeNull();
    expect(helper.association).toBeNull();
    const unmatched = producerNamed(ratios, "nobody_knows_me").precision;
    if (!unmatched.known) {
      throw new Error("an unattributed producer still emitted findings");
    }
    expect(unmatched.precision).toBe(0);
  });

  it("carries the ingest's own lost input onto the ratios", () => {
    const ratios = codeReviewFindingsRatios(
      collectCodeReviewFindings([
        twoProducerRun(),
        { runId: "cr-broken", envelope: null },
        {
          runId: "cr-unclaimed",
          envelope: {
            review_id: "rev-4",
            verified: [],
            justified: [],
            rejected: [{ verifier_verdict: REJECTED }],
            pending_verification: [],
          },
        },
      ])
    );
    // A precision published beside a silent "one run of three was unreadable"
    // is a rate over a population the consumer cannot see.
    expect(ratios.unreadableRuns).toBe(1);
    expect(ratios.unattributedFindings).toBe(1);
    expect(ratios.fullyAdjudicated).toBe(false);
  });
});

describe("codeReviewFindingsRatios count-capped shortfall (ISS-11310)", () => {
  it("carries a withheld run's exact size onto the ratios rather than reading as complete", () => {
    const capped = codeReviewFindingsRatios(
      collectCodeReviewFindings([
        {
          runId: "cr-huge",
          envelope: {
            verified: [{ reviewer: "auditor", verifier_verdict: "CONFIRMED" }],
            pending_verification: Array.from(
              { length: CODE_REVIEW_FINDINGS_FOLD_BUDGET },
              () => 0
            ),
          },
        },
      ])
    );
    // The run is neither folded nor counted as unreadable, so without these two
    // fields the result is indistinguishable from a pass that saw nothing wrong.
    expect(capped.producers).toEqual([]);
    expect(capped.unreadableRuns).toBe(0);
    expect(capped.countCappedRuns).toBe(1);
    expect(capped.findingsPresentInCappedRuns).toBe(
      CODE_REVIEW_FINDINGS_FOLD_BUDGET + 1
    );
    expect(capped.fullyAdjudicated).toBe(false);
  });

  it("reports no capped shortfall for a pass that folded every run", () => {
    const folded = codeReviewFindingsRatios(
      collectCodeReviewFindings([
        {
          runId: "cr-small",
          envelope: {
            verified: [{ reviewer: "auditor", verifier_verdict: "CONFIRMED" }],
          },
        },
      ])
    );
    expect(folded.countCappedRuns).toBe(0);
    expect(folded.findingsPresentInCappedRuns).toBe(0);
    expect(folded.producers.map((entry) => entry.reviewerId)).toEqual([
      "auditor",
    ]);
  });
});
