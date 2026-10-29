import {
  type AgentComponentFindingsFunnelReading,
  readAgentComponentFindingsFunnel,
} from "@repo/api/src/types/agent-component-findings-funnel";
import { describe, expect, it } from "vitest";
import { FindingsSurvivalCorrelationVerdict } from "./findings-survival-correlation.ts";
import {
  type AgentFindingsSurvivalInput,
  agentLineSurvivalFigure,
  buildAgentFindingsSurvivalJoin,
  FINDINGS_SURVIVAL_CONFOUNDS,
  FindingsSurvivalExclusion,
  findingsSurvivalExclusionCounts,
} from "./findings-survival-join.ts";
import { renderAgentFindingsSurvivalReport } from "./findings-survival-report.ts";

const ANCHOR = "cca6649cee0000000000000000000000000000ab";

/**
 * Confirmed-findings counts, and a net-new-lines series that varies
 * INDEPENDENTLY of them — without variance in the control there is no partial
 * correlation to take, and a control that tracks findings exactly is collinear.
 */
const CONFIRMED_FINDINGS = [0, 2, 4, 6, 8];
const NET_NEW_LINES = [400, 900, 500, 1000, 600];
/** The default correlation window, which every operand span must match. */
const DEFAULT_SPAN_DAYS = 21;
const WINDOW_LABEL = /\d+d /;
const NO_WINDOW_SET = /at least one window/;
const WINDOW_NOT_REQUESTED = /not one of the requested windows/;
const WINDOW_NOT_WHOLE_DAYS = /whole positive days/;
const WINDOW_REPEATED = /must not repeat/;
const POPULATION_LABEL = /of \d+ lines/;

function directionalCohort(
  survivedLines: readonly number[],
  survivedLines14: readonly number[] = survivedLines,
  spanDays: number = DEFAULT_SPAN_DAYS
): AgentFindingsSurvivalInput[] {
  return CONFIRMED_FINDINGS.map((confirmed, index) =>
    agent(`agent-${index}`, {
      reviewers: [measured(confirmed, 0)],
      linesAdded: NET_NEW_LINES[index],
      linesRemoved: 0,
      survived14: survivedLines14[index],
      survived21: survivedLines[index],
      spanDays,
    })
  );
}

/**
 * A cohort large enough for a null to be a MEASURED null. Survival is symmetric
 * about the middle of the findings series and volume cycles on a coprime
 * period, so both coefficients are zero by construction — and at this
 * population the interval is narrow enough to say so, which five agents can
 * never do.
 */
function nullCohort(): AgentFindingsSurvivalInput[] {
  return Array.from({ length: 150 }, (_unused, index) => {
    const confirmed = index % 10;
    return agent(`agent-${index}`, {
      reviewers: [measured(confirmed, 0)],
      linesAdded: 100 + 50 * (index % 3),
      linesRemoved: 0,
      survived14: 800 + 5 * Math.abs(2 * confirmed - 9),
      survived21: 800 + 5 * Math.abs(2 * confirmed - 9),
    });
  });
}

function measured(
  findingsEmitted: number,
  findingsInvalidated: number
): AgentComponentFindingsFunnelReading {
  return readAgentComponentFindingsFunnel({
    findingsEmitted,
    findingsInvalidated,
  });
}

const UNKNOWN_REVIEWER: AgentComponentFindingsFunnelReading =
  readAgentComponentFindingsFunnel(null);

const NOT_APPLICABLE_REVIEWER: AgentComponentFindingsFunnelReading =
  readAgentComponentFindingsFunnel(null, true);

