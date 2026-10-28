/**
 * ISS-9848 — the wire basis for `mergedLocPerDollar`, graded on the three
 * answers a version-skewed reader can get.
 *
 * The defect these pin: one field name carrying more than one quantity over
 * time, with no way for the reader to tell which it received. So the test that
 * matters is not "the field is present" — a basis that is always the same
 * constant passes that — but that two responses carrying the SAME NUMBER and
 * DIFFERENT BASES are told apart, and that the one this build cannot describe is
 * not silently described as the one it can.
 *
 * Every expected sentence is pinned as an INDEPENDENT LITERAL rather than read
 * back out of the map under test, so a fixture cannot agree with a rewritten
 * map by construction.
 */
import { describe, expect, it } from "vitest";
import type { AgentSessionUsageSummary } from "./agent-session";
import {
  MERGED_LOC_PER_DOLLAR_DETAIL_UNRECOGNIZED_BASIS,
  MERGED_LOC_PER_DOLLAR_DETAIL_WITHOUT_BASIS,
  MERGED_LOC_PER_DOLLAR_HOW_UNRECOGNIZED_BASIS,
  MERGED_LOC_PER_DOLLAR_HOW_WITHOUT_BASIS,
  MERGED_LOC_PER_DOLLAR_LABEL_UNRECOGNIZED_BASIS,
  MERGED_LOC_PER_DOLLAR_LABEL_WITHOUT_BASIS,
  MERGED_LOC_PER_DOLLAR_WHAT_UNRECOGNIZED_BASIS,
  MERGED_LOC_PER_DOLLAR_WHAT_WITHOUT_BASIS,
  MergedLocPerDollarBasis,
  resolveMergedLocPerDollarDetail,
  resolveMergedLocPerDollarHow,
  resolveMergedLocPerDollarLabel,
  resolveMergedLocPerDollarWhat,
} from "./merged-loc-per-dollar-basis";

/** The sentence the total-cost basis publishes today. */
const TOTAL_COST_SENTENCE =
  "Merged gross lines divided by the total estimated cost across matched sessions.";

/** The sentence a basis this build has never compiled against must fall to. */
const UNRECOGNIZED_SENTENCE =
  "This figure was computed on a basis this version of the app does not recognize.";

/** The "what am I looking at" sentence the total-cost basis publishes today. */
const TOTAL_COST_WHAT =
  "Lines of code merged per dollar, output efficiency. Higher is better.";

/** What an unrecognized basis must say instead — naming neither side, nor a direction. */
const UNRECOGNIZED_WHAT =
  "Numerator and denominator are not stated by this response.";

/** The card's own label on each arm (ISS-9978). */
const SHIPPED_LABEL = "LOC / $";
const UNRECOGNIZED_LABEL = "Efficiency ratio";

/** The caption under the value on each arm (ISS-9978). */
const SHIPPED_DETAIL = "across sessions in range";
const UNRECOGNIZED_DETAIL = "scope not stated";

/**
 * A basis member from a server newer than this build, delivered the way a real
 * one arrives: through `JSON.parse`, where no type annotation constrains it.
 * ISS-9814's points numerator is the concrete next one.
 */
function basisFromNewerServer(): string | undefined {
  const payload: { mergedLocPerDollarBasis?: string } = JSON.parse(
    '{"mergedLocPerDollar":3.5,"mergedLocPerDollarBasis":"pensero_points_over_total_cost"}'
  );
  return payload.mergedLocPerDollarBasis;
}

describe("resolveMergedLocPerDollarHow", () => {
  it("states the total-cost basis the server actually published", () => {
    expect(
      resolveMergedLocPerDollarHow(
        MergedLocPerDollarBasis.MergedLinesOverTotalCost
      )
    ).toBe(TOTAL_COST_SENTENCE);
  });

  it("falls back to the pre-ISS-9848 sentence when the producer states no basis", () => {
    // A server that omits the field predates it, and every such server divided
    // by total estimated cost. Absence must NOT reach the unrecognized branch:
    // that would caption every older cloud with "we cannot describe this".
    expect(resolveMergedLocPerDollarHow(undefined)).toBe(TOTAL_COST_SENTENCE);
  });

  it("coarsens a basis from a newer server instead of throwing or guessing", () => {
    const basis = basisFromNewerServer();

    // Not a throw: this string only captions a number, and rejecting the
    // response over it would take the whole summary down.
    expect(resolveMergedLocPerDollarHow(basis)).toBe(UNRECOGNIZED_SENTENCE);
    // And emphatically not the sentence we happen to know — asserting a basis
    // the response declined to claim is the defect, not the fallback.
    expect(resolveMergedLocPerDollarHow(basis)).not.toBe(TOTAL_COST_SENTENCE);
  });

  it("tells two responses carrying the SAME ratio and DIFFERENT bases apart", () => {
    // The whole point of the field. Both payloads publish 3.5 LOC/$; a reader
    // with only the number cannot distinguish them, and before this contract
    // neither could a client.
    const known = resolveMergedLocPerDollarHow(
      MergedLocPerDollarBasis.MergedLinesOverTotalCost
    );
    const newer = resolveMergedLocPerDollarHow(basisFromNewerServer());

    expect(known).not.toBe(newer);
  });

  it("does not resolve an inherited property as a known basis", () => {
    // A dispatch table read with an untrusted key: `__proto__` and `constructor`
    // are truthy on a plain object and must not pass for members.
    expect(resolveMergedLocPerDollarHow("__proto__")).toBe(
      UNRECOGNIZED_SENTENCE
    );
    expect(resolveMergedLocPerDollarHow("constructor")).toBe(
      UNRECOGNIZED_SENTENCE
    );
  });
});

