/**
 * @file The pure fold behind the wizard's session-discovery screen (ISS-8346).
 *
 * Takes what a host measured and returns the view model the analysis step and
 * the analysis banner render. Every input is STRUCTURAL — plain numbers, plain
 * string harness keys, and an injected label function — so this package learns
 * no desktop vocabulary and imports nothing from `apps/desktop`. The desktop
 * adapter owns the translation and holds the compile-time witnesses that keep
 * its own vocabulary from drifting past this one.
 *
 * The rule the whole module exists to enforce: THE SUMMARY MAY NEVER CONTRADICT
 * ITS OWN POPULATION. The rows and the total are computed from one list in one
 * pass, so "N sessions found" is the sum of the rows beneath it by construction
 * rather than by agreement.
 *
 * The second rule is that absence is not zero. A harness the host cannot count
 * carries no count and a count nobody reported is `null`. A percentage is
 * derived from whatever population the host did measure.
 */

import {
  analyzedCountFitsFound,
  type OnboardingAnalysisEstimate,
  OnboardingAnalysisEstimateStatus,
  type OnboardingAnalysisProgress,
  OnboardingAnalysisProgressStatus,
  OnboardingProgressOperand,
  type OnboardingSessionDiscovery,
  type OnboardingSessionSource,
  progressPercentFromRatio,
} from "../components/guided-onboarding-data";

/** Sessions attributed to one source, keyed by the host's own harness key. */
export type OnboardingHarnessSessions = {
  harness: string;
  sessions: number;
};

/**
 * Whether a host's session enumeration can be stated at all.
 *
 * A sweep with one impaired probe is still a measurement of everything else it
 * walked, and the ruling of 2026-09-04 (ISS-8346, option A) is that the screen
 * states that floor and derives the percentage and the estimate from it,
 * uncaveated: the approved design has one screen, and a single impaired probe
 * must not erase three of its elements. So there is no middle state. Either the
 * host measured a population, or it measured nothing and the counts are
 * withdrawn.
 */
export const OnboardingEnumerationQuality = {
  /** A population was measured. Counts are stated and completion derived. */
  Whole: "whole",
  /** Nothing believable was enumerated. The counts are withdrawn entirely. */
  Withdrawn: "withdrawn",
} as const;
export type OnboardingEnumerationQuality =
  (typeof OnboardingEnumerationQuality)[keyof typeof OnboardingEnumerationQuality];

/** The byte lane's own view of how much is left, for the fallback percentage. */
export type OnboardingParseBytes = {
  remaining: number;
  eligible: number;
};

export type OnboardingDiscoveryInput = {
  /**
   * Sessions DISCOVERED per harness, or `null` when no host reported any. This
   * is the population: counted rows exist for these harnesses and no others.
   */
  found: readonly OnboardingHarnessSessions[] | null;
  /**
   * Sessions that have LANDED in the local store per harness, or `null` when
   * that read has not settled. `null` is not zero — a harness present in
   * `found` and missing from a settled `analyzed` really has none yet.
   */
  analyzed: readonly OnboardingHarnessSessions[] | null;
  /**
   * Harnesses the host has PROVEN are not on this machine. Only a host holding
   * real evidence of absence may populate this; a harness it simply cannot see
   * belongs in neither list, because "we looked and it is not there" and "we
   * cannot look" are different claims and only one of them may be rendered.
   */
  absent: readonly string[];
  /** Display name for a harness key. Injected: this package owns no such map. */
  label: (harness: string) => string;
  /** Bytes of logs on disk, or `null` when unreported. */
  logBytes: number | null;
  estimate: OnboardingAnalysisEstimate;
  quality: OnboardingEnumerationQuality;
  /**
   * The byte-lane remainder and its denominator, or `null` when the host has no
   * measured byte estimate. Supplied ONLY when both numbers describe the same
   * sweep — the caller is what proves that, because the two revisions it checks
   * are its own vocabulary.
   */
  bytes: OnboardingParseBytes | null;
};

