/**
 * Merged-PR identity and lines-of-change resolution for the Delivery insights
 * (PLN-1535 M4; identity extended to the sibling facets by ISS-5411).
 *
 * This is the SSOT for two things a projected `PullRequestDetail` row set needs
 * before any Delivery figure is taken of it: WHICH PULL REQUEST a row is
 * ({@link projectedPrIdentity}, {@link dedupeMergedPrs},
 * {@link distinctMergedPrCount}) and HOW MANY LINES it moved
 * ({@link mergedPrLoc}, {@link mergedPrLocTotals}). Every merged-PR facet in
 * one Delivery response reads the same identity here, so they all report pull
 * requests rather than rows.
 *
 * The LOC half replaces the previous
 * branch-file-cache derivation, which was wrong in two ways the plan's D1 calls
 * out by name:
 *
 * 1. **It double-counted multi-PR branches.** LOC was summed per BRANCH
 *    artifact and then read once per merged PR, so a branch carrying two merged
 *    PRs in the window contributed its whole line total twice. Reading LOC off
 *    the PR row makes each PR contribute exactly its own diff, and deduping by
 *    PR identity stops one real PR projected by two producers from counting
 *    twice.
 * 2. **It reported unknown LOC as zero.** An un-enriched branch folded into the
 *    KLOC sum as `0` — described at the call site as "harmless for a sum", but
 *    it silently understated a real number with no indication that anything was
 *    missing. Here `null` additions/deletions mean UNKNOWN and are excluded
 *    from the sum, counted, and reported as a coverage exclusion instead.
 *
 * Lives in this sibling module rather than the grandfathered `service.ts` so
 * the cohesive LOC logic and its focused tests live together and that file
 * shrinks. Mirrors the Branches read service's `branch-loc.ts` split.
 */

import {
  KpiFormat,
  kpi,
  SizeCoveragePopulation,
  withSizeCoverage,
} from "@closedloop-ai/loops-api/insights";
import type { KpiStat } from "@repo/api/src/types/insights";
import { median, round } from "@repo/api/src/utils/math";

/**
 * The projection fields this module needs to identify one merged PR.
 *
 * Split from {@link MergedPrLocInput} by ISS-5411 so a caller that only needs
 * to COUNT distinct pull requests can select these five columns and skip the
 * diff stats — the identity never depends on them.
 */
export type ProjectedPrIdentityInput = {
  /** Row primary key — the last-resort identity for a repo-less row. */
  id: string;
  number: number;
  /** GitHub node id; globally unique when present, so the strongest identity. */
  githubId: string | null;
  /** Normalized `owner/name`; the producer-independent repo identity. */
  repositoryFullName: string | null;
  /** Installation-repo surrogate; only App-adopted rows carry it. */
  repositoryId: string | null;
};

/** The projection fields this module needs to identify and size one merged PR. */
export type MergedPrLocInput = ProjectedPrIdentityInput & {
  additions: number | null;
  deletions: number | null;
};

/** Deduped, null-preserving totals over the merged PRs in a window. */
export type MergedPrLocTotals = {
  /** Sum over PRs with KNOWN LOC. An unknown PR is never folded in as zero. */
  totalLines: number;
  /**
   * Per-PR sizes for PRs with KNOWN LOC — the Median-PR-size population. A
   * known-zero PR (both counts present, no lines touched) belongs here; an
   * unknown one does not.
   */
  knownLocValues: number[];
  /** Deduped merged-PR count — the population every share below is taken of. */
  prCount: number;
  /** PRs whose projection carries no LOC. The coverage exclusion, not a zero. */
  unknownLocCount: number;
};

