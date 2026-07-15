/**
 * @file pr-link-maintenance.ts
 * @description Post-backfill PR-branch maintenance that issues `prisma.write`
 * callbacks, so it MUST execute inside the FEA-2038 db host (the process that
 * owns the SQLite handle). A `prisma.write(fn)` cannot cross the db-host method
 * proxy (a function can't be structured-cloned over IPC, a DataCloneError), so
 * these run in-child, exposed to the main process as the clone-safe
 * `agentDatabase.remediateMisattributedPrBranches()` /
 * `agentDatabase.propagateAllBranchPrLinks()` methods (see sqlite.ts).
 */

import { artifactLinkId } from "../collectors/parsing/artifact-ref-extractor.js";
import type { DesktopPrisma } from "./prisma-client.js";

/**
 * FEA-1959: one-time remediation for PR artifacts whose branch_name is a default
 * branch (main/master/develop) that were mis-stamped by the old import path which
 * used the session's stale gitBranch. Reset them to provisional so the enrichment
 * sweep re-fetches from GitHub and writes the correct headRefName. Returns the
 * number of rows reset so the caller can trigger an enrichment sweep.
 *
 * The `enriched_at IS NULL` guard is what makes this idempotent: enrichment
 * stamps `enriched_at` whenever it commits a state (applyEnrichmentResult), and
 * it only writes branch_name from GitHub's headRefName. So a row with
 * enriched_at set already has a GitHub-confirmed branch_name: if that name is
 * legitimately a default branch, resetting it would just have enrichment write
 * the same value back and re-match next boot, an infinite reset↔enrich cycle.
 * Only the stale-import rows (never enriched) need remediation.
 */
export async function remediateMisattributedPrBranches(
  prisma: DesktopPrisma,
  log: (msg: string) => void
): Promise<number> {
  try {
    const remediated = await prisma.write((client) =>
      client.$executeRawUnsafe(
        `UPDATE artifacts SET enrichment_state = 'provisional'
         WHERE kind = 'pull_request'
           AND branch_name IN ('main', 'master', 'develop')
           AND enrichment_state = 'final'
           AND enriched_at IS NULL`
      )
    );
    if (remediated > 0) {
      log(
        `PR branch remediation: reset ${remediated} mis-attributed PR(s) to provisional`
      );
    }
    return remediated;
  } catch (e) {
    log(
      `PR branch remediation failed: ${e instanceof Error ? e.message : String(e)}`
    );
    return 0;
  }
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
         JOIN artifacts branch ON sal.artifact_id = branch.id
           AND branch.kind = 'branch'
           AND branch.repo_full_name IS NOT NULL
         JOIN pull_requests pr ON pr.repo_full_name = branch.repo_full_name
           AND pr.branch_name = branch.branch_name
           AND pr.pr_number IS NOT NULL
           AND pr.branch_name NOT IN ('main', 'master', 'develop', 'HEAD')
         JOIN artifacts pr_art ON pr_art.kind = 'pull_request'
           AND pr_art.repo_full_name = pr.repo_full_name
           AND pr_art.pr_number = pr.pr_number
           -- NULL pr_state (unenriched) treated as open: temporary over-link that
           -- self-heals once the enrichment sweep sets pr_state. Accepted tradeoff.
           AND COALESCE(pr_art.pr_state, 'open') NOT IN ('merged', 'closed')
         WHERE NOT EXISTS (
           SELECT 1 FROM session_artifact_links ex
           WHERE ex.session_id = sal.session_id AND ex.artifact_id = pr_art.id
             AND ex.relation = 'workspace'
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
        "workspace"
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
           VALUES ($1, $2, $3, 'workspace', 'branch_pr_association', '{}', 0,
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
