/**
 * @file pr-link-maintenance.ts
 * @description Post-backfill PR-branch maintenance that issues `prisma.write`
 * callbacks, so it MUST execute inside the FEA-2038 db host (the process that
 * owns the SQLite handle). A `prisma.write(fn)` cannot cross the db-host method
 * proxy (a function can't be structured-cloned over IPC, a DataCloneError), so
 * these run in-child, exposed to the main process as the clone-safe
 * `agentDatabase.propagateAllBranchPrLinks()` /
 * `agentDatabase.correlateCommitShaPrLinks()` methods (see sqlite.ts).
 */

import { artifactLinkId } from "../collectors/parsing/artifact-ref-extractor.js";
import {
  BRANCH_PR_ASSOCIATION_METHOD,
  branchAuthoringEvidenceSql,
  PR_WORKSPACE_RELATION,
} from "./branch-pr-attribution.js";
import type { DesktopPrisma } from "./prisma-client.js";

/**
 * `session_artifact_links.method` stamped on a `created` session→PR link minted
 * by `correlateCommitShaPrLinks`. Exported so the sync-source projection can
 * recognise a correlation-minted link — its `observed_at` is the maintenance
 * pass's wall-clock time (Desktop boot), NOT a real PR-raised instant, so the
 * PrRaised lifecycle event must fall back to the canonical GitHub open time
 * (`pull_requests.opened_at`) rather than stamping boot time on the timeline.
 */
export const COMMIT_SHA_CORRELATION_METHOD = "commit_sha_correlation";

/**
 * Minimum hex length for a commit SHA to be eligible for prefix correlation.
 * Git abbreviates to 7 by default; anything shorter is not a real short SHA and
 * an accidental prefix collision would be too likely, so we refuse to match it.
 */
export const MIN_ABBREV_SHA_LEN = 7;

/**
 * ISS-5735: the SHA prefix length the partial expression indexes
 * `idx_artifacts_head_sha_p7` / `idx_artifacts_merge_commit_sha_p7` are built
 * over (migration `0058_iss5735_idx_artifacts_sha_prefix`). Frozen at the value
 * the migration DDL carries — a migration is immutable once merged, so this
 * constant follows the index rather than the other way round.
 *
 * It is only ever a SEEKABLE NECESSARY CONDITION, never the match rule: two
 * SHAs where one is a prefix of the other and both are at least
 * `MIN_ABBREV_SHA_LEN` hex necessarily agree on their first
 * `MIN_ABBREV_SHA_LEN` characters, so an equality on the first
 * `SHA_PREFIX_INDEX_LEN` of them admits every real match while the full
 * `shaPrefixMatchExpr` residual still decides. That holds only while
 * `MIN_ABBREV_SHA_LEN >= SHA_PREFIX_INDEX_LEN`; below it the equality would
 * over-filter and silently drop every match shorter than the indexed prefix,
 * with no error and no behavioural test going red — lowering the abbreviation
 * floor needs a NEW migration re-cutting these indexes, not an edit here. Both
 * constants are exported so test/commit-sha-pr-correlation-scan.test.ts can
 * assert that relation directly and mint its fixture from the shortest SHA the
 * floor actually admits.
 */
export const SHA_PREFIX_INDEX_LEN = 7;

/**
 * SQLite boolean expression: true when a PR-side full OID column (`prShaCol`,
 * 40 hex from gh enrichment) and a commit-side SHA column (`commitShaCol`, which
 * `GIT_COMMIT_SUMMARY_RE` may have captured ABBREVIATED — 7–40 hex — verbatim
 * from `git commit` output) identify the SAME object. A raw `=` misses the usual
 * production case where the session commit is stored abbreviated but the PR head
 * is the full OID, so this matches on git's own abbreviation contract: the
 * shorter value must be a prefix of the longer one. Both sides must be non-null,
 * non-empty, and the SHORTER side must be at least `MIN_ABBREV_SHA_LEN` hex.
 *
 * This is a prefix match by necessity (a short SHA has no more bytes to compare),
 * but it is NOT a loose partial match: correctness is preserved by the callers'
 * same-repo scoping AND the exactly-one-PR ambiguity guard, so a hypothetical
 * short-prefix collision resolves to >1 PR and is rejected, never mis-attributed.
 * `substr(longer, 1, length(shorter)) = shorter` is the anchored prefix test.
 */
