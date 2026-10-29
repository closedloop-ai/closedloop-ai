import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { LocPerDollarCoverageState } from "@repo/api/src/types/loc-per-dollar-coverage";
import { describe, expect, it } from "vitest";
import {
  DiffVerdict,
  diffUsageSummary,
  EXPECTED_MOVEMENT,
  EXPECTED_TRANSITIONS,
  FLOAT_FIELDS,
  summarizeDiff,
} from "@/app/agent-sessions/service/usage-summary-differ";

const base = {
  totalSessions: 64,
  totalInputTokens: 1200,
  earliestSessionAt: "2026-01-01T00:00:00.000Z",
  totalEstimatedCost: 12.345_678,
  mergedPrCount: 4,
} as unknown as AgentSessionUsageSummary;

const ALL = new Set(Object.keys(base));

/** The ticket or decision an allowlisted movement must cite. */
const ALLOWLIST_REASON = /ISS-8557|D3/;

/** The note a sanctioned (live, candidate) PAIR carries (ISS-9902). */
const SANCTIONED_TRANSITION = /Sanctioned transition/;

/** The note the bare coverage key carries, now that it covers presence only. */
const PRESENCE_ONLY = /PRESENCE ONLY/;

/**
 * Every field the allowlist sanctions, RESTATED rather than read from
 * `EXPECTED_MOVEMENT`. Same reason as `EXPECTED_FLOAT_FIELDS` below: an oracle
 * derived from the map mutates along with it and cannot fail (ISS-9975).
 *
 * The drift guard pins the direction the per-field cases cannot. A key REMOVED
 * or blanked demotes a sanctioned movement to a defect, which a shadow run
 * shows; a key ADDED silently sanctions a real divergence, and nothing else
 * here would notice — `EXPECTED_MOVEMENT.has("byUser")` covers one field, by
 * name. Listing the keys makes both visible, and forces an addition to be
 * DECIDED rather than typed.
 */
const EXPECTED_MOVEMENT_FIELDS = [
  "mergedPrCount",
  "medianPrSize",
  "mergedLocPerDollar",
  "mergedLocPerDollarCoverage",
  "mergedLocPerDollarCoverage.numeratorSessionCount",
  "mergedLocPerDollarCoverage.excludedSessionCount",
  "mergedKlocPerDollar",
  "byModel",
  "penseroPointsPerDollar",
] as const;

describe("diffUsageSummary", () => {
  it("reports identical responses as all matched", () => {
    const report = diffUsageSummary(base, { ...base }, ALL);
    expect(report.defects).toEqual([]);
    expect(report.expected).toEqual([]);
    expect(report.matchedCount).toBe(Object.keys(base).length);
  });

  it("calls an unsanctioned difference a defect", () => {
    const report = diffUsageSummary(base, { ...base, totalSessions: 63 }, ALL);
    expect(report.defects).toHaveLength(1);
    expect(report.defects[0]).toMatchObject({
      field: "totalSessions",
      verdict: DiffVerdict.Defect,
      current: 64,
      candidate: 63,
    });
  });

  it("calls a sanctioned difference expected, and says why", () => {
    const report = diffUsageSummary(base, { ...base, mergedPrCount: 7 }, ALL);
    expect(report.defects).toEqual([]);
    expect(report.expected).toHaveLength(1);
    // The reason travels with the finding — a reviewer should not have to go
    // looking for why a movement was allowed.
    expect(report.expected[0]?.note).toMatch(ALLOWLIST_REASON);
  });

  it("every allowlist entry carries a reason, not just a field name", () => {
    for (const [field, reason] of EXPECTED_MOVEMENT) {
      expect(reason.length, `${field} has an empty reason`).toBeGreaterThan(20);
    }
  });

  it("sanctions exactly the fields that were decided, and no others", () => {
    expect([...EXPECTED_MOVEMENT.keys()].sort()).toEqual(
      [...EXPECTED_MOVEMENT_FIELDS].sort()
    );
  });
});

/**
 * The float fields, RESTATED rather than read from `FLOAT_FIELDS`.
 *
 * Restating is the point. The first version of this block drove `describe.each`
 * from the set itself, and Stryker showed it killed nothing: mutating an entry
 * to `""` also changes what the loop iterates, so the test mutates along with
 * the code and passes either way. A test whose expectation comes from the thing
 * under test cannot fail.
 *
 * So this list is the ORACLE and `agrees with FLOAT_FIELDS` below is the drift
 * guard — that pairing is what makes a renamed, dropped or added entry visible,
 * while the per-field cases prove each one actually receives the tolerance.
 */
