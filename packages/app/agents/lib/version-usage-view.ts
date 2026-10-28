import type {
  AgentComponentKind,
  ComponentVersion,
} from "@repo/api/src/types/agent-component";
import { isLocPerDollarVerifiableKind } from "@repo/api/src/types/agent-component";
import type {
  AgentComponentUsageAttribution,
  AgentComponentVersionUsage,
} from "@repo/api/src/types/agent-component-version-usage";
import {
  MergedPrsCoverage,
  resolveMergedPrsCoverage,
} from "@repo/api/src/types/analytics";
import {
  LOC_METRIC_DEFINITION,
  LocMetricDefinitionId,
} from "@repo/api/src/types/loc-metric-definitions";
import { TOTAL_ESTIMATED_COST_LABEL } from "@repo/api/src/types/total-estimated-cost-copy";
import { TOTAL_TOKENS_LABEL } from "@repo/api/src/types/total-tokens-copy";
import {
  formatCostPreciseOrDash,
  formatCountOrDash,
  formatLocPerDollar,
  formatTokenCountOrDash,
} from "@repo/app/shared/lib/format-utils";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import { SESSION_LEVEL_ATTRIBUTION_CAVEAT } from "./session-level-attribution-copy";
import { coerceHash, versionLabelForHash } from "./version-label";

/**
 * ISS-10467 — display shaping for the component detail's per-CONTENT-VERSION
 * usage drill-down.
 *
 * The one rule this module exists to hold: a MEASURED ZERO and a NOT-COMPUTED
 * value must never render the same way. The ISS-5363 contract makes every figure
 * `number | null` precisely so those two states are distinguishable on the wire,
 * and a formatter that collapses them throws that away at the last step — which
 * is the shape of the original ISS-10341 defect, one layer further out. The
 * shared `numberOrDash`/`KPI_NO_VALUE` pair is what enforces it, imported rather
 * than re-declared so this surface cannot print a different no-value mark from
 * the cards above it.
 */

/**
 * The unit a version-usage row is measured in.
 *
 * Declared here rather than reusing `BranchMetricUnit`: that const is the
 * Branches data dictionary's own axis (its docstring files each member against a
 * PRD-600/601/602 formula) and it carries no token member at all, so widening it
 * for this panel would put an agent-component unit in a branch dictionary. What
 * this exists for is the compare's magnitude formatting — ISS-10468 needs "format
 * a delta in this row's own unit" as data, and a `Record` over these members is
 * what makes a newly added row fail `tsc` until it names its formatter rather
 * than silently inheriting a count's.
 */
export const VersionUsageMetricUnit = {
  Count: "count",
  LocPerDollar: "loc_per_dollar",
  Tokens: "tokens",
  Usd: "usd",
} as const;
export type VersionUsageMetricUnit =
  (typeof VersionUsageMetricUnit)[keyof typeof VersionUsageMetricUnit];

/** One display row of a version's usage readout. */
export type VersionUsageMetric = {
  key: string;
  label: string;
  value: string;
  /** Whether {@link value} is a real measurement, for the muted no-data slot. */
  measured: boolean;
  /**
   * ISS-10468: the RAW figure behind {@link value}, or null when not computed.
   *
   * Carried so the side-by-side compare subtracts the same number this row
   * renders instead of re-reading the entry itself. A compare that reached back
   * into `AgentComponentVersionUsage` would be a second derivation of "this
   * row's figure" — it would have to re-apply the kind gate, the coverage
   * decoding and the unit choice, and any of the three drifting puts a delta on
   * the screen that does not belong to the two values beside it.
   */
  raw: number | null;
  /**
   * Whether {@link value} wears the floor marker, so a delta computed from it
   * knows its own operand was a floor rather than a total.
   */
  bounded: boolean;
  /** This row's unit, which decides how a delta over it is formatted. */
  unit: VersionUsageMetricUnit;
  /**
   * Which direction — if any — is an improvement for this row.
   *
   * Read from the canonical `MetricPolarity` vocabulary rather than a second
   * good/bad map. Only `LOC / $` scores. Every VOLUME row here is `Neutral`
   * deliberately: a verdict on "this revision ran more" needs an exposure
   * denominator this panel does not compute, so calling a rise in invocations,
   * sessions, merged PRs, tokens or dollars "better" or "worse" would assert a
   * ranking nobody specified. The DIRECTION and the magnitude are still
   * published for every row — what is withheld is only the good/bad overlay,
   * which was never computed.
   */
  polarity: MetricPolarity;
};