describe("ISS-9848 exported sentences", () => {
  it("says the same thing for a stated total-cost basis as for no basis at all", () => {
    // Today's servers all divide by total cost, so adding the field changes
    // nothing a reader sees. This is what makes the change non-perceivable —
    // and it is asserted rather than assumed, because the two constants are
    // deliberately independent and a future default WILL move one of them.
    expect(MERGED_LOC_PER_DOLLAR_HOW_WITHOUT_BASIS).toBe(TOTAL_COST_SENTENCE);
    expect(
      resolveMergedLocPerDollarHow(
        MergedLocPerDollarBasis.MergedLinesOverTotalCost
      )
    ).toBe(MERGED_LOC_PER_DOLLAR_HOW_WITHOUT_BASIS);
  });

  it("keeps the unrecognized sentence free of any claim about the numerator", () => {
    expect(MERGED_LOC_PER_DOLLAR_HOW_UNRECOGNIZED_BASIS).toBe(
      UNRECOGNIZED_SENTENCE
    );
  });
});

describe("resolveMergedLocPerDollarWhat", () => {
  it("states the lines-per-dollar metric the total-cost basis publishes", () => {
    expect(
      resolveMergedLocPerDollarWhat(
        MergedLocPerDollarBasis.MergedLinesOverTotalCost
      )
    ).toBe(TOTAL_COST_WHAT);
  });

  it("keeps the pre-ISS-9848 sentence when the producer states no basis", () => {
    expect(resolveMergedLocPerDollarWhat(undefined)).toBe(TOTAL_COST_WHAT);
    expect(MERGED_LOC_PER_DOLLAR_WHAT_WITHOUT_BASIS).toBe(TOTAL_COST_WHAT);
  });

  it("names neither side of the ratio, nor a direction, for a newer server's basis", () => {
    const basis = basisFromNewerServer();

    expect(resolveMergedLocPerDollarWhat(basis)).toBe(UNRECOGNIZED_WHAT);
    expect(MERGED_LOC_PER_DOLLAR_WHAT_UNRECOGNIZED_BASIS).toBe(
      UNRECOGNIZED_WHAT
    );
    // Each clause is a claim the response declined to make: the numerator can
    // move (ISS-9814's points swap), the denominator can move, and an unknown
    // numerator has no known direction of goodness.
    expect(resolveMergedLocPerDollarWhat(basis)).not.toContain("Lines of code");
    expect(resolveMergedLocPerDollarWhat(basis)).not.toContain("per dollar");
    expect(resolveMergedLocPerDollarWhat(basis)).not.toContain(
      "Higher is better"
    );
  });

  it("does not resolve an inherited property as a known basis", () => {
    expect(resolveMergedLocPerDollarWhat("__proto__")).toBe(UNRECOGNIZED_WHAT);
    expect(resolveMergedLocPerDollarWhat("constructor")).toBe(
      UNRECOGNIZED_WHAT
    );
  });
});

describe("ISS-9848 — the two sentences resolve on the SAME arm", () => {
  // The card renders `what` and `how` together in one hint, so an arm that
  // disagrees between them is visible as a self-contradiction: "Lines of code
  // merged per dollar" directly above "computed on a basis this version of the
  // app does not recognize." That was the shipped state until the `what` was
  // moved onto the wire beside the `how` (codex review on #6929).
  it("coarsens BOTH sentences for a basis this build cannot describe", () => {
    const basis = basisFromNewerServer();

    expect(resolveMergedLocPerDollarWhat(basis)).toBe(UNRECOGNIZED_WHAT);
    expect(resolveMergedLocPerDollarHow(basis)).toBe(UNRECOGNIZED_SENTENCE);
  });

  it("states BOTH sentences for a basis the server named", () => {
    const basis = MergedLocPerDollarBasis.MergedLinesOverTotalCost;

    expect(resolveMergedLocPerDollarWhat(basis)).toBe(TOTAL_COST_WHAT);
    expect(resolveMergedLocPerDollarHow(basis)).toBe(TOTAL_COST_SENTENCE);
  });

  it("states BOTH sentences for a producer that names none", () => {
    expect(resolveMergedLocPerDollarWhat(undefined)).toBe(TOTAL_COST_WHAT);
    expect(resolveMergedLocPerDollarHow(undefined)).toBe(TOTAL_COST_SENTENCE);
  });
});