function agent(
  agentId: string,
  options: {
    linesAdded?: number;
    linesRemoved?: number;
    base?: number;
    survived14?: number;
    survived21?: number;
    moved14?: number;
    moved21?: number;
    reviewers?: readonly AgentComponentFindingsFunnelReading[];
    windows?: readonly number[];
    spanDays?: number;
  } = {}
): AgentFindingsSurvivalInput {
  const base = options.base ?? 1000;
  const windows = options.windows ?? [14, 21];
  const survival = windows.map((windowDays) => ({
    windowDays,
    baseLines: base,
    survivedLines:
      windowDays === 14
        ? (options.survived14 ?? 900)
        : (options.survived21 ?? 850),
    movedLines:
      windowDays === 14 ? (options.moved14 ?? 0) : (options.moved21 ?? 0),
  }));
  return {
    agentId,
    observedSpanDays: options.spanDays ?? DEFAULT_SPAN_DAYS,
    linesAdded: options.linesAdded ?? 500,
    linesRemoved: options.linesRemoved ?? 100,
    reviewerFindings: options.reviewers ?? [measured(4, 1)],
    survival,
  };
}

/** Every reason at zero, with the named ones raised — so a new reason cannot be forgotten. */
function exclusionCounts(
  raised: Partial<Record<FindingsSurvivalExclusion, number>>
): Record<FindingsSurvivalExclusion, number> {
  const counts = Object.fromEntries(
    Object.values(FindingsSurvivalExclusion).map((reason) => [reason, 0])
  ) as Record<FindingsSurvivalExclusion, number>;
  return { ...counts, ...raised };
}

describe("agentLineSurvivalFigure", () => {
  it("judges on real churn: a verbatim relocation is not rework", () => {
    const positional = agentLineSurvivalFigure({
      windowDays: 21,
      baseLines: 1000,
      survivedLines: 600,
      movedLines: 0,
    });
    const relocated = agentLineSurvivalFigure({
      windowDays: 21,
      baseLines: 1000,
      survivedLines: 600,
      movedLines: 300,
    });
    expect(positional?.survivalRate).toBeCloseTo(0.6);
    expect(positional?.realChurnedLines).toBe(400);
    // Same positional survival, 300 of the churn relocated: real churn is 100.
    expect(relocated?.survivalRate).toBeCloseTo(0.9);
    expect(relocated?.realChurnedLines).toBe(100);
    expect(relocated?.realSurvivedLines).toBe(900);
  });

  it("clamps a move claim to the churned count so survival cannot exceed base", () => {
    const figure = agentLineSurvivalFigure({
      windowDays: 21,
      baseLines: 1000,
      survivedLines: 900,
      movedLines: 5000,
    });
    expect(figure?.realSurvivedLines).toBe(1000);
    expect(figure?.survivalRate).toBe(1);
    expect(figure?.realChurnedLines).toBe(0);
  });

  it("has no rate at all for an impossible or empty observation", () => {
    for (const observation of [
      { windowDays: 21, baseLines: 0, survivedLines: 0, movedLines: 0 },
      { windowDays: 21, baseLines: 100, survivedLines: 101, movedLines: 0 },
      { windowDays: 21, baseLines: 100, survivedLines: -1, movedLines: 0 },
      { windowDays: 21, baseLines: 100.5, survivedLines: 50, movedLines: 0 },
      { windowDays: 21, baseLines: 100, survivedLines: 50, movedLines: -1 },
    ]) {
      expect(agentLineSurvivalFigure(observation)).toBeUndefined();
    }
  });
});