/**
 * The per-version readout.
 *
 * ITS LABELS ARE THE CANONICAL ONES, so a reader scanning down from the family
 * strip finds the same names for the same quantities — `LOC / $` and the two
 * spend rows read their phrases from the metric-vocabulary owners rather than
 * spelling them here.
 *
 * `LOC / $` KEEPS THE FAMILY'S KIND GATE. It is hidden for a kind whose
 * per-component attribution we do not consider verifiable (skill, command, …),
 * exactly as `componentMetrics` hides it: rendering a RATIO here for a kind the
 * headline hides it for would have a subordinate figure making a stronger
 * attribution claim than the total it says it is part of.
 *
 * THE SPEND ROWS DO NOT, and the difference is deliberate rather than an
 * oversight (operator ruling, marisolashgrove 2026-09-26). They are the raw token
 * and cost totals over a session set the producer can name exactly — measured,
 * in hand, and previously dropped at this very function — so withholding them
 * would delete a figure rather than decline an unsupportable one. The
 * attribution they cannot make is stated in words instead, by
 * {@link sessionLevelAttributionCaveat}.
 *
 * THIS PANEL IS NOW WIDER THAN THE FAMILY STRIP for those kinds: the strip
 * renders no token or cost card for a skill or command at all. That asymmetry is
 * a live product question and is NOT resolved here — growing the strip is a
 * second decision, and this function must not be read as having made it.
 */