const EXPECTED_FLOAT_FIELDS = [
  "totalEstimatedCost",
  "subscriptionEstimatedCost",
  "apiEstimatedCost",
  "meteredEstimatedCost",
  "unknownEstimatedCost",
  "mergedLocPerDollar",
  "mergedKlocPerDollar",
  "medianPrSize",
  "mergedLocPerDollarCoverage.costBasisCoveredUsd",
  "mergedLocPerDollarCoverage.costBasisExcludedUsd",
] as const;

/**
 * A fixture carrying exactly one float field, nested when the key is dotted.
 */
function withFloat(field: string, value: number): AgentSessionUsageSummary {
  const [head, tail] = field.split(".");
  const patch = tail ? { [head]: { [tail]: value } } : { [head]: value };
  return { ...base, ...patch } as unknown as AgentSessionUsageSummary;
}

describe("float tolerance", () => {
  it("agrees with FLOAT_FIELDS, so a new or renamed entry is not silently untested", () => {
    expect([...FLOAT_FIELDS].sort()).toEqual([...EXPECTED_FLOAT_FIELDS].sort());
  });

  describe.each(EXPECTED_FLOAT_FIELDS)("%s", (field) => {
    const COVERED = new Set([...ALL, field.split(".")[0]]);

    it("treats sub-epsilon drift as a MATCH", () => {
      // Stryker found this hole: dropping a field from FLOAT_FIELDS makes it
      // compare exactly, and for six of the ten nothing noticed. Only
      // `totalEstimatedCost` had a case, and the fixture did not even carry the
      // other values. Same class a reviewer caught in the two nested
      // `costBasis*Usd` entries; the top-level siblings had it too.
      const report = diffUsageSummary(
        withFloat(field, 10.5),
        withFloat(field, 10.5 + 1e-9),
        COVERED
      );

      expect(report.defects).toEqual([]);
      expect(report.expected).toEqual([]);
    });

    it("still reports a difference that exceeds the epsilon", () => {
      const report = diffUsageSummary(
        withFloat(field, 10.5),
        withFloat(field, 11.5),
        COVERED
      );

      // Some of these are sanctioned in EXPECTED_MOVEMENT, so a real move lands
      // in `expected` rather than `defects`. Either way it must be REPORTED —
      // what the mutation removes is the ability to compare with a tolerance.
      expect([...report.defects, ...report.expected]).toHaveLength(1);
    });
  });
});

describe("numeric comparison", () => {
  it("tolerates sub-millionth cost drift, which is representation not disagreement", () => {
    const report = diffUsageSummary(
      base,
      { ...base, totalEstimatedCost: 12.345_678_1 },
      ALL
    );
    expect(report.defects).toEqual([]);
    expect(report.matchedCount).toBe(Object.keys(base).length);
  });

  it("does NOT tolerate the same drift on an integer count", () => {
    // A tolerance on counts would hide a real off-by-one, so token and session
    // counts compare exactly.
    const report = diffUsageSummary(
      base,
      { ...base, totalInputTokens: 1201 },
      ALL
    );
    expect(report.defects).toHaveLength(1);
    expect(report.defects[0]?.field).toBe("totalInputTokens");
  });

  it("catches a cost difference that exceeds the epsilon", () => {
    const report = diffUsageSummary(
      base,
      { ...base, totalEstimatedCost: 12.35 },
      ALL
    );
    expect(report.defects).toHaveLength(1);
  });
});

describe("absent versus null", () => {
  it("does not let a missing field pass as a documented null", () => {
    // `earliestSessionAt: null` means "no sessions matched" and is a real
    // answer. An absent field means the producer did not answer at all.
    const report = diffUsageSummary(
      { ...base, earliestSessionAt: null },
      { ...base, earliestSessionAt: undefined },
      ALL
    );
    expect(report.defects).toHaveLength(1);
    expect(report.defects[0]?.field).toBe("earliestSessionAt");
  });

  it("matches null against null", () => {
    const report = diffUsageSummary(
      { ...base, earliestSessionAt: null },
      { ...base, earliestSessionAt: null },
      ALL
    );
    expect(report.defects).toEqual([]);
  });
});

