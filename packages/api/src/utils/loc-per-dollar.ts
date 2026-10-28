/**
 * ISS-4667: the canonical LOC/$ ("lines per dollar") code-efficiency metric,
 * shared by the cloud session/component projections (`apps/api`), the desktop
 * local readers (`apps/desktop`), and the app-core surfaces (`packages/app`).
 *
 *   locPerDollar = totalLines / cost      // NO divide-by-1000
 *
 * Higher is better. This is the ONLY unit and orientation for the metric on
 * every surface — never KLOC/$ (which floored a real 4,004-line / $4,574.72
 * session to a misleading `0.00`), and never the inverted $/LOC or $/KLOC.
 *
 * `totalLines` is added + removed (lines *changed*), matching the org-level
 * definition in `apps/api/app/agent-components/loc-per-dollar.ts` and the
 * insights rollup — NOT additions only — so a single session's efficiency reads
 * on the same basis as the aggregates it rolls into, and its numerator/
 * denominator reconcile with the same card's "Lines changed" and "Cost".
 */

import type { InvocationLocPerDollarUncoveredOperand } from "../types/agent-component-invocation-lines.ts";
import {
  type SessionLocEntry,
  sumSessionLocDedupedByBranch,
} from "./session-loc.ts";

/**
 * The canonical user-facing label for the metric. Every surface that names the
 * metric — table column, metric card, view-menu option, KPI tile — reads this
 * constant so the label cannot drift back to "KLOC / $" or "$ / KLOC" in one
 * place while the rest say something else.
 */
export const LOC_PER_DOLLAR_LABEL = "LOC / $";

/**
 * ISS-10667 / DOC-27 R4a: the ONE spelling of the ratio, with the basis leading
 * the label rather than trailing it as a parenthetical.
 *
 * Two labels because the ratio has two bases, not because it has two names:
 * merged lines and pushed lines are different numerators over the same
 * denominator, and merged is a SUBSET of pushed. R4a collapses the Session and
 * Branch scopings of each basis onto one label deliberately — the label cannot
 * carry that distinction, so R9/R13 put it on the explainer.
 *
 * {@link LOC_PER_DOLLAR_LABEL} above is the spelling these replace; it stays
 * until the gate is retired, because a closed-by-default rollout has to render
 * both.
 */
export const MERGED_LOC_PER_DOLLAR_LABEL = "Merged LOC per $";

export const PUSHED_LOC_PER_DOLLAR_LABEL = "Pushed LOC per $";

/**
 * ISS-10667 ruling 7: the ONE authorized short form of the ratio.
 *
 * It DROPS THE BASIS, which R4a deliberately put first — so where merged and
 * pushed can appear together it leaves the reader inferring which one they are
 * reading. The ticket flags that for the team review; this constant exists so a
 * site that measurably cannot hold the canonical has one spelling to fall back
 * to rather than inventing a third.
 */
export const LOC_PER_DOLLAR_ALIAS_LABEL = "LOC per $";

/**
 * Lines in one KLOC — the legacy unit's scale factor. Only used to convert a
 * version-skewed producer's legacy `klocPerDollar` wire value into the
 * canonical unit; nothing in the current math divides by it.
 */
const LINES_PER_KLOC = 1000;

/**
 * LOC/$ efficiency.
 *
 * ISS-9980 (RULED 2026-09-11) moved the `null` OFF the numerator and ONTO the
 * denominator, and the distinction it draws is the whole point:
 *
 *   - A numerator that is KNOWN and ZERO is a fact about the population — "this
 *     session merged nothing, and you spent $X" — so it divides, and the answer
 *     is a real `0`. Suppressing it hid a true measurement behind the same
 *     placeholder that means "we could not measure".
 *   - A numerator that is NOT KNOWABLE arrives as `null` (the caller looked and
 *     could not resolve it — desktop before a cloud sync, or merged PRs whose
 *     per-PR LOC rows are unreachable). There is nothing to divide, so the
 *     answer is `null`, and the UI renders NOT AVAILABLE.
 *   - A denominator that is zero, absent, or unpriced makes the ratio
 *     arithmetically undefined, so it is `null` whatever the numerator is.
 *
 * A negative or non-finite line count is impossible rather than merely unknown,
 * so it is refused the same way — never coerced to a measured `0`.
 *
 * This is now the SAME rule {@link locPerDollarFromPopulation} applies over a
 * cohort; before ISS-9980 the two deliberately differed on the zero numerator.
 */
