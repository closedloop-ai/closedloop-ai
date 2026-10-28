/**
 * ISS-8554 / PLN-1853 D6 — the response differ.
 *
 * Compares the live `/agent-sessions/usage` response against the TypedSQL
 * candidate and classifies every field into one of four verdicts. It exists
 * because several decisions in this plan MOVE PUBLISHED NUMBERS on purpose
 * (§11), so "the responses differ" is not by itself a failure — the question is
 * always whether a given difference is one we decided on.
 *
 * WHY THIS IS PURE. It takes two already-built objects and returns a report; it
 * runs nothing. The orchestration that fetches both lives at the call site. That
 * split is what lets the interesting cases — a field absent on one side, a
 * float that differs in the sixth decimal, an allowlisted movement — be tested
 * without a database.
 *
 * WHAT IT REFUSES TO DO. It will not report a field as matching unless it
 * actually compared it. Parity is incomplete (see `usage-sql-reader`), and a
 * differ that silently scores uncovered fields as equal would manufacture
 * exactly the confidence this change cannot afford. Uncovered fields come back
 * as `not-compared`, and {@link summarizeDiff} refuses to call a run clean while
 * any remain.
 */

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { LocPerDollarCoverageState } from "@repo/api/src/types/loc-per-dollar-coverage";
import { isRecord } from "@/lib/type-guards";

export const DiffVerdict = {
  /** Both sides produced the same value. */
  Match: "match",
  /** They differ, and PLN-1853 §11 says this field was expected to move. */
  Expected: "expected",
  /** They differ, and nothing sanctioned it. */
  Defect: "defect",
  /** The candidate does not produce this field yet. */
  NotCompared: "not-compared",
} as const;
export type DiffVerdict = (typeof DiffVerdict)[keyof typeof DiffVerdict];

export type FieldDiff = {
  field: string;
  verdict: DiffVerdict;
  current: unknown;
  candidate: unknown;
  /** Why an `expected` movement was sanctioned, or why a field is uncompared. */
  note?: string;
};

export type DiffReport = {
  defects: FieldDiff[];
  expected: FieldDiff[];
  notCompared: FieldDiff[];
  matchedCount: number;
};

/**
 * PLN-1853 §11, as data.
 *
 * A field listed here is one the plan says will move, WITH the reason. Keeping
 * it as a table rather than a set of field names is deliberate: a reviewer
 * reading a differ report should not have to go find out why a movement was
 * allowed, and an entry whose reason no longer applies is visible as prose that
 * stopped being true.
 *
 * ONE entry is a DECIDED REMOVAL rather than a movement: the candidate omits
 * the field and the live producer still emits it, so the difference is absence,
 * not a changed number. It is listed here because the differ's job is to say
 * whether a difference was decided on, and that one was.
 *
 * It was briefly two. `mergedKlocPerDollar` was the second, and it was never a
 * removal — the candidate emits it (ISS-9769). Removing a field from this map
 * because it stopped being a REMOVAL is a mistake: what belongs here is anything
 * that legitimately DIFFERS, for any reason.
 *
 * This is an allowlist of FIELDS, not of magnitudes. It sanctions "this number
 * changes", never "this number changed by an acceptable amount" — nothing here
 * can tell a 3% drift from a 300% one, and a field that moves for a reason
 * other than its stated one still reports `expected`. That is the known limit
 * of this tool, and why the counts in ISS-8557 exist separately.
 *
 * KEYS MAY BE DOTTED since ISS-9902, because `classify` descends into
 * object-valued fields. `mergedLocPerDollarCoverage` sanctions only the field's
 * PRESENCE; its sub-fields are listed separately or not at all.
 *
 * THREE OF THAT OBJECT'S SUB-FIELDS ARE DELIBERATELY ABSENT from this map, and
 * that is a decision rather than an oversight — `denominatorSessionCount`,
 * `costBasisCoveredUsd` and `costBasisExcludedUsd`. There is no evidence they
 * move, and the lesson ISS-9902 records is that sanctioning a field you have not
 * shown to move is how a real defect scores `expected`. If a shadow run reports
 * one of them, that is the tool working: someone reads the pair, decides, and
 * adds an entry WITH the evidence. Adding them pre-emptively to keep reports
 * quiet would rebuild the hole this issue was filed to close. (The two USD
 * fields do now carry FLOAT_EPSILON via their dotted entries in
 * {@link FLOAT_FIELDS}, so sixth-decimal noise is a MATCH, not a report.)
 *
 * `comparison.deltas.prsShipped` IS ABSENT FOR A DIFFERENT REASON, and it is
 * the one an entry here would look most obviously right (tamsinb on #7751).
 * The delta divides `mergedPrCount` by the prior window's, so the D3 population
 * sanctioned at the top of this map moves it too — measured, that difference is
 * present in every run the shadow reports the delta a defect (ISS-10867).
 * What stops the entry is that the PRIOR operand is published nowhere else in
 * `AgentSessionUsageSummary`: this delta is the report's only witness to the
 * candidate's prior-window merged-PR read. An entry sanctions every magnitude
 * the ratio takes, the shadow log carries field NAMES and no values, and so no
 * run can tell the D3 share from an aggregation defect in that read. Sanctioning
 * it would retire the only detector for a divergence nobody has decided on.
 */