function shaPrefixMatchExpr(prShaCol: string, commitShaCol: string): string {
  return `(
    ${prShaCol} IS NOT NULL AND ${prShaCol} != ''
    AND ${commitShaCol} IS NOT NULL AND ${commitShaCol} != ''
    AND (
      CASE
        WHEN length(${commitShaCol}) <= length(${prShaCol})
          THEN length(${commitShaCol}) >= ${MIN_ABBREV_SHA_LEN}
               AND substr(${prShaCol}, 1, length(${commitShaCol})) = ${commitShaCol}
        ELSE length(${prShaCol}) >= ${MIN_ABBREV_SHA_LEN}
               AND substr(${commitShaCol}, 1, length(${prShaCol})) = ${prShaCol}
      END
    )
  )`;
}

/**
 * SQLite boolean expression: the two SHA columns agree on their first
 * `SHA_PREFIX_INDEX_LEN` characters. An index-seekable NECESSARY condition for
 * `shaPrefixMatchExpr` (see {@link SHA_PREFIX_INDEX_LEN}), never a sufficient
 * one — it always sits alongside the full residual test, never instead of it.
 * Spelled to match the indexed expression exactly so SQLite recognises it.
 */
function shaPrefixIndexEqExpr(prShaCol: string, commitShaCol: string): string {
  return `substr(${prShaCol}, 1, ${SHA_PREFIX_INDEX_LEN}) = substr(${commitShaCol}, 1, ${SHA_PREFIX_INDEX_LEN})`;
}

/**
 * SQLite boolean expression: the commit and PR artifacts are in the SAME
 * repository for attribution purposes. Both sides must AGREE — equal non-null
 * repo names, OR both null (a purely local commit matched against a purely
 * local, repo-less PR). A repo-less commit must NOT match a repo-bearing PR (or
 * vice versa): git history is shared across forks, so a bare SHA whose owning
 * repo we never captured could otherwise be mis-attributed to some unrelated
 * known repository's PR that happens to carry the same object. Requiring both
 * sides null (or equal) closes that cross-fork false-attribution path.
 */
function sameRepoScopeExpr(commitRepoCol: string, prRepoCol: string): string {
  return `(
    (${commitRepoCol} IS NULL AND ${prRepoCol} IS NULL)
    OR (
      ${commitRepoCol} IS NOT NULL AND ${prRepoCol} IS NOT NULL
      AND ${commitRepoCol} = ${prRepoCol}
    )
  )`;
}

/**
 * FEA-1899: bulk link propagation. Sessions on branches that have PR artifacts
 * get auto-linked to the PR. Runs once after backfill on every boot. Idempotent
 * (ON CONFLICT DO NOTHING). No transcript re-scan, no gh calls; pure DB join.
 */
