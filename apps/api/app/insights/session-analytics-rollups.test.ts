import { SpendOutcome } from "@closedloop-ai/loops-api/insights";
import { LossClass, ModelVerdict } from "@repo/api/src/types/session-analytics";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, expect, it } from "vitest";
import {
  foldBehavioralCauses,
  foldPeople,
  foldSystemicCauses,
  foldTotals,
  foldTrend,
  MIN_BASELINE_SESSIONS,
  toLostSessionRows,
} from "./lost-work";
import type {
  LossPersonGridRow,
  LossTrendGridRow,
  LostSessionCandidate,
} from "./lost-work-queries";
import type { SignalGridRow } from "./session-analytics-sql";
import {
  foldModelRows,
  foldOutcomeRows,
  foldWasteEstimate,
  MIN_GRADED_SESSIONS,
} from "./tokenops-waste";
import type {
  ModelMedianRow,
  ModelSpendGridRow,
  SpendGridRow,
} from "./tokenops-waste-queries";

/**
 * The rest of the ported prototype reconciliation suite: the totals a screen
 * shows must reconcile with the rows they are made of, and an estimate must
 * stay visibly separate from — and inside — the facts it was derived from.
 */

const CENTS = 2;
const TENTHS = 1;
const MINUTES_PER_HOUR = 60;

function gridRow(overrides: Partial<SignalGridRow> = {}): SignalGridRow {
  return {
    endsWithError: null,
    hasWallClock: true,
    minutes: 60,
    producedArtifact: false,
    sessions: 1,
    status: SESSION_STATUS.INACTIVE,
    throttleSource: null,
    ...overrides,
  };
}

/** A population covering productive work and all three loss classes. */
const GRID: SignalGridRow[] = [
  // Produced an artifact: productive, never a loss class.
  gridRow({
    endsWithError: false,
    minutes: 300,
    producedArtifact: true,
    sessions: 5,
  }),
  // Coachable: errored, no throttle, nothing to show for it.
  gridRow({
    endsWithError: true,
    minutes: 120,
    sessions: 3,
    status: SESSION_STATUS.ERROR,
  }),
  gridRow({
    endsWithError: true,
    minutes: 90,
    sessions: 2,
    status: SESSION_STATUS.INACTIVE,
  }),
  // Systemic: a platform throttle is on the record.
  gridRow({
    endsWithError: true,
    minutes: 200,
    sessions: 4,
    status: SESSION_STATUS.ERROR,
    throttleSource: "usage_limit",
  }),
  gridRow({
    endsWithError: true,
    minutes: 45,
    sessions: 1,
    status: SESSION_STATUS.ERROR,
    throttleSource: "provider_rate_limit",
  }),
  // Unattributed: the outcome was never recorded.
  gridRow({ endsWithError: null, minutes: 75, sessions: 2 }),
  // Ended clean without an artifact: NOT lost work, and not a fabricated loss.
  gridRow({ endsWithError: false, minutes: 40, sessions: 2 }),
  // Consumed no wall-clock: never counted as lost.
  gridRow({
    endsWithError: true,
    hasWallClock: false,
    minutes: 0,
    sessions: 1,
  }),
];

