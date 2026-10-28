/**
 * ISS-9848 — what `AgentSessionUsageSummary.mergedLocPerDollar` is a ratio OF,
 * stated ON THE WIRE instead of inferred by whoever renders it.
 *
 * THE DEFECT THIS CLOSES. The cloud deploys ahead of the Desktop builds already
 * installed, so a client routinely renders a figure the server computed on a
 * basis that client has never heard of. Until now the ONLY statement of that
 * basis was a compile-time literal in the summary card — "Merged gross lines
 * divided by the total estimated cost across matched sessions" — which only a
 * client release can change. ISS-6526 opened one such window (the divisor moved
 * from the API-billed ledger to total spend while installed clients kept saying
 * "API-billed"); the next one moves the NUMERATOR. One field name, two
 * quantities, and no way for the reader to tell which it got.
 *
 * The pairing is the one ISS-9744 made for `deadLetteredCount`: keep the field's
 * meaning STABLE PER EMITTER and put an explicit basis beside it, rather than
 * making the field polymorphic or renaming it.
 *
 * SCOPE, deliberately narrow. This vocabulary describes the Sessions summary's
 * `mergedLocPerDollar` and nothing else. It is NOT a general per-dollar basis:
 * the Branches value-per-dollar card is a DIFFERENT ESTIMAND — it apportions
 * each session's spend evenly across the branches it touched
 * (`sumEvenSplitEnrichedSpend`, FEA-2032/ISS-4689) and reads 1.70 in production
 * beside 123,649 on this canonical family — so stamping a member of this set on
 * it would assert a population match nobody measured. Whether the two estimands
 * unify is ISS-9750 and is a product decision, not this contract's.
 *
 * Lightweight and dependency-free (no Zod, no heavy transitive graph) because a
 * `"use client"` summary card imports it to render the sentence — the same
 * constraint the sibling `loc-per-dollar-coverage.ts` module carries. The one
 * import below is the sibling label constant, which is itself a bare string.
 */

import {
  LOC_PER_DOLLAR_LABEL,
  MERGED_LOC_PER_DOLLAR_LABEL,
} from "../utils/loc-per-dollar.ts";

/**
 * The bases `mergedLocPerDollar` can be published on.
 *
 * ONE member today, and that is the honest count rather than a placeholder: the
 * API-billed divisor ISS-6526 replaced was deleted outright by #6885, and
 * listing a basis no producer can emit would be unreachable contract surface.
 * The set exists so the NEXT change adds a member — which a version-skewed
 * client coarsens through {@link resolveMergedLocPerDollarHow} — instead of
 * silently re-pointing this one at a different quantity.
 *
 * The member names BOTH sides of the ratio on purpose. A denominator-only
 * vocabulary would still be true the day the numerator moves, and the sentence
 * it drives names the numerator, so the caption would go back to lying while the
 * basis field claimed to prevent exactly that.
 */
export const MergedLocPerDollarBasis = {
  /**
   * Merged gross lines (additions + deletions) across the matched sessions'
   * merged PRs, divided by the TOTAL estimated cost of those sessions — every
   * ledger (subscription + metered + unclassified), not the API-billed one
   * alone. Settled by #6885; `resolveLocPerDollarCostBasis` is the producer.
   */
  MergedLinesOverTotalCost: "merged_lines_over_total_cost",
} as const;
export type MergedLocPerDollarBasis =
  (typeof MergedLocPerDollarBasis)[keyof typeof MergedLocPerDollarBasis];

/**
 * The reader-facing "how is this computed" sentence for each basis.
 *
 * ONE canonical map so the web card, the desktop card, and any later surface
 * cannot each spell the same basis differently.
 */
const HOW_BY_BASIS: Record<MergedLocPerDollarBasis, string> = {
  [MergedLocPerDollarBasis.MergedLinesOverTotalCost]:
    "Merged gross lines divided by the total estimated cost across matched sessions.",
};

/**
 * The sentence for a producer that states NO basis.
 *
 * Every server that omits the field predates it, and every such server divided
 * by total estimated cost — so this describes what those responses actually are,
 * and a client talking to one is exactly as correct as it was before this
 * contract existed.
 *
 * Deliberately its OWN literal rather than an alias of the total-cost entry
 * above, even though the two strings are identical today. They state two
 * different facts — "this response says its basis" versus "this response
 * predates the field" — and editing the map entry when a future basis becomes
 * the default must not silently rewrite the claim made about an old server.
 * They cannot drift apart unnoticed: one helper below decides between them, and
 * a test pins that today they agree.
 */