export type OnboardingDiscoveryFold = {
  discovery: OnboardingSessionDiscovery;
  progress: OnboardingAnalysisProgress;
};

/**
 * Fold one host's measurements into the discovery view model and the overall
 * progress beside it.
 */
export function foldOnboardingSessionDiscovery(
  input: OnboardingDiscoveryInput
): OnboardingDiscoveryFold {
  const counted = countableSessions(input);
  const reported = analyzedLookup(input.analyzed);
  const analyzedByHarness = statableAnalyzed(counted, reported);
  // Two different shortfalls, one consequence: the session RATIO may not be
  // formed. A corrupt read withdraws the count as well and leaves the rows with
  // nothing to state; an overshoot leaves both counts intact and withholds only
  // the quotient between them. Either way the row has settled and no ratio is
  // coming, which is a different screen from one whose read is still in flight.
  //
  // These two are the HEADLINE's gate and are deliberately whole-fold: the
  // headline divides the sums, so one row's overshoot disqualifies that
  // quotient however well its siblings fit. The ROWS are marked one at a time
  // in `buildSources`, because a row that fits still has a ratio of its own and
  // holding its bar would report a source nothing is wrong with as degraded.
  const analyzedUnstatable = reported !== null && analyzedByHarness === null;
  const ratioDeclined = !analyzedFitsFound(counted, analyzedByHarness);
  const analyzedWithheld =
    analyzedUnstatable || (analyzedByHarness !== null && ratioDeclined);
  const sources = buildSources(input, counted, analyzedByHarness, {
    analyzedUnstatable,
  });
  const sessionsFound = counted === null ? null : sumSessions(counted);
  const sessionsAnalyzed = sumAnalyzedSessions(counted, analyzedByHarness);

  const progress = deriveProgress(
    input,
    sessionsFound,
    ratioDeclined ? null : sessionsAnalyzed,
    analyzedWithheld
  );
  if (
    sessionsFound === null &&
    input.logBytes === null &&
    sources.length === 0 &&
    input.estimate.status === OnboardingAnalysisEstimateStatus.Unknown
  ) {
    // Nothing was measured at all. Anything else here would be the wizard
    // asserting that a scan is under way, which is its own fabrication.
    return { discovery: { status: "unknown" }, progress };
  }
  return {
    discovery: {
      estimate: input.estimate,
      logBytes: input.logBytes,
      sessionsAnalyzed,
      sessionsFound,
      sources,
      status: "measured",
    },
    progress,
  };
}

/**
 * The discovered rows this fold is allowed to count, or `null` when none are.
 *
 * A zero or negative entry is dropped rather than rendered: the producers here
 * omit a harness they could not enumerate, so a `0` arriving from one is a bug
 * in that producer, and rendering it would put a source on screen claiming a
 * measured absence nobody measured.
 *
 * When that drops EVERY entry the count is withdrawn rather than stated. A
 * surviving subset is a real population and still renders; an
 * empty one leaves nothing that was measured, and summing it to a `0` would
 * turn a list of producer bugs into "we found no sessions" — the fabricated
 * zero this fold exists to prevent, over a machine nobody counted.
 */
function countableSessions(
  input: OnboardingDiscoveryInput
): readonly OnboardingHarnessSessions[] | null {
  if (
    input.found === null ||
    input.quality === OnboardingEnumerationQuality.Withdrawn
  ) {
    return null;
  }
  const countable = input.found.filter((entry) => entry.sessions > 0);
  return countable.length > 0 ? countable : null;
}

/** A settled analyzed read as a lookup, or `null` when it has not settled. */
function analyzedLookup(
  analyzed: readonly OnboardingHarnessSessions[] | null
): Map<string, number> | null {
  if (analyzed === null) {
    return null;
  }
  // A `Map` and not an object literal: the harness key comes from a host and a
  // plain-object fold on `__proto__` would land on `Object.prototype`.
  return new Map(analyzed.map((entry) => [entry.harness, entry.sessions]));
}