export async function propagateAllBranchPrLinks(
  prisma: DesktopPrisma,
  log: (msg: string) => void
): Promise<number> {
  try {
    // Join through pull_requests (lifecycle detail store) for the correct
    // branch_name↔PR mapping. artifacts.branch_name is unreliable (set from
    // the importing session's branch, not the PR's head ref).
    // SQLite has no md5()/left()/now(): resolve the missing links first, then
    // insert each with a JS-computed deterministic id (matching
    // propagateBranchPrLinks / linkBranchSessionsToPr). The ON CONFLICT on the
    // natural triple still de-dupes regardless of the id encoding.
    const missing = await prisma.client.$queryRawUnsafe<
      {
        session_id: string;
        pr_artifact_id: string;
        identity_key: string;
      }[]
    >(
      `SELECT DISTINCT
           sal.session_id,
           pr_art.id AS pr_artifact_id,
           pr_art.identity_key
         FROM session_artifact_links sal
         -- FEA-4377 authoring-evidence gate (see branch-pr-attribution.ts SSOT):
         -- only a relation='created' branch-link (git_push/git_commit/
         -- gh_pr_create) may feed PR attribution; a relation='workspace' link is
         -- the stale CWD gitBranch the FEA-2531 invariant forbids attributing by.
         -- The predicate also admits the pre-v7 write-method workspace fallback
         -- (transcript-gone old rows never re-derived to 'created'). Stale links
         -- minted before this gate are swept by removeUnauthoredBranchPrLinks.
         JOIN artifacts branch ON sal.artifact_id = branch.id
           AND branch.kind = 'branch'
           AND branch.repo_full_name IS NOT NULL
           AND ${branchAuthoringEvidenceSql("sal")}
         JOIN pull_requests pr ON pr.repo_full_name = branch.repo_full_name
           AND pr.branch_name = branch.branch_name
           AND pr.pr_number IS NOT NULL
         JOIN artifacts pr_art ON pr_art.kind = 'pull_request'
           AND pr_art.repo_full_name = pr.repo_full_name
           AND pr_art.pr_number = pr.pr_number
           -- NULL pr_state treated as open. PLN-1535 M5 deleted the sweep that
           -- used to set pr_state, so this over-link no longer self-heals --
           -- the column has no writer left (see enrichment/types.ts).
           AND COALESCE(pr_art.pr_state, 'open') NOT IN ('merged', 'closed')
         WHERE NOT EXISTS (
           SELECT 1 FROM session_artifact_links ex
           WHERE ex.session_id = sal.session_id AND ex.artifact_id = pr_art.id
             AND ex.relation = '${PR_WORKSPACE_RELATION}'
         )`
    );
    if (missing.length === 0) {
      return 0;
    }
    const now = new Date().toISOString();
    // Each link is its own isolated write (matching the prior per-row autonomous
    // inserts): one bad row can't roll back the batch, and the shared write queue
    // isn't held for the whole loop. ON CONFLICT DO NOTHING keeps re-runs free.
    let linked = 0;
    for (const m of missing) {
      const linkId = artifactLinkId(
        m.session_id,
        "pull_request",
        m.identity_key,
        PR_WORKSPACE_RELATION
      );
      // Per-row isolation (matching the autonomous-insert intent above): one
      // failed insert must not abort the loop and discard the count of the rows
      // that did link — that would suppress the desktop:db:changed nudge and
      // strand already-committed links until the next sweep.
      try {
        linked += await prisma.write((client) =>
          client.$executeRawUnsafe(
            `INSERT INTO session_artifact_links
             (id, session_id, artifact_id, relation, method, evidence, is_primary,
              status, extractor_version, observed_at, created_at)
           VALUES ($1, $2, $3, '${PR_WORKSPACE_RELATION}', '${BRANCH_PR_ASSOCIATION_METHOD}', '{}', 0,
                   'candidate', 1, $4, $4)
           ON CONFLICT(session_id, artifact_id, relation) DO NOTHING`,
            linkId,
            m.session_id,
            m.pr_artifact_id,
            now
          )
        );
      } catch (rowError) {
        log(
          `branch→PR link insert failed for session ${m.session_id}: ${rowError instanceof Error ? rowError.message : String(rowError)}`
        );
      }
    }
    if (linked > 0) {
      log(`branch→PR link propagation: linked ${linked} session(s) to PRs`);
    }
    return linked;
  } catch (e) {
    log(
      `branch→PR link propagation failed: ${e instanceof Error ? e.message : String(e)}`
    );
    return 0;
  }
}

