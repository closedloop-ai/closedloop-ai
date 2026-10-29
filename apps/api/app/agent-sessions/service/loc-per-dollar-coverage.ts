// ISS-7705 — the fail-closed coverage gate for the Sessions LOC/$ ratio.
//
// THE DEFECT THIS CLOSES. `buildUsageSummary` publishes LOC/$ as a ratio whose
// two sides are aggregated from two INDEPENDENTLY-SCOPED reads:
//
//   numerator   merged gross lines, read PR-side through the SESSION-LINKED
//               DELIVERY arms (`sessionLinkedPopulationArms` — the Metric
//               session→PR arms plus a non-prose session→BRANCH link, the
//               ISS-8153 population) over the DELIVERY scope: every facet filter
//               preserved but the session-activity date window deliberately
//               STRIPPED (`collectDeliveryPrScope`), so an older session's
//               in-window merge is still counted.
//   denominator the total estimated cost from a `groupBy` over the WINDOWED
//               summary `where` (`resolveLocPerDollarCostBasis`).
//
// Nothing proves the second set covers the first. Every session that carries
// numerator evidence but contributes no denominator dollars pushes the ratio UP,
// silently and without bound: a PR that merged inside the window whose sessions
// all last moved before it lands its full line count against nobody's spend.
//
// So this module measures the two populations against each other and returns a
// VERDICT. It does not repair the ratio and it does not choose the basis —
// It establishes whether the published number is one the producer can stand
// behind, so the card can decline to state it rather than state it wrongly.
//
// WHICH SESSIONS ARE THE NUMERATOR. Not "every session that ever carried a
// delivery link" — that set is far wider than the numerator and mostly
// contributes no lines at all, so measuring it would fault a perfectly covered
// ratio on any org with history. The numerator cohort is the sessions linked to
// the branch of a merged PR that landed INSIDE the selected merge window, which
// is exactly the population the LOC came from (`MergedPrBranchRef`, emitted by
// the same admission decision that built the PR set).
//
// ISS-7905: "linked" here means the SAME arms the delivery read selects, not the
// session→PR arms alone. A session on the installation-free lane reaches its
// merged PR only through a non-prose session→branch link, so a probe still
// scoped to session→PR links would find no sessions behind lines the numerator
// had just counted — and report `complete` over a cohort of zero, which is the
// false-completeness this whole module exists to prevent. The two populations
// move together or not at all.
//
// The cohort is scoped by PR IDENTITY, not by branch alone. A branch gets reused
// — a bot branch, re-opened work — and then carries the session→PR links of every
// PR that ever ran on it. Admission (`mergedPrLinkedBranches`) checks link
// metadata against repo+PR, so a cohort read that pulled every link on the branch
// would disagree with the very decision that built the numerator: sessions
// belonging to a DIFFERENT PR would enter the cohort, contribute no lines, and —
// being outside the divisor's window — blank a genuinely covered card as
// `missing` or `stale`. So the admitting identity travels with the branch
// (`MergedPrBranchRef.prIdentity` plus its admission kind) and the link side
// re-applies it through the shared mirror `linkDeclaresAdmittedPr`.
//
// QUERY BUDGET. Nothing here runs unless the delivery read already admitted a
// merged PR in the window. The reads are anchored rather than scanned: the link
// lookup is driven from a known branch-id set on
// `@@index([organizationId, targetId, linkType])`, and the session read is keyed
// on the resulting artifact ids (the primary key). That is a strictly better
// plan than the un-anchored `sourceLinks.some(...)` semi-join, which has no
// index that can enumerate matching links without first walking the org's
// candidate sessions — the same shape ISS-6028 moved the sibling merged-PR read
// away from.
//
// Every id-keyed read goes through the SHARED `readInIdChunks`/`countInIdChunks`
// bound (`session-pr-links.ts`), the same one `findMergedPrsLinkedToSessions`
// already chunks its branch-id lookup on. An all-time window can put either list
// past the driver's bind-parameter ceiling, and an over-limit statement here
// rejects only the PROBE — leaving it reporting `failed` about a summary read
// that succeeded, so the surface contradicts itself instead of erroring cleanly.