describe("lost-work totals reconcile with the rows that make them up", () => {
  const totals = foldTotals(GRID);

  it("splits every minute of wall-clock into productive or exactly one loss class", () => {
    const split =
      totals.productiveMinutes +
      totals.minutesByClass[LossClass.Actionable] +
      totals.minutesByClass[LossClass.Systemic] +
      totals.minutesByClass[LossClass.Unattributed];
    expect(split).toBe(totals.totalMinutes);
  });

  it("counts every session in the window exactly once", () => {
    const expected = GRID.reduce((sum, row) => sum + row.sessions, 0);
    expect(totals.sessionCount).toBe(expected);
  });

  it("keeps a clean session with no artifact out of the loss classes entirely", () => {
    // 40 minutes of clean-but-artifactless work is productive time, not loss.
    // Grading it would invent loss that was never observed.
    expect(totals.minutesByClass[LossClass.Unattributed]).toBe(75);
  });

  it("ranks systemic causes against their own class, naming each source", () => {
    const causes = foldSystemicCauses(GRID);
    expect(causes.map((cause) => cause.label)).toEqual([
      "Usage limit",
      "Provider rate limit",
    ]);
    const summed = causes.reduce((sum, cause) => sum + cause.minutes, 0);
    expect(summed).toBe(totals.minutesByClass[LossClass.Systemic]);
  });

  it("ranks behavioral causes against the coachable class only", () => {
    const causes = foldBehavioralCauses(GRID);
    const summed = causes.reduce((sum, cause) => sum + cause.minutes, 0);
    expect(summed).toBe(totals.minutesByClass[LossClass.Actionable]);
    // ISS-4654: this used to also assert an "Abandoned mid-run" cause. That
    // split read off AgentSessionState.Abandoned, which is retired — no other
    // signal separates a swept-idle run from a dead-ended one — so every
    // actionable loss now reports one cause. The reconciliation above is the
    // real contract and still holds; what changed is the number of buckets it
    // reconciles across, so pin that rather than leaving the assertion loose.
    expect(causes.map((cause) => cause.label)).toEqual([
      "Ended with error, no artifact",
    ]);
  });

  it("emits an explicit zero for a day with no sessions", () => {
    // The chart plots points as adjacent categories and fills between them, so
    // an absent day is not a gap on screen — it puts Jul 20 beside Jul 24 and
    // draws four quiet days as a smooth ramp of accruing lost hours.
    const days = [
      "2026-07-20",
      "2026-07-21",
      "2026-07-22",
      "2026-07-23",
      "2026-07-24",
    ];
    const sparse: LossTrendGridRow[] = GRID.flatMap((row) => [
      { ...row, day: "2026-07-20" },
      { ...row, day: "2026-07-24" },
    ]);

    const points = foldTrend(sparse, days);

    expect(points.map((point) => point.date)).toEqual(days);
    for (const date of ["2026-07-21", "2026-07-22", "2026-07-23"]) {
      const gap = points.find((point) => point.date === date);
      expect(gap?.values[LossClass.Actionable]).toBe(0);
      expect(gap?.values[LossClass.Systemic]).toBe(0);
      expect(gap?.values[LossClass.Unattributed]).toBe(0);
    }
    // The measured days still carry their real loss — zero-filling must not
    // dilute what was actually observed.
    const chartedActionable = points.reduce(
      (sum, point) => sum + point.values[LossClass.Actionable],
      0
    );
    expect(chartedActionable).toBeGreaterThan(0);
  });

  it("sums the trend series back to the class totals it is split from", () => {
    const day = "2026-07-20";
    const other = "2026-07-21";
    const trendRows: LossTrendGridRow[] = GRID.flatMap((row) => [
      { ...row, day },
      { ...row, day: other },
    ]);
    const points = foldTrend(trendRows, [day, other]);
    expect(points).toHaveLength(2);
    for (const lossClass of [
      LossClass.Actionable,
      LossClass.Systemic,
      LossClass.Unattributed,
    ]) {
      const charted = points.reduce(
        (sum, point) => sum + point.values[lossClass],
        0
      );
      // Two identical days, so the charted total is twice the single-day total.
      expect(charted).toBeCloseTo(
        (totals.minutesByClass[lossClass] * 2) / MINUTES_PER_HOUR,
        TENTHS
      );
    }
  });
});

function personRow(
  overrides: Partial<LossPersonGridRow> = {}
): LossPersonGridRow {
  return {
    ...gridRow(),
    engineer: "Dana Whitaker",
    isEarly: false,
    userId: "user-1",
    ...overrides,
  };
}