/**
 * FEA-4379: commit-SHA → PR content correlation. Mints a `created` session→PR
 * link when a commit SHA the session actually authored (a `created`-relation
 * commit artifact) identifies the same object as a PR's head or merge-commit SHA.
 * The session-side SHA may be git-ABBREVIATED (7–40 hex, captured verbatim from
 * `git commit` output by `GIT_COMMIT_SUMMARY_RE`) while the PR side is the full
 * 40-hex OID from gh enrichment, so identity is tested by `shaPrefixMatchExpr`
 * (git's own abbreviation contract: shorter-is-a-prefix-of-longer, ≥7 hex), not
 * a raw `=` that would miss the common abbreviated-commit case.
 *
 * Why this is not "loosening the authoring gate": a session with local commits
 * but no in-transcript `gh pr create` / `git push` (the PR was created
 * out-of-band by separate automation) has ZERO `created`-relation PR links, so
 * `resolveAuthoredPrLinkIdentity` correctly renders `prs:[]` / `branch:null`.
 * But a commit SHA is content — the same SHA appearing in BOTH the session's
 * `created` commits AND a PR's commit set is strong, non-fabricated proof that
 * THIS session authored that PR, independent of the transcript. This mints a
 * REAL `created` link on that evidence (Mike's content-based-identity principle,
 * cf. FEA-4335). The projection then surfaces the PR/branch unchanged.
 *
 * Correlation targets (no new GitHub fetch — both already stored on the PR
 * artifact by gh enrichment; `pull_requests.head_sha` is written from the same
 * enrichment, so the artifact columns are the authoritative, single source):
 *   - PR artifact `head_sha` — origin-authoritative branch tip.
 *   - PR artifact `merge_commit_sha` — the merge/squash commit.
 * The session side is `artifacts.sha` for `kind='commit'` rows linked with
 * `relation='created'` (the git-authorship gate — read/workspace commit refs,
 * of which there are none for commits, never qualify).
 *
 * Conservative guards against false positives:
 *   - The commit link must be `relation='created'` (authored, not referenced).
 *   - Same-repo scoping: the commit and PR repos must AGREE — equal non-null
 *     names, OR both null (a purely local commit matched against a repo-less,
 *     local-only PR). A repo-less commit does NOT match a repo-bearing PR (and
 *     vice versa): fork history is shared, so a bare SHA whose owning repo we
 *     never captured could otherwise be mis-attributed to an unrelated known
 *     repository's PR carrying the same object. `sameRepoScopeExpr` enforces this.
 *   - Exactly-one-PR: a SHA that maps to more than one distinct PR is ambiguous
 *     (e.g. a shared base commit surfaced as two PRs' head) and is skipped. The
 *     ambiguity count carries the SAME same-repo predicate as the main join, so
 *     a fork and its upstream sharing a head object (identical SHA in two repos)
 *     don't make an unambiguous same-repo match look ambiguous.
 *   - Suppress-only-on-`created`: the re-mint guard rejects a candidate only when
 *     a `created` link already exists (the natural key is
 *     (session, artifact, relation) — a `workspace`/reference link is a different
 *     row and must not block the authoring mint the projection needs).
 *
 * Idempotent (ON CONFLICT DO NOTHING on the natural triple) and additive: a
 * brand-new mint path that does not touch the FEA-4377 branch→PR join. Runs in
 * the DB host alongside the other maintenance passes.
 */
export async function correlateCommitShaPrLinks(
  prisma: DesktopPrisma,
  log: (msg: string) => void
): Promise<number> {
  try {
    // Resolve (session, PR) pairs whose evidence is a matching commit SHA: a
    // `created` commit artifact of the session identifies the PR's head or merge
    // commit (`shaPrefixMatchExpr` — abbreviated-vs-full aware). Group by
    // (session, PR) so a session with several matching commits
    // yields one link; require the matched SHA to map to exactly ONE PR so an
    // ambiguous shared SHA never attributes. The per-group MIN(sha) is the
    // representative evidence SHA (deterministic for the evidence blob).
    const matches = await prisma.client.$queryRawUnsafe<
      {
        session_id: string;
        pr_artifact_id: string;
        identity_key: string;
        matched_sha: string;
      }[]
    >(commitShaPrCorrelationSql());
    if (matches.length === 0) {
      return 0;
    }
    const now = new Date().toISOString();
    let minted = 0;
    for (const m of matches) {
      const linkId = artifactLinkId(
        m.session_id,
        "pull_request",
        m.identity_key,
        "created"
      );
      const evidence = JSON.stringify({
        via: COMMIT_SHA_CORRELATION_METHOD,
        sha: m.matched_sha,
      });
      // Per-row isolation (matching the sibling pass): one failed insert must
      // not abort the loop and discard the count of rows that did mint. The
      // insert AND the session-timestamp touch run in ONE write transaction so
      // the cloud sync cursor (which selects sessions by `updated_at`) re-picks
      // this session and ships the new link — otherwise, once the cursor has
      // passed this session, the minted link stays local-only until some
      // unrelated mutation bumps the row. The touch fires only when the insert
      // actually landed a row (ON CONFLICT DO NOTHING returns 0 on a re-run), so
      // an idempotent no-op re-run never churns `updated_at`.
      try {
        minted += await prisma.write((client) =>
          client.$transaction(async (tx) => {
            const inserted = await tx.$executeRawUnsafe(
              `INSERT INTO session_artifact_links
             (id, session_id, artifact_id, relation, method, evidence, is_primary,
              status, extractor_version, observed_at, created_at)
           VALUES ($1, $2, $3, 'created', $6, $4, 0,
                   'confirmed', 1, $5, $5)
           ON CONFLICT(session_id, artifact_id, relation) DO NOTHING`,
              linkId,
              m.session_id,
              m.pr_artifact_id,
              evidence,
              now,
              COMMIT_SHA_CORRELATION_METHOD
            );
            if (inserted > 0) {
              await tx.$executeRawUnsafe(
                "UPDATE sessions SET updated_at = $1 WHERE id = $2",
                now,
                m.session_id
              );
            }
            return inserted;
          })
        );
      } catch (rowError) {
        log(
          `commit-SHA→PR correlation insert failed for session ${m.session_id}: ${rowError instanceof Error ? rowError.message : String(rowError)}`
        );
      }
    }
    if (minted > 0) {
      log(
        `commit-SHA→PR correlation: minted ${minted} created session→PR link(s)`
      );
    }
    return minted;
  } catch (e) {
    log(
      `commit-SHA→PR correlation failed: ${e instanceof Error ? e.message : String(e)}`
    );
    return 0;
  }
}