describe("buildAgentFindingsSurvivalJoin", () => {
  it("puts lines, survival at both windows and confirmed findings on one row", () => {
    const join = buildAgentFindingsSurvivalJoin({
      anchorCommit: ANCHOR,
      inputs: [
        agent("agent-a", { reviewers: [measured(6, 2), measured(3, 0)] }),
        agent("agent-b", { reviewers: [measured(1, 1)] }),
      ],
    });
    expect(join.anchorCommit).toBe(ANCHOR);
    expect(join.windowDays).toEqual([14, 21]);
    // Two agents with DIFFERENT funnels: a single-agent fixture cannot tell a
    // per-agent join from one that reuses the whole population's totals.
    expect(join.rows[0]).toMatchObject({
      agentId: "agent-a",
      netNewLines: 400,
      confirmedFindings: 7,
      reportingReviewers: 2,
      populationReviewers: 2,
    });
    expect(join.rows[1]).toMatchObject({
      agentId: "agent-b",
      confirmedFindings: 0,
      reportingReviewers: 1,
    });
    expect(join.rows[0]?.survival.map((f) => f.windowDays)).toEqual([14, 21]);
  });

  it("keys each window's figure by windowDays, not by array position", () => {
    // The 21d observation is supplied FIRST. A positional lookup would publish
    // 21d's numbers under the 14d label and pass every other assertion here.
    const join = buildAgentFindingsSurvivalJoin({
      anchorCommit: ANCHOR,
      inputs: [
        {
          agentId: "out-of-order",
          observedSpanDays: DEFAULT_SPAN_DAYS,
          linesAdded: 300,
          linesRemoved: 100,
          reviewerFindings: [measured(2, 0)],
          survival: [
            {
              windowDays: 21,
              baseLines: 1000,
              survivedLines: 700,
              movedLines: 0,
            },
            {
              windowDays: 14,
              baseLines: 1000,
              survivedLines: 950,
              movedLines: 0,
            },
          ],
        },
      ],
    });
    expect(join.rows[0]?.survival).toEqual([
      {
        windowDays: 14,
        baseLines: 1000,
        realSurvivedLines: 950,
        realChurnedLines: 50,
        survivalRate: 0.95,
      },
      {
        windowDays: 21,
        baseLines: 1000,
        realSurvivedLines: 700,
        realChurnedLines: 300,
        survivalRate: 0.7,
      },
    ]);
  });

  it("reports every exclusion reason at zero when nothing was excluded", () => {
    const join = buildAgentFindingsSurvivalJoin({
      anchorCommit: ANCHOR,
      inputs: [agent("clean")],
    });
    expect(join.excludedAgents).toBe(0);
    expect(findingsSurvivalExclusionCounts(join)).toEqual(exclusionCounts({}));
  });

  it("counts an agent whose lines cannot be attributed instead of scoring it zero", () => {
    const join = buildAgentFindingsSurvivalJoin({
      anchorCommit: ANCHOR,
      inputs: [
        agent("attributed"),
        {
          ...agent("no-lines"),
          linesAdded: undefined,
          linesRemoved: undefined,
        },
        { ...agent("bad-lines"), linesAdded: -5 },
        agent("bad-window", { windows: [14] }),
        // base 0 with 0 survivors is ADMISSIBLE and simply has no rate; the
        // impossible fixture below is what separates the two reasons.
        agent("no-base", { base: 0, survived14: 0, survived21: 0 }),
        agent("impossible-survival", {
          base: 100,
          survived14: 101,
          survived21: 50,
        }),
        agent("silent-reviewers", {
          reviewers: [UNKNOWN_REVIEWER, UNKNOWN_REVIEWER],
        }),
        agent("declared-no-output", {
          reviewers: [NOT_APPLICABLE_REVIEWER, NOT_APPLICABLE_REVIEWER],
        }),
      ],
    });
    expect(join.rows.map((row) => row.agentId)).toEqual(["attributed"]);
    expect(join.cohortAgents).toBe(1);
    expect(join.populationAgents).toBe(8);
    expect(join.excludedAgents).toBe(7);
    // Each impossible input gets its OWN reason: a missing figure and a
    // malformed one are different facts, and so are a reviewer that went silent
    // and one that could never have spoken.
    expect(findingsSurvivalExclusionCounts(join)).toEqual(
      exclusionCounts({
        [FindingsSurvivalExclusion.UnattributableLines]: 1,
        [FindingsSurvivalExclusion.InadmissibleLines]: 1,
        [FindingsSurvivalExclusion.MissingSurvivalWindow]: 1,
        [FindingsSurvivalExclusion.EmptySurvivalBase]: 1,
        [FindingsSurvivalExclusion.InadmissibleSurvivalObservation]: 1,
        [FindingsSurvivalExclusion.NoReportingReviewer]: 1,
        [FindingsSurvivalExclusion.NoApplicableReviewer]: 1,
      })
    );
    expect(join.exclusions).toContainEqual({
      agentId: "silent-reviewers",
      reason: FindingsSurvivalExclusion.NoReportingReviewer,
    });
  });

  it("does not let an unknown reviewer contribute a zero to the count", () => {
    const join = buildAgentFindingsSurvivalJoin({
      anchorCommit: ANCHOR,
      inputs: [
        agent("mixed", {
          reviewers: [
            measured(5, 1),
            UNKNOWN_REVIEWER,
            NOT_APPLICABLE_REVIEWER,
          ],
        }),
      ],
    });
    expect(join.rows[0]).toMatchObject({
      confirmedFindings: 4,
      reportingReviewers: 1,
      notApplicableReviewers: 1,
      populationReviewers: 3,
    });
  });

  it("does not read a reviewer that cannot report as one that failed to", () => {
    const join = buildAgentFindingsSurvivalJoin({
      anchorCommit: ANCHOR,
      inputs: [
        agent("a", { reviewers: [measured(2, 0), NOT_APPLICABLE_REVIEWER] }),
      ],
    });
    expect(renderAgentFindingsSurvivalReport(join)).toContain(
      "across 1 of 2 reviewers (1 declare no findings output)"
    );
  });

  it("takes the correlations at the longest requested window by default", () => {
    // 21d survival RISES with findings while 14d FALLS, so only the window the
    // default actually selects can decide the verdict. Identical series at both
    // windows would let any window choice pass.
    const divergent: [readonly number[], readonly number[]] = [
      [700, 740, 780, 820, 860],
      [900, 860, 820, 780, 740],
    ];
    const join = buildAgentFindingsSurvivalJoin({
      anchorCommit: ANCHOR,
      inputs: directionalCohort(divergent[0], divergent[1]),
    });
    expect(join.correlationWindowDays).toBe(21);
    expect(join.volumeControlledCorrelation.verdict).toBe(
      FindingsSurvivalCorrelationVerdict.Positive
    );
    expect(renderAgentFindingsSurvivalReport(join)).toContain("at 21d");

    const atFourteen = buildAgentFindingsSurvivalJoin({
      anchorCommit: ANCHOR,
      correlationWindowDays: 14,
      inputs: directionalCohort(divergent[0], divergent[1], 14),
    });
    expect(atFourteen.correlationWindowDays).toBe(14);
    expect(atFourteen.volumeControlledCorrelation.verdict).toBe(
      FindingsSurvivalCorrelationVerdict.Negative
    );
  });

  it("reports a positive association when survival rises with findings", () => {
    const join = buildAgentFindingsSurvivalJoin({
      anchorCommit: ANCHOR,
      inputs: directionalCohort([700, 740, 780, 820, 860]),
    });
    expect(join.volumeControlledCorrelation.verdict).toBe(
      FindingsSurvivalCorrelationVerdict.Positive
    );
    expect(join.rawCorrelation.verdict).toBe(
      FindingsSurvivalCorrelationVerdict.Positive
    );
    expect(join.volumeControlledCorrelation.pairs).toBe(5);
  });

  it("reports a negative association as a result, not as an absence", () => {
    const join = buildAgentFindingsSurvivalJoin({
      anchorCommit: ANCHOR,
      inputs: directionalCohort([900, 860, 820, 780, 740]),
    });
    expect(join.volumeControlledCorrelation.verdict).toBe(
      FindingsSurvivalCorrelationVerdict.Negative
    );
    expect(join.volumeControlledCorrelation.coefficient).toBeLessThan(0);
    expect(join.volumeControlledCorrelation.pairs).toBe(5);
  });

  it("reports unknown, never a zero coefficient, when the cohort cannot support one", () => {
    const join = buildAgentFindingsSurvivalJoin({
      anchorCommit: ANCHOR,
      inputs: [agent("only-one")],
    });
    expect(join.volumeControlledCorrelation.verdict).toBe(
      FindingsSurvivalCorrelationVerdict.Unknown
    );
    expect(join.volumeControlledCorrelation.coefficient).toBeUndefined();
    expect(join.volumeControlledCorrelation.pairs).toBe(1);
    expect(join.rawCorrelation.verdict).toBe(
      FindingsSurvivalCorrelationVerdict.Unknown
    );
  });

  it("reports unknown rather than a coefficient when volume is collinear with findings", () => {
    // Volume tracks findings exactly, so no association between findings and
    // survival survives holding volume constant — there is nothing left to
    // vary. The raw figure is published beside it rather than instead of it.
    const inputs = [1, 2, 3, 4, 5, 6].map((step, index) =>
      agent(`agent-${index}`, {
        reviewers: [measured(step, 0)],
        linesAdded: 100 * step,
        linesRemoved: 0,
        survived21: 500 + step * 50,
        survived14: 500 + step * 50,
      })
    );
    const join = buildAgentFindingsSurvivalJoin({
      anchorCommit: ANCHOR,
      inputs,
    });
    expect(join.rawCorrelation.verdict).toBe(
      FindingsSurvivalCorrelationVerdict.Positive
    );
    expect(join.volumeControlledCorrelation.verdict).toBe(
      FindingsSurvivalCorrelationVerdict.Unknown
    );
  });

  it("does not call a five-agent cohort a direction on the coefficient alone", () => {
    // Survival rises with findings but not monotonically, so |r| clears the
    // 0.2 threshold while five points cannot say the association is not zero.
    // Reading the verdict off |r| alone printed this as a POSITIVE finding.
    const join = buildAgentFindingsSurvivalJoin({
      anchorCommit: ANCHOR,
      inputs: directionalCohort([820, 800, 850, 830, 870]),
    });
    expect(
      Math.abs(join.rawCorrelation.coefficient ?? 0)
    ).toBeGreaterThanOrEqual(0.2);
    expect(join.rawCorrelation.verdict).toBe(
      FindingsSurvivalCorrelationVerdict.Unknown
    );
    // The coefficient it could not decide is still published.
    expect(join.rawCorrelation.interval).toBeDefined();
  });

  it("excludes every copy of a duplicated agent instead of counting it twice", () => {
    const join = buildAgentFindingsSurvivalJoin({
      anchorCommit: ANCHOR,
      inputs: [agent("twice"), agent("twice"), agent("once")],
    });
    expect(join.rows.map((row) => row.agentId)).toEqual(["once"]);
    expect(join.excludedAgents).toBe(2);
    expect(findingsSurvivalExclusionCounts(join)).toEqual(
      exclusionCounts({ [FindingsSurvivalExclusion.DuplicateAgent]: 2 })
    );
  });

  it("refuses operands gathered over a different span than the window", () => {
    const join = buildAgentFindingsSurvivalJoin({
      anchorCommit: ANCHOR,
      inputs: [
        agent("matched"),
        agent("other-span", { spanDays: 14 }),
        agent("no-span", { spanDays: 0 }),
        agent("fractional-span", { spanDays: 10.5 }),
      ],
    });
    expect(join.rows.map((row) => row.agentId)).toEqual(["matched"]);
    expect(join.rows[0]?.observedSpanDays).toBe(21);
    expect(findingsSurvivalExclusionCounts(join)).toEqual(
      exclusionCounts({
        [FindingsSurvivalExclusion.SpanMismatch]: 1,
        [FindingsSurvivalExclusion.InadmissibleSpan]: 2,
      })
    );
  });

  it("excludes an agent whose confirmed-findings total is no longer exact", () => {
    // Each reading is individually a safe integer; the SUM is not, so the
    // aggregate would be silently rounded and then correlated as a measurement.
    const half = Math.floor(Number.MAX_SAFE_INTEGER / 2);
    const join = buildAgentFindingsSurvivalJoin({
      anchorCommit: ANCHOR,
      inputs: [
        agent("overflowing", {
          reviewers: [measured(half, 0), measured(half, 0), measured(half, 0)],
        }),
      ],
    });
    expect(join.rows).toEqual([]);
    expect(findingsSurvivalExclusionCounts(join)).toEqual(
      exclusionCounts({
        [FindingsSurvivalExclusion.InadmissibleConfirmedFindings]: 1,
      })
    );
  });

  it("refuses a window set it cannot take a correlation at", () => {
    // An empty set made the default window -Infinity, which no row carries:
    // every verdict read unknown and the report printed "at -Infinityd".
    expect(() =>
      buildAgentFindingsSurvivalJoin({
        anchorCommit: ANCHOR,
        inputs: [agent("a")],
        windowDays: [],
      })
    ).toThrow(NO_WINDOW_SET);
    expect(() =>
      buildAgentFindingsSurvivalJoin({
        anchorCommit: ANCHOR,
        inputs: [agent("a")],
        windowDays: [14, 21],
        correlationWindowDays: 30,
      })
    ).toThrow(WINDOW_NOT_REQUESTED);
    expect(() =>
      buildAgentFindingsSurvivalJoin({
        anchorCommit: ANCHOR,
        inputs: [agent("a")],
        windowDays: [0],
      })
    ).toThrow(WINDOW_NOT_WHOLE_DAYS);
    expect(() =>
      buildAgentFindingsSurvivalJoin({
        anchorCommit: ANCHOR,
        inputs: [agent("a")],
        windowDays: [21, 21],
      })
    ).toThrow(WINDOW_REPEATED);
  });
});