describe("the person table never lets a rate be read as a total", () => {
  it("sums every person's session count back to the denominator on screen", () => {
    const rows: LossPersonGridRow[] = [
      personRow({ endsWithError: true, minutes: 120, sessions: 3 }),
      personRow({
        endsWithError: null,
        engineer: "Marcus Iyer",
        minutes: 60,
        sessions: 2,
        userId: "user-2",
      }),
    ];
    const people = foldPeople(rows);
    const summed = people.reduce((sum, row) => sum + row.sessionCount, 0);
    expect(summed).toBe(5);
  });

  it("returns a null baseline rather than a zero when a half is too thin", () => {
    const rows: LossPersonGridRow[] = [
      personRow({ isEarly: true, sessions: 1 }),
      personRow({ isEarly: false, sessions: 1 }),
    ];
    const [person] = foldPeople(rows);
    // Null, not 0. A `0` here would read as "held steady", which is a finding
    // this data cannot support.
    expect(person.baselineDeltaPts).toBeNull();
  });

  it("reports a real zero delta when a person genuinely held steady", () => {
    const half = MIN_BASELINE_SESSIONS;
    const rows: LossPersonGridRow[] = [
      personRow({ endsWithError: true, isEarly: true, sessions: half }),
      personRow({ endsWithError: true, isEarly: false, sessions: half }),
    ];
    const [person] = foldPeople(rows);
    expect(person.baselineDeltaPts).toBe(0);
  });

  it("names the class of a dominant cause so it cannot read as coachable", () => {
    const rows: LossPersonGridRow[] = [
      personRow({
        endsWithError: true,
        minutes: 400,
        sessions: 4,
        status: SESSION_STATUS.ERROR,
        throttleSource: "usage_limit",
      }),
      personRow({
        endsWithError: true,
        minutes: 30,
        sessions: 1,
        status: SESSION_STATUS.INACTIVE,
      }),
    ];
    const [person] = foldPeople(rows);
    expect(person.dominantCause).toBe("Usage limit");
    expect(person.dominantCauseClass).toBe(LossClass.Systemic);
  });

  it("keeps a real zero distinct from an absent value on a person row", () => {
    const rows: LossPersonGridRow[] = [
      personRow({
        endsWithError: true,
        minutes: 200,
        sessions: 2,
        throttleSource: "usage_limit",
      }),
    ];
    const [person] = foldPeople(rows);
    // No coachable loss at all, but real systemic hours beside it.
    expect(person.actionableMinutes).toBe(0);
    expect(person.systemicMinutes).toBeGreaterThan(0);
  });
});

function candidate(
  overrides: Partial<LostSessionCandidate> = {}
): LostSessionCandidate {
  return {
    endsWithError: true,
    engineer: "Dana Whitaker",
    id: "session-1",
    minutes: 42,
    name: "Fix flaky gateway auth test",
    producedArtifact: false,
    repositoryFullName: "closedloop-ai/closedloop-ai",
    startedAt: new Date("2026-07-20T09:00:00.000Z"),
    status: SESSION_STATUS.ERROR,
    throttleSource: null,
    ...overrides,
  };
}

describe("the lost-sessions table shows only what the classifier calls lost", () => {
  it("drops a candidate the SQL prefilter admitted but the classifier rejects", () => {
    const rows = toLostSessionRows(
      [
        candidate(),
        // Clean outcome: the prefilter cannot see this, the classifier can.
        candidate({ endsWithError: false, id: "session-2" }),
        // Produced an artifact after all.
        candidate({ id: "session-3", producedArtifact: true }),
      ],
      12
    );
    expect(rows.map((row) => row.id)).toEqual(["session-1"]);
  });

  it("labels each row with its class and a named cause", () => {
    const [row] = toLostSessionRows(
      [candidate({ throttleSource: "api_error" })],
      12
    );
    expect(row.lossClass).toBe(LossClass.Systemic);
    expect(row.cause).toBe("Provider API error");
  });

  it("stops at the row limit", () => {
    const many = Array.from({ length: 20 }, (_unused, index) =>
      candidate({ id: `session-${index}` })
    );
    expect(toLostSessionRows(many, 12)).toHaveLength(12);
  });
});