export const MERGED_LOC_PER_DOLLAR_HOW_WITHOUT_BASIS =
  "Merged gross lines divided by the total estimated cost across matched sessions.";

/**
 * The sentence for a basis this build does not know.
 *
 * A newer server can send a member this client has never compiled against. It
 * must not fall back to the total-cost sentence — asserting a basis the response
 * explicitly declined to claim is the defect, not the fallback — and it must not
 * throw over a field that only captions a number. So it coarsens: the figure
 * still renders, the caption stops describing a computation nobody here can
 * describe.
 */
export const MERGED_LOC_PER_DOLLAR_HOW_UNRECOGNIZED_BASIS =
  "This figure was computed on a basis this version of the app does not recognize.";

/**
 * The "how" sentence for a wire value, coarsening anything unrecognized.
 *
 * Takes `string | undefined` rather than the declared union because that is what
 * the field actually is at runtime: it crosses an HTTP boundary from a server
 * that may be newer than this build, where the type system guarantees nothing.
 */
export function resolveMergedLocPerDollarHow(
  basis: string | undefined
): string {
  return resolveBasisCopy(
    basis,
    HOW_BY_BASIS,
    MERGED_LOC_PER_DOLLAR_HOW_WITHOUT_BASIS,
    MERGED_LOC_PER_DOLLAR_HOW_UNRECOGNIZED_BASIS
  );
}

/**
 * Membership in the map, via `Object.hasOwn` so a payload carrying `__proto__`
 * or `constructor` cannot resolve to an inherited member.
 */
function isMergedLocPerDollarBasis(
  value: string
): value is MergedLocPerDollarBasis {
  return Object.hasOwn(HOW_BY_BASIS, value);
}

/**
 * The reader-facing "what am I looking at" sentence for each basis.
 *
 * A SECOND basis-dependent sentence, because the card's info hint states the
 * metric twice and only one of the two was moved onto the wire at first: the
 * "how" named the computation, and the "what" named the NUMERATOR AND THE UNIT
 * ("Lines of code merged per dollar"). Coarsening only the "how" left the card
 * describing an unrecognized ratio as lines-of-code-per-dollar one line above
 * saying it could not describe it (codex review on #6929). Both sentences are
 * claims about the same basis, so both are published by it.
 *
 * Not folded into one string with the "how": the card renders them in two
 * distinct slots with different typography, and joining them here would make
 * this module own that layout.
 */
const WHAT_BY_BASIS: Record<MergedLocPerDollarBasis, string> = {
  [MergedLocPerDollarBasis.MergedLinesOverTotalCost]:
    "Lines of code merged per dollar, output efficiency. Higher is better.",
};

/**
 * The "what" sentence for a producer that states NO basis.
 *
 * Its own literal rather than an alias of the total-cost entry above, for the
 * reason {@link MERGED_LOC_PER_DOLLAR_HOW_WITHOUT_BASIS} spells out: the two
 * state different facts and a future default must not silently rewrite the
 * claim made about an old server. A test pins that today they agree.
 */
export const MERGED_LOC_PER_DOLLAR_WHAT_WITHOUT_BASIS =
  "Lines of code merged per dollar, output efficiency. Higher is better.";

/**
 * The "what" sentence for a basis this build does not know.
 *
 * Names NEITHER side of the ratio and NOT its orientation. "Lines of code",
 * "per dollar" and "higher is better" are each a claim the response declined to
 * make: a member this build never compiled against can move the numerator
 * (ISS-9814 swaps merged lines for Pensero points), the denominator, or both,
 * and an unknown numerator has no known direction of goodness either. The
 * figure still renders — coarsening the caption must not withdraw data the
 * reader can use — it just stops being labelled a quantity nobody here can
 * vouch for.
 *
 * ISS-9978 reworded it to stop opening with the words the LABEL now carries.
 * Once {@link MERGED_LOC_PER_DOLLAR_LABEL_UNRECOGNIZED_BASIS} made the card
 * call itself "Efficiency ratio", a hint one click below reading "An efficiency
 * ratio whose…" spent its first three words repeating the line above it. The
 * hint exists to add what an 11px uppercase label cannot carry, so it starts at
 * that part.
 */
export const MERGED_LOC_PER_DOLLAR_WHAT_UNRECOGNIZED_BASIS =
  "Numerator and denominator are not stated by this response.";

