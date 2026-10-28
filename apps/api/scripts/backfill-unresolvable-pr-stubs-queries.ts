/**
 * ISS-8463 — the SQL half of the unresolvable-factless-PR-stub backfill: the
 * population predicate, the KPI rollup, the capture-and-clear, and the revert.
 *
 * Split out of `backfill-unresolvable-pr-stubs.ts` (#6241 review) so the CLI
 * entry point, the console reporting, and this data layer are three files rather
 * than one over the repo's 500-line smell line.
 */
import { GitHubFetchMechanism } from "@repo/api/src/types/github-read-model";
import { Prisma, withDb } from "@repo/database";
import { DESKTOP_PR_FETCHABLE_FACT_COLUMNS } from "@/lib/desktop-pull-request-facts";

export type UnresolvableStubRow = {
  id: string;
  organizationId: string;
  repositoryFullName: string | null;
  number: number;
  lastVerifiedAt: Date;
  lastRefreshAttemptAt: Date;
};

/** A row the apply actually cleared, carrying the grain the KPI is emitted at. */
export type ClearedStubRow = {
  id: string;
  organizationId: string;
  repositoryFullName: string | null;
};

export type UnresolvableStubGroup = {
  organizationId: string;
  repositoryFullName: string | null;
  /** Every row in the group the predicate admits, ignoring `LIMIT`. */
  eligibleCount: bigint;
  /**
   * The rows in the group THIS run will clear — the eligible set intersected
   * with the same `ORDER BY … LIMIT` window {@link applyStampBackfill} uses.
   * Zero for a group the run's cap does not reach, which is the case the
   * eligible count on its own reported as a KPI step that never happened.
   */
  selectedCount: bigint;
  /**
   * Every factless `desktop_sync` row in the group, cleared or not — the `S` in
   * the reconciler's own capacity model, which is what decides whether the
   * attempt-age cutoff bought the retries it claims.
   */
  desktopStubBacklog: bigint;
};

/**
 * The population as one run sees it: what is eligible, and what this run's
 * `LIMIT` actually reaches.
 *
 * The two totals are carried SEPARATELY and never folded into one number.
 * `apps/api/AGENTS.md` requires a capped batch to "return an explicit
 * partial/truncated outcome"; reporting `eligibleTotal` as the delivery-coverage
 * step while the apply clears `selectedTotal` rows is exactly the conflation that
 * rule forbids, and it overstates the KPI step by the difference.
 */
export type UnresolvableStubPopulation = {
  groups: UnresolvableStubGroup[];
  eligibleTotal: number;
  /** What this run clears. Equals `eligibleTotal` when no `LIMIT` binds. */
  selectedTotal: number;
  /** `selectedTotal < eligibleTotal` — the run leaves eligible rows behind. */
  truncated: boolean;
};