export const EXPECTED_MOVEMENT: ReadonlyMap<string, string> = new Map([
  [
    "mergedPrCount",
    "D3 removes the merged_at window bound, and O1/ISS-8557 currently ships a superset population.",
  ],
  [
    "medianPrSize",
    "Same population change as mergedPrCount; the median is taken over it.",
  ],
  [
    "mergedLocPerDollar",
    "Numerator moves with the population (D3, O1); denominator moves with D1.",
  ],
  [
    "mergedLocPerDollarCoverage",
    "PRESENCE ONLY. Since ISS-9902 the differ DESCENDS into object-valued fields, so this bare key sanctions just one thing: the field being absent on one side and present on the other. Its sub-fields are judged individually under their own dotted keys. D3 presence divergence, and it is the CANDIDATE that is correct. Live gates this field on `coverageProbed` -- a cohort scoped to PRs whose merged_at falls INSIDE the window -- while D3 says this surface windows on the session's last_activity_at and models no merge window at all. The candidate gates on merged-PR EXISTENCE, which is what the field's own contract requires: present only when there is a ratio to gate, i.e. at least one merged PR. So for an in-range session tied to a PR that merged outside the range, the candidate emits and live omits. NOT a removal -- the field is emitted (ISS-9768, tamsinb and whitlockk on #6853).",
  ],
  [
    "mergedLocPerDollarCoverage.numeratorSessionCount",
    "D3 population (ISS-9754). Live counts the numerator over the UNWINDOWED `deliveryWhere` (`stripDateWindow`, applied in `collectDeliveryPrScope`, delivery-metrics.ts) so an out-of-window session whose PR merged in range still reaches the scan; the candidate counts it over the WINDOWED `base`, because on the sessions page the date range selects SESSIONS. The candidate's count is therefore <= live's on any range that excludes a linked session. Sanctioned as a COUNT movement only -- the state it feeds is judged separately, by transition.",
  ],
  [
    "mergedLocPerDollarCoverage.excludedSessionCount",
    "Identically 0 on the candidate (ISS-9754). `foldLocPerDollarCoverage` derives it as numerator - covered, and the candidate's `covered_numerator_session_count` re-states the divisor's own predicate over a cohort that already passed it, so the difference cannot be non-zero. Live's is non-zero whenever a delivery-linked session falls outside the range. Ruled 2026-09-09: keep the field emitted, let `Missing` go dead.",
  ],
  [
    "mergedKlocPerDollar",
    "Derived, so it moves with its source. `toDeliverySummaryFields` computes it as `legacyKlocPerDollarFromLoc(mergedLocPerDollar)`, i.e. LOC/$ divided by 1000, and mergedLocPerDollar is itself sanctioned above for the D3/O1 population change. Any LOC/$ move above 1e-3 puts the derived alias past FLOAT_EPSILON (1e-6), so without this entry a shadow run could never report clean in exactly the case the mergedLocPerDollar entry was written for -- `summarizeDiff` gates clean on `defects.length === 0` (marisolashgrove on #6853). NOT a removal -- the field IS emitted, for pre-ISS-4667 Desktop builds that still read it (ISS-9769).",
  ],
  [
    "penseroPointsPerDollar",
    "NOT A REMOVAL, and not a moved number: the live route reads Pensero delivery points AFTER `buildUsageSummary` returns (ISS-11117), so the field exists on the live side and the TypedSQL composition does not produce it at all. The difference is therefore always absence-on-the-candidate, never disagreement about a value, and it is sanctioned here so a shadow run can still reach clean for a principal inside the `pensero-points-per-dollar` rollout. When that reader is OUTSIDE the rollout the field is absent on BOTH sides and never reaches the differ. Teaching the candidate to produce it belongs with the cutover, not with a display wiring change (whitlockk on #7863).",
  ],
  [
    "byModel",
    "DECIDED 2026-08-31 (O2): dropped. The only consumer of agent_session_token_usage on this path, and it renders nowhere — the Model facet reads modelFilterOptions, and ISS-10733 deleted the only component that rendered byModel, so nothing renders it at all.",
  ],
]);