/**
 * The "what" sentence for a wire value, coarsening anything unrecognized.
 *
 * Takes `string | undefined` for the same reason {@link
 * resolveMergedLocPerDollarHow} does: the field crosses an HTTP boundary from a
 * server that may be newer than this build.
 */
export function resolveMergedLocPerDollarWhat(
  basis: string | undefined
): string {
  return resolveBasisCopy(
    basis,
    WHAT_BY_BASIS,
    MERGED_LOC_PER_DOLLAR_WHAT_WITHOUT_BASIS,
    MERGED_LOC_PER_DOLLAR_WHAT_UNRECOGNIZED_BASIS
  );
}

/**
 * ISS-9978: the card's own LABEL for each basis.
 *
 * A THIRD basis-dependent string, and the one that had been left compiled in
 * longest. Whatever the stated arm renders asserts the UNIT and the NUMERATOR —
 * exactly the two claims {@link MERGED_LOC_PER_DOLLAR_WHAT_UNRECOGNIZED_BASIS}
 * exists to stop making — so under a basis this build never compiled against
 * the card coarsened both info sentences and then went on naming the figure in
 * 18px type above them.
 *
 * The stated arm is a shared constant, not a re-spelling of one: the unit must
 * keep having exactly one owner (ISS-4667), and a second literal here is how
 * one surface drifts back to a retired spelling. ISS-10667 adds the gated
 * sibling {@link CANONICAL_LABEL_BY_BASIS} rather than editing this map, so the
 * closed-by-default rollout can render both.
 */
const LABEL_BY_BASIS: Record<MergedLocPerDollarBasis, string> = {
  [MergedLocPerDollarBasis.MergedLinesOverTotalCost]: LOC_PER_DOLLAR_LABEL,
};

/** ISS-10667: the same map on the canonical phrase. */
const CANONICAL_LABEL_BY_BASIS: Record<MergedLocPerDollarBasis, string> = {
  [MergedLocPerDollarBasis.MergedLinesOverTotalCost]:
    MERGED_LOC_PER_DOLLAR_LABEL,
};

/**
 * The label for a producer that states NO basis.
 *
 * Its own binding rather than an alias, for the reason {@link
 * MERGED_LOC_PER_DOLLAR_HOW_WITHOUT_BASIS} spells out: "this response says its
 * basis" and "this response predates the field" are two different facts, and a
 * future default must not silently rewrite the claim made about an old server.
 * Both resolve through the shared constant today, and a test pins that.
 */
export const MERGED_LOC_PER_DOLLAR_LABEL_WITHOUT_BASIS = LOC_PER_DOLLAR_LABEL;

/**
 * The label for a basis this build does not know.
 *
 * Names NEITHER side of the ratio and no unit — "LOC" is a numerator claim and
 * "/ $" a denominator one, and a member this build never compiled against can
 * move either (ISS-9814 swaps merged lines for Pensero points).
 *
 * It still names a CARD, because the figure keeps rendering — coarsening the
 * caption must not withdraw data the reader can use, and a card with a number
 * and no label is worse than one honestly labelled at a coarser grain.
 */
export const MERGED_LOC_PER_DOLLAR_LABEL_UNRECOGNIZED_BASIS =
  "Efficiency ratio";

/**
 * The card's label for a wire value, coarsening anything unrecognized.
 *
 * Takes `string | undefined` for the same reason the two sentence resolvers do:
 * the field crosses an HTTP boundary from a server that may be newer than this
 * build.
 */
export function resolveMergedLocPerDollarLabel(
  basis: string | undefined
): string {
  return resolveBasisCopy(
    basis,
    LABEL_BY_BASIS,
    MERGED_LOC_PER_DOLLAR_LABEL_WITHOUT_BASIS,
    MERGED_LOC_PER_DOLLAR_LABEL_UNRECOGNIZED_BASIS
  );
}

/**
 * ISS-10667 (behind `ONE_LABEL_PER_METRIC_FLAG_KEY`): the same resolution with
 * the two MERGED arms on the canonical phrase.
 *
 * The unrecognized arm is deliberately UNCHANGED, and ISS-10667 v8 confirms it
 * is not a variant spelling of the ratio at all — it is the coarsening this
 * module exists for. `Merged LOC per $` is a STRONGER claim than the spelling
 * it replaces: it asserts the numerator as well as the unit, which is exactly
 * what a response stating a basis this build never compiled against has
 * declined to state (ISS-9814 swaps merged lines for Pensero points). Putting
 * it there would reinstate the ISS-9978 defect while the sibling sentence still
 * reads "Numerator and denominator are not stated by this response."
 */