describe("ISS-9848 — the CONSUMER field is an open string (whitlockk review on #6929)", () => {
  it("admits a basis this build never compiled against, with no cast", () => {
    // This declaration COMPILES only while
    // `AgentSessionUsageSummary["mergedLocPerDollarBasis"]` is `string`.
    // Restoring the closed `MergedLocPerDollarBasis` union fails `tsc` right
    // here — which is the guarantee: with the union declared, a typed consumer
    // could write a `switch` exhaustive over the one member this build knows,
    // satisfy the compiler, and never compile the generic arm that exists for
    // exactly the value a newer server sends.
    const fromNewerServer: AgentSessionUsageSummary["mergedLocPerDollarBasis"] =
      "pensero_points_over_total_cost";

    expect(resolveMergedLocPerDollarHow(fromNewerServer)).toBe(
      UNRECOGNIZED_SENTENCE
    );
    expect(resolveMergedLocPerDollarWhat(fromNewerServer)).toBe(
      UNRECOGNIZED_WHAT
    );
  });

  it("still admits every member the server can emit", () => {
    // Opening the consumer field must not cost the producer its vocabulary:
    // the closed union is retained for emission, and its members stay valid
    // values of the field they are emitted into.
    const emitted: AgentSessionUsageSummary["mergedLocPerDollarBasis"] =
      MergedLocPerDollarBasis.MergedLinesOverTotalCost;

    expect(resolveMergedLocPerDollarHow(emitted)).toBe(TOTAL_COST_SENTENCE);
    expect(resolveMergedLocPerDollarWhat(emitted)).toBe(TOTAL_COST_WHAT);
  });
});

describe("ISS-9978 — the label and the caption are basis-dependent too", () => {
  it("names the unit for a stated basis and for a producer that states none", () => {
    expect(
      resolveMergedLocPerDollarLabel(
        MergedLocPerDollarBasis.MergedLinesOverTotalCost
      )
    ).toBe(SHIPPED_LABEL);
    expect(resolveMergedLocPerDollarLabel(undefined)).toBe(SHIPPED_LABEL);
    expect(MERGED_LOC_PER_DOLLAR_LABEL_WITHOUT_BASIS).toBe(SHIPPED_LABEL);
  });

  it("stops naming the unit and the numerator for a newer server's basis", () => {
    const basis = basisFromNewerServer();

    expect(resolveMergedLocPerDollarLabel(basis)).toBe(UNRECOGNIZED_LABEL);
    expect(MERGED_LOC_PER_DOLLAR_LABEL_UNRECOGNIZED_BASIS).toBe(
      UNRECOGNIZED_LABEL
    );
    // Each clause the shipped label asserts is a claim the response declined to
    // make: "LOC" is the numerator, "/ $" the denominator.
    expect(resolveMergedLocPerDollarLabel(basis)).not.toContain("LOC");
    expect(resolveMergedLocPerDollarLabel(basis)).not.toContain("$");
  });

  it("states the population for a stated basis and for a producer that states none", () => {
    expect(
      resolveMergedLocPerDollarDetail(
        MergedLocPerDollarBasis.MergedLinesOverTotalCost
      )
    ).toBe(SHIPPED_DETAIL);
    expect(resolveMergedLocPerDollarDetail(undefined)).toBe(SHIPPED_DETAIL);
    expect(MERGED_LOC_PER_DOLLAR_DETAIL_WITHOUT_BASIS).toBe(SHIPPED_DETAIL);
  });

  it("stops claiming a population for a newer server's basis", () => {
    const basis = basisFromNewerServer();

    expect(resolveMergedLocPerDollarDetail(basis)).toBe(UNRECOGNIZED_DETAIL);
    expect(MERGED_LOC_PER_DOLLAR_DETAIL_UNRECOGNIZED_BASIS).toBe(
      UNRECOGNIZED_DETAIL
    );
    // "in range" is itself a population claim — a basis whose denominator is not
    // summed per session need not respect the range control at all.
    expect(resolveMergedLocPerDollarDetail(basis)).not.toContain("in range");
  });

  it("lands all FOUR strings on the same arm for one basis", () => {
    // The property `resolveBasisCopy` exists to hold: the reader sees the label,
    // the caption and both hint sentences at once, so an arm that disagreed
    // between them is a visible self-contradiction. Three strings were already
    // covered; the label and the caption joined them in ISS-9978.
    const basis = basisFromNewerServer();

    expect(resolveMergedLocPerDollarLabel(basis)).toBe(UNRECOGNIZED_LABEL);
    expect(resolveMergedLocPerDollarDetail(basis)).toBe(UNRECOGNIZED_DETAIL);
    expect(resolveMergedLocPerDollarWhat(basis)).toBe(UNRECOGNIZED_WHAT);
    expect(resolveMergedLocPerDollarHow(basis)).toBe(UNRECOGNIZED_SENTENCE);
  });

  it("does not resolve an inherited property as a known basis", () => {
    expect(resolveMergedLocPerDollarLabel("__proto__")).toBe(
      UNRECOGNIZED_LABEL
    );
    expect(resolveMergedLocPerDollarDetail("constructor")).toBe(
      UNRECOGNIZED_DETAIL
    );
  });
});
