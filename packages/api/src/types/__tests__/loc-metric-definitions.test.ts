/**
 * ISS-9097 item 1 — the LOC definition registry states every shipped
 * definition, and states it in words a human already approved.
 *
 * Every expectation here is written INDEPENDENTLY of the registry. An id list
 * derived from `LocMetricDefinitionId` would stay green when a member is
 * deleted, which is the one regression a registry-of-record has; the literal
 * list below is the duplication that makes the deletion red.
 *
 * The sibling `loc-metric-definitions-derivation.test.ts` proves the strings
 * are READ from their owners rather than re-typed here, which an identity
 * assertion cannot.
 */
import { describe, expect, it } from "vitest";
import {
  LOC_METRIC_DEFINITION,
  LocMetricDefinitionId,
  locMetricDefinition,
} from "../loc-metric-definitions.ts";
import {
  MERGED_LOC_PER_DOLLAR_DENOMINATOR,
  MERGED_LOC_PER_DOLLAR_NUMERATOR,
  MergedLocPerDollarBasis,
  resolveMergedLocPerDollarHow,
} from "../merged-loc-per-dollar-basis.ts";

/** Written out, not derived. See the header. */
const SHIPPED_DEFINITION_IDS = [
  "branch_canonical_publication_loc",
  "branch_detail_publication_loc",
  "branch_list_publication_loc",
  "branch_pushed_loc",
  "component_lines_changed",
  "session_detail_merged_loc",
  "session_merged_loc",
];

describe("the LOC definition registry", () => {
  it("holds exactly the seven shipped definitions", () => {
    expect(Object.keys(LOC_METRIC_DEFINITION).sort()).toEqual(
      SHIPPED_DEFINITION_IDS
    );
  });

  /**
   * The Agents column, the Agents card, the Agents summary tile, its Show/Hide
   * row, Agent detail and Pack detail render
   * `AgentComponentRow.locPerDollar`, which has no merge predicate anywhere in
   * its producer. Filing them under the merged basis would record a definition
   * none of them computes — the drift ISS-9097 exists to end, reintroduced by
   * the registry meant to end it. Written as literals so the two entries cannot
   * be reconciled by editing either one.
   */
  it("keeps the component ratio distinct from the merged Sessions one", () => {
    const component = locMetricDefinition(
      LocMetricDefinitionId.ComponentLinesChanged
    );
    const session = locMetricDefinition(LocMetricDefinitionId.SessionMergedLoc);
    expect(component.numerator).toBe("lines changed");
    expect(component.population).toBe("the sessions that used this component");
    expect(session.numerator).toBe("merged gross lines");
    expect(session.population).toBe("across sessions in range");
    expect(component.numerator).not.toBe(session.numerator);
    expect(component.population).not.toBe(session.population);
    // ISS-10667 moved no label onto this surface, so the gate cannot rename it
    // to a merged phrase.
    expect(component.canonicalLabel).toBe(component.label);
    expect(component.canonicalLabel).not.toBe(session.canonicalLabel);
  });

  /**
   * ISS-9097 (tamsinb, #7881). The Session detail Properties row and the detail
   * KPI strip divide ONE session's merged lines by that SAME session's cost;
   * the summary card divides across the matched sessions in range. They share a
   * numerator and nothing else, so a single entry records a denominator and a
   * population one of the two surfaces does not compute. Written as literals so
   * the two entries cannot be reconciled by editing either one.
   */
  it("keeps the per-session ratio distinct from the summary one", () => {
    const row = locMetricDefinition(
      LocMetricDefinitionId.SessionDetailMergedLoc
    );
    const summary = locMetricDefinition(LocMetricDefinitionId.SessionMergedLoc);
    expect(row.numerator).toBe(summary.numerator);
    expect(row.denominator).toBe("this session's own estimated cost");
    expect(row.population).toBe("this session");
    expect(summary.denominator).toBe(
      "the total estimated cost across matched sessions"
    );
    expect(summary.population).toBe("across sessions in range");
    expect(row.denominator).not.toBe(summary.denominator);
    expect(row.population).not.toBe(summary.population);
    // ISS-10667 moved this row's label too, and splitting the formula must not
    // withdraw that: the two entries differ in their terms, never in the words.
    expect(row.label).toBe(summary.label);
    expect(row.canonicalLabel).toBe(summary.canonicalLabel);
  });

  it("states a numerator, a denominator and a population for every one", () => {
    for (const id of SHIPPED_DEFINITION_IDS) {
      const definition = LOC_METRIC_DEFINITION[id as LocMetricDefinitionId];
      expect(definition.numerator.length).toBeGreaterThan(0);
      expect(definition.denominator.length).toBeGreaterThan(0);
      expect(definition.population.length).toBeGreaterThan(0);
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.canonicalLabel.length).toBeGreaterThan(0);
      expect(definition.unitLabel.length).toBeGreaterThan(0);
    }
  });

  /**
   * The registry may not author product copy. Its Sessions numerator and
   * denominator are the two halves of the sentence that card already renders,
   * so reassembling them has to give that sentence back byte for byte — and
   * `resolveMergedLocPerDollarHow` is the independent side of the comparison.
   */
  it("splits the Sessions basis without writing new words", () => {
    const session = locMetricDefinition(LocMetricDefinitionId.SessionMergedLoc);
    const numerator = session.numerator;
    const reassembled = `${numerator[0].toUpperCase()}${numerator.slice(1)} divided by ${session.denominator}.`;
    expect(reassembled).toBe(
      resolveMergedLocPerDollarHow(
        MergedLocPerDollarBasis.MergedLinesOverTotalCost
      )
    );
    expect(numerator).toBe(MERGED_LOC_PER_DOLLAR_NUMERATOR);
    expect(session.denominator).toBe(MERGED_LOC_PER_DOLLAR_DENOMINATOR);
  });

  /**
   * ISS-10667's gate picks between two spellings and this registry carries
   * both, so the gate keeps choosing exactly what it chose before.
   */
  it("serves the shipped spelling and the canonical spelling side by side", () => {
    const session = locMetricDefinition(LocMetricDefinitionId.SessionMergedLoc);
    expect(session.label).toBe("LOC / $");
    expect(session.canonicalLabel).toBe("Merged LOC per $");
    const branchList = locMetricDefinition(
      LocMetricDefinitionId.BranchListPublicationLoc
    );
    expect(branchList.label).toBe("LOC per $");
    expect(branchList.canonicalLabel).toBe("Pushed LOC per $");
  });

  /**
   * ISS-9097's fourth spelling: the Branches card printed `LOC/$` beside a
   * label reading `LOC per $`. Both now come off one entry, so the compact
   * unit cannot name a metric the heading does not.
   */
  it("carries the compact unit every entry's card prints", () => {
    for (const id of SHIPPED_DEFINITION_IDS) {
      expect(LOC_METRIC_DEFINITION[id as LocMetricDefinitionId].unitLabel).toBe(
        "LOC/$"
      );
    }
  });
});