describe("coverage", () => {
  it("reports an uncovered field as not-compared rather than matched", () => {
    const covered = new Set(["totalSessions"]);
    const report = diffUsageSummary(base, { ...base }, covered);
    expect(report.matchedCount).toBe(1);
    expect(report.notCompared.map((d) => d.field)).toContain("mergedPrCount");
  });

  it("takes coverage from the caller, not from the candidate's own keys", () => {
    // A candidate omitting a field because it CANNOT produce it looks identical
    // to one omitting it because the value is absent. Only the caller knows.
    const report = diffUsageSummary(base, {}, new Set(["totalSessions"]));
    expect(report.defects).toHaveLength(1);
    expect(report.defects[0]?.field).toBe("totalSessions");
  });
});

describe("summarizeDiff", () => {
  it("refuses to call a run clean while anything is uncompared", () => {
    const report = diffUsageSummary(
      base,
      { ...base },
      new Set(["totalSessions"])
    );
    const { clean, line } = summarizeDiff(report);
    // Zero defects over one field of five is not parity, and the flag must not
    // open on it.
    expect(report.defects).toEqual([]);
    expect(clean).toBe(false);
    expect(line).toContain("not compared");
  });

  it("is clean only with full coverage and no defects", () => {
    expect(summarizeDiff(diffUsageSummary(base, { ...base }, ALL)).clean).toBe(
      true
    );
  });

  it("stays unclean when an allowlisted movement hides a defect elsewhere", () => {
    const report = diffUsageSummary(
      base,
      { ...base, mergedPrCount: 9, totalSessions: 1 },
      ALL
    );
    expect(summarizeDiff(report).clean).toBe(false);
    expect(report.expected).toHaveLength(1);
    expect(report.defects).toHaveLength(1);
  });
});

describe("the regression this differ exists for", () => {
  // 6a7208486: statement 5 returned facet COUNTS only, dropping every _sum the
  // Prisma groupBys carried. Nothing consumed it yet, so no test could fail and
  // no query errored — the rows were simply thinner than the contract. This is
  // that defect, replayed.
  const withSums = {
    totalSessions: 64,
    byUser: [
      {
        userId: "u1",
        userName: "A",
        userEmail: "a@x",
        userAvatarUrl: null,
        sessionCount: 41,
        inputTokens: 9000,
        outputTokens: 450,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 3.25,
      },
    ],
  } as unknown as AgentSessionUsageSummary;

  const countsOnly = {
    totalSessions: 64,
    byUser: [{ userId: "u1", sessionCount: 41 }],
  } as unknown as Partial<AgentSessionUsageSummary>;

  it("catches a breakdown that lost its sums", () => {
    const report = diffUsageSummary(
      withSums,
      countsOnly,
      new Set(["totalSessions", "byUser"])
    );
    expect(report.defects).toHaveLength(1);
    expect(report.defects[0]?.field).toBe("byUser");
    expect(summarizeDiff(report).clean).toBe(false);
  });

  it("does not excuse it as an allowlisted movement", () => {
    // byUser is not in EXPECTED_MOVEMENT, and a thinner row is not a number
    // the plan sanctioned moving.
    expect(EXPECTED_MOVEMENT.has("byUser")).toBe(false);
  });
});

/**
 * Every (live, candidate) pair the transition list sanctions, RESTATED rather
 * than read from `EXPECTED_TRANSITIONS`. Same oracle rule as the two lists
 * above.
 *
 * The two cases below pin the two DECIDED answers by name, so ADDING
 * `[MigrationPending, Complete]` does go red. What they cannot see is a pair
 * they never mention: appending `[Stale, Complete]` sanctions divergence (b) in
 * the map's own docstring — a mid-flight rebuild publishing a ratio — and every
 * case in this file stays green.
 */
const EXPECTED_TRANSITION_PAIRS: ReadonlyArray<
  readonly [string, unknown, unknown]
> = [
  [
    "mergedLocPerDollarCoverage.state",
    LocPerDollarCoverageState.Missing,
    LocPerDollarCoverageState.Complete,
  ],
];

/**
 * ISS-9902 — object-valued fields are DESCENDED, not compared whole.
 *
 * Before this, `classify` looked `EXPECTED_MOVEMENT` up by top-level field name
 * and `valuesAgree` compared objects with `JSON.stringify`. Sanctioning
 * `mergedLocPerDollarCoverage` therefore sanctioned all six of its sub-fields at
 * once, and the shadow run reported `clean` while a real defect sat inside the
 * object. `summarizeDiff` gates the cutover flag on that boolean, so the one
 * mechanism standing between the candidate and production could not see the
 * class of defect it most needed to.
 */
