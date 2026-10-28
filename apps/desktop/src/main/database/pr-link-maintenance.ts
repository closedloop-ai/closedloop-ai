/**
 * @file pr-link-maintenance.ts
 * @description Post-backfill PR-branch maintenance that issues `prisma.write`
 * callbacks, so it MUST execute inside the FEA-2038 db host (the process that
 * owns the SQLite handle). A `prisma.write(fn)` cannot cross the db-host method
 * proxy (a function can't be structured-cloned over IPC, a DataCloneError), so
 * these run in-child, exposed to the main process as the clone-safe
 * `agentDatabase.propagateAllBranchPrLinks()` method (see sqlite.ts).
 */

import { artifactLinkId } from "../collectors/parsing/artifact-ref-extractor.js";
import {
  BRANCH_PR_ASSOCIATION_METHOD,
  branchAuthoringEvidenceSql,
  PR_WORKSPACE_RELATION,
} from "./branch-pr-attribution.js";
import type { DesktopPrisma } from "./prisma-client.js";

/**
 * `session_artifact_links.method` on `created` session→PR links minted by the
 * removed commit-SHA correlation pass; rows already stored keep it. Exported so
 * the sync-source projection can recognise a correlation-minted link: its
 * `observed_at` is the maintenance pass's wall-clock time (Desktop boot), NOT a
 * real PR-raised instant, so the PrRaised lifecycle event falls back to
 * `pull_requests.opened_at`.
 */
export const COMMIT_SHA_CORRELATION_METHOD = "commit_sha_correlation";

/**
 * `session_artifact_links.method` stamped on the conservative session→PR link
 * `persistNormalizedPullRequests` mints — the ONLY method minted exclusively by
 * the pull-requests import phase.
 *
 * ISS-8758 + ISS-8905: that ownership is load-bearing, not documentation. It is
 * what PARTITIONS `session_artifact_links` between the two import phases that
 * jointly write it — the artifact-links phase deletes and rebuilds every other
 * method, the pull-requests phase deletes and rebuilds this one, each inside its
 * own transaction. Each therefore compares its link fingerprint over the methods
 * it OWNS (this one excluded there, this one alone here), or a byte-identical
 * re-import would read as a link change on every pass. ISS-8905 moved this
 * slice's TEARDOWN to match: before it, the artifact-links phase deleted these
 * rows and only the later PR phase restored them, so a failed PR group left a
 * durable deletion whose fingerprint and watermark bump had rolled back with it.
 */
export const NORMALIZED_PR_LINK_METHOD = "normalized_pr";

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