/**
 * The fields whose values are genuinely continuous, and the tolerance they get.
 *
 * Cost is `numeric(14,6)`, so a difference below a millionth is representation
 * rather than disagreement; the ratios and the percentile are floats derived by
 * division and carry the same rounding. EVERYTHING ELSE — session counts, token
 * totals, merged PR counts — is an integer and is compared exactly, because a
 * tolerance there would hide a real off-by-one.
 *
 * Named explicitly rather than matched by suffix. `endsWith("Cost")` happens to
 * cover today's five cost fields, but it would also silently grant a tolerance
 * to any integer field a future contract names `...Cost`, and the failure would
 * be a comparison that stopped catching things rather than one that broke.
 */
const FLOAT_EPSILON = 1e-6;
export const FLOAT_FIELDS: ReadonlySet<string> = new Set([
  "totalEstimatedCost",
  "subscriptionEstimatedCost",
  "apiEstimatedCost",
  "meteredEstimatedCost",
  "unknownEstimatedCost",
  "mergedLocPerDollar",
  "mergedKlocPerDollar",
  "medianPrSize",
  // DOTTED, because these two live inside `mergedLocPerDollarCoverage`. Before
  // ISS-9902 the differ compared that object whole with JSON.stringify, so a
  // sixth-decimal representation difference in either read as a full-object
  // disagreement -- and, because the object was sanctioned, as `expected`.
  // Neither could ever be judged on its own terms.
  "mergedLocPerDollarCoverage.costBasisCoveredUsd",
  "mergedLocPerDollarCoverage.costBasisExcludedUsd",
]);

/**
 * Sub-field movements sanctioned only for SPECIFIC (live, candidate) pairs.
 *
 * ISS-9902. Some fields move for a decided reason AND for an undecided one, and
 * a plain allowlist entry cannot tell the two apart — it sanctions the field, so
 * every value it ever takes reads `expected`.
 *
 * `mergedLocPerDollarCoverage.state` is the case that forced this. It moves:
 *
 *   (a) `missing` -> `complete`, which IS decided (ISS-9754: the candidate
 *       windows its numerator, so `excludedSessionCount` is identically 0 and
 *       the state cannot fire). Ruled 2026-09-09: let it go dead.
 *   (b) `migration_pending` -> `complete`, or `stale` -> `complete`, which is
 *       NOT decided. Live folds those two counts from the UNWINDOWED delivery
 *       rows and the candidate counts them over the WINDOWED numerator, and both
 *       states OUTRANK `missing` in `resolveCoverageState`. A (b) divergence is a
 *       mid-flight rebuild publishing a ratio — precedence rule 1 in
 *       `foldLocPerDollarCoverage` exists to prevent exactly that.
 *
 * Listing the field would sanction (b) along with (a). Listing the TRANSITION
 * sanctions (a) alone and leaves (b) a defect, which is the whole point.
 *
 * A field present here is NOT also read from {@link EXPECTED_MOVEMENT}: the
 * transition list is the complete sanction for it, so an unlisted pair is a
 * defect rather than falling through to a broader entry.
 */
export const EXPECTED_TRANSITIONS: ReadonlyMap<
  string,
  ReadonlyArray<readonly [unknown, unknown]>
> = new Map([
  [
    "mergedLocPerDollarCoverage.state",
    [
      [
        LocPerDollarCoverageState.Missing,
        LocPerDollarCoverageState.Complete,
      ] as const,
    ],
  ],
]);

function numbersAgree(field: string, a: number, b: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  return FLOAT_FIELDS.has(field) ? Math.abs(a - b) < FLOAT_EPSILON : a === b;
}