/**
 * The unresolvable population, as one predicate over `pull_request_detail`.
 *
 * Four conjuncts, each excluding a different kind of row that must survive.
 * There are deliberately no `IS NOT NULL` guards: the strict inequality below
 * is what enforces both, since a comparison against NULL is NULL and never
 * admits a row. A separate guard would read as doing work it cannot do.
 *
 * 1. `fetch_mechanism = desktop_sync` — still desktop-owned. A successful
 *    reconcile overwrites the mechanism with `graphql` AND fills `title` in one
 *    statement, so a repaired row leaves by either test, and this is what holds
 *    an ISS-8462 frozen row out. READ IT NARROWLY: the converse is FALSE. A
 *    non-`desktop_sync` mechanism does NOT mean the row was successfully
 *    reconciled. ISS-8535 removed the two producers that relabelled a row
 *    without reading GitHub at all (the pre-fetch stamp, and the
 *    no-client-minted stamp). That change did not touch this predicate, but it
 *    does MOVE ROWS INTO IT: a refresh that never reached GitHub now leaves the
 *    row at `desktop_sync`, so it stays admitted here instead of being relabelled
 *    out. AC-1 still holds for those rows, and conjunct 4 is what holds it — a
 *    row a repair schedule is still working is re-attempted daily by the
 *    reconciler's ordinary arm, so an attempt stamp that has stood unanswered
 *    for `UNRESOLVABLE_STUB_MIN_ATTEMPT_AGE_MS` (7 days) is evidence that
 *    schedule has run and failed. Conjunct 1 was never the AC-1 proof.
 *    A REST read that WAS issued and failed is the remaining exclusion: it ends
 *    at `rest` and this predicate does not see it, so THE REPORTED POPULATION IS
 *    STILL A LOWER BOUND ON STRANDING, NOT A CENSUS. Deliberately not widened to
 *    reach it — widening a shipped selection is the riskier half, and the row is
 *    reachable by the mechanism-blind schedule above.
 * 2. every fetchable fact column NULL — rendered from
 *    `DESKTOP_PR_FETCHABLE_FACT_COLUMNS`, the same map the reconciler's own stub
 *    arm renders its predicate from. Sharing it is what stops this query and the
 *    arm it must agree with drifting apart silently (ISS-8423).
 * 3. `last_refresh_attempt_at > last_verified_at` — A RECONCILER ATTEMPT
 *    HAPPENED AND THE ROW CARRIES A STAMP, and this conjunct alone establishes
 *    both. Before ISS-8423 the desktop producer wrote `lastVerifiedAt:
 *    observedAt, lastRefreshAttemptAt: observedAt` in one write, so on an
 *    unattempted legacy row the two clocks are EQUAL and the strict inequality
 *    rejects it — a row still eligible to self-repair on its next tick reads
 *    otherwise identically to one the provider has given up on. It also rejects
 *    the two NULL shapes: a post-ISS-8423 factless row (both clocks null, no
 *    stamp to clear) and one the reconciler has since attempted (attempt set,
 *    stamp still null — unresolvable, but there is nothing to clear and no prior
 *    value to capture).
 * 4. `last_refresh_attempt_at < cutoff` — that attempt has stood unanswered for
 *    `UNRESOLVABLE_STUB_MIN_ATTEMPT_AGE_MS`.
 *
 * FAILS CLOSED ON CLOCK SKEW. Conjunct 3 compares a server clock against a
 * desktop-reported `observedAt`. A desktop running ahead stamps a
 * `last_verified_at` in the future, no later server attempt can exceed it, and
 * the row is left alone — the safe direction, since leaving a stamp is
 * recoverable and clearing one is what this script captures a pre-image for.
 */
export function unresolvableStubPredicateSql(cutoff: Date): Prisma.Sql {
  return Prisma.sql`
    ${desktopFactlessStubSql()}
    AND prd.last_refresh_attempt_at > prd.last_verified_at
    AND prd.last_refresh_attempt_at < ${cutoff}
  `;
}

/** Every row the backfill would clear at `cutoff`, oldest attempt first. */
export function selectUnresolvableStubs(
  cutoff: Date
): Promise<UnresolvableStubRow[]> {
  return withDb((db) =>
    db.$queryRaw<UnresolvableStubRow[]>(Prisma.sql`
      SELECT
        prd.id,
        prd.organization_id AS "organizationId",
        prd.repository_full_name AS "repositoryFullName",
        prd.number,
        prd.last_verified_at AS "lastVerifiedAt",
        prd.last_refresh_attempt_at AS "lastRefreshAttemptAt"
      FROM pull_request_detail prd
      WHERE ${unresolvableStubPredicateSql(cutoff)}
      ORDER BY ${STUB_SELECTION_ORDER_SQL}
    `)
  );
}

/**
 * The population grouped the way the KPI is emitted, with the run's `LIMIT`
 * applied to the step it reports.
 *
 * `trustedVerifiedPrCount` rides a per-(org, repo) reconcile tick, so this is
 * the grain at which the step can be stated. It reports the NUMERATOR delta
 * only. The denominator is the reconciler's own session-linked scan; re-deriving
 * it here would be a second implementation of the coverage query, and a coverage
 * ratio computed by a different query than the one being watched is worth less
 * than no number at all.
 *
 * THE `selected` CTE REPEATS {@link applyStampBackfill}'s WINDOW EXACTLY — same
 * predicate, same `STUB_SELECTION_ORDER_SQL`, same `LIMIT` — so the per-group
 * step this reports is the set that apply will clear rather than the set that
 * was merely eligible. Groups the cap does not reach are still returned, at
 * `selectedCount = 0`, because "eligible and untouched" is the outcome an
 * operator has to see to know the run was partial.
 */