/**
 * The analyzed read, or `null` when a value in it is not a count any source
 * could have produced.
 *
 * There is deliberately NO comparison against the found counts. The two reads
 * cover DIFFERENT populations: `analyzed` counts rows the local store has
 * accumulated, `found` counts transcripts still on disk, and a store outlives
 * the files it was built from — deleted worktrees, CI checkouts, pruned temp
 * dirs. So `analyzed > found` is an ordinary steady state the two populations
 * reach and never leave, not a contradiction. Treating it as impossible
 * withdrew the analyzed read permanently on any install whose transcripts had
 * been pruned, taking the per-source counts, the total, and the progress
 * percent with it (ISS-10582: a store of 2,443 against 940 live transcripts).
 *
 * What IS withdrawn is a figure no count can take — fractional, negative,
 * non-finite, or past the safe-integer range — because each renders as a
 * confident measurement rather than as the corrupt read it came from. The read
 * goes whole rather than by row, so the total stays a sum over exactly the set
 * the rows show.
 *
 * Scoped to `counted`, because only those harnesses reach a row or the total: a
 * store row for a harness this sweep never discovered is already unrenderable,
 * so letting its value withdraw a discovered sibling's valid count would delete
 * a good measurement over one nothing was ever going to show.
 */
function statableAnalyzed(
  counted: readonly OnboardingHarnessSessions[] | null,
  analyzedByHarness: Map<string, number> | null
): Map<string, number> | null {
  if (counted === null || analyzedByHarness === null) {
    return analyzedByHarness;
  }
  const impossible = counted.some((entry) => {
    const sessions = analyzedByHarness.get(entry.harness);
    return sessions !== undefined && !isStatableCount(sessions);
  });
  return impossible ? null : analyzedByHarness;
}

/**
 * Whether a number is a count at all: exact, non-negative, and inside the range
 * JS can still tell apart.
 *
 * The contract is `safeStorageCountSchema` (`packages/lib/harness/safe-counts.ts`),
 * which this deliberately does NOT import: that module is a Zod schema, and this
 * fold is reached by the desktop renderer through a `"use client"` graph the repo
 * keeps clear of parsing libraries. Same bound, stated where it costs no bundle.
 */
function isStatableCount(sessions: number): boolean {
  return Number.isSafeInteger(sessions) && sessions >= 0;
}

/**
 * Whether the session ratio may be formed at all.
 *
 * Checked PER HARNESS, never on the two sums: a sibling with headroom would
 * otherwise absorb another row's overshoot and the headline would divide while
 * the row's own bar declined, which is the summary disagreeing with its own
 * list. `found = [claude 940, codex 5000]` against `analyzed = [claude 2443]`
 * sums to 2443 of 5940 and states 41%, when at most 940 of those 5,940 can have
 * been analyzed.
 *
 * Why an overshoot may not be divided at all, rather than clamped, is
 * {@link analyzedCountFitsFound} — the one exported rule the per-source rows and
 * the ambient banner also call, so the three cannot drift apart. An overshoot
 * declines this lane for the byte remainder, which measures work actually
 * outstanding. The analyzed COUNT is untouched and still states what the store
 * holds; only the quotient it cannot validly form is withheld.
 */
function analyzedFitsFound(
  counted: readonly OnboardingHarnessSessions[] | null,
  analyzedByHarness: Map<string, number> | null
): boolean {
  if (counted === null || analyzedByHarness === null) {
    return false;
  }
  return counted.every((entry) =>
    analyzedCountFitsFound(
      analyzedByHarness.get(entry.harness) ?? 0,
      entry.sessions
    )
  );
}

function sumSessions(entries: readonly OnboardingHarnessSessions[]): number {
  return entries.reduce((total, entry) => total + entry.sessions, 0);
}

/**
 * Analyzed sessions summed over the COUNTED population, or `null` when either
 * side is absent.
 *
 * Summed over `counted` rather than over the analyzed read itself, so the total
 * covers exactly the harnesses the rows show — a store row for a harness this
 * sweep never discovered contributes to no row and so may not contribute to the
 * total either. A discovered harness whose store has outlived its transcripts
 * may still carry the total above the found one; that is the populations
 * diverging, not a row disagreeing with its own sum.
 */