function spendRow(overrides: Partial<SpendGridRow> = {}): SpendGridRow {
  return {
    endsWithError: null,
    hasWallClock: true,
    producedArtifact: false,
    sessions: 1,
    // A terminal state by default: `outcomeOf` reports Unknown for a run that
    // has not finished, so a fixture that omitted this would silently grade
    // every row as outcome-unknown and pass for the wrong reason.
    status: SESSION_STATUS.INACTIVE,
    usd: 10,
    ...overrides,
  };
}

const SPEND_GRID: SpendGridRow[] = [
  spendRow({
    endsWithError: false,
    producedArtifact: true,
    sessions: 5,
    usd: 250,
  }),
  spendRow({ endsWithError: true, sessions: 4, usd: 180 }),
  spendRow({ endsWithError: null, sessions: 2, usd: 60 }),
];

describe("tokenops estimates stay visibly separate from the facts", () => {
  const outcomes = foldOutcomeRows(SPEND_GRID);
  const waste = foldWasteEstimate(SPEND_GRID);

  it("splits total spend into exactly the three outcome buckets", () => {
    expect(outcomes).toHaveLength(3);
    const summed = outcomes.reduce((sum, row) => sum + row.usd, 0);
    expect(summed).toBeCloseTo(490, CENTS);
  });

  it("never folds outcome-unknown spend into clean or errored", () => {
    const unknown = outcomes.find(
      (row) => row.outcome === SpendOutcome.Unknown
    );
    expect(unknown?.usd).toBeCloseTo(60, CENTS);
  });

  it("keeps the recoverable-waste range inside the spend it was derived from", () => {
    expect(waste.lowUsd).toBeGreaterThan(0);
    expect(waste.lowUsd).toBeLessThan(waste.highUsd);
    expect(waste.highUsd).toBeLessThanOrEqual(waste.errorOutcomeUsd);
  });

  it("excludes outcome-unknown spend from the estimate and reports the amount", () => {
    const unknownUsd =
      outcomes.find((row) => row.outcome === SpendOutcome.Unknown)?.usd ?? 0;
    expect(waste.excludedUnknownUsd).toBeCloseTo(unknownUsd, CENTS);
  });

  it("counts only outcome-unknown sessions that LOST the work as excluded", () => {
    // The excluded figure is rendered as spend the estimate had to leave out
    // because we never observed those runs failing. An unknown-outcome session
    // that shipped an artifact and finished was never a candidate, so folding
    // it in would describe healthy spend as possible waste — and on an org full
    // of pre-ISS-4586 rows it would dwarf the basis and make a fine screen read
    // as unmeasurable.
    const withHealthyUnknown = [
      ...SPEND_GRID,
      spendRow({
        endsWithError: null,
        producedArtifact: true,
        sessions: 3,
        usd: 500,
      }),
    ];
    const estimate = foldWasteEstimate(withHealthyUnknown);
    const unknownSplit =
      foldOutcomeRows(withHealthyUnknown).find(
        (row) => row.outcome === SpendOutcome.Unknown
      )?.usd ?? 0;

    // The outcome SPLIT still reports every unknown dollar — that is a
    // measurement of where the money went.
    expect(unknownSplit).toBeCloseTo(560, CENTS);
    // The EXCLUDED figure describes only the lost ones.
    expect(estimate.excludedUnknownUsd).toBeCloseTo(60, CENTS);
  });

  it("does not count a still-running session's spend as ended clean", () => {
    // A live row syncs `endsWithError: false`, so without the terminal gate its
    // spend landed under "Ended clean" for a run that has not ended.
    const rows = [
      spendRow({
        endsWithError: false,
        producedArtifact: false,
        sessions: 2,
        status: SESSION_STATUS.ACTIVE,
        usd: 75,
      }),
    ];
    const split = foldOutcomeRows(rows);
    const clean = split.find((row) => row.outcome === SpendOutcome.Clean);
    const unknown = split.find((row) => row.outcome === SpendOutcome.Unknown);
    expect(clean?.usd).toBeCloseTo(0, CENTS);
    expect(unknown?.usd).toBeCloseTo(75, CENTS);
  });

  it("sends the recovery assumption with the estimate rather than leaving it to the render site", () => {
    expect(waste.lowRate).toBeGreaterThan(0);
    expect(waste.highRate).toBeGreaterThan(waste.lowRate);
  });
});