/**
 * Stable identity for one projected pull request.
 *
 * Repo identity LEADS, per the repo-wide PR identity rule: repository plus
 * number when a repository is known, never number alone, because two repos can
 * each have a PR #42 and collapsing them would UNDER-count. `repositoryFullName`
 * is the producer-independent component (schema.prisma D2) — both the desktop
 * sync writer and the GitHub App projection writer stamp it — so it is the one
 * key under which two projections of ONE pull request actually meet.
 *
 * `githubId` deliberately does NOT lead, though it is the strongest-looking
 * field: `PullRequestDetail.githubId` is `@unique`, so no two rows can ever
 * share one. Keyed first, it can therefore never MERGE a duplicate pair — it can
 * only SPLIT one, by handing a `gh:` key to whichever row got adopted and a
 * `repo:` key to the twin left behind. That pair is not hypothetical:
 * `adoptRepolessPullRequestDetail` stamps the githubId onto exactly one
 * `githubId IS NULL` row and documents leaving "any additional duplicate row
 * untouched", because no unique constraint forbids two of them on one
 * (branchArtifactId, number). Both keep the same `repositoryFullName`, so
 * repo-first is what collapses them — and the double-count this module exists
 * to fix stays fixed.
 *
 * A row with no repo identity at all falls back to its github id, then to its
 * own primary key: two such rows stay separate. Over-counting a genuine
 * duplicate is the lesser error against collapsing two distinct PRs into one.
 *
 * Named for the PROJECTION row it keys, not `mergedPrIdentity`, because
 * `apps/api/lib/session-pr-links.ts` already exports a function by that name for
 * the session→PR-link readers. The two take different inputs (a link's
 * `MergedPrDetail` + branch artifact id vs. a projection row) and need different
 * last-resort fallbacks, so they are not collapsible — but they MUST agree on
 * the shared part of the key, hence the same `toLowerCase()` on the repo. Two
 * identity helpers that case-fold differently would dedupe the same PR in one
 * reader and not the other.
 */
export function projectedPrIdentity(pr: ProjectedPrIdentityInput): string {
  if (pr.repositoryFullName) {
    return `repo:${pr.repositoryFullName.toLowerCase()}#${pr.number}`;
  }
  if (pr.repositoryId) {
    return `repoId:${pr.repositoryId}#${pr.number}`;
  }
  if (pr.githubId) {
    return `gh:${pr.githubId}`;
  }
  return `row:${pr.id}`;
}

/**
 * One PR's size, preserving unknown.
 *
 * BOTH counts must be present: a row carrying additions but no deletions is a
 * partially-projected row, not a PR that removed nothing. This is the same
 * all-or-nothing rule `isLocEnriched` applies on the Branches surface, so a
 * half-projected row reads as unavailable rather than as a wrong-but-plausible
 * size.
 */
export function mergedPrLoc(pr: MergedPrLocInput): number | null {
  const additions = finiteCount(pr.additions);
  const deletions = finiteCount(pr.deletions);
  if (additions === null || deletions === null) {
    return null;
  }
  return additions + deletions;
}

/**
 * Dedupe merged PRs by identity, returning the winning ROWS so callers keep
 * every field they selected (the KLOC trend still needs `mergedAt`).
 *
 * Two tie-breaks, in order:
 *
 * 1. **A sized row beats an unsized one** — a repo-less desktop row missing its
 *    diff stats must never suppress the webhook-projected row for the same PR.
 * 2. **When BOTH carry LOC and the counts disagree, the App-owned row wins** —
 *    the one carrying a `githubId`, which only the App/webhook path writes. Left
 *    to arrival order the reported size of one PR would depend on row ordering,
 *    which is not a fact about the PR; GitHub's own numbers are the tiebreaker
 *    with a claim to being right.
 */
export function dedupeMergedPrs<T extends MergedPrLocInput>(
  rows: readonly T[]
): T[] {
  const byIdentity = new Map<string, T>();
  for (const row of rows) {
    const identity = projectedPrIdentity(row);
    const existing = byIdentity.get(identity);
    if (!existing || winsDedupe(existing, row)) {
      byIdentity.set(identity, row);
    }
  }
  return [...byIdentity.values()];
}