export function versionUsageMetrics(
  kind: AgentComponentKind,
  entry: AgentComponentVersionUsage | undefined
): readonly VersionUsageMetric[] {
  const rows: VersionUsageMetric[] = [];
  if (isLocPerDollarVerifiableKind(kind)) {
    rows.push({
      key: "loc-per-dollar",
      // A RATIO over a sampled session set is not a floor — both operands are
      // bounded, so it can land either side of the true value and a `+` would
      // be a direction nobody measured. It carries no marker for that reason;
      // the counts beside it do, and `truncated` is disclosed in prose.
      // The family headline's own definition (`componentMetrics`), named rather
      // than spelled, so the subordinate row cannot claim a different
      // numerator, denominator or population than the total it is part of.
      label:
        LOC_METRIC_DEFINITION[LocMetricDefinitionId.ComponentLinesChanged]
          .label,
      value: formatLocPerDollar(entry?.locPerDollar),
      measured: isMeasured(entry?.locPerDollar),
      raw: rawFigure(entry?.locPerDollar),
      // NOT a floor marker on the VALUE — see the note above; `bounded` is read
      // only by the compare's delta state, never by this row's own rendering. A
      // ratio computed over a CAPPED merged-PR cohort is a sampled figure, so the
      // change between two of them is real but inexact: the compare publishes it
      // as approximate with the shortfall named, rather than as an exact figure
      // carrying a better/worse verdict. Read through the same canonical resolver
      // `sampledLocPerDollarCaveat` gates its own sentence on, so the delta's
      // state and the prose beneath the table cannot disagree about one cohort.
      bounded:
        resolveMergedPrsCoverage(entry?.mergedPrsTruncated) ===
        MergedPrsCoverage.Capped,
      unit: VersionUsageMetricUnit.LocPerDollar,
      // The ONE row on this panel with a good direction: more lines changed per
      // dollar is the efficiency claim the metric's own definition makes.
      polarity: MetricPolarity.HigherIsBetter,
    });
  }
  rows.push(
    {
      key: "invocations",
      label: "Invocations",
      value: countWithFloor(entry?.invocations, entry?.truncated === true),
      measured: isMeasured(entry?.invocations),
      raw: rawFigure(entry?.invocations),
      bounded: entry?.truncated === true,
      unit: VersionUsageMetricUnit.Count,
      polarity: MetricPolarity.Neutral,
    },
    {
      key: "sessions",
      label: "Sessions",
      value: countWithFloor(entry?.sessions, entry?.truncated === true),
      measured: isMeasured(entry?.sessions),
      raw: rawFigure(entry?.sessions),
      bounded: entry?.truncated === true,
      unit: VersionUsageMetricUnit.Count,
      polarity: MetricPolarity.Neutral,
    },
    {
      key: "merged-prs",
      label: "Merged PRs",
      // Its OWN coverage flag, not the entry's: the cohort read can be sampled
      // independently, and `mergedPrsTruncated` is a TRI-state where only a
      // DECLARED cap earns the marker — decoded through the canonical resolver
      // rather than a second `=== true`, exactly as the family card does.
      value: countWithFloor(
        entry?.mergedPrs,
        resolveMergedPrsCoverage(entry?.mergedPrsTruncated) ===
          MergedPrsCoverage.Capped
      ),
      measured: isMeasured(entry?.mergedPrs),
      raw: rawFigure(entry?.mergedPrs),
      // Its OWN coverage flag, for the same reason the value above reads it: the
      // cohort read is sampled independently of the usage lane.
      bounded:
        resolveMergedPrsCoverage(entry?.mergedPrsTruncated) ===
        MergedPrsCoverage.Capped,
      unit: VersionUsageMetricUnit.Count,
      polarity: MetricPolarity.Neutral,
    },
    // ISS-10467 (operator ruling, marisolashgrove 2026-09-26): "I think we actually
    // want to break down token/cost by version for skills & commands, in
    // particularly skills."
    //
    // TRAILING, matching where the family strip puts its own spend cards, and
    // UNGATED BY KIND — unlike `LOC / $` above. The two gates are not the same
    // question: `isLocPerDollarVerifiableKind` withholds a RATIO whose numerator
    // this surface cannot attribute at all, while these are the raw totals the
    // producer measured over a session set it can name exactly. Suppressing them
    // for the kinds the ruling names would delete a figure that is computed and
    // in hand — which is what shipped, and what the ruling reverses. What a
    // session-level kind owes instead is the admission, not the suppression:
    // {@link sessionLevelAttributionCaveat} states it beneath the rows.
    {
      key: "total-tokens",
      label: TOTAL_TOKENS_LABEL,
      value: spendWithFloor(
        formatTokenCountOrDash(entry?.totalTokens),
        entry?.totalTokens,
        entry?.totalTokensPartial === true
      ),
      measured: isMeasured(entry?.totalTokens),
      raw: rawFigure(entry?.totalTokens),
      bounded: entry?.totalTokensPartial === true,
      unit: VersionUsageMetricUnit.Tokens,
      polarity: MetricPolarity.Neutral,
    },
    {
      key: "estimated-cost",
      label: TOTAL_ESTIMATED_COST_LABEL,
      // The canonical cost guard at ROW precision, so an unpriced revision
      // reaches the same `—` the cards above use and can never print the
      // `$0.00` that the family strip's own `toFixed(2)` once made unavoidable
      // (ISS-4798) — a MEASURED zero still renders `$0.00`, which is the
      // ISS-5363 distinction and not that lie.
      //
      // CENTS, not the whole dollars this column shipped with (operator ruling,
      // marisolashgrove 2026-10-01: "raise cost column's precision"). ISS-10468 put
      // a CHANGE column beside this one, and at whole-dollar precision a real
      // $0.20 move rendered as `$20` beside `$21` — two cells a dollar apart
      // under a change reading twenty cents. `formatCurrencyWhole`'s own
      // docstring already draws the line this follows: whole dollars for a large
      // aggregate headline, cents for a per-row figure whose fractional part is
      // the signal.
      value: spendWithFloor(
        formatCostPreciseOrDash(entry?.estimatedCostUsd),
        entry?.estimatedCostUsd,
        entry?.estimatedCostPartial === true
      ),
      measured: isMeasured(entry?.estimatedCostUsd),
      raw: rawFigure(entry?.estimatedCostUsd),
      bounded: entry?.estimatedCostPartial === true,
      unit: VersionUsageMetricUnit.Usd,
      // NOT `LowerIsBetter`, and the difference is the whole reason this row has
      // a polarity field. A revision that cost less may simply have run less;
      // spend per unit of work is `LOC / $` above, which already carries the
      // verdict. Grading raw spend here would tell a reader a barely-used
      // revision "did better".
      polarity: MetricPolarity.Neutral,
    }
  );
  return rows;
}