function modelRow(
  overrides: Partial<ModelSpendGridRow> = {}
): ModelSpendGridRow {
  return {
    ...spendRow(),
    model: "claude-sonnet-4.6",
    tokens: 1_000_000,
    ...overrides,
  };
}

describe("model right-sizing grades against the fleet, never a magic absolute", () => {
  const graded = MIN_GRADED_SESSIONS;
  const rows: ModelSpendGridRow[] = [
    // A workhorse: plenty of sessions, ordinary rate, ordinary failure share.
    modelRow({
      endsWithError: false,
      producedArtifact: true,
      sessions: graded,
      tokens: 20_000_000,
      usd: 200,
    }),
    modelRow({ endsWithError: true, sessions: 2, tokens: 2_000_000, usd: 20 }),
    // A cheap model handing its rate back in retries.
    modelRow({
      endsWithError: false,
      model: "claude-haiku-4.2",
      producedArtifact: true,
      sessions: graded,
      tokens: 20_000_000,
      usd: 20,
    }),
    modelRow({
      endsWithError: true,
      model: "claude-haiku-4.2",
      sessions: graded,
      tokens: 10_000_000,
      usd: 40,
    }),
    // A trial model: too few sessions to grade, and no failures at all.
    modelRow({
      endsWithError: false,
      model: "gpt-5.4-mini",
      producedArtifact: true,
      sessions: 3,
      tokens: 500_000,
      usd: 5,
    }),
  ];
  // Billed medians are deliberately larger than, and ordered differently from,
  // the work medians beside them: nothing here may be passing because the two
  // bases happen to agree.
  const medians: ModelMedianRow[] = [
    {
      medianTokens: 4_000_000,
      medianWorkTokens: 1_500_000,
      model: "claude-sonnet-4.6",
    },
    {
      medianTokens: 3_000_000,
      medianWorkTokens: 1_200_000,
      model: "claude-haiku-4.2",
    },
    {
      medianTokens: 2_000_000,
      medianWorkTokens: 100_000,
      model: "gpt-5.4-mini",
    },
  ];
  const models = foldModelRows(rows, medians);

  it("withholds a verdict, and a confidence, from a model with too few sessions", () => {
    const trial = models.find((row) => row.model === "gpt-5.4-mini");
    expect(trial?.verdict).toBe(ModelVerdict.Ungraded);
    // OMITTED, not 0. A `0%` would read as "we are certain it is wrong".
    expect(trial?.confidencePct).toBeUndefined();
    expect(Object.hasOwn(trial ?? {}, "confidencePct")).toBe(false);
  });

  it("reports a real zero for a model that had no failed sessions", () => {
    const trial = models.find((row) => row.model === "gpt-5.4-mini");
    expect(trial?.errorOutcomeUsd).toBe(0);
    // A measured zero, so the spend it DID incur is still a real number.
    expect(trial?.usd).toBeGreaterThan(0);
  });

  it("grades every model with enough sessions and no others", () => {
    for (const row of models) {
      const isGraded = row.verdict !== ModelVerdict.Ungraded;
      expect(isGraded).toBe(row.sessions >= MIN_GRADED_SESSIONS);
    }
  });

  it("actually exercises more than one verdict", () => {
    // A right-sizing column that says the same thing on every row proves
    // nothing. If the thresholds ever flatten it, this fails rather than
    // shipping a table with no signal in it.
    const verdicts = new Set(models.map((row) => row.verdict));
    expect(verdicts.size).toBeGreaterThan(1);
    expect(verdicts.has(ModelVerdict.Underpowered)).toBe(true);
    expect(verdicts.has(ModelVerdict.Ungraded)).toBe(true);
  });

  it("sums the model rows back to the same total spend the outcome split shows", () => {
    const modelTotal = models.reduce((sum, row) => sum + row.usd, 0);
    const outcomeTotal = foldOutcomeRows(rows).reduce(
      (sum, row) => sum + row.usd,
      0
    );
    expect(modelTotal).toBeCloseTo(outcomeTotal, CENTS);
  });
});