export function locPerDollarFromLines(
  totalLines: number | null,
  cost: number | null
): number | null {
  if (totalLines === null) {
    return null;
  }
  if (!(Number.isFinite(totalLines) && totalLines >= 0)) {
    return null;
  }
  if (cost === null || !(Number.isFinite(cost) && cost > 0)) {
    return null;
  }
  return totalLines / cost;
}

/**
 * Cross-version compatibility: convert a legacy `klocPerDollar` wire value
 * (thousand-lines per dollar) emitted by a producer that predates ISS-4667 into
 * the canonical LOC/$ unit. A missing/null/non-finite legacy value stays `null`
 * — an old producer's "unavailable" must not become a fabricated number.
 */
export function locPerDollarFromLegacyKlocPerDollar(
  legacyValue: number | null | undefined
): number | null {
  if (!(typeof legacyValue === "number" && Number.isFinite(legacyValue))) {
    return null;
  }
  // A nonpositive legacy value is not a real efficiency score — reject it rather
  // than scaling it into a fabricated number (ISS-4667 malformed-input guard).
  if (legacyValue <= 0) {
    return null;
  }
  return legacyValue * LINES_PER_KLOC;
}

/**
 * Read the canonical LOC/$ off a wire payload, tolerating version skew. A
 * present canonical value is authoritative (including an explicit `null`, which
 * is the producer's honest "unavailable"); only a payload that OMITS the
 * canonical field (`undefined`) falls back to the producer's legacy KLOC/$
 * value, scaled into LOC/$.
 *
 * A canonical `0` is a MEASURED value and is passed through (ISS-9980, RULED
 * 2026-09-11). The producer divides a known-zero numerator into a real `0`
 * (see {@link locPerDollarFromLines}), so rejecting it here would collapse that
 * measurement back onto the same placeholder that means "we could not measure"
 * — at every consumer reading the server-projected field, and beside a "Lines
 * changed" row already rendering `0 in merged PRs`. A producer that genuinely
 * could not measure sends an explicit `null`, which stays `null`.
 *
 * A canonical value that is present but not a finite non-negative number — a
 * negative, `NaN`, or `Infinity` reaching us from a malformed/version-skewed
 * producer — is not a real efficiency score and must not render as one; it is
 * normalized to `null` ("unavailable") here rather than dropping the enclosing
 * payload, so the malformed metric degrades to a placeholder while the rest of
 * the record survives.
 *
 * Every consumer of a `locPerDollar`-carrying payload — session detail,
 * component inventory row, pack analytics, the Sessions delivery summary —
 * reads through this one resolver so the skew rule cannot drift per surface.
 */
export function resolveLocPerDollar(
  canonical: number | null | undefined,
  legacyKlocPerDollar: number | null | undefined
): number | null {
  if (canonical !== undefined) {
    return canonical !== null && Number.isFinite(canonical) && canonical >= 0
      ? canonical
      : null;
  }
  return locPerDollarFromLegacyKlocPerDollar(legacyKlocPerDollar);
}

/**
 * Cross-version compatibility (EMIT side): scale a canonical LOC/$ value back
 * DOWN into the legacy KLOC/$ unit for the deprecated `klocPerDollar` /
 * `mergedKlocPerDollar` wire alias.
 *
 * The cloud API deploys ahead of the installed Desktop builds already on
 * people's machines. A pre-ISS-4667 Desktop still reads `usage.mergedKlocPerDollar`
 * (and its `packAnalyticsSchema` REQUIRED `klocPerDollar` before it was made
 * optional), so if the cloud stops emitting those fields the old client's Zod
 * parse fails or its render falls to a neutral dash even though the server has
 * the data. Per AGENTS.md Cross-Repo Compatibility, keep emitting the renamed
 * field as a compatibility alias until a human approves removing the shim.
 *
 * A `null`/non-finite canonical value stays `null` — an "unavailable" LOC/$
 * must not become a fabricated legacy number. This is the exact inverse of
 * {@link locPerDollarFromLegacyKlocPerDollar}.
 */
export function legacyKlocPerDollarFromLoc(
  locPerDollar: number | null | undefined
): number | null {
  if (!(typeof locPerDollar === "number" && Number.isFinite(locPerDollar))) {
    return null;
  }
  if (locPerDollar <= 0) {
    return null;
  }
  return locPerDollar / LINES_PER_KLOC;
}