function sumAnalyzedSessions(
  counted: readonly OnboardingHarnessSessions[] | null,
  analyzedByHarness: Map<string, number> | null
): number | null {
  if (counted === null || analyzedByHarness === null) {
    return null;
  }
  return counted.reduce(
    (total, entry) => total + (analyzedByHarness.get(entry.harness) ?? 0),
    0
  );
}

/**
 * One row per source the host can speak about, detected first.
 *
 * A harness proven absent is rendered as such and contributes nothing to the
 * totals, so its presence can never move the number above it.
 *
 * The withheld marker is carried PER ROW, against that row's own two counts.
 * The headline's gate is the aggregate one and stays that way — it divides the
 * sums, so any row's overshoot disqualifies it — but a row is asked only whether
 * ITS analyzed count fits ITS found count. Stamping the aggregate verdict on
 * every row made a source whose ratio is perfectly formable render as held:
 * `claude` at 2,443 of 940 withheld the bar of `codex` at 4 of 146, whose 3% is
 * a valid measurement of a sweep genuinely under way.
 *
 * A withdrawn read is the one whole-fold case, and it is not an exception: it
 * leaves EVERY row's analyzed count `null`, so each row independently has no
 * quotient coming and is marked on its own terms like any other.
 */
function buildSources(
  input: OnboardingDiscoveryInput,
  counted: readonly OnboardingHarnessSessions[] | null,
  analyzedByHarness: Map<string, number> | null,
  gap: { analyzedUnstatable: boolean }
): readonly OnboardingSessionSource[] {
  const countedRows = counted ?? [];
  const detected = countedRows.map((entry): OnboardingSessionSource => {
    const analyzed = analyzedByHarness
      ? (analyzedByHarness.get(entry.harness) ?? 0)
      : null;
    const withheld = isRowRatioWithheld(
      analyzed,
      entry.sessions,
      gap.analyzedUnstatable
    );
    return {
      detection: {
        analyzed,
        found: entry.sessions,
        status: "detected",
        ...(withheld ? { analyzedWithheld: true } : {}),
      },
      harness: entry.harness,
      label: input.label(entry.harness),
    };
  });
  const countedHarnesses = new Set(countedRows.map((entry) => entry.harness));
  const absent = input.absent
    .filter((harness) => !countedHarnesses.has(harness))
    .map(
      (harness): OnboardingSessionSource => ({
        detection: { status: "not-detected" },
        harness,
        label: input.label(harness),
      })
    );
  return [...detected, ...absent];
}

/**
 * The overall percentage, or the reason there is none.
 *
 * Ordered so the strongest claim that is also SELF-CONSISTENT wins. The session
 * ratio comes first because its numerator and denominator are the same two
 * numbers the rows show, so the headline and the list can never disagree. The
 * byte remainder is the fallback for a host that reports no session total — an
 * older desktop build, one whose inventory is unavailable, or a store that has
 * outlived its transcripts, whose ratio the caller declines. The producer's own
 * `complete` is last: it is authoritative about the byte lane only, and letting
 * it outrank a session ratio — measured OR withheld — would paint 100% over rows
 * reading three of ten.
 *
 * Every branch that divides proves its denominator first, because `complete`
 * explicitly includes "there was nothing to parse", so a zero denominator is
 * reachable rather than theoretical. The caller proves the other half — that
 * every row's numerator is inside its OWN denominator — and passes `null` here
 * when it is not, which is why this branch may simply divide.
 *
 * The percentage is over the population the rows show, which is what the host
 * measured, impaired probes and all (ISS-8346 ruling, 2026-09-04). A withdrawn
 * enumeration has no population and reaches only the producer's own verdict.
 *
 * A WITHHELD session ratio outranks the producer's `complete`, which is why that
 * branch sits above it rather than below. `complete` is a verdict about the BYTE
 * lane, and the byte remainder above already spends it whenever real byte numbers
 * exist; reaching it with none left is a host that measured no bytes at all, so
 * promoting it there restates the session lane — the exact lane that could not be
 * stated — as finished. Below the `complete` branch this returned 100 and the
 * heading read "Session analysis complete." over 2,443 analyzed against 940 found
 * (ISS-10582), which is the completion claim the withholding exists to prevent.
 *
 * When every branch declines, the answer distinguishes a numerator that was
 * WITHHELD from one that has simply not arrived. Only a withheld one is
 * `unavailable`; a read still in flight stays `unknown`, because `sessionsFound`
 * arrives from the inventory before the analyzed read settles and calling that
 * window "unavailable" would pause the dialog over a count that is still loading.
 */