/**
 * A count, with the house floor marker when its population was bounded.
 *
 * ISS-5521's convention on this page is a trailing `+` on the NUMBER, which the
 * family Merged PRs card and the unversioned disclosure both already speak. A
 * bare count under a cap claims a total nobody measured; the marker is the whole
 * difference between a usable floor and a lie. Never decorates a no-value dash —
 * `—+` would assert a bound on a figure that does not exist.
 */
function countWithFloor(
  value: number | null | undefined,
  bounded: boolean
): string {
  return spendWithFloor(formatCountOrDash(value), value, bounded);
}

/**
 * The floor marker applied to an ALREADY-FORMATTED figure.
 *
 * {@link countWithFloor} is this plus the count formatter. Split out because the
 * token and cost rows format through their own canonical helpers and must still
 * wear the SAME `+` this page already speaks — a second floor glyph on one panel
 * is how a reader learns to read one of them as decoration. The `isMeasured`
 * guard travels with it, so no formatter can decorate a dash.
 */
function spendWithFloor(
  formatted: string,
  value: number | null | undefined,
  bounded: boolean
): string {
  if (bounded && isMeasured(value)) {
    return `${formatted}+`;
  }
  return formatted;
}

/**
 * The sentence stating what the drill-down is doing with usage that names NO
 * version — the population most rows on real data actually belong to.
 *
 * This is not decoration. Per-version figures cannot contain these invocations,
 * and a drill-down that dropped them silently would understate every version
 * against a family headline that counts them: the same unstated-population
 * defect ISS-10341 fixed.
 *
 * It states only what was MEASURED and infers nothing about how much of the
 * versioned remainder the revisions below actually account for, because a usage
 * row can name a version identity that lines up with no revision in this
 * component's history. Returns null ONLY when the producer could not compute the
 * partition, in which case the caller says THAT instead — never "0
 * unattributed", which would be a measurement nobody took.
 */