function valuesAgree(field: string, a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return numbersAgree(field, a, b);
  }
  if (a === null || b === null || a === undefined || b === undefined) {
    // Null and undefined are NOT interchangeable here. `earliestSessionAt: null`
    // is a documented "no sessions matched"; an absent field is a producer that
    // did not answer, and conflating them is how a missing field passes as an
    // empty one.
    return a === b;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Classify ONE scalar (or whole-value) comparison.
 *
 * Precedence: a transition allowlist, when the field has one, is the complete
 * sanction — an unlisted pair is a defect and does NOT fall through to
 * {@link EXPECTED_MOVEMENT}.
 */
function classifyLeaf(
  field: string,
  current: unknown,
  candidate: unknown
): FieldDiff {
  if (valuesAgree(field, current, candidate)) {
    return { field, verdict: DiffVerdict.Match, current, candidate };
  }
  const transitions = EXPECTED_TRANSITIONS.get(field);
  if (transitions) {
    const sanctionedPair = transitions.some(
      ([from, to]) => from === current && to === candidate
    );
    return sanctionedPair
      ? {
          field,
          verdict: DiffVerdict.Expected,
          current,
          candidate,
          note: `Sanctioned transition ${String(current)} -> ${String(candidate)}. Any other movement of this field is a defect (ISS-9902).`,
        }
      : { field, verdict: DiffVerdict.Defect, current, candidate };
  }
  const sanctioned = EXPECTED_MOVEMENT.get(field);
  return sanctioned
    ? {
        field,
        verdict: DiffVerdict.Expected,
        current,
        candidate,
        note: sanctioned,
      }
    : { field, verdict: DiffVerdict.Defect, current, candidate };
}

/**
 * Classify a field, descending into an object-valued one.
 *
 * ISS-9902: before this, an object was compared with `JSON.stringify` and looked
 * up in {@link EXPECTED_MOVEMENT} by its TOP-LEVEL name, so sanctioning the
 * object sanctioned all six of its sub-fields at once and a genuine defect
 * inside it scored `expected`. Descending keys each sub-field by dotted path, so
 * a sanction names exactly what it covers and everything else stays judged.
 *
 * PRESENCE is still a whole-field question and is NOT descended: when the field
 * is absent on one side there is no pair of objects to walk, and "the candidate
 * omits this" is one fact rather than six. That case falls through to the
 * top-level entry, which is why {@link EXPECTED_MOVEMENT} keeps both the bare
 * `mergedLocPerDollarCoverage` key and its dotted children.
 */
function classify(
  field: string,
  current: unknown,
  candidate: unknown
): FieldDiff[] {
  if (valuesAgree(field, current, candidate)) {
    return [{ field, verdict: DiffVerdict.Match, current, candidate }];
  }
  // `isRecord` already excludes null and arrays — arrays deliberately, because
  // descending one would key diffs by INDEX, so a single inserted element would
  // report every later position as a defect and `byModel` (a decided removal)
  // would explode into one entry per model rather than one saying the field is
  // gone. The Date exclusion is this call site's own: a producer that hands a
  // Date rather than an ISO string has no useful sub-fields to walk, and
  // descending it would emit diffs keyed on internal slots.
  // (`isRecord` is imported rather than re-declared — apps/api/AGENTS.md:138.)
  if (
    isRecord(current) &&
    isRecord(candidate) &&
    !(current instanceof Date) &&
    !(candidate instanceof Date)
  ) {
    const keys = [
      ...new Set([...Object.keys(current), ...Object.keys(candidate)]),
    ].sort();
    return keys.flatMap((key) =>
      classify(`${field}.${key}`, current[key], candidate[key])
    );
  }
  return [classifyLeaf(field, current, candidate)];
}

/**
 * Compare one live response against a candidate that covers only `covered`.
 *
 * `covered` is passed explicitly rather than inferred from the candidate's own
 * keys. A candidate that omits a field because it cannot produce it and one that
 * omits it because the value is genuinely absent are indistinguishable by
 * inspection, and only the caller knows which. Inferring would let a producer
 * bug read as coverage.
 */
export function diffUsageSummary(
  current: AgentSessionUsageSummary,
  candidate: Partial<AgentSessionUsageSummary>,
  covered: ReadonlySet<string>
): DiffReport {
  const report: DiffReport = {
    defects: [],
    expected: [],
    notCompared: [],
    matchedCount: 0,
  };
  const fields = new Set([...Object.keys(current), ...Object.keys(candidate)]);

  for (const field of [...fields].sort()) {
    if (!covered.has(field)) {
      report.notCompared.push({
        field,
        verdict: DiffVerdict.NotCompared,
        current: (current as Record<string, unknown>)[field],
        candidate: (candidate as Record<string, unknown>)[field],
        note: "The TypedSQL path does not produce this field yet.",
      });
      continue;
    }
    // An array, because an object-valued field yields one diff PER SUB-FIELD
    // (ISS-9902) rather than one verdict for the whole object.
    for (const diff of classify(
      field,
      (current as Record<string, unknown>)[field],
      (candidate as Record<string, unknown>)[field]
    )) {
      if (diff.verdict === DiffVerdict.Match) {
        report.matchedCount += 1;
      } else if (diff.verdict === DiffVerdict.Expected) {
        report.expected.push(diff);
      } else {
        report.defects.push(diff);
      }
    }
  }
  return report;
}

/**
 * A one-line verdict, and whether the run may be treated as clean.
 *
 * `clean` requires BOTH no defects AND nothing uncompared. A run with zero
 * defects over half the fields is not evidence of parity, and the flag must not
 * open on it — which is the whole reason this returns a boolean rather than
 * leaving each caller to decide what "no defects" was worth.
 */
export function summarizeDiff(report: DiffReport): {
  clean: boolean;
  line: string;
} {
  const clean = report.defects.length === 0 && report.notCompared.length === 0;
  const parts = [
    `${report.matchedCount} matched`,
    `${report.expected.length} expected`,
    `${report.defects.length} defect(s)`,
    `${report.notCompared.length} not compared`,
  ];
  return { clean, line: parts.join(", ") };
}