describe("object-valued fields (ISS-9902)", () => {
  const coverage = {
    state: LocPerDollarCoverageState.Complete,
    numeratorSessionCount: 3,
    denominatorSessionCount: 3,
    excludedSessionCount: 0,
    costBasisCoveredUsd: 10.5,
    costBasisExcludedUsd: 0,
  };
  const withCoverage = {
    ...base,
    mergedLocPerDollarCoverage: coverage,
  } as unknown as AgentSessionUsageSummary;
  const COVERED = new Set(Object.keys(withCoverage));

  function diffCoverage(candidateCoverage: Record<string, unknown>) {
    return diffUsageSummary(
      withCoverage,
      {
        ...withCoverage,
        mergedLocPerDollarCoverage: candidateCoverage,
      } as unknown as AgentSessionUsageSummary,
      COVERED
    );
  }

  it("sanctions exactly the transitions that were decided, and no others", () => {
    const sanctioned = [...EXPECTED_TRANSITIONS].flatMap(([field, pairs]) =>
      pairs.map(([live, candidate]) => [field, live, candidate])
    );
    expect(sanctioned).toEqual(EXPECTED_TRANSITION_PAIRS);
  });

  it("calls a MigrationPending -> Complete state move a DEFECT", () => {
    // THE REGRESSION THIS ISSUE IS ABOUT. Live folds migration_pending from the
    // UNWINDOWED delivery rows and the candidate counts it over the WINDOWED
    // numerator; MigrationPending OUTRANKS Missing in `resolveCoverageState`, so
    // this pair is a mid-flight rebuild publishing a ratio. Sanctioning the
    // FIELD would score it expected; sanctioning the TRANSITION does not.
    const live = {
      ...withCoverage,
      mergedLocPerDollarCoverage: {
        ...coverage,
        state: LocPerDollarCoverageState.MigrationPending,
      },
    } as unknown as AgentSessionUsageSummary;

    const report = diffUsageSummary(
      live,
      { ...withCoverage } as unknown as AgentSessionUsageSummary,
      COVERED
    );

    expect(report.defects).toHaveLength(1);
    expect(report.defects[0]).toMatchObject({
      field: "mergedLocPerDollarCoverage.state",
      verdict: DiffVerdict.Defect,
      current: LocPerDollarCoverageState.MigrationPending,
      candidate: LocPerDollarCoverageState.Complete,
    });
    expect(summarizeDiff(report).clean).toBe(false);
  });

  it("calls the Missing -> Complete state move EXPECTED, and says so", () => {
    // The one sanctioned transition (ISS-9754, ruled 2026-09-09).
    const live = {
      ...withCoverage,
      mergedLocPerDollarCoverage: {
        ...coverage,
        state: LocPerDollarCoverageState.Missing,
      },
    } as unknown as AgentSessionUsageSummary;

    const report = diffUsageSummary(
      live,
      { ...withCoverage } as unknown as AgentSessionUsageSummary,
      COVERED
    );

    expect(report.defects).toEqual([]);
    const stateDiff = report.expected.find(
      (d) => d.field === "mergedLocPerDollarCoverage.state"
    );
    expect(stateDiff?.verdict).toBe(DiffVerdict.Expected);
    expect(stateDiff?.note).toMatch(SANCTIONED_TRANSITION);
  });

  it("judges an UNLISTED sub-field even though the parent is sanctioned", () => {
    // `denominatorSessionCount` is deliberately absent from EXPECTED_MOVEMENT.
    // Under the old whole-object comparison this scored `expected` purely
    // because its parent key was listed.
    const report = diffCoverage({ ...coverage, denominatorSessionCount: 99 });

    expect(report.defects).toHaveLength(1);
    expect(report.defects[0]?.field).toBe(
      "mergedLocPerDollarCoverage.denominatorSessionCount"
    );
  });

  // BOTH nested USD fields, parameterised. Exercising only the covered one left
  // the excluded one's FLOAT_FIELDS entry free to be mistyped or dropped: its
  // sub-epsilon drift would then score a DEFECT, taking the shadow run
  // not-clean and holding the cutover gate, while this suite still passed
  // (davetho on #6965).
  for (const field of [
    "costBasisCoveredUsd",
    "costBasisExcludedUsd",
  ] as const) {
    it(`gives nested ${field} the same epsilon a top-level float gets`, () => {
      // FLOAT_FIELDS is keyed by name, so before the dotted entries these were
      // compared by JSON.stringify and a sixth-decimal difference read as a
      // full-object disagreement.
      const report = diffCoverage({
        ...coverage,
        [field]: coverage[field] + 1e-9,
      });

      expect(report.defects).toEqual([]);
      expect(report.expected).toEqual([]);
    });

    it(`still reports a real dollar error in nested ${field}`, () => {
      const report = diffCoverage({
        ...coverage,
        [field]: coverage[field] + 1,
      });

      expect(report.defects).toHaveLength(1);
      expect(report.defects[0]?.field).toBe(
        `mergedLocPerDollarCoverage.${field}`
      );
    });
  }

  it("sanctions PRESENCE at the parent key, without descending", () => {
    // Absent on one side: there is no pair of objects to walk, and "the
    // candidate omits this" is ONE fact rather than six.
    const report = diffUsageSummary(
      withCoverage,
      { ...base } as unknown as AgentSessionUsageSummary,
      COVERED
    );

    expect(report.defects).toEqual([]);
    expect(report.expected).toHaveLength(1);
    expect(report.expected[0]?.field).toBe("mergedLocPerDollarCoverage");
    expect(report.expected[0]?.note).toMatch(PRESENCE_ONLY);
  });

  it("does NOT descend into arrays", () => {
    // Keying diffs by array INDEX would report every position after an inserted
    // element as a defect, and would explode a decided removal into one entry
    // per row instead of one saying the field is gone.
    const live = {
      ...base,
      byModel: [{ model: "opus", sessions: 1 }],
    } as unknown as AgentSessionUsageSummary;
    const report = diffUsageSummary(
      live,
      { ...base, byModel: [] } as unknown as AgentSessionUsageSummary,
      new Set([...ALL, "byModel"])
    );

    const byModel = [...report.defects, ...report.expected].filter((d) =>
      d.field.startsWith("byModel")
    );
    expect(byModel).toHaveLength(1);
    expect(byModel[0]?.field).toBe("byModel");
  });
});