export function unversionedDisclosure(
  attribution: AgentComponentUsageAttribution | undefined
): string | null {
  const invocations = attribution?.unversioned.invocations;
  const sessions = attribution?.unversioned.sessions;
  // ONE ABSENT OPERAND MUST NOT TAKE THE OTHER WITH IT — the same rule
  // `familyBaselineCopy` follows on this panel. `AgentComponentUsageSlice` types
  // the two independently, so a version-skewed producer can send one and not the
  // other, and returning null there routes the panel to "we couldn't work out how
  // much of this component's usage recorded no version" while holding the
  // invocation figure that sentence denies having.
  if (!(isMeasured(invocations) || isMeasured(sessions))) {
    return null;
  }
  const bounded = attribution?.truncated === true;
  // SESSIONS ARE NOT CLAIMED TO BE DISJOINT, and the wording is load-bearing.
  // Usage is keyed per (session, kind, key, branch), so one session can carry a
  // hash-bearing row and a hash-less one and is counted in BOTH slices — the
  // contract on `AgentComponentUsageAttribution` says so. The earlier "in none of
  // the figures here" asserted disjointness for the session count too, which let
  // a reader subtract a session the panel had already counted. Only the
  // INVOCATION halves partition, so only they get that claim.
  const lead = unversionedLead(invocations, sessions, bounded);
  const versioned = attribution?.versioned.invocations;
  if (!isMeasured(versioned)) {
    return bounded ? `${lead} ${SAMPLED_PARTITION_CAVEAT}` : lead;
  }
  // The versioned total is STATED rather than left to inference. It is NOT "the
  // sum of the revisions below": a usage row can name a version identity that
  // lines up with no revision in this component's history, and printing the
  // total is what lets a reader see that gap instead of concluding the revision
  // list accounts for everything the unversioned figure does not.
  //
  // NOT CALLED "the remaining", though, and not when bounded. The partition is
  // folded row by row over the family's usage rows, so when that lane hit its cap
  // the two slices sum to the SAMPLE while the cards above state the POPULATION —
  // a reader subtracting one from the other lands on a remainder nothing
  // measured, and a single revision's own count (which IS a population figure)
  // can exceed the versioned slice it belongs to. The figures are real and both
  // are published; what the caveat removes is the arithmetic claim.
  const versionedClause = `${countWithFloor(versioned, bounded)} named a version, which the revisions here may not account for in full.`;
  if (bounded) {
    return `${lead} A further ${versionedClause} ${SAMPLED_PARTITION_CAVEAT}`;
  }
  return `${lead} The remaining ${versionedClause}`;
}

/**
 * The caveat beside a partition folded from a bounded SAMPLE of the usage rows.
 *
 * Published rather than suppressed: both slices are real measurements over the
 * rows the lane could see, and a floor is usable where a blank is not. What the
 * sentence has to stop is the SUBTRACTION — these two do not sum to the cards
 * above, because those state the whole population.
 */
export const SAMPLED_PARTITION_CAVEAT =
  "This split was read from a sample of this component's usage rows, so the two figures here do not add up to the totals above.";

/**
 * The lead sentence, naming whichever of the two slice figures was measured.
 *
 * The invocation clause carries the "in none of the figures here" claim because
 * the invocation halves genuinely partition; the session clause never does, since
 * usage is keyed per (session, kind, key, branch) and one session can hold rows
 * in both slices.
 */
function unversionedLead(
  invocations: number | null | undefined,
  sessions: number | null | undefined,
  bounded: boolean
): string {
  const tail =
    "They belong to this component and to no revision, so they are in the totals above and in none of the figures here.";
  if (!isMeasured(invocations)) {
    return `Some of this component's usage was recorded across ${countWithFloor(sessions, bounded)} sessions that name no version at all, and how many invocations that covers could not be computed.`;
  }
  const lead = `${countWithFloor(invocations, bounded)} of this component's invocations recorded no version at all`;
  if (!isMeasured(sessions)) {
    return `${lead}. ${tail}`;
  }
  return `${lead}, seen across ${countWithFloor(sessions, bounded)} sessions. Those invocations ${tail.slice("They ".length)}`;
}

/**
 * The caveat beside a `LOC / $` computed over a BOUNDED sample of the revision's
 * sessions.
 *
 * The ratio itself is published, not withheld — both operands are real, and a
 * directional figure is usable where a blank is not. What it may not do is sit
 * there unqualified: `truncated` on this entry is narrower than "the lane was
 * bounded" (it is false whenever the whole-population aggregate stood in for the
 * cap), so when the lane WAS capped the counts beside this ratio are exact and
 * nothing else on the panel said the session set behind the ratio was a sample.
 * The cohort's own coverage flag is that statement — it follows the same lane
 * bound the LOC/cost read's session ids were drawn under — so it is what this
 * reads (codex review, ISS-10467).
 */
