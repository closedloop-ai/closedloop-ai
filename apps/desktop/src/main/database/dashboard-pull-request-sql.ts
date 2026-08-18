/**
 * ISS-6451: the SQLite read behind `getPullRequests`, extracted from
 * `dashboard-queries.ts` (a grandfathered over-ceiling file) so the windowed
 * query can carry its ordering/paging contract without growing it. The consumer
 * keeps only the JS map from a row to a `DashboardPullRequestSummary`.
 */

/**
 * FEA-1899 / ISS-6451: one row per PR artifact — the strongest-link winner plus
 * the branch resolution, exactly the columns the summary fold reads.
 */
export type SqlitePullRequestRow = {
  artifact_id: string;
  session_id: string | null;
  session_name: string | null;
  pr_url: string | null;
  pr_number: bigint | null;
  repo_full_name: string | null;
  branch_name: string | null;
  head_sha: string | null;
  title: string | null;
  harness: string | null;
  observed_at: string | null;
};

/**
 * FEA-1899: PRs live as `kind='pull_request'` rows in the canonical artifacts
 * table, joined to the sessions that captured them via the pure
 * `session_artifact_links` join. One row per PR artifact: when a PR links to
 * multiple sessions the `ROW_NUMBER()` window keeps the strongest link (created
 * > primary > oldest) so the dashboard never double-counts a PR.
 *
 * ISS-6451: the read is WINDOWED, and the order is the QUERY's, not the JS
 * fold's. The sort key is `unixepoch(observed_at, 'subsec')` — an INSTANT, not
 * the raw bytes — because that is what the `compareIsoDesc` fold it replaces
 * compared, and the two disagree on the values this column can still hold. Every
 * writer of `artifacts.observed_at` canonicalizes to ISO-8601 UTC (ISS-5427,
 * contract in FEA-3743), so a bare lexical `DESC` is right for every row written
 * since — but rows written BEFORE it are not backfilled, and a session whose
 * source transcript is gone is skipped by the DATA_REVISION re-derive, so an
 * offset-form value survives indefinitely: `2026-06-20T10:00:00+02:00` is really
 * 08:00Z and sorts AHEAD of a canonical 09:00:00Z by bytes and BEHIND it by
 * instant. `unixepoch` reads the offset (verified against the live store) and
 * yields NULL for a value it cannot parse, which `NULLS LAST` then puts at the
 * tail — where `Date.parse`'s NaN put it, and where a bare `DESC` would instead
 * have put it at the very HEAD of page 1. The one place the two deliberately
 * DISAGREE is a zone-less timestamp (`2026-06-20 09:00:00`): `Date.parse` reads
 * it as the operator's local time and `unixepoch` as UTC. UTC is the settled
 * convention for this column (ISS-5496), so that shift is the point, not a
 * regression.
 *
 * `artifact_id` is the tiebreaker, and the `pr` join is DEDUPED to one row per
 * (session, repo, number) so it cannot reintroduce a tie: `pull_requests` is
 * keyed on a hash of the raw `pr_url`, with no uniqueness on that triple, so
 * `.../pull/7` and `.../pull/7/files` in one session are two rows that agree on
 * every `ORDER BY` term. `LIMIT`/`OFFSET` over the resulting non-total order
 * would let the duplicate eat a page slot and drop the artifact it displaced
 * from every page — and a duplicate row also breaks the one-row-per-artifact
 * contract the golden `agg.core.pull_requests_one_per_artifact` gate asserts,
 * which is why the dedupe is here rather than left to the JS fold.
 *
 * `deliveryPopulationClause` — rendered by `excludeNonDeliveryOnlyArtifacts`
 * from ids the caller just read out of this same store — is the only
 * interpolation; the window rides in as positional parameters, `$1` limit and
 * `$2` offset, in that textual order.
 */