/**
 * A delta whose OPERAND is sanctioned (ISS-10867, tamsinb on #7751).
 *
 * `comparison.deltas.prsShipped` divides `mergedPrCount` by the prior window's,
 * so the D3 population that sanctions the operand moves the delta with it. It
 * stays a DEFECT anyway: the prior operand reaches the report through this
 * delta and nothing else, so an entry would retire the only witness to the
 * candidate's prior-window read.
 *
 * The dotted key is written out rather than read from `EXPECTED_MOVEMENT` or
 * built from the metric const, so adding the entry turns this case red rather
 * than mutating its own oracle (ISS-9975). It is also the only case here that
 * descends TWO levels, which is what produces that key at all.
 */
describe("a delta whose operand is sanctioned", () => {
  const comparison = {
    priorStartDate: "2026-01-01T00:00:00.000Z",
    priorEndDate: "2026-01-07T23:59:59.999Z",
    deltas: { prsShipped: 25 },
  };
  const live = { ...base, comparison } as unknown as AgentSessionUsageSummary;
  const COMPARED = new Set(Object.keys(live));

  it("keeps a prsShipped divergence a defect while its operand reads expected", () => {
    const report = diffUsageSummary(
      live,
      {
        ...base,
        mergedPrCount: 7,
        comparison: { ...comparison, deltas: { prsShipped: 60 } },
      } as unknown as AgentSessionUsageSummary,
      COMPARED
    );

    expect(report.expected.map((diff) => diff.field)).toEqual([
      "mergedPrCount",
    ]);
    expect(report.defects).toHaveLength(1);
    expect(report.defects[0]).toMatchObject({
      field: "comparison.deltas.prsShipped",
      verdict: DiffVerdict.Defect,
      current: 25,
      candidate: 60,
    });
  });

  it("reports the delta appearing on only one side, rather than skipping it", () => {
    // `pctDelta` OMITS an entry it declines to state, so one side carrying the
    // key and the other not is an ordinary production shape, not a producer bug.
    const report = diffUsageSummary(
      live,
      {
        ...base,
        comparison: { ...comparison, deltas: {} },
      } as unknown as AgentSessionUsageSummary,
      COMPARED
    );

    expect(report.defects.map((diff) => diff.field)).toEqual([
      "comparison.deltas.prsShipped",
    ]);
  });
});