export const SAMPLED_LOC_PER_DOLLAR_CAVEAT =
  "This revision's LOC / $ was computed from a sample of its sessions, so read it as directional rather than exact.";

/**
 * {@link SAMPLED_LOC_PER_DOLLAR_CAVEAT} when this entry's ratio is both SHOWN
 * and sample-derived, else null. Silent when the kind hides the row, when no
 * ratio was computed (a caveat on a dash claims a measurement that does not
 * exist), and when coverage is merely unknown rather than a declared cap.
 */
export function sampledLocPerDollarCaveat(
  kind: AgentComponentKind,
  entry: AgentComponentVersionUsage | undefined
): string | null {
  if (
    !(isLocPerDollarVerifiableKind(kind) && isMeasured(entry?.locPerDollar))
  ) {
    return null;
  }
  if (
    resolveMergedPrsCoverage(entry?.mergedPrsTruncated) !==
    MergedPrsCoverage.Capped
  ) {
    return null;
  }
  return SAMPLED_LOC_PER_DOLLAR_CAVEAT;
}

/**
 * ISS-10467 (operator ruling 2026-09-26): the session-level admission owed
 * beside a revision's token/cost totals, or null when it is not owed.
 *
 * The figures render for every kind, so the honesty has to live in words rather
 * than in a suppression. For a kind whose per-component attribution IS reliable
 * (`subagent` governs the whole session it runs) nothing is owed and the sentence
 * would be false, so the caveat is gated on the SAME predicate that decides
 * whether `LOC / $` is publishable — one gate, two different uses of its answer.
 *
 * Silent when NEITHER figure was measured: a caveat over two dashes states a
 * shortfall in a measurement that does not exist, which is the rule
 * {@link sampledLocPerDollarCaveat} already follows one row up.
 */
export function sessionLevelAttributionCaveat(
  kind: AgentComponentKind,
  entry: AgentComponentVersionUsage | undefined
): string | null {
  if (isLocPerDollarVerifiableKind(kind)) {
    return null;
  }
  if (
    !(isMeasured(entry?.totalTokens) || isMeasured(entry?.estimatedCostUsd))
  ) {
    return null;
  }
  return SESSION_LEVEL_ATTRIBUTION_CAVEAT;
}

/** The copy shown when the producer could not compute the partition at all. */
export const UNVERSIONED_UNAVAILABLE_COPY =
  "We couldn't work out how much of this component's usage recorded no version, so the figures here may cover less than they look like they do.";

/** The copy shown when the version-usage read itself failed. */
export const VERSION_USAGE_ERROR_COPY =
  "Couldn't load this version's usage. Refresh to try again.";

/**
 * The revisions a version selector may legitimately offer.
 *
 * A hash that coerces to `""` is dropped. `coerceHash` exists because these
 * values DO arrive as non-strings in production (FEA-3520), and an empty option
 * value is not merely useless here — Radix throws on it, which takes the whole
 * detail page to the route error boundary.
 */
export function selectableVersions(
  versions: readonly ComponentVersion[]
): readonly ComponentVersion[] {
  return versions.filter((version) => coerceHash(version.hash).length > 0);
}

/** The selector label for one revision, matching the Definition panel's. */
export function versionSelectLabel(
  version: ComponentVersion,
  versions: readonly ComponentVersion[]
): string {
  const label = versionLabelForHash(version.hash, versions) ?? "Revision";
  return `${label} · #${coerceHash(version.hash).slice(0, 7)}`;
}

function isMeasured(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The row's raw figure, normalized to the `number | null` the ISS-5363 contract
 * declares.
 *
 * A version-skewed producer can omit a field entirely, and `undefined` is not a
 * third state this panel recognizes — it is the same "not computed" a `null` is.
 * Folding it here means the compare has one absence to test for rather than two.
 */
function rawFigure(value: number | null | undefined): number | null {
  return isMeasured(value) ? value : null;
}