export function buildDashboardPullRequestSql(
  deliveryPopulationClause: string
): string {
  return `
    SELECT
      ranked.artifact_id    AS artifact_id,
      ranked.session_id     AS session_id,
      ranked.session_name   AS session_name,
      ranked.pr_url         AS pr_url,
      ranked.pr_number      AS pr_number,
      ranked.repo_full_name AS repo_full_name,
      -- Branch is sourced from the AUTHORITATIVE pull_requests row of the
      -- winning link's session: the head ref for a PR that session created,
      -- or null for a merely-referenced PR. That column is import-authoritative
      -- and is deleted+re-derived per session on a DATA_REVISION rebuild, so it
      -- self-corrects on upgrade. The COALESCE-accumulated artifacts.branch_name
      -- can retain a stale pre-fix value a re-derive won't clear, so it is used
      -- ONLY as a fallback when no import row exists (e.g. a PR discovered purely
      -- by branch enrichment, which writes the real head to the artifact alone).
      CASE
        WHEN pr.session_id IS NOT NULL THEN pr.branch_name
        ELSE ranked.artifact_branch_name
      END                   AS branch_name,
      ranked.head_sha       AS head_sha,
      ranked.title          AS title,
      ranked.harness        AS harness,
      ranked.observed_at    AS observed_at
    FROM (
      SELECT
        a.id              AS artifact_id,
        sal.session_id    AS session_id,
        s.name            AS session_name,
        a.url             AS pr_url,
        a.pr_number       AS pr_number,
        a.repo_full_name  AS repo_full_name,
        a.branch_name     AS artifact_branch_name,
        a.head_sha        AS head_sha,
        a.title           AS title,
        a.harness         AS harness,
        a.observed_at     AS observed_at,
        ROW_NUMBER() OVER (
          PARTITION BY a.id
          ORDER BY
            CASE WHEN sal.relation = 'created' THEN 0 ELSE 1 END,
            CASE WHEN sal.is_primary THEN 0 ELSE 1 END,
            sal.created_at ASC
        ) AS rn
      FROM artifacts a
      JOIN session_artifact_links sal ON sal.artifact_id = a.id
      JOIN sessions s ON s.id = sal.session_id
      WHERE a.kind = 'pull_request'
        AND a.pr_number IS NOT NULL
        -- ISS-6451: the empty-string case is excluded HERE, not only in the JS
        -- fold, so the page the window returns is the page the caller keeps —
        -- a row the fold drops would otherwise consume one of its LIMIT slots.
        AND a.repo_full_name IS NOT NULL
        AND a.repo_full_name <> ''
        -- ISS-5764: a PR the corpus only ever NAMED in prose is not one of
        -- its pull requests. Same population gate the delivery KPIs use.
        AND ${deliveryPopulationClause}
    ) ranked
    LEFT JOIN (
      -- One import row per (session, repo, number) — the newest observed, id as
      -- the tiebreak. Without this the join is 1:N (see the docstring) and the
      -- fan-out both duplicates the artifact and breaks the page window.
      --
      -- This ranks all of pull_requests rather than seeking idx_pr_session per
      -- outer row, which is the deliberate side of the trade: it is ONE pass over
      -- a table with at most one row per (session, PR url), against O(rows
      -- surviving the gate) correlated seeks — and the outer ROW_NUMBER() over
      -- artifacts JOIN links already materializes and sorts the strictly larger
      -- set, so this does not change the query's shape. Revisit with a measured
      -- plan, not by assumption, if pull_requests ever outgrows that.
      SELECT
        session_id,
        repo_full_name,
        pr_number,
        branch_name,
        ROW_NUMBER() OVER (
          PARTITION BY session_id, repo_full_name, pr_number
          ORDER BY unixepoch(observed_at, 'subsec') DESC NULLS LAST, id ASC
        ) AS prn
      FROM pull_requests
    ) pr
      ON pr.session_id = ranked.session_id
      AND pr.repo_full_name = ranked.repo_full_name
      AND pr.pr_number = ranked.pr_number
      AND pr.prn = 1
    WHERE ranked.rn = 1
    ORDER BY unixepoch(ranked.observed_at, 'subsec') DESC NULLS LAST,
             ranked.artifact_id ASC
    LIMIT $1 OFFSET $2
  `;
}
