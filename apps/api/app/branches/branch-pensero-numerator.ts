import "server-only";

import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  branchCorruptStoredShareRowCount,
  branchDeliveryPoints,
  branchUnresolvedRowCount,
  type DeliveryPointAttribution,
  type DeliveryPointWindow,
} from "@/lib/delivery-points/delivery-point-attribution";
import { readPenseroBranchDeliveryPoints } from "@/lib/delivery-points/delivery-point-read";
import {
  type FeatureFlagIdentity,
  isFeatureFlagEnabledForAnyIdentity,
} from "@/lib/feature-flag-identity";
import { PENSERO_POINTS_PER_DOLLAR_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";
import { failedAcquisitionDay } from "./branch-pensero-failed-day";

/**
 * ISS-9814: one branch's Pensero points, in the shape the metric kernel takes.
 *
 * `null` means there is NO Pensero numerator for this branch, and the card keeps
 * rendering LOC/$ (AC2). `points: 0` means Pensero measured this branch at zero
 * and the card renders `0 pts/$` (AC3). Those are different values of different
 * types on purpose — the read's own contract keeps three zeros apart, and this
 * is where they would be collapsed if anyone wrote `?? 0`.
 */
export type BranchPenseroNumerator = {
  readonly points: number;
  /**
   * ISS-9930: whether this org has a day it attempted and never once retrieved
   * — on branch detail, inside the branch's activity window (ISS-10653); on a
   * listing, inside the request's window (ISS-11600). It selects WHICH
   * shortfall the Partial disclosure names, never whether the number publishes.
   */
  readonly hasFailedAcquisitionDay: boolean;
  /**
   * ISS-9930: whether the rows this pass DID collect hold points no single
   * branch could claim. A different layer's shortfall from the day above, and
   * likewise a disclosure input and never a reason to withhold.
   */
  readonly hasAmbiguousPoints: boolean;
  /**
   * ISS-10608: whether a collected share was refused because its stored value
   * is one no measurement produces. Split from ambiguity so the disclosure
   * names the cause the reader actually has.
   */
  readonly hasUnreadablePointValues: boolean;
};

/**
 * What the fold below can see: the facts one attribution pass states.
 *
 * `hasFailedAcquisitionDay` is deliberately NOT here — it comes from a ledger
 * the fold never reads, and taking it as an argument only to copy it into the
 * return made every call site pass a placeholder the caller then overwrote
 * (tamsinb, PR #7539).
 */
export type BranchPenseroAttributedPoints = Omit<
  BranchPenseroNumerator,
  "hasFailedAcquisitionDay"
>;

/**
 * Fold one branch's delivery attribution into a numerator.
 *
 * ## Which outcomes fold to `null` HERE, stated precisely
 *
 * `readPenseroBranchDeliveryPoints` keeps four outcomes apart. THREE of them
 * fold to `null` here — deliberately, and only after each has been recognized:
 *
 * - the whole attribution is `null` (the principal is outside the
 *   `pensero-integration` rollout — nothing was read),
 * - the attribution ran and this branch has no entry (nothing was there, which
 *   is the state an EMPTY `delivery_points` table produces for every branch),
 * - the attribution ran, rows existed, and NONE resolved to this branch —
 *   including the case where this branch's only interaction was refused as
 *   `AMBIGUOUS`, since `attributeDeliveryPoints` never adds a refused
 *   interaction's branch to `byBranchArtifactId`.
 *
 * All three mean "no publishable Pensero numerator for this branch", which is
 * one render: LOC/$, per AC2 ("Pensero data unavailable → LOC/$ exactly as
 * today"). They are NOT folded into a zero, which would be a fourth, false
 * meaning. The distinction that survives is the one the reader can see — a
 * number versus no number.
 *
 * ## No coverage verdict is derived here — ISS-9930, operator ruling 2026-09-17
 *
 * This fold used to publish `coverageComplete: attribution.unattributed.rowCount
 * === 0`, a claim about the attribution state of rows ALREADY STORED, which said
 * nothing about whether acquisition had stored them all. `SegmentCompleteness`
 * (`packages/pensero/delivery-client.ts`) has no `Complete` member, so nothing
 * can attest that, and the result is Partial whatever this fold sees. The
 * `unattributed` tally is still read, but it now only NAMES a cause in the
 * disclosure; it can no longer withhold the number.
 *
 * ## MULTI-BRANCH SAFE — ISS-11117 discharged the old precondition
 *
 * This fold used to read `attribution.unattributed.unresolvedBranchRowCount`, a
 * total over the whole attribution pass. That was correct only because the sole
 * production caller requested one branch; a listing page attributes the whole
 * visible cohort in ONE pass, and reading the pass total per row would put one
 * row's refused interaction under every other row's number.
 *
 * It now reads {@link branchUnresolvedRowCount}, the per-branch view
 * `attributeDeliveryPoints` records alongside that total, so the fold states
 * only what THIS branch lost. The single-branch caller is unchanged by
 * construction: the read anchors on the requested branch, so every refused
 * interaction it can see is one whose rows named that branch.
 *
 * ## Decimal → number happens exactly once, here
 *
 * `DeliveryPoint.points` is `DECIMAL(12,4)` and the provider emits tenths, so
 * the SUM is accumulated in `Decimal` upstream (`attributeDeliveryPoints`) where
 * float drift would corrupt it. The finished total crosses to `number` at this
 * boundary because the ratio it feeds is a float either way; converting once, at
 * the edge, is what keeps the accumulation exact. `Decimal(0).toNumber()` is
 * `0`, and the explicit `null` check above it is what stops a genuine zero being
 * read as an absence by a nullish or falsy test.
 */
export function branchPenseroNumerator(
  attribution: DeliveryPointAttribution | null,
  branchArtifactId: string
): BranchPenseroAttributedPoints | null {
  if (attribution === null) {
    return null;
  }
  const points = branchDeliveryPoints(attribution, branchArtifactId);
  if (points === null) {
    return null;
  }
  // Per-branch tallies, one per refusal cause (ISS-10608), and NOT the
  // pass-level totals — see the multi-branch note above.
  return {
    points: points.toNumber(),
    hasAmbiguousPoints:
      branchUnresolvedRowCount(attribution, branchArtifactId) > 0,
    hasUnreadablePointValues:
      branchCorruptStoredShareRowCount(attribution, branchArtifactId) > 0,
  };
}

/**
 * Read this branch's Pensero numerator for a request principal.
 *
 * ## ORG CHECK: route-level, by construction — not pushed into the read
 *
 * `readPenseroBranchDeliveryPoints` takes `organizationId` at face value and
 * never checks it against `identity`; its docstring makes that the caller's
 * obligation. ISS-9814 discharges it at the ROUTE and not inside the function.
 *
 * The route (`apps/api/app/branches/[id]/route.ts`) is wrapped in `withAnyAuth`,
 * and what that guarantees — stated exactly, because the looser version of this
 * claim is false — is that `user.organizationId` always names an org whose
 * membership the identity provider has already VERIFIED for this principal:
 *
 * - Clerk session: `resolveOrgHeader` DOES read a caller-supplied
 *   `X-Organization-Id` header, so the org is not literally independent of the
 *   request. But a header naming an org other than the session's is admitted
 *   only after `clerkService.getOrganizationMembershipRole` returns a role; no
 *   role is `forbidden`, and a failed lookup is `unverifiable`. A caller can
 *   therefore select among orgs it is a verified member of, never an arbitrary
 *   one.
 * - API key: the org is the one the key is bound to at issuance, and
 *   `usersService.findById(userId, organizationId)` matches on both columns, so
 *   a mismatch resolves to `null` and 401s.
 * - Desktop session: the org comes from the resolved session.
 *
 * That is the membership proof `readPenseroBranchDeliveryPoints` asks its caller
 * for. Pushing a second check down into the read was rejected: it would have to
 * re-derive membership inside a module whose job is a pure org-scoped query,
 * creating a SECOND authorization authority for a fact the route has already
 * established. Two authorities that can disagree is worse than one, and the
 * branch row itself is fetched under the same `organizationId` — a principal who
 * could reach another org's points could already reach that org's branch.
 *
 * The branch id IS client-supplied and is read before `getBranchDetail` proves
 * the branch belongs to this org. That is inert rather than a disclosure: the
 * row predicate is compound (`organizationId` AND `branchArtifactId` on the same
 * row), so another org's real branch id, a nonexistent id, and an owned branch
 * with no delivery data all return the identical empty result.
 *
 * ## Must not run inside another transaction
 *
 * The read opens its own `RepeatableRead` transaction and `withDb.tx` THROWS
 * rather than join a weaker ambient one, so this is called before
 * `getBranchDetail` opens its `withDb`, never from inside it.
 *
 * ## Gated on the DISPLAY key before any database work
 *
 * Both keys must pass, and this one is checked FIRST because it is the cheap
 * one: a PostHog evaluation costs nothing next to a second interactive
 * transaction, and a principal who will render LOC/$ has no use for the result.
 * Without this gate every branch-detail request for any org in the WRITE
 * rollout pays for the transaction and then discards the value.
 *
 * ## NEVER FATAL
 *
 * `apps/api/app/branches/AGENTS.md`: "An optional analytics read on a required
 * path takes the whole surface down when it times out. Keep lifetime/usage
 * enrichment in a best-effort failure domain." This read opens a
 * `RepeatableRead` transaction, which can fail with a serialization error under
 * a concurrent backfill, or time out — so every throw is swallowed to `null`
 * and the card falls back to LOC/$. A closed-by-default metric must not be able
 * to turn a working branch-detail page into a 500.
 *
 * ## The failed-day flag is added later, by `withBranchFailedAcquisitionDay`
 *
 * ISS-10653 bounds that probe to the branch's activity window, which only the
 * detail read projects.
 */
export async function readBranchPenseroNumerator(
  identity: FeatureFlagIdentity,
  organizationId: string,
  branchArtifactId: string
): Promise<BranchPenseroAttributedPoints | null> {
  try {
    if (!(await isPenseroPointsPerDollarEnabled(identity))) {
      return null;
    }
    const attribution = await readPenseroBranchDeliveryPoints(
      identity,
      organizationId,
      [branchArtifactId]
    );
    return branchPenseroNumerator(attribution, branchArtifactId);
  } catch (error) {
    log.warn("branch_pensero_numerator_read_failed", {
      branchArtifactId,
      error: parseError(error),
    });
    return null;
  }
}

/**
 * ISS-11117: a LISTING COHORT's Pensero numerator — the same read, asked about
 * every branch on screen at once.
 *
 * ## Why this is not N calls to {@link readBranchPenseroNumerator}
 *
 * That one opens a `RepeatableRead` transaction per branch. A listing shows up
 * to a whole org's cohort, so per-branch calls would be a transaction per row,
 * and — worse than the cost — each would run on its OWN snapshot, so a row
 * relinking mid-page would make two branches of one listing disagree about the
 * same interaction. `readPenseroBranchDeliveryPoints` already takes the whole id
 * set and chunks it inside one snapshot, which is what this passes.
 *
 * ## The cohort's disclosure reads the PASS total, and that is correct here
 *
 * {@link branchPenseroNumerator} deliberately reads the PER-BRANCH tally,
 * because a per-row disclosure that read the pass total would print one row's
 * refused interaction under every other row. This function publishes ONE number
 * for the whole requested cohort, so its shortfall is a pass-level quantity.
 * Reading a per-branch tally here would be the mirror error: naming one
 * branch's ambiguity as the cohort's whole story.
 *
 * It is `unattributed.cohortUnresolvedRowCount` rather than
 * `unresolvedBranchRowCount`, for the same reason the numerator is
 * `cohortPoints` rather than `attributedPoints` — a refusal wholly inside the
 * cohort costs a per-branch answer its number and costs this one nothing.
 *
 * ## Same boundaries as its per-branch sibling
 *
 * Gated on the DISPLAY key before any database work, so a reader who will
 * render LOC/$ never pays for the transaction. NEVER FATAL — every throw is
 * swallowed to `null` and the cohort card keeps rendering LOC/$, because a
 * closed-by-default metric must not be able to 500 a listing. And it must not
 * run inside another transaction, so callers invoke it AFTER the branch read
 * snapshot has closed.
 *
 * `null` means there is no Pensero numerator for this cohort — outside the
 * rollout, nothing attributed, or the read failed. It is never a zero:
 * `points: 0` is a measured zero and publishes as `0 Pts / $`.
 *
 * ## The cohort total is WINDOWED, because the cost it divides is
 *
 * Every per-dollar denominator on a listing covers the request's date range:
 * `canonicalEstimatedCostUsd` folds `visibleWindowedUsageByBranch`
 * (`branch-analytics-read.ts:165`), and the Sessions divisor is the cost of the
 * sessions the range matched. A branch-LIFETIME numerator over that divisor
 * inflates as the window narrows, invisibly. So the caller passes the request's
 * window and `attributeDeliveryPoints` sums only the shares the provider dated
 * inside it — see {@link DeliveryPointWindow} for why that is a fold-time
 * filter and not a query predicate. Omitted is the all-time view, where the two
 * terms are both "everything". ISS-11600: the failed-day probe takes the same
 * window at UTC-day grain, so the disclosure names only a day overlapping the
 * period the number sums.
 */
export async function readCohortPenseroNumerator(
  identity: FeatureFlagIdentity,
  organizationId: string,
  branchArtifactIds: readonly string[],
  window?: DeliveryPointWindow
): Promise<BranchPenseroNumerator | null> {
  if (branchArtifactIds.length === 0) {
    return null;
  }
  try {
    if (!(await isPenseroPointsPerDollarEnabled(identity))) {
      return null;
    }
    const attribution = await readPenseroBranchDeliveryPoints(
      identity,
      organizationId,
      branchArtifactIds,
      window
    );
    // `cohortPoints`, NOT `attributedPoints` (tamsinb, PR #7863).
    // `attributedPoints` is a sum of PER-BRANCH totals, so it drops every
    // interaction that named two branches — a refusal that exists because no
    // single branch may claim it, which is not a question ONE cohort total
    // asks. When every branch such an interaction named is inside this cohort
    // its points belong to this total, and dropping them reads LOW by an
    // invisible amount on exactly the stacked-PR and relinked-branch shapes a
    // listing shows most. `cohortPoints` recovers those and only those.
    const points = attribution?.cohortPoints ?? null;
    if (points === null) {
      return null;
    }
    return {
      points: points.toNumber(),
      // The cohort's OWN shortfalls: the pass-level `unresolvedBranchRowCount`
      // also counts the refusals `cohortPoints` just recovered, which would
      // print an ambiguity disclosure under a number that lost nothing.
      hasAmbiguousPoints:
        (attribution?.unattributed.cohortUnresolvedRowCount ?? 0) > 0,
      hasUnreadablePointValues:
        (attribution?.unattributed.cohortCorruptStoredShareRowCount ?? 0) > 0,
      hasFailedAcquisitionDay: await failedAcquisitionDay(
        organizationId,
        window
      ),
    };
  } catch (error) {
    log.warn("cohort_pensero_numerator_read_failed", {
      branchCount: branchArtifactIds.length,
      error: parseError(error),
    });
    return null;
  }
}

/**
 * ISS-11117: the reader a Branches-listing route hands its read service.
 *
 * One helper so both listing routes — `/branches/analytics` and
 * `/branches/analytics/cohort` — bind the identity and the org the same way,
 * and so the read service never has to know about PostHog or about which
 * principal is asking. `user.organizationId` is the org `withAnyAuth` resolved
 * and verified for this principal, which is the membership proof
 * `readPenseroBranchDeliveryPoints` requires of its caller — the same discharge
 * the branch-detail route makes.
 */
export function cohortPenseroPointsReader(
  identity: FeatureFlagIdentity,
  organizationId: string,
  /** ISS-11117: the request's date window, so the two terms span one period. */
  window?: DeliveryPointWindow
): (
  branchArtifactIds: readonly string[]
) => Promise<BranchPenseroNumerator | null> {
  return (branchArtifactIds) =>
    readCohortPenseroNumerator(
      identity,
      organizationId,
      branchArtifactIds,
      window
    );
}

/**
 * Whether this reader sees Pensero points as the per-dollar numerator.
 *
 * Fail-closed like its write-half sibling: unavailable, false, null, or a
 * thrown evaluation all resolve to false, so a PostHog outage renders LOC/$
 * rather than opening a dark-launched metric.
 */
export function isPenseroPointsPerDollarEnabled(
  identity: FeatureFlagIdentity
): Promise<boolean> {
  return isFeatureFlagEnabledForAnyIdentity(
    PENSERO_POINTS_PER_DOLLAR_SERVER_FLAG,
    identity,
    "pensero_points_per_dollar_feature_flag_unavailable"
  );
}