export function summarizeUnresolvableStubs(
  cutoff: Date,
  limit: number | null
): Promise<UnresolvableStubPopulation> {
  return withDb(async (db) => {
    const groups = await db.$queryRaw<UnresolvableStubGroup[]>(Prisma.sql`
      WITH eligible AS (
        SELECT
          prd.id,
          prd.organization_id,
          prd.repository_full_name,
          prd.last_refresh_attempt_at
        FROM pull_request_detail prd
        WHERE ${unresolvableStubPredicateSql(cutoff)}
      ),
      selected AS (
        -- Aliased to prd so this window is spelled by the SAME constant the
        -- apply's is, rather than by a second copy that could drift from it.
        SELECT prd.id
        FROM eligible prd
        ORDER BY ${STUB_SELECTION_ORDER_SQL}
        ${limitSql(limit)}
      ),
      backlog AS (
        SELECT
          prd.organization_id,
          prd.repository_full_name,
          count(*) AS backlog
        FROM pull_request_detail prd
        WHERE ${desktopFactlessStubSql()}
        GROUP BY prd.organization_id, prd.repository_full_name
      )
      SELECT
        eligible.organization_id AS "organizationId",
        eligible.repository_full_name AS "repositoryFullName",
        count(*) AS "eligibleCount",
        count(selected.id) AS "selectedCount",
        coalesce(max(backlog.backlog), 0) AS "desktopStubBacklog"
      FROM eligible
      LEFT JOIN selected ON selected.id = eligible.id
      LEFT JOIN backlog
        ON backlog.organization_id = eligible.organization_id
        AND backlog.repository_full_name IS NOT DISTINCT FROM eligible.repository_full_name
      GROUP BY eligible.organization_id, eligible.repository_full_name
      ORDER BY count(selected.id) DESC, count(*) DESC
    `);
    return foldPopulation(groups);
  });
}

/**
 * Capture the pre-image and clear the stamp, as ONE statement.
 *
 * The capture and the clear cannot diverge because there is no window between
 * them: a crash after capturing and before clearing would otherwise leave a
 * pre-image claiming a stamp the row still holds, and reverting it would be a
 * no-op that read as a success.
 *
 * A row the reconciler verified between the operator's dry run and this call is
 * dropped by the statement's own READ COMMITTED snapshot — it simply no longer
 * satisfies the predicate. `FOR UPDATE` is for the narrower case that snapshot
 * cannot cover: a reconciler write still IN FLIGHT when this statement reaches
 * the row, where the lock forces the re-check that keeps the two writers from
 * interleaving. Neither mechanism is the other's, and the lock is not what makes
 * the already-committed case safe.
 *
 * RETURNS the (org, repo) of every cleared row, not just its id: that is the
 * grain the KPI is announced at, and the realized grouping is the only honest
 * source for it once a `LIMIT` or a concurrent reconcile has moved the outcome
 * away from the summary.
 *
 * COST: no index covers this predicate, so it is a full scan of
 * `pull_request_detail` plus a sort. Deliberately not indexed — the access path
 * exists for one operator run, and building an index on that table costs more
 * than the scan it would save. `LIMIT` bounds the write and lock footprint, not
 * the scan. Run the dry run first and read its duration as the apply's.
 */
export function applyStampBackfill(input: {
  runId: string;
  cutoff: Date;
  limit: number | null;
}): Promise<ClearedStubRow[]> {
  return withDb((db) =>
    db.$queryRaw<ClearedStubRow[]>(Prisma.sql`
      WITH selected AS (
        SELECT prd.id, prd.organization_id, prd.last_verified_at, prd.pr_state
        FROM pull_request_detail prd
        WHERE ${unresolvableStubPredicateSql(input.cutoff)}
        ORDER BY ${STUB_SELECTION_ORDER_SQL}
        ${limitSql(input.limit)}
        FOR UPDATE
      ),
      captured AS (
        INSERT INTO pull_request_verification_stamp_backfill (
          run_id,
          pull_request_detail_id,
          organization_id,
          prior_last_verified_at,
          prior_pr_state
        )
        SELECT
          ${input.runId}::uuid,
          selected.id,
          selected.organization_id,
          selected.last_verified_at,
          selected.pr_state
        FROM selected
        RETURNING pull_request_detail_id
      )
      UPDATE pull_request_detail
      SET last_verified_at = NULL
      WHERE id IN (SELECT pull_request_detail_id FROM captured)
      RETURNING
        id,
        organization_id AS "organizationId",
        repository_full_name AS "repositoryFullName"
    `)
  );
}