import type { DeliveryWindow } from "@repo/api/src/insights/delivery-kpis/normalized-rows";
import { LinkType } from "@repo/api/src/types/artifact";
import {
  type LocPerDollarCoverage,
  LocPerDollarCoverageState,
} from "@repo/api/src/types/loc-per-dollar-coverage";
import { type Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import type { LimitFunction } from "p-limit";
import type { MergedPrBranchRef } from "@/lib/agent-session-delivery-metrics";
import { createDbFanoutLimiter } from "@/lib/db-fanout";
import {
  type AdmittedBranchPrs,
  linkDeclaresAdmittedPr,
  MergedPrBranchAdmissionKind,
  sessionLinkedPopulationArms,
} from "@/lib/session-pr-links";
import {
  countInIdChunks,
  readInIdChunks,
} from "@/lib/session-pr-links-chunking";

/**
 * The raw populations behind a coverage verdict, read from the database.
 *
 * Separated from the fold below so the decision is unit-testable against
 * synthetic populations without a database, and so the fold is the single place
 * precedence is decided.
 */
export type LocPerDollarCoverageCounts = {
  /**
   * Sessions carrying the session-linked DELIVERY links the merged lines were
   * read through — `sessionLinkedPopulationArms`, i.e. the Metric session→PR
   * arms plus a non-prose session→branch link, never the session→PR arms alone
   * (ISS-7905).
   */
  numeratorSessionCount: number;
  /** Of those, how many the DENOMINATOR's own predicate also matches. */
  coveredNumeratorSessionCount: number;
  /**
   * Of the numerator cohort, how many have a chunked replacement STAGED and not
   * yet committed (`pendingChunkRevision IS NOT NULL`).
   */
  migrationPendingSessionCount: number;
  /**
   * Of the numerator cohort, how many carry no `dataRevision` at all — derived
   * cost that was never stamped with a parser revision.
   */
  unrevisionedSessionCount: number;
};

/** The scalars the fold needs that the caller already has in hand. */
export type LocPerDollarCoverageBasis = {
  /** Sessions whose cost the published divisor sums (`aggregate._count._all`). */
  denominatorSessionCount: number;
  /** The dollars the divisor actually summed (`LocPerDollarCostBasis.costUsd`). */
  costBasisCoveredUsd: number;
  /**
   * The WINDOW's spend that the divisor's ledgers leave out — 0 on the total
   * basis, the subscription-covered spend on the API-billed one. Window-scoped,
   * not numerator-cohort-scoped — the published copy is worded to match, and
   * must stay so.
   */
  costBasisExcludedUsd: number;
};

/**
 * Reads the numerator-cohort populations: the sessions whose SESSION-LINKED
 * DELIVERY links declare one of the PRs `numeratorCohort` admitted (the PRs that
 * merged in window), scoped by `deliveryWhere`, measured against
 * `denominatorWhere` — the windowed summary predicate the divisor is actually
 * summed over.
 *
 * "Delivery links" is `sessionLinkedPopulationArms` (ISS-7905), the same
 * population `findMergedPrsLinkedToSessions` reads the numerator from: the
 * Metric session→PR arms PLUS a non-prose session→branch link. Do not narrow one
 * without the other — a probe scoped to a subset of its own subject reports
 * `complete` over lines it never measured.
 *
 * Returns `null` when the probe could not be completed — see the catch for why
 * that degrades rather than throws, and {@link foldLocPerDollarCoverage} for why
 * it becomes `failed` rather than `complete`.
 */
export async function readLocPerDollarCoverageCounts(
  organizationId: string,
  numeratorCohort: NumeratorBranchCohort,
  deliveryWhere: Prisma.SessionDetailWhereInput,
  denominatorWhere: Prisma.SessionDetailWhereInput,
  callerLimiter?: LimitFunction
): Promise<LocPerDollarCoverageCounts | null> {
  try {
    return await withDb(async (db) => {
      // ISS-6136: ONE limiter across this probe's chunked reads, because the row
      // read and the count below are CONCURRENT SIBLINGS and the CALL bound
      // composes by ADDITION — a limiter each would spend
      // `2 x DB_FANOUT_MAX_CONCURRENCY`. For the same reason the CALLER'S limiter
      // wins when it has one: this probe is itself a sibling of the merged-PR
      // read inside `collectDeliveryPrScope`, and minting one here would add a
      // second budget to the stage instead of joining its one. Only the call
      // bound needs stating here: the CONNECTION bound is already ambient,
      // because `withDb` opens a `withDbAcquisitionBudget` scope that every
      // `mapWithDbConcurrency` below joins rather than nesting a second ceiling
      // inside.
      const limiter = callerLimiter ?? createDbFanoutLimiter();
      // The sessions on the numerator side of the ratio: the sources of the
      // delivery links pointing at the branches whose PRs merged in window —
      // then narrowed to the links that declare one of the ADMITTED PRs, so a
      // reused branch's other PR cannot drag its sessions into the cohort.
      const links = await readInIdChunks(
        [...numeratorCohort.keys()],
        (chunk) =>
          db.artifactLink.findMany({
            where: {
              // ISS-5823 / ISS-7905: the SAME arms the delivery read selects
              // (`sessionLinkedPopulationArms` — the Metric session→PR arms plus
              // the non-prose session→branch arm), because this probe reports the
              // coverage of a number a user reads and its population must be
              // identical to the summary read it reports on. Prose stays excluded:
              // the audience doc names LOC-per-dollar as one a prose mention must
              // not move. A probe scoped NARROWER than its subject is the trap
              // here — it would report `complete` over a cohort of zero for lines
              // the numerator had just counted.
              linkType: LinkType.RelatesTo,
              OR: sessionLinkedPopulationArms(),
              organizationId,
              targetId: { in: chunk },
            },
            select: {
              sourceId: true,
              targetId: true,
              metadata: true,
              branchParticipation: true,
            },
          }),
        limiter
      );
      const numeratorArtifactIds = resolveNumeratorArtifactIds(
        links,
        numeratorCohort
      );
      if (numeratorArtifactIds.length === 0) {
        return EMPTY_COUNTS;
      }
      // One row per numerator session, three narrow scalars wide, so the two
      // revision detectors fold in memory instead of costing a query each. The
      // facet filters still apply: `deliveryWhere` carries every filter the
      // reader has on except the date window.
      const [rows, coveredNumeratorSessionCount] = await Promise.all([
        readInIdChunks(
          numeratorArtifactIds,
          (chunk) =>
            db.sessionDetail.findMany({
              where: { AND: [deliveryWhere, { artifactId: { in: chunk } }] },
              select: { dataRevision: true, pendingChunkRevision: true },
            }),
          limiter
        ),
        // Counted with the caller's ACTUAL denominator predicate rather than by
        // re-deriving which clause the two scopes differ by, so the gate cannot
        // drift away from the divisor it describes: whatever the summary
        // aggregates over is, by construction, what "covered" means here. The
        // chunks partition the cohort, so the summed count is the whole
        // population's, not a sample of it.
        countInIdChunks(
          numeratorArtifactIds,
          (chunk) =>
            db.sessionDetail.count({
              where: {
                AND: [denominatorWhere, { artifactId: { in: chunk } }],
              },
            }),
          limiter
        ),
      ]);
      return {
        numeratorSessionCount: rows.length,
        coveredNumeratorSessionCount,
        migrationPendingSessionCount: rows.filter(
          (row) => row.pendingChunkRevision !== null
        ).length,
        unrevisionedSessionCount: rows.filter(
          (row) => row.dataRevision === null
        ).length,
      };
    });
  } catch (error) {
    // The summary's other aggregates have already succeeded by the time this
    // runs. Letting a probe that only ever DECIDES WHETHER TO STATE ONE CARD
    // reject the whole response would give a gate veto power over every headline
    // the reader came for — a regression in blast radius, and the same trap
    // `readOptionalPriorFigures` closes for the prior-period read.
    //
    // So the failure degrades to `null`, which the fold turns into the `failed`
    // verdict, NOT into `complete`: an unanswered coverage question is not a
    // clean bill of health, and the ratio stays unstated. Reported on the
    // monitored server path rather than to the reader — a probe that fails while
    // its sibling aggregates succeed is a real defect worth alerting on even
    // though the response stays useful.
    log.error("Sessions LOC/$ coverage probe failed", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The branches whose merged PRs actually contributed lines to the numerator —
 * every admitted merged PR whose `mergedAt` lands inside the selected merge
 * window — keyed by branch, each carrying the PR identities that were admitted
 * ON that branch.
 *
 * A `null` window is the all-time case (no date filter selected), where every
 * admitted merged PR counts. The bounds are inclusive, matching the SSOT
 * `mergedPrs` population the LOC numerator is computed from, so the cohort this
 * returns and the lines the ratio divides are drawn from one rule.
 *
 * ISS-7705: the identities, not just the branch ids, are what the probe scopes
 * on. A branch that merged two PRs — one in window, one out — appears once here
 * with only the in-window PR's identity, so the out-of-window PR's sessions are
 * not measured as if they had contributed lines.
 */
export function resolveNumeratorBranchCohort(
  mergedBranches: readonly MergedPrBranchRef[],
  mergeWindow: DeliveryWindow | null
): NumeratorBranchCohort {
  const cohort = new Map<string, MutableAdmittedBranchPrs>();
  for (const ref of mergedBranches) {
    const inWindow =
      mergeWindow === null ||
      (ref.mergedAtMs >= mergeWindow.start &&
        ref.mergedAtMs <= mergeWindow.end);
    if (!inWindow) {
      continue;
    }
    const admitted = cohort.get(ref.branchArtifactId) ?? {
      identities: new Set<string>(),
      legacyUniqueFallback: false,
      tierTwoUniqueBranchFallback: false,
    };
    if (ref.prIdentity === null) {
      if (
        ref.admissionKind === MergedPrBranchAdmissionKind.TierTwoUniqueBranch
      ) {
        admitted.tierTwoUniqueBranchFallback = true;
      } else {
        admitted.legacyUniqueFallback = true;
      }
    } else {
      admitted.identities.add(ref.prIdentity);
    }
    cohort.set(ref.branchArtifactId, admitted);
  }
  return cohort;
}

/** A numerator cohort with no sessions behind it — nothing to fault. */
const EMPTY_COUNTS: LocPerDollarCoverageCounts = {
  numeratorSessionCount: 0,
  coveredNumeratorSessionCount: 0,
  migrationPendingSessionCount: 0,
  unrevisionedSessionCount: 0,
};

/**
 * Folds populations into the published verdict.
 *
 * PRECEDENCE is explicit and ordered, because more than one condition holds
 * routinely and the reader gets ONE sentence. The order is by how much the
 * condition moves the number the reader would otherwise act on:
 *
 *  0. `Failed` — the probe did not complete, so nothing below it was measured
 *     at all. Handled before the ordering proper (see the `null` branch).
 *  1. `MigrationPending` — the cohort is actively being replaced. This must
 *     outrank everything: it is what makes a data-revision bump unable to move
 *     the published ratio until the replacement cohort commits, so demoting it
 *     behind a condition that is permanently true on some accounts (the basis
 *     narrowing) would let a mid-flight rebuild publish through.
 *  2. `Stale` — a row whose cost was never revision-stamped cannot be validated
 *     against any revision, so it is unfixable by waiting, unlike (1).
 *  3. `Missing` — numerator sessions the divisor does not sum. The commonest
 *     and the one the reader can act on by widening the range.
 *  4. `CostBasisExcluded` — systematic, always-on for subscription accounts, and
 *     therefore last: reported when nothing sharper is wrong, never masking one.
 *
 * A numerator cohort of zero is `Complete`, not `Missing`: with no
 * numerator-bearing sessions there are no merged lines to divide and the ratio
 * is already null on its own account. Reporting a coverage failure there would
 * caption an absent metric with a reason that does not describe it.
 */
export function foldLocPerDollarCoverage(
  counts: LocPerDollarCoverageCounts | null,
  basis: LocPerDollarCoverageBasis
): LocPerDollarCoverage {
  const shared = {
    denominatorSessionCount: basis.denominatorSessionCount,
    costBasisCoveredUsd: basis.costBasisCoveredUsd,
    costBasisExcludedUsd: basis.costBasisExcludedUsd,
  };
  // A probe that did not complete leaves every numerator population UNKNOWN.
  // They are reported as zero because there is no honest number to report, and
  // the `failed` state is what tells a telemetry consumer to read them that way
  // rather than as a measured empty cohort.
  if (counts === null) {
    return {
      ...shared,
      state: LocPerDollarCoverageState.Failed,
      numeratorSessionCount: 0,
      excludedSessionCount: 0,
    };
  }
  const excludedSessionCount = Math.max(
    0,
    counts.numeratorSessionCount - counts.coveredNumeratorSessionCount
  );
  return {
    ...shared,
    numeratorSessionCount: counts.numeratorSessionCount,
    excludedSessionCount,
    state: resolveCoverageState(counts, excludedSessionCount, basis),
  };
}

/** The ordered precedence described on {@link foldLocPerDollarCoverage}. */
function resolveCoverageState(
  counts: LocPerDollarCoverageCounts,
  excludedSessionCount: number,
  basis: LocPerDollarCoverageBasis
): LocPerDollarCoverageState {
  if (counts.numeratorSessionCount === 0) {
    return LocPerDollarCoverageState.Complete;
  }
  if (counts.migrationPendingSessionCount > 0) {
    return LocPerDollarCoverageState.MigrationPending;
  }
  if (counts.unrevisionedSessionCount > 0) {
    return LocPerDollarCoverageState.Stale;
  }
  if (excludedSessionCount > 0) {
    return LocPerDollarCoverageState.Missing;
  }
  if (basis.costBasisExcludedUsd > 0) {
    return LocPerDollarCoverageState.CostBasisExcluded;
  }
  return LocPerDollarCoverageState.Complete;
}

/**
 * The numerator cohort the probe measures: branch artifact id → the merged PRs
 * admitted on that branch, including which null-identity fallback admitted it,
 * as {@link linkDeclaresAdmittedPr} needs to see them.
 */
export type NumeratorBranchCohort = ReadonlyMap<string, AdmittedBranchPrs>;

/** The accumulating form of {@link AdmittedBranchPrs}, local to the resolver. */
type MutableAdmittedBranchPrs = {
  identities: Set<string>;
  legacyUniqueFallback: boolean;
  tierTwoUniqueBranchFallback: boolean;
};

/**
 * The distinct sessions on the numerator side: the sources of the delivery links
 * that declare an ADMITTED PR, dropping the links a reused branch carries for a
 * PR this window never counted lines from.
 */
function resolveNumeratorArtifactIds(
  links: readonly {
    sourceId: string;
    targetId: string;
    metadata: unknown;
    branchParticipation?: string | null;
  }[],
  numeratorCohort: NumeratorBranchCohort
): string[] {
  const sourceIds = new Set<string>();
  for (const link of links) {
    if (
      linkDeclaresAdmittedPr(
        link.metadata,
        numeratorCohort.get(link.targetId),
        link.branchParticipation
      )
    ) {
      sourceIds.add(link.sourceId);
    }
  }
  return [...sourceIds];
}