/**
 * Emit-side helper for a payload that carries the canonical `locPerDollar` plus
 * its deprecated `klocPerDollar` compatibility alias. Spread into the wire object
 * so every producer emits BOTH fields identically for the version-skew window —
 * see {@link legacyKlocPerDollarFromLoc}. One helper so the two fields cannot
 * drift apart per emit site.
 */
export function emitLocPerDollarWithLegacy(
  locPerDollar: number | null,
  /**
   * ISS-10730: which operand the suppression could not cover, when the caller
   * knows. Emitted ONLY beside a null ratio — a resolved number needs no reason,
   * and attaching one would state a shortfall that did not occur.
   */
  uncoveredOperand?: InvocationLocPerDollarUncoveredOperand
): {
  locPerDollar: number | null;
  klocPerDollar: number | null;
  locPerDollarUncoveredOperand?: InvocationLocPerDollarUncoveredOperand;
} {
  return {
    locPerDollar,
    klocPerDollar: legacyKlocPerDollarFromLoc(locPerDollar),
    ...(locPerDollar === null && uncoveredOperand !== undefined
      ? { locPerDollarUncoveredOperand: uncoveredOperand }
      : {}),
  };
}

/**
 * ISS-9964 / ISS-9980 (RULED 2026-09-11): the LOC/$ NUMERATOR — lines delivered
 * by this session's MERGED authored PRs, and nothing else.
 *
 * ISS-6113 built this as `max(localWorkingTreeDiff, branchDiff,
 * mergedAuthoredPrLines)` so the ratio could not disagree with the
 * session-detail "Lines changed" row. The agreement is kept; the RUNGS are
 * retired. Sessions LOC/$ now answers one question — "lines that actually
 * landed, per dollar spent" — and a local working tree or an unmerged branch
 * diff is work in progress, not delivered output. Branches LOC/$ counts lines
 * pushed to origin (ISS-9958) and that difference is INTENTIONAL: the two
 * surfaces measure different things on purpose.
 *
 * The return distinguishes the two shapes a caller must render differently:
 *   - a NUMBER (including `0`) is a MEASURED fact: the merge-gated field spoke,
 *     and `0` means "this session merged nothing", which divides into a real
 *     `0` LOC/$.
 *   - `null` is NOT KNOWABLE: no producer supplied the merge-gated count at all
 *     — a desktop session before its first cloud sync, or a version-skewed
 *     producer sending only the legacy `authoredPrLinesChanged` key, which
 *     cannot answer the merged question. The caller renders NOT AVAILABLE and
 *     must never substitute a `0`, because that would report a measurement
 *     nobody took.
 */
export function locPerDollarNumeratorLines(session: {
  mergedAuthoredPrLinesChanged?: number | null;
  /**
   * @deprecated ISS-6114's pre-rename spelling of
   * {@link mergedAuthoredPrLinesChanged}. Still accepted on the wire for
   * version-skewed producers, but it predates the merge gate, so a session
   * carrying only this key yields `null` (not knowable) rather than a count
   * that would silently include unmerged PRs.
   */
  authoredPrLinesChanged?: number | null;
}): number | null {
  // One owner for the skew rule — see `resolveSessionMergedAuthoredPrLoc`.
  const { lines, merged } = resolveSessionMergedAuthoredPrLoc(session);
  if (!merged) {
    return null;
  }
  return lines;
}

/**
 * A line-count input coerced to a usable number. A missing, null, or non-finite
 * value from a version-skewed producer is 0 — never `NaN`, which would collapse
 * every `Math.max` it reaches.
 */
function toLineCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * ISS-6114: which authored-PR roll-up answers, and whether the MERGED one did.
 *
 * SESSION-scoped, and named so deliberately: `projections.ts` already has a
 * private `resolveAuthoredPrLoc(link, repositoryFullName, prNumber, { mergedOnly })` that
 * answers a different question (ONE PR's LOC from a branch's detail rows, `null`
 * when unverified) and already imports from this module. Two exports one import
 * block apart, same name, different contracts, is how the next reader aliases
 * one of them and re-creates the drift this function exists to end.
 *
 * ONE owner for the skew rule, because it was written out twice — here and in
 * `sessionOutputDiffDisplay` (`@repo/app`) — and those two must agree or the
 * LOC/$ ratio and the displayed "Lines changed" figure disagree, which is the
 * exact divergence `locPerDollarNumeratorLines` was created to end (ISS-6113).
 * A later edit widening `??` to `||` in one file, or dropping the legacy arm
 * from one, would reintroduce it with nothing red.
 *
 * `??` and not `||`: a genuine `0` from the new key is an answer ("nothing
 * merged"), not a reason to consult the old one. `merged` reports which key
 * answered, so a caller rendering a qualifier can say "in merged PRs" only when
 * the merge-gated field is the one that spoke.
 *
 * `merged` requires a finite, non-negative number and not merely a non-null one.
 * `mergedAuthoredPrLinesChanged` is an OPTIONAL CROSS-REPO wire field, so a
 * version-skewed or malformed producer can put `NaN`, `Infinity`, or `-5` on it;
 * {@link toLineCount} would fold the non-finite ones to `0`, and a bare non-null
 * test would then publish that as a MEASURED zero — rendering `0 in merged PRs`
 * and a `0` LOC/$ for a session whose merged total is in fact unreadable. An
 * impossible count is not knowable, so it takes the `null` path with the rest.
 */
export function resolveSessionMergedAuthoredPrLoc(session: {
  mergedAuthoredPrLinesChanged?: number | null;
  authoredPrLinesChanged?: number | null;
}): { lines: number; merged: boolean } {
  const mergedValue = session.mergedAuthoredPrLinesChanged;
  const merged =
    typeof mergedValue === "number" &&
    Number.isFinite(mergedValue) &&
    mergedValue >= 0;
  return {
    lines: toLineCount(mergedValue ?? session.authoredPrLinesChanged),
    merged,
  };
}

/**
 * ISS-9980 (RULED 2026-09-11): the LOC/$ ratio for a caller whose numerator has
 * NO tri-state — one that cannot tell "measured zero" from "never measured".
 *
 * {@link locPerDollarFromLines} divides a zero numerator into a real `0`, which
 * is only honest when the caller actually looked and found nothing. The
 * agent-COMPONENT fold cannot make that claim: it builds its numerator as
 * `(row.linesAdded ?? 0) + (row.linesRemoved ?? 0)` over per-session rows whose
 * columns are NULL until a sync populates them, so a never-synced session and a
 * session that changed no lines arrive as the same `0`. Publishing that as a
 * measured `0.00` would report a measurement nobody took — the precise failure
 * the ruling exists to prevent, arrived at from the other direction.
 *
 * So a zero fold here is NOT KNOWABLE and returns `null`. This is the component
 * surfaces' long-standing behaviour, kept deliberately rather than inherited by
 * accident. Giving that fold a real tri-state (the way `SessionLocCost` already
 * carries `costMeasured` for the denominator) would let these callers move to
 * {@link locPerDollarFromLines} and publish an honest component-level `0`; until
 * then they must not.
 */
export function locPerDollarFromCoercedLines(
  totalLines: number,
  cost: number
): number | null {
  if (!(Number.isFinite(totalLines) && totalLines > 0)) {
    return null;
  }
  return locPerDollarFromLines(totalLines, cost);
}

/**
 * ISS-9732: one member of a LOC/$ POPULATION — the unit BOTH terms are summed
 * over (a Session for the Sessions/Agents surfaces, a per-event cost
 * contribution for Branches). `costUsd` is the estimated API cost attributed to
 * that member, or `null`/`undefined` when it was never measured.
 */
export type LocPerDollarCostMember = {
  costUsd: number | null | undefined;
};

/**
 * ISS-9732: the LOC/$ DENOMINATOR — estimated API cost summed over a population,
 * together with the coverage verdict that says whether the sum spans ALL of it.
 *
 * The one owner, the way this module already owns the label (ISS-4667) and the
 * numerator (ISS-6113). Every surface derived its own before, which is how
 * Branches came to divide a numerator summed over its FULL 640-branch cohort by
 * a denominator summed only over the cost-KNOWN subset — $20.39 of a real
 * $163,834.35 — and printed 123,649 LOC/$ for a corpus whose honest rate is
 * single digits. A ratio whose two terms describe different populations is not
 * a rate, so the sum is useless without the verdict and they are returned
 * together rather than left to each caller to pair up.
 *
 * A member whose cost is missing, non-finite, or negative is NOT a $0 member:
 * it is unmeasured, so it is excluded from the sum and recorded as a coverage
 * hole. `measured`/`total` are published so a caller can disclose the gap.
 * A genuine `0` IS measured — priced, and it cost nothing.
 */
export function locPerDollarDenominatorCost(
  members: Iterable<LocPerDollarCostMember>
): {
  cost: number;
  measured: number;
  total: number;
  coverageComplete: boolean;
} {
  let cost = 0;
  let measured = 0;
  let total = 0;
  for (const member of members) {
    total += 1;
    const value = member.costUsd;
    if (!locPerDollarCostMeasured(value)) {
      continue;
    }
    cost += value;
    measured += 1;
  }
  return { cost, measured, total, coverageComplete: measured === total };
}

/**
 * ISS-9732: the LOC/$ ratio for a population whose two terms must span the SAME
 * members. `null` — never a number — when coverage is incomplete, because the
 * ratio is then not a rate at all; the caller renders its unavailable state.
 *
 * Separate from {@link locPerDollarFromLines} for its COVERAGE term, not for its
 * zero rule: ISS-9980 (RULED 2026-09-11) made both treat a verified `0`
 * numerator as the answer it is — "nothing landed in range, and you spent $X".
 * What only a population has is a partial denominator, and a ratio whose two
 * terms span different members is not a rate, so `coverageComplete` is the
 * guard this one adds and the session-scoped helper has no use for.
 */
export function locPerDollarFromPopulation(population: {
  lines: number;
  cost: number;
  coverageComplete: boolean;
}): number | null {
  if (!population.coverageComplete) {
    return null;
  }
  if (!(Number.isFinite(population.lines) && population.lines >= 0)) {
    return null;
  }
  if (!(Number.isFinite(population.cost) && population.cost > 0)) {
    return null;
  }
  return population.lines / population.cost;
}

/**
 * ISS-9097: the two terms that make ONE session's `locPerDollar` a different
 * definition from the Sessions summary's, split so the LOC definition registry
 * can state them without a second spelling.
 *
 * The summary divides across the MATCHED SESSIONS in range; this row divides one
 * session's merged lines by that same session's own cost (ISS-9964 / ISS-9980,
 * ruled 2026-09-11, documented on `AgentSessionDetail.locPerDollar`). Filing the
 * row under the summary's basis would record a denominator and a population it
 * does not compute — and `../types/merged-loc-per-dollar-basis.ts` says in its
 * own header that its scope is `mergedLocPerDollar` and nothing else.
 *
 * The NUMERATOR is not restated here: the two count the same quantity, so the
 * registry reads the summary basis's constant for both and they cannot drift.
 */
export const SESSION_DETAIL_LOC_PER_DOLLAR_DENOMINATOR =
  "this session's own estimated cost";

export const SESSION_DETAIL_LOC_PER_DOLLAR_POPULATION = "this session";

/**
 * ISS-11226 (review: whitlockk): the ONE rule for whether an estimated cost is a
 * MEASURED figure, and therefore whether its member belongs in a LOC/$
 * population at all.
 *
 * This module already applied exactly this test inside
 * {@link locPerDollarDenominatorCost}, but did not publish it, so three other
 * sites re-typed the expression: the cloud fold, the desktop fold — whose
 * docstring claimed the predicate was "shared with the cloud" while holding a
 * copy of it — and the desktop per-session resolver. A policy spelled four
 * times is a policy that can disagree with itself, which is how the Local and
 * Cloud cards come to weigh the same session differently.
 *
 * Missing, non-finite, or negative is NOT a $0 member: nothing measured it, so
 * counting it as free work would lift the rate. A genuine `0` IS measured — it
 * was priced, and it cost nothing.
 */
export function locPerDollarCostMeasured(
  costUsd: number | null | undefined
): costUsd is number {
  return (
    typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0
  );
}

/**
 * One session's LOC contribution plus its cost. `costMeasured` says whether
 * `cost` is a measured figure rather than a stand-in for an absent one. Both the
 * cloud `SessionLocCost` and the desktop `SharedAgentSessionLocCost` satisfy it.
 */
export type SessionLocCostEntry = SessionLocEntry & {
  cost: number;
  costMeasured: boolean;
};

/**
 * ISS-6409: the LOC/$ NUMERATOR and DENOMINATOR for one component, before they
 * are divided. Sessions are deduped by id (a component can carry multiple usage
 * rows per session, so each session's LOC + cost must count exactly once).
 *
 * The split from the ratio exists because a ratio of sums cannot be rebuilt from
 * per-component ratios, so a population fold needs the undivided terms over a
 * session UNION. Keeping ONE fold here means the population behind the terms and
 * the population behind any ratio are the same by construction.
 *
 * One implementation for the cloud agent-components fold
 * (`apps/api/app/agent-components/loc-per-dollar.ts`) and its desktop twin
 * (`apps/desktop/src/main/dashboard/shared-agent-components-loc-per-dollar.ts`),
 * so the two surfaces cannot weigh the same session differently. It sums the
 * denominator through {@link locPerDollarDenominatorCost}.
 */
export function computeLocPerDollarTerms(
  sessionIds: Iterable<string>,
  locCostBySession: ReadonlyMap<string, SessionLocCostEntry>
): { lines: number; cost: number } {
  // FEA-3633: LOC is deduped PER BRANCH — a branch whose LOC came from the
  // branch/PR-total fallback contributes its total once, not once per authoring
  // session (which would count the same code N times). Commit-sourced LOC still
  // sums per-session. Cost always sums per-session (it is genuinely per-session).
  const locEntries: SessionLocEntry[] = [];
  const costMembers: LocPerDollarCostMember[] = [];
  const seen = new Set<string>();
  for (const sessionId of sessionIds) {
    // Dedup by session id first: a component can carry multiple usage rows per
    // session, but each session's LOC + cost must count at most once here.
    if (seen.has(sessionId)) {
      continue;
    }
    seen.add(sessionId);
    const sessionCost = locCostBySession.get(sessionId);
    if (!sessionCost) {
      continue;
    }
    // ISS-6409 (#6417 review): reject the WHOLE impossible set, not the half
    // that is easy to remember. `NaN < 0` and `Infinity < 0` are both false, so
    // a comparison-only guard lets a non-finite cost into the sum — and under
    // the union fold that nulls the entire card rather than one row. Skip the
    // session so numerator and denominator stay on the same session set.
    if (
      !(
        Number.isFinite(sessionCost.cost) && Number.isFinite(sessionCost.loc)
      ) ||
      sessionCost.cost < 0 ||
      sessionCost.loc < 0
    ) {
      continue;
    }
    locEntries.push({
      loc: sessionCost.loc,
      locSource: sessionCost.locSource,
      repositoryFullName: sessionCost.repositoryFullName,
      branch: sessionCost.branch,
    });
    costMembers.push({ costUsd: sessionCost.cost });
  }
  return {
    // ISS-9732: the denominator is summed by its one owner, over exactly the
    // members the numerator above kept — never a second local accumulator.
    cost: locPerDollarDenominatorCost(costMembers).cost,
    lines: sumSessionLocDedupedByBranch(locEntries),
  };
}

/**
 * The sessions a population fold may count: those whose cost was actually
 * MEASURED, in input order.
 *
 * The rule is null-versus-zero, not zero-versus-positive (Cosimo, 2026-09-02):
 *
 *  - cost `0`, measured — INCLUDED. A real figure. The work was free.
 *  - cost absent — EXCLUDED. Its lines would enter the numerator while
 *    contributing nothing to the denominator, so an unpriced session reads as
 *    free work and lifts the rate — and under a union fold it lifts the whole
 *    card, not one row.
 *  - cost measured, NO lines — INCLUDED. Real, common, and it correctly lowers
 *    the rate.
 *
 * Those first two are the same number at this layer, which is why
 * {@link SessionLocCostEntry} carries `costMeasured` at all.
 *
 * Scope: this is the FOLD's rule. A row's own LOC/$ still counts its
 * unmeasured sessions, so a row and the card can weigh the same session
 * differently. Extending it to `computeLocPerDollarTerms` would change the
 * Metric column too, which is wider than was asked for here.
 */
export function measuredCostSessionIds(
  sessionIds: Iterable<string>,
  locCostBySession: ReadonlyMap<string, SessionLocCostEntry>
): string[] {
  const measured: string[] = [];
  for (const sessionId of sessionIds) {
    const sessionCost = locCostBySession.get(sessionId);
    if (!sessionCost) {
      continue;
    }
    if (
      !(sessionCost.costMeasured && locPerDollarCostMeasured(sessionCost.cost))
    ) {
      continue;
    }
    measured.push(sessionId);
  }
  return measured;
}