/**
 * The Over-powered verdict itself, which is what ISS-5189 changed the token
 * basis to make reachable. It is a CONJUNCTION — expensive per million tokens
 * AND pointed at smaller-than-median jobs — and each half is pinned by a model
 * that trips the other half alone and must still come back Right-sized. Without
 * those two, deleting either guard leaves every suite green.
 *
 * Every row ends clean, so the fleet's error share is zero and the
 * Under-powered branch (which is evaluated first) cannot fire and mask the
 * comparison under test.
 */
describe("the Over-powered verdict needs BOTH an expensive rate and small jobs", () => {
  const CHEAP_USD = 10;
  const ORDINARY_USD = 20;
  const PREMIUM_USD = 100;
  const FLEET_TOKENS = 10_000_000;

  function cleanModelRow(model: string, usd: number): ModelSpendGridRow {
    return modelRow({
      endsWithError: false,
      model,
      producedArtifact: true,
      sessions: MIN_GRADED_SESSIONS,
      tokens: FLEET_TOKENS,
      usd,
    });
  }

  // Rates per million: 1, 1, 2, 10, 10 — so the fleet median is 2 and the
  // Over-powered bar is 6. Only the two premiums clear it.
  const rows: ModelSpendGridRow[] = [
    cleanModelRow("cheap-small-jobs", CHEAP_USD),
    cleanModelRow("cheap-ordinary-jobs", CHEAP_USD),
    cleanModelRow("ordinary", ORDINARY_USD),
    cleanModelRow("premium-small-jobs", PREMIUM_USD),
    cleanModelRow("premium-hard-jobs", PREMIUM_USD),
  ];
  // WORK medians: 200k, 300k, 1M, 1M, 5M — fleet median 1M.
  //
  // The BILLED medians beside them are ordered so that reading the wrong basis
  // INVERTS the answer rather than merely perturbing it: their fleet median is
  // 5M and `premium-small-jobs` carries the largest of them (8M), so a verdict
  // computed over `medianTokens` cannot call it small-jobs and the
  // Over-powered case below goes red. Equal values on both bases would let the
  // verdict read either one and stay green.
  const medians: ModelMedianRow[] = [
    {
      medianTokens: 5_000_000,
      medianWorkTokens: 300_000,
      model: "cheap-small-jobs",
    },
    {
      medianTokens: 4_000_000,
      medianWorkTokens: 1_000_000,
      model: "cheap-ordinary-jobs",
    },
    { medianTokens: 3_000_000, medianWorkTokens: 1_000_000, model: "ordinary" },
    {
      medianTokens: 8_000_000,
      medianWorkTokens: 200_000,
      model: "premium-small-jobs",
    },
    {
      medianTokens: 5_500_000,
      medianWorkTokens: 5_000_000,
      model: "premium-hard-jobs",
    },
  ];
  const verdictOf = (model: string) =>
    foldModelRows(rows, medians).find((row) => row.model === model)?.verdict;

  it("grades a costly model on small jobs Over-powered", () => {
    expect(verdictOf("premium-small-jobs")).toBe(ModelVerdict.Overpowered);
  });

  it("spares a costly model that is doing genuinely large jobs", () => {
    // Drop the job-size half of the conjunction and this model is condemned for
    // its sticker price alone, which is the judgment the verdict refuses to
    // make: a premium model on hard work is earning what it costs.
    expect(verdictOf("premium-hard-jobs")).toBe(ModelVerdict.RightSized);
  });

  it("spares a cheap model on small jobs", () => {
    // Drop the rate half and small jobs alone convict this one. Being pointed
    // at short work is not a finding when the work is not expensive.
    expect(verdictOf("cheap-small-jobs")).toBe(ModelVerdict.RightSized);
  });

  it("reads the job-size guard off the WORK basis, not the billed one", () => {
    // The two bases are inverted in this fixture (see the medians above), so
    // this is the assertion that fails if `resolveVerdict` is ever pointed back
    // at `medianTokens`. The three cases above would all survive that swap on
    // some other fixture; this one cannot.
    const row = foldModelRows(rows, medians).find(
      (item) => item.model === "premium-small-jobs"
    );
    expect(row?.medianWorkTokens).toBe(200_000);
    expect(row?.medianTokens).toBe(8_000_000);
    expect(row?.verdict).toBe(ModelVerdict.Overpowered);
  });

  it("withholds Over-powered when the job size is unknown rather than reading it as zero", () => {
    // The sentinel hazard. A missing median coerced to `0` satisfies
    // `medianWorkTokens < fleet.medianSessionTokens` for ANY positive fleet
    // median, so the fabricated value does not merely fail to inform the
    // verdict — it actively convicts. Every other input here is the
    // Over-powered case that passes above, so only the unknown job size is
    // under test.
    const withUnknownJobSize = medians.map((row) =>
      row.model === "premium-small-jobs"
        ? { ...row, medianWorkTokens: null }
        : row
    );
    const row = foldModelRows(rows, withUnknownJobSize).find(
      (item) => item.model === "premium-small-jobs"
    );
    expect(row?.verdict).toBe(ModelVerdict.RightSized);
  });
});