export function resolveCanonicalMergedLocPerDollarLabel(
  basis: string | undefined
): string {
  return resolveBasisCopy(
    basis,
    CANONICAL_LABEL_BY_BASIS,
    MERGED_LOC_PER_DOLLAR_LABEL,
    MERGED_LOC_PER_DOLLAR_LABEL_UNRECOGNIZED_BASIS
  );
}

/**
 * ISS-9978: the caption under the value — the POPULATION the ratio is measured
 * over.
 *
 * The fourth basis-dependent string, and a claim in exactly the way the label
 * is: "across sessions in range" says the denominator was summed over the
 * matched sessions in the selected window. A basis that moves the population —
 * per-PR, per-branch, per-repo — leaves that sentence wrong with nothing on
 * screen contradicting it.
 */
const DETAIL_BY_BASIS: Record<MergedLocPerDollarBasis, string> = {
  [MergedLocPerDollarBasis.MergedLinesOverTotalCost]:
    "across sessions in range",
};

/**
 * The caption for a producer that states NO basis — what every server in
 * production today lands on, and what this card hard-coded before ISS-9978.
 */
export const MERGED_LOC_PER_DOLLAR_DETAIL_WITHOUT_BASIS =
  "across sessions in range";

/**
 * The caption for a basis this build does not know.
 *
 * States that the scope is unknown instead of naming one. "in range" is itself
 * a population claim — a basis whose denominator is not summed per session need
 * not respect the range control at all — so the coarsened caption keeps neither
 * half of the shipped sentence.
 *
 * "scope", not "population": this slot sits directly under the value in
 * `text-muted-foreground text-sm`, where every sibling caption on these two
 * strips is a phrase completing "3.50 ___" ("merged in range", "across sessions
 * in range", "all time"). "population" is this module's own vocabulary and
 * reads as a stats noun dropped into a modifier slot; "scope" is already the
 * product word on this metric family (the Branches LOC/$ hint says "in the same
 * filtered authority scope").
 */
export const MERGED_LOC_PER_DOLLAR_DETAIL_UNRECOGNIZED_BASIS =
  "scope not stated";

/**
 * The caption for a wire value, coarsening anything unrecognized.
 */
export function resolveMergedLocPerDollarDetail(
  basis: string | undefined
): string {
  return resolveBasisCopy(
    basis,
    DETAIL_BY_BASIS,
    MERGED_LOC_PER_DOLLAR_DETAIL_WITHOUT_BASIS,
    MERGED_LOC_PER_DOLLAR_DETAIL_UNRECOGNIZED_BASIS
  );
}

/**
 * ISS-9097: the two halves of the total-cost basis's shipped "how" sentence.
 *
 * The LOC definition registry (`./loc-metric-definitions.ts`) owes a numerator
 * and a denominator, and this basis states them only as one joined sentence.
 * They are SPLIT here rather than written there because these are the sentence's
 * own words: `__tests__/loc-metric-definitions.test.ts` reassembles the two and
 * holds the result against {@link resolveMergedLocPerDollarHow}, so neither half
 * can drift into copy no human approved, and a basis that moves the sentence
 * cannot leave the registry describing the old one.
 */
export const MERGED_LOC_PER_DOLLAR_NUMERATOR = "merged gross lines";

export const MERGED_LOC_PER_DOLLAR_DENOMINATOR =
  "the total estimated cost across matched sessions";

/**
 * The ONE arm decision behind every basis-dependent sentence.
 *
 * Both public resolvers delegate here rather than each re-deriving
 * stated/absent/unrecognized, so the two sentences a reader sees together
 * cannot land on different arms — which is the failure the "what" was in
 * before: a stated arm for one sentence and a coarsened arm for the other, in
 * the same hint. Adding a third basis-dependent string keeps that property by
 * construction instead of by a third copy of this `if` ladder.
 */
function resolveBasisCopy(
  basis: string | undefined,
  stated: Record<MergedLocPerDollarBasis, string>,
  absent: string,
  unrecognized: string
): string {
  if (basis === undefined) {
    return absent;
  }
  if (isMergedLocPerDollarBasis(basis)) {
    return stated[basis];
  }
  return unrecognized;
}