/**
 * {@link dedupeMergedPrs} for rows that carry their branch artifact's creation
 * instant, with each winner's `branchArtifact.createdAt` rewritten to the
 * EARLIEST creation any of its twin rows carries.
 *
 * The dedupe picks winners by diff-stat quality — a fact with no bearing on
 * timing. Twin rows sit on different branch artifacts, and `Artifact.createdAt`
 * is `@default(now())`, so a winner projected only AFTER the merge would carry
 * a branch-created→merged interval that reads negative and gets dropped by the
 * caller, erasing a valid interval the losing twin still held. Rewriting the
 * winner to the pair's earliest creation — the closest observable stand-in for
 * when the branch actually began — keeps every deduped row self-consistent, so
 * a consumer reading `branchArtifact.createdAt` off a winner gets the pull
 * request's timing, never a fact about which twin won the LOC tie-break.
 */
export function dedupeMergedPrsWithEarliestCreation<
  T extends MergedPrLocInput & { branchArtifact: { createdAt: Date } },
>(rows: readonly T[]): T[] {
  const earliestMsByIdentity = new Map<string, number>();
  for (const row of rows) {
    const identity = projectedPrIdentity(row);
    const createdMs = row.branchArtifact.createdAt.getTime();
    const existing = earliestMsByIdentity.get(identity);
    if (existing === undefined || createdMs < existing) {
      earliestMsByIdentity.set(identity, createdMs);
    }
  }
  return dedupeMergedPrs(rows).map((winner) => {
    const earliestMs = earliestMsByIdentity.get(projectedPrIdentity(winner));
    if (
      earliestMs === undefined ||
      earliestMs === winner.branchArtifact.createdAt.getTime()
    ) {
      return winner;
    }
    return {
      ...winner,
      branchArtifact: {
        ...winner.branchArtifact,
        createdAt: new Date(earliestMs),
      },
    };
  });
}

/**
 * Null-preserving KLOC/median/coverage inputs over ALREADY-DEDUPED rows — pass
 * the output of {@link dedupeMergedPrs} or of
 * {@link dedupeMergedPrsWithEarliestCreation}, so one window is deduped exactly
 * once and every derived number is taken of the same population.
 */
export function mergedPrLocTotals(
  dedupedRows: readonly MergedPrLocInput[]
): MergedPrLocTotals {
  const knownLocValues: number[] = [];
  for (const pr of dedupedRows) {
    const loc = mergedPrLoc(pr);
    if (loc !== null) {
      knownLocValues.push(loc);
    }
  }
  return {
    totalLines: knownLocValues.reduce((sum, loc) => sum + loc, 0),
    knownLocValues,
    prCount: dedupedRows.length,
    unknownLocCount: dedupedRows.length - knownLocValues.length,
  };
}

/**
 * An exact merged-PR ROW count corrected down to distinct PULL REQUESTS
 * (ISS-5411).
 *
 * The headline count is a `count()` over the same predicate the row scan uses,
 * so it is exact and — unlike the scan — uncapped. What it counts is rows
 * though, and one real pull request can be two of them (see
 * {@link projectedPrIdentity} for why that pair exists and cannot be forbidden
 * by a unique constraint). Subtracting the duplicates the scan can see turns it
 * into a pull-request count without giving up the uncapped exactness the
 * separate `count()` exists for.
 *
 * `scannedRows` MUST come from the same window and predicate as
 * `exactRowCount`. Identity is row-local, so every duplicate pair the scan
 * holds is a duplicate pair in the full population — the correction is never an
 * over-count. When the scan is capped it sees only some of them, so the result
 * lands between the true distinct count and the raw row count: still short of
 * the truth by the unseen duplicates, but never further from it than the
 * uncorrected count was.
 *
 * ISS-5624: this is now the ONLY approximate operand. The windows the endpoint
 * holds no rows for — the prior merged window and the closed side of the merge
 * rate — count their distinct identities in SQL and are exact at any size, so a
 * ratio taken against one of them reconciles exactly below the cap and, above
 * it, carries this side's unseen duplicates alone rather than a difference
 * between two independently-capped slices. Correcting the current window the
 * same way would cost nothing extra in queries; it is left alone here because
 * the scan it corrects is already in hand and every sibling merged-PR facet is
 * built from that same capped scan.
 */