/**
 * One arm of the candidate join: PR artifacts whose `prShaCol` identifies an
 * authored commit SHA. The `IS NOT NULL` + `kind` terms and the
 * `shaPrefixIndexEqExpr` equality are spelled as top-level `AND`s so SQLite can
 * prove the partial predicate of `idx_artifacts_<col>_p7` and seek its indexed
 * expression instead of walking `idx_artifacts_kind`; the full
 * `shaPrefixMatchExpr` then decides as a residual, so semantics are unchanged.
 *
 * `CROSS JOIN` pins the loop order, and is load-bearing rather than stylistic:
 * the desktop store is never `ANALYZE`d, so with a plain `JOIN` SQLite has no
 * stats to separate the two candidate orders and picks `pr_art` as the OUTER
 * loop — which puts the SHA prefix equality on the wrong side to be seeked and
 * silently restores the product-sized scan this whole change exists to remove.
 * The commit corpus must drive; the PR side must be the indexed probe.
 */
function shaPrCandidateArmSql(prShaCol: string): string {
  return `SELECT
             c.sha AS sha,
             c.repo_full_name AS repo_full_name,
             pr_art.id AS pr_artifact_id,
             pr_art.identity_key AS identity_key
           FROM authored_commit_shas c
           CROSS JOIN artifacts pr_art ON pr_art.kind = 'pull_request'
             AND pr_art.${prShaCol} IS NOT NULL
             AND ${shaPrefixIndexEqExpr(`pr_art.${prShaCol}`, "c.sha")}
             AND ${shaPrefixMatchExpr(`pr_art.${prShaCol}`, "c.sha")}
             -- Same-repo scoping: both sides must AGREE — equal non-null repos,
             -- or both null (a purely local commit matched against a repo-less
             -- PR). A repo-less commit must NOT match a repo-bearing PR: shared
             -- fork history could otherwise mis-attribute a bare SHA to an
             -- unrelated known repository's PR carrying the same object.
             AND ${sameRepoScopeExpr("c.repo_full_name", "pr_art.repo_full_name")}`;
}