/**
 * Write one run's pre-image back.
 *
 * `last_verified_at IS NULL` on the target is a guard, not a filter: if the
 * reconciler has legitimately verified the row since it was cleared, its own
 * measurement outranks the stamp this script removed, and restoring would put
 * back a value that is now doubly wrong.
 *
 * Both counts come from THIS call's own CTEs, so `closedCount` is captures this
 * revert closed and not captures that exist. Counting the latter would report an
 * already-reverted run identically to one whose rows were re-verified — the
 * caller says opposite things about those two, and only a zero can tell them
 * apart.
 */
export function revertStampBackfill(runId: string): Promise<RevertResult> {
  return withDb(async (db) => {
    const [counts] = await db.$queryRaw<
      { closedCount: bigint; restoredCount: bigint }[]
    >(Prisma.sql`
      WITH closed AS (
        UPDATE pull_request_verification_stamp_backfill
        SET reverted_at = now()
        WHERE run_id = ${runId}::uuid AND reverted_at IS NULL
        RETURNING pull_request_detail_id, prior_last_verified_at
      ),
      restored AS (
        UPDATE pull_request_detail prd
        SET last_verified_at = closed.prior_last_verified_at
        FROM closed
        WHERE prd.id = closed.pull_request_detail_id
          AND prd.last_verified_at IS NULL
        RETURNING prd.id
      )
      SELECT
        (SELECT count(*) FROM closed) AS "closedCount",
        (SELECT count(*) FROM restored) AS "restoredCount"
    `);
    return {
      closedCount: Number(counts?.closedCount ?? 0),
      restoredCount: Number(counts?.restoredCount ?? 0),
    };
  });
}

export type RevertResult = { closedCount: number; restoredCount: number };

/**
 * The order that makes "the first N eligible rows" a well-defined set.
 *
 * Held as ONE constant because the summary's `selected` CTE and the apply's must
 * name the same window: if they order differently, the per-group step the
 * operator announced describes rows the apply did not touch, which is the defect
 * the run-scoped reporting exists to close. `id` breaks the tie so a page is
 * stable across the two statements even when attempt clocks collide. The
 * summary's CTE aliases its source to `prd` so this one constant serves both.
 */
const STUB_SELECTION_ORDER_SQL = Prisma.sql`prd.last_refresh_attempt_at ASC, prd.id ASC`;

/**
 * Conjuncts 1 and 2 alone — the reconciler's stub cohort, whatever its clocks
 * say. Named separately because the dry run counts it as the backlog denominator
 * the cutoff has to be judged against.
 */
function desktopFactlessStubSql(): Prisma.Sql {
  return Prisma.sql`prd.fetch_mechanism = ${GitHubFetchMechanism.DesktopSync}
    AND ${factlessColumnsSql()}`;
}

/** Every fetchable fact column still empty, rendered from the shared map. */
function factlessColumnsSql(): Prisma.Sql {
  // `Prisma.raw` over module constants, never caller input — these are column
  // identifiers, which cannot be bound as parameters.
  return Prisma.sql`(${Prisma.join(
    DESKTOP_PR_FETCHABLE_FACT_COLUMNS.map(
      (column) => Prisma.sql`prd.${Prisma.raw(column)} IS NULL`
    ),
    " AND "
  )})`;
}

/**
 * `LIMIT n`, or nothing at all.
 *
 * `resolveRunConfig` already rejects a non-positive or partially-parsed value
 * rather than falling back, so a limit that reaches here is an integer >= 1.
 * The clamp is repeated anyway because this function is exported surface for the
 * two statements that must agree, and a `LIMIT 0` slipping through would report
 * a zero step while the apply cleared nothing — a self-consistent lie.
 */
function limitSql(limit: number | null): Prisma.Sql {
  if (limit === null) {
    return Prisma.empty;
  }
  return Prisma.sql`LIMIT ${Math.max(1, Math.trunc(limit))}`;
}

/**
 * Group rows into the population summary, summing the two totals in one pass.
 *
 * `truncated` is derived from the totals rather than from whether a `LIMIT` was
 * set: a `LIMIT` larger than the population truncates nothing, and announcing a
 * partial outcome for a run that covered everything is its own wrong number.
 */
function foldPopulation(
  groups: UnresolvableStubGroup[]
): UnresolvableStubPopulation {
  let eligibleTotal = 0;
  let selectedTotal = 0;
  for (const group of groups) {
    eligibleTotal += Number(group.eligibleCount);
    selectedTotal += Number(group.selectedCount);
  }
  return {
    groups,
    eligibleTotal,
    selectedTotal,
    truncated: selectedTotal < eligibleTotal,
  };
}