/**
 * The wire shape of the two bases (ISS-5189).
 *
 * `apps/api` and `apps/app` are separate Vercel deploy units on one push, so
 * changing what `medianTokens` MEANS in place would misreport for the whole
 * window in which one of them is old. The field therefore keeps its billed
 * basis and the work basis arrives beside it as an additive optional field.
 * These pin both halves of that: the old field must not have moved, and the new
 * one must be omitted rather than zeroed when there is nothing to send.
 */
describe("the model row carries both token bases as separate wire fields", () => {
  const rows: ModelSpendGridRow[] = [
    modelRow({
      endsWithError: false,
      producedArtifact: true,
      sessions: MIN_GRADED_SESSIONS,
      tokens: 10_000_000,
      usd: 50,
    }),
  ];
  const model = "claude-sonnet-4.6";

  it("passes the billed median through on `medianTokens`, unchanged", () => {
    // The retired field, on its ORIGINAL basis. An `apps/app` build that
    // predates `medianWorkTokens` renders exactly this number, so it must be
    // the billed median the read returned and not the work one.
    const row = foldModelRows(rows, [
      { medianTokens: 900_000, medianWorkTokens: 120_000, model },
    ])[0];
    expect(row.medianTokens).toBe(900_000);
  });

  it("carries the work median on `medianWorkTokens`", () => {
    const row = foldModelRows(rows, [
      { medianTokens: 900_000, medianWorkTokens: 120_000, model },
    ])[0];
    expect(row.medianWorkTokens).toBe(120_000);
  });

  it("OMITS `medianWorkTokens` when there is no work median, rather than sending 0", () => {
    // Omitted, not `null` and not `0`: a real `0` is reachable on this narrowed
    // basis, so a fabricated one is indistinguishable from a measurement, and
    // the screen's absent-field dash is the only honest render.
    const row = foldModelRows(rows, [
      { medianTokens: 900_000, medianWorkTokens: null, model },
    ])[0];
    expect(Object.hasOwn(row, "medianWorkTokens")).toBe(false);
    expect(row.medianWorkTokens).toBeUndefined();
  });

  it("OMITS `medianWorkTokens` for a model the median read returned no row for", () => {
    const row = foldModelRows(rows, [])[0];
    expect(Object.hasOwn(row, "medianWorkTokens")).toBe(false);
    // The retired field keeps the `0` it has always projected here: narrowing a
    // required field would break the very client it is being kept for.
    expect(row.medianTokens).toBe(0);
  });
});