/**
 * The candidate query behind {@link correlateCommitShaPrLinks}, factored out so
 * the ISS-5735 planner guard can EXPLAIN the statement production actually runs.
 *
 * Shape, and why it is this shape: the SHA identity test is a prefix expression
 * and so not sargable, which used to make the pass an O(commits × PRs) walk of
 * `idx_artifacts_kind` — twice over, because the exactly-one-PR ambiguity guard
 * was a CORRELATED subquery that re-scanned every PR for every candidate commit.
 * Three changes fix that without moving the semantics:
 *   - The PR match is keyed by `shaPrefixIndexEqExpr`, an equality the ISS-5735
 *     partial expression indexes can seek, with `shaPrefixMatchExpr` demoted to
 *     a residual filter over the (tiny) seeked set.
 *   - `head_sha` and `merge_commit_sha` are separate UNION arms rather than an
 *     `OR` over two columns, because one index serves one column and an `OR`
 *     across both would not reliably plan onto either.
 *   - The ambiguity guard becomes a `GROUP BY … HAVING COUNT(DISTINCT …) = 1`
 *     over that same candidate set, evaluated ONCE per distinct (SHA, repo)
 *     rather than once per authored commit link.
 *
 * The ambiguity count is deliberately taken BEFORE the re-mint suppression: an
 * ambiguous SHA must stay ambiguous even when one of its PRs already carries a
 * `created` link, exactly as the correlated subquery (which never saw the
 * suppression) behaved. `MIN(pr_artifact_id)`/`MIN(identity_key)` under that
 * `HAVING` are picking from a one-PR group, so they name that PR.
 */
function commitShaPrCorrelationSql(): string {
  return `WITH authored_commit_shas AS (
           -- The session-side corpus, collapsed to the distinct (SHA, repo) the
           -- PR join actually keys on: a SHA authored by twenty sessions costs
           -- one probe, not twenty. \`length >= ${MIN_ABBREV_SHA_LEN}\` is not a
           -- new gate — a shorter commit SHA can never satisfy
           -- \`shaPrefixMatchExpr\` from either side of its length CASE, so this
           -- only moves the rejection earlier.
           SELECT DISTINCT
             commit_art.sha AS sha,
             commit_art.repo_full_name AS repo_full_name
           FROM session_artifact_links sal
           JOIN artifacts commit_art ON sal.artifact_id = commit_art.id
             AND commit_art.kind = 'commit'
             AND commit_art.sha IS NOT NULL
             AND length(commit_art.sha) >= ${MIN_ABBREV_SHA_LEN}
           WHERE sal.relation = 'created'
         ),
         sha_pr_candidates AS (
           ${shaPrCandidateArmSql("head_sha")}
           UNION
           ${shaPrCandidateArmSql("merge_commit_sha")}
         ),
         unambiguous_sha_prs AS (
           -- The exactly-one-PR ambiguity guard. A SHA that maps to more than
           -- one distinct PR (e.g. a shared base commit surfaced as two PRs'
           -- head) is skipped. Grouping by \`repo_full_name\` keeps the count
           -- repo-scoped, so a fork and its upstream sharing a head object do
           -- not make an unambiguous same-repo match look ambiguous.
           SELECT
             sha,
             repo_full_name,
             MIN(pr_artifact_id) AS pr_artifact_id,
             MIN(identity_key) AS identity_key
           FROM sha_pr_candidates
           GROUP BY sha, repo_full_name
           HAVING COUNT(DISTINCT pr_artifact_id) = 1
         )
         SELECT
           sal.session_id AS session_id,
           u.pr_artifact_id AS pr_artifact_id,
           u.identity_key AS identity_key,
           MIN(commit_art.sha) AS matched_sha
         FROM session_artifact_links sal
         JOIN artifacts commit_art ON sal.artifact_id = commit_art.id
           AND commit_art.kind = 'commit'
         -- \`IS\` rather than \`=\` on the repo: both sides are the same nullable
         -- column and a repo-less commit must rejoin its own repo-less group.
         JOIN unambiguous_sha_prs u ON u.sha = commit_art.sha
           AND u.repo_full_name IS commit_art.repo_full_name
         WHERE sal.relation = 'created'
           -- Don't re-mint when a session→PR *created* link already exists (a real
           -- gh_pr_create link, or a prior run of this pass). Scoped to 'created'
           -- because the natural key is (session, artifact, relation): a
           -- non-'created' reference/workspace link (e.g. the FEA-4377 branch→PR
           -- propagation stamps 'workspace') is a DIFFERENT row and must NOT
           -- suppress the authoring mint — the projection needs the 'created' link.
           AND NOT EXISTS (
             SELECT 1 FROM session_artifact_links ex
             WHERE ex.session_id = sal.session_id
               AND ex.artifact_id = u.pr_artifact_id
               AND ex.relation = 'created'
           )
         GROUP BY sal.session_id, u.pr_artifact_id, u.identity_key`;
}
