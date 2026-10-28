/**
 * @file pr-opened-at-rank-sql.ts
 * @description ISS-11106 — the correlated `pull_requests.opened_at` aggregate the
 * artifact-link projection reads, ranked by INSTANT rather than by BYTES.
 *
 * `pull_requests` holds one row per (harness, session, pr_url), so one PR can
 * carry several rows and the read has to pick the earliest of them. The column is
 * TEXT, and it has NO LIVE WRITER LEFT IN THIS REPO: the GitHub enrichment lane
 * that wrote it (`syncPullRequestLifecycle`, whose `UPDATE pull_requests SET …
 * opened_at = COALESCE(opened_at, $5)` took `prMeta.openedAt` straight from
 * GitHub metadata) was deleted by PLN-1535, and the only remaining write is
 * `pr-store.ts`'s INSERT of `seed?.openedAt`, which is a value read back out of
 * this same column by `rebuild-session-tx.ts` and carried across a DATA_REVISION
 * rebuild. So what an installed database holds is whatever some earlier release
 * stored, and nothing in the current tree constrains its WIDTH — which is why
 * this site could not honestly take a `lexical-timestamp-ok` marker.
 *
 * Byte order is time order only at a FIXED width. A whole-second `Z` form sorts
 * ABOVE a fractional one (`Z` is 0x5A, `.` is 0x2E) while being the EARLIER
 * instant, and a legacy offset form (`…T07:00:00-05:00`, really 12:00Z) loses
 * outright — so the plain aggregate this replaces could name the WRONG ROW and
 * hand the marker builder the LATER of two opened times.
 *
 * {@link canonicalRankingKeySql} folded through
 * {@link allOrNothingCanonicalSortSql} over an EMPTY window is the fix. The
 * window must match the set the reader COMPARES across, and here that is every
 * row for this one PR identity — which is exactly the subquery's own rows, so the
 * spec is empty. The fold then guarantees one mode: canonical text for every row,
 * or the raw column verbatim for every row, never a mix. Canonical mode returns
 * the 24-character form (better for the consumer, which parses it); the raw arm
 * returns the same bytes the old aggregate did, so a set holding one genuinely
 * un-canonicalizable value cannot regress.
 *
 * `NULLIF(TRIM(…), '')` is what makes that raw arm safe rather than merely
 * unchanged, and it is the one place this expression goes beyond the old one. A
 * BLANK stored value is not an un-canonicalizable timestamp, it is an ABSENT one,
 * and the two behave differently in the fold: a NULL dissenter is counted on
 * neither side and cannot move the group, while `''` is counted as present but
 * never canonicalizes, so it drops the WHOLE group to the raw arm and then WINS
 * the byte-wise `MIN` — the empty string sorts below everything under BINARY
 * collation. A PR with one good canonical row and one blank row therefore came
 * back blank, which every consumer reads as "no PR-opened instant" (`validTimestamp`
 * in branch-lifecycle-events.ts returns undefined on a falsy value), so a real
 * measured instant was discarded and the marker silently fell back to the
 * session's activity end. Normalizing blank to NULL before the fold makes the
 * good sibling win. Whitespace is trimmed for the same reason: a padded value is
 * not canonical either, and trimming lets canonicalization succeed on it instead
 * of dragging its whole group into raw mode.
 *
 * Its own module rather than a literal inside `sync-source.ts`: that file is
 * grandfathered on the `noExcessiveLinesPerFile` list and must not grow, and the
 * prose above belongs to this expression rather than to the 40-column projection
 * that reads it. It also cannot live in the SQL comment it replaces — the source
 * gate's scan does not strip `--` comments, so spelling the defective aggregate
 * in prose there re-fires the rule on the very text explaining the fix.
 *
 * Correlates on the OUTER `artifacts` alias `a`, so this is not a standalone
 * statement: it is only valid spliced into a query that joins `artifacts AS a`.
 */
import {
  allOrNothingCanonicalSortSql,
  canonicalRankingKeySql,
} from "./session-timestamp-form.js";

export const CANONICAL_PR_OPENED_AT_SQL = `(
          SELECT MIN(ranked_opened_at)
          FROM (
            SELECT ${allOrNothingCanonicalSortSql("canonical_opened_at", "raw_opened_at", "")} AS ranked_opened_at
            FROM (
              SELECT
                raw_opened_at,
                ${canonicalRankingKeySql("raw_opened_at")} AS canonical_opened_at
              FROM (
                SELECT NULLIF(TRIM(pr.opened_at), '') AS raw_opened_at
                FROM pull_requests pr
                WHERE pr.repo_full_name = a.repo_full_name
                  AND pr.pr_number = a.pr_number
              )
            )
          )
        )`;