describe("renderAgentFindingsSurvivalReport", () => {
  it("prints the anchor, the populations and every confound with the result", () => {
    const join = buildAgentFindingsSurvivalJoin({
      anchorCommit: ANCHOR,
      inputs: [
        agent("agent-a", { reviewers: [measured(6, 2)] }),
        {
          ...agent("no-lines"),
          linesAdded: undefined,
          linesRemoved: undefined,
        },
      ],
    });
    const report = renderAgentFindingsSurvivalReport(join);
    expect(report).toContain(ANCHOR);
    expect(report).toContain("cohort: 1 of 2 agents; 1 excluded");
    expect(report).toContain("no produced-line figure reached the agent: 1");
    expect(report).toContain("confirmed findings 4 across 1 of 1 reviewers");
    for (const confound of FINDINGS_SURVIVAL_CONFOUNDS) {
      expect(report).toContain(confound);
    }
  });

  it("never prints a percentage without its population and window", () => {
    const join = buildAgentFindingsSurvivalJoin({
      anchorCommit: ANCHOR,
      inputs: [agent("agent-a")],
    });
    const report = renderAgentFindingsSurvivalReport(join);
    for (const line of report.split("\n")) {
      if (!line.includes("%")) {
        continue;
      }
      expect(line).toMatch(WINDOW_LABEL);
      expect(line).toMatch(POPULATION_LABEL);
    }
  });

  it("gives a null and a negative result the same prominence as a positive one", () => {
    const shapes = [
      // A null is a MEASURED null, so it needs a cohort whose interval fits
      // inside the threshold; five agents can never supply one.
      {
        inputs: nullCohort(),
        verdict: FindingsSurvivalCorrelationVerdict.Null,
      },
      {
        inputs: directionalCohort([900, 860, 820, 780, 740]),
        verdict: FindingsSurvivalCorrelationVerdict.Negative,
      },
      {
        inputs: directionalCohort([700, 740, 780, 820, 860]),
        verdict: FindingsSurvivalCorrelationVerdict.Positive,
      },
    ];
    for (const { inputs, verdict } of shapes) {
      const join = buildAgentFindingsSurvivalJoin({
        anchorCommit: ANCHOR,
        inputs,
      });
      expect(join.volumeControlledCorrelation.verdict).toBe(verdict);
      const report = renderAgentFindingsSurvivalReport(join);
      expect(report).toContain(
        "Does survival rise with reviewer confirmed findings?"
      );
      expect(report).toContain(`volume-controlled: ${verdict.toUpperCase()}`);
      expect(report).toContain("raw (volume NOT held constant)");
      expect(report).toContain("null threshold |r| < 0.2");
    }
  });
});