export function distinctMergedPrCount(
  exactRowCount: number,
  scannedRows: readonly ProjectedPrIdentityInput[]
): number {
  const identities = new Set<string>();
  for (const row of scannedRows) {
    identities.add(projectedPrIdentity(row));
  }
  // Distinct pull requests the scan PROVED, plus at most one pull request per
  // row the count saw beyond the scan (the cap overflow). When the two racing
  // queries disagree — a twin row written between them — the overflow term
  // clamps to zero and the scan's own distinct count is the floor that cannot
  // lie, never a zero the sibling facets built from the same scan contradict.
  return identities.size + Math.max(0, exactRowCount - scannedRows.length);
}

/**
 * Which of two rows for the SAME pull request should represent it.
 *
 * A sized row always beats an unsized one. Between two sized rows the counts
 * normally agree (both project the same PR), and when they do this is a no-op;
 * when they DISAGREE the App-owned row — the one carrying the `githubId` only
 * the App/webhook path writes — wins, so the reported size of a PR is never
 * decided by which row the query happened to emit first.
 */
function winsDedupe(
  existing: MergedPrLocInput,
  row: MergedPrLocInput
): boolean {
  const existingLoc = mergedPrLoc(existing);
  const rowLoc = mergedPrLoc(row);
  if (existingLoc === null) {
    return rowLoc !== null;
  }
  if (rowLoc === null || rowLoc === existingLoc) {
    return false;
  }
  return Boolean(row.githubId) && !existing.githubId;
}

/**
 * Narrow a projected diff count to a usable number, or `null`.
 *
 * The declared type is `number | null`, but this sits at a persistence
 * boundary: a Prisma row that never selected the column, a partially-written
 * projection, or a corrupt value can all present as `undefined`, `NaN`, or
 * `Infinity` at runtime. Comparing against `null` alone let `undefined` through
 * and produced a `NaN` KLOC — a number that renders as garbage rather than as
 * the honest "unknown" the caller is prepared to handle.
 *
 * A NEGATIVE count is unknown for the same reason: `Number.isFinite(-5)` is
 * true, so a corrupt projection could otherwise subtract from the KLOC sum and
 * drive lines-per-dollar below zero — a number no diff can produce. Anything
 * that is not a finite, non-negative number is unknown.
 */