function deriveProgress(
  input: OnboardingDiscoveryInput,
  sessionsFound: number | null,
  sessionsAnalyzed: number | null,
  analyzedWithheld: boolean
): OnboardingAnalysisProgress {
  if (
    sessionsFound !== null &&
    sessionsAnalyzed !== null &&
    sessionsFound > 0
  ) {
    return measuredPercent(sessionsAnalyzed / sessionsFound);
  }
  if (input.bytes !== null && input.bytes.eligible > 0) {
    const done = input.bytes.eligible - input.bytes.remaining;
    return measuredPercent(done / input.bytes.eligible);
  }
  // A population is on screen and the analyzed read that would have divided into
  // it was WITHHELD. That is a measurement that CANNOT be taken, not one that
  // has not arrived yet, and the two render differently: `unknown` is a screen
  // whose numerator is still in flight, this one is a screen whose numerator has
  // settled as unusable. Reporting it as `unknown` is what left the bar sweeping
  // forever beside "1,092 sessions found" on a store the discovery sweep could
  // no longer reconcile. Gating on the withholding rather than on `sessionsFound`
  // alone is what keeps a pending read out of here: the inventory lands first,
  // so every run passes through `found > 0` with no analyzed count yet.
  if (analyzedWithheld && sessionsFound !== null && sessionsFound > 0) {
    return {
      missing: OnboardingProgressOperand.AnalyzedSessions,
      status: OnboardingAnalysisProgressStatus.Unavailable,
    };
  }
  if (input.estimate.status === OnboardingAnalysisEstimateStatus.Complete) {
    return { percent: 100, status: OnboardingAnalysisProgressStatus.Measured };
  }
  return { status: OnboardingAnalysisProgressStatus.Unknown };
}

/**
 * A ratio as a measured percentage. The clamp is the shared one, so the headline
 * and the per-source rows agree on when 100 may be said — both bounds are
 * reachable through the byte lane, where a remainder outside its own
 * denominator is a real skew between two producers, and each would otherwise
 * render a bar that has left its own track. The SESSION lane no longer reaches
 * either: its caller declines the quotient when the analyzed read overshoots
 * its denominator, because a clamp would turn that overshoot into a completion
 * claim rather than bound it.
 */
function measuredPercent(ratio: number): OnboardingAnalysisProgress {
  return {
    percent: progressPercentFromRatio(ratio),
    status: OnboardingAnalysisProgressStatus.Measured,
  };
}

/**
 * Whether ONE row's analyzed→found ratio was withheld, as opposed to merely
 * unread.
 *
 * The two `null` cases are the whole point of taking the withdrawal flag: a row
 * whose count was read and found corrupt has settled and no quotient is coming,
 * while a row whose read has not returned yet is a measurement in flight, and
 * the marker separates them so only the first holds its bar.
 *
 * A row that HAS a count is asked the one exported question
 * ({@link analyzedCountFitsFound}) about its own two numbers, never about the
 * fold's. That is what keeps a sibling's overshoot off a bar whose own ratio is
 * fine (ISS-10582).
 */
function isRowRatioWithheld(
  analyzed: number | null,
  found: number,
  analyzedUnstatable: boolean
): boolean {
  if (analyzed === null) {
    return analyzedUnstatable;
  }
  return !analyzedCountFitsFound(analyzed, found);
}