function finiteCount(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/** The Delivery KPIs derived wholly from {@link MergedPrLocTotals}. */
export type MergedLocKpis = {
  kloc: KpiStat;
  mergedKloc: KpiStat;
  prsWithoutLoc: KpiStat;
  prsScanned: KpiStat;
  prSize: KpiStat;
};

/**
 * Builds every Delivery KPI that reads nothing but {@link MergedPrLocTotals}.
 *
 * Lives beside the derivation rather than in the grandfathered `service.ts` for
 * the reason stated in the module header: the KLOC sum, the median population,
 * and the coverage the two captions quote are one cohesive unit, and splitting
 * them across two files is what let the caption drift from the number before.
 * `service.ts` splices the returned KPIs into its list, so their order on the
 * wire is unchanged.
 */
export function mergedLocKpis({
  totalLines,
  knownLocValues,
  prCount,
  unknownLocCount,
}: MergedPrLocTotals): MergedLocKpis {
  // A window where NO merged PR carries projected LOC has an UNKNOWN KLOC, not
  // a KLOC of zero: `round(0/1000)` would render "0.0 thousand lines landed"
  // over PRs that certainly landed lines — the unavailable-as-real-zero
  // conflation the shared insights rules forbid. `null` renders `—`. When only
  // SOME are unknown the sum is a genuine lower bound, so it still reports and
  // `unknownLocCount` carries how much of the population it could not see.
  const klocValue =
    knownLocValues.length > 0 ? round(totalLines / 1000, 1) : null;
  // ISS-5414: the coverage pair below is `internal` and backs no tile, so this
  // clause is where it reaches a reader. Both the KLOC sum and the median are
  // taken over the sized REST of `prCount`; without it the tiles present that
  // lower bound as if it were the whole figure.
  const coverageSub = (sub: string) =>
    withSizeCoverage(
      sub,
      prCount,
      unknownLocCount,
      SizeCoveragePopulation.Merged
    );
  return {
    kloc: kpi(
      "kloc",
      "KLOC merged",
      klocValue,
      KpiFormat.Number,
      coverageSub("thousand lines landed")
    ),
    // FEA-2947: surface-agnostic MERGED-lines KLOC the shared AI-Impact card reads
    // as its "Tokens per KLOC" denominator. Here it equals the visible `kloc` tile
    // above (cloud's `kloc` is ALREADY merged-lines KLOC), but desktop's `kloc` KPI
    // carries CAPTURED-PR KLOC (its "KLOC captured" tile), so the card cannot rely on
    // `kloc` meaning "merged lines" on both surfaces — both now expose this dedicated
    // key with identical (merged-lines) semantics. Flagged `internal` (mirrors the
    // `mergedCount` reconciliation in FEA-2946): response-only, backs no tile, so it
    // renders nothing on its own — hence no coverage clause on its caption.
    mergedKloc: kpi(
      "mergedKloc",
      "KLOC merged",
      klocValue,
      KpiFormat.Number,
      "thousand lines landed",
      true
    ),
    // PLN-1535 M4 coverage pair. Without them the response cannot distinguish
    // "the org merged this many lines" from "…this many lines THAT WE CAN SEE",
    // since KLOC and Median PR size are taken over the sized REST of the
    // population. Both internal (response-only, back no tile) — ISS-5414 renders
    // them through the two captions above and below instead.
    //
    // They ship together on purpose: the population is `mergedPrsScanned` — the
    // deduped, cap-bounded row scan — NOT the `merged` count, which corrects an
    // exact uncapped `countMergedPrsInRange`. "7 without size" beside
    // "Merged PRs 120" invites the wrong denominator. Both now count pull
    // requests rather than rows (ISS-5411), so the scan cap is the only thing
    // left that makes them diverge.
    //
    // Both use plain `kpi()` (ISS-4995): neither computes a prior-window
    // figure, so the emitted `deltaPct` stays null and now declares
    // `KpiDeltaBasis.NotComputed` as its reason rather than leaving a reader to
    // infer "no prior window". Reaching for `comparableKpi` here would claim a
    // comparison this producer never works out.
    prsWithoutLoc: kpi(
      "mergedPrsWithoutLoc",
      "Merged PRs without size",
      unknownLocCount,
      KpiFormat.Number,
      "merged PRs the projection cannot size",
      true
    ),
    prsScanned: kpi(
      "mergedPrsScanned",
      "Merged PRs scanned",
      prCount,
      KpiFormat.Number,
      "deduped merged PRs the size coverage is taken of",
      true
    ),
    prSize: kpi(
      "pr-size",
      "Median PR size",
      // FEA-2923: no merged PR with a KNOWN size in the window ⇒ nothing to
      // median ⇒ emit `null` so the KPI renders `—` (formatKpiValue), not a
      // misleading 0. `null` is JSON-serializable (unlike a non-finite number)
      // and matches the `KpiStat.value: number | null` contract. Mirrors
      // desktop `computeDelivery`.
      //
      // PLN-1535 M4: the population is now PRs whose own projection carries
      // both diff counts, rather than PRs whose BRANCH file cache was Fresh.
      // Same intent — median over known sizes only — against per-PR truth.
      knownLocValues.length > 0 ? (median(knownLocValues) ?? 0) : null,
      KpiFormat.Number,
      coverageSub("lines changed")
    ),
  };
}
