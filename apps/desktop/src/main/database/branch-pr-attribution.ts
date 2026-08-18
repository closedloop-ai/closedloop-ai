/**
 * @file branch-pr-attribution.ts
 * @description SSOT for branch→PR attribution: the authoring-evidence gate
 * (FEA-4377 / FEA-2531) plus the session-linking and stale-link remediation it
 * governs. Three propagation paths mint the same `branch_pr_association`
 * workspace link — the per-import `propagateBranchPrLinks` (invoked from
 * artifact-link-persistence), the boot maintenance `propagateAllBranchPrLinks`
 * (pr-link-maintenance), and the enrichment `linkBranchSessionsToPr` (below) —
 * and all three must gate on the same rule, so the shared constants live here
 * rather than being re-declared in lockstep at each site.
 *
 * ISS-4651: only the first TWO are live, and they are predicate-identical.
 * `linkBranchSessionsToPr` has no production caller left (the enrichment sweep
 * that drove it was deleted by PLN-1535 M5) and its gate is the LOOSEST of the
 * three — no `pull_requests` join, no head-ref or `pr_state` condition — so do
 * not read it as the reference implementation of the rule. It is kept pending
 * an explicit decision to remove it; treat the two live paths as the pair that
 * must not drift.
 *
 * The gate (FEA-2531): a session may be attributed to a PR only via a branch
 * link that carries authoring evidence — `relation='created'` (git_push /
 * git_commit / gh_pr_create). A `relation='workspace'` branch link
 * (start_branch / git_checkout / git_worktree_add) records only that the
 * session's CWD sat on the branch — the stale gitBranch the invariant forbids
 * attributing by — so it must never drive the branch→PR name-join.
 *
 * Runs `prisma.write` callbacks, so — like pr-link-maintenance — it MUST execute
 * inside the FEA-2038 db host (a callback can't cross the method proxy). See
 * pr-link-maintenance.ts and database/AGENTS.md.
 */

import { artifactLinkId } from "../collectors/parsing/artifact-ref-extractor.js";
import {
  ArtifactKind,
  artifactIdFromIdentityKey,
  computeIdentityKey,
} from "../enrichment/identity-key.js";
import { BRANCH_WRITE_METHOD_VALUES, sqlStringList } from "./db-constants.js";
import type { Prisma } from "./generated/client.js";
import type { DesktopPrisma } from "./prisma-client.js";

/**
 * Only a branch link carrying authoring evidence may feed PR attribution. A
 * `workspace` branch link is the stale CWD gitBranch FEA-2531 rejects.
 */
export const BRANCH_AUTHORING_RELATION = "created";
/** The relation stamped on the branch↔PR workspace link this module mints. */
export const PR_WORKSPACE_RELATION = "workspace";
/** The `method` marker on a propagation-minted branch↔PR workspace link. */
export const BRANCH_PR_ASSOCIATION_METHOD = "branch_pr_association";

/**
 * FEA-2531 split branch links by evidence at EXTRACTOR_VERSION 7: write methods
 * (git_push/gh_pr_create/git_commit) began emitting `relation='created'`; before
 * v7 they were ALL stored as `relation='workspace'` (there was no `created`
 * relation). The version at/after which authored branch links carry `created`.
 */
export const BRANCH_CREATED_RELATION_MIN_VERSION = 7;

/**
 * FEA-4377 compat fallback (wongk review): the authoring-evidence gate the three
 * propagators share. A branch link (aliased `<alias>`) is authoring evidence when
 * EITHER
 *   (1) it carries the post-v7 `relation='created'` marker, OR
 *   (2) it is a PRE-v7 row (`extractor_version < 7`) whose `method` is a branch
 *       WRITE method (git_push/gh_pr_create/git_commit) — pre-v7 those authored
 *       links were recorded as `relation='workspace'`, so a strict relation-only
 *       gate would silently drop them.
 *
 * The re-derivation path (artifact-link-backfill) rewrites pre-v7 workspace rows
 * to `created` as soon as the extractor version bumps — but ONLY while the source
 * transcript still exists. For a session whose transcript is gone, the frozen
 * pre-v7 row is all that remains, so this fallback is the only thing that keeps a
 * legitimately-authored old session attributable if its PR mapping arrives later.
 *
 * Method-qualified so it stays SAFE: a pre-v7 READ link (git_checkout /
 * git_worktree_add / slug_in_branch / start_branch) is NOT a write method, so it
 * remains excluded — the FEA-2531 mis-attribution stays closed. The clause is a
 * pure predicate over the aliased link row and adds no join.
 */
export function branchAuthoringEvidenceSql(alias: string): string {
  return `(${alias}.relation = '${BRANCH_AUTHORING_RELATION}'
     OR (${alias}.extractor_version < ${BRANCH_CREATED_RELATION_MIN_VERSION}
         AND ${alias}.method IN (${sqlStringList(BRANCH_WRITE_METHOD_VALUES)})))`;
}

type BranchArtifactRef = {
  id: string;
  branch_name: string | null;
  git_dir: string | null;
};

/**
 * FEA-1899: upsert the PR artifact for `branchArt`'s head ref and link every
 * session that AUTHORED this branch to it (idempotent). SQLite has no
 * md5()/left(): resolve the branch's sessions first, then insert one workspace
 * link per session with a JS-computed deterministic id (matching
 * propagateBranchPrLinks). The per-session `upsert` with an empty `update`
 * reproduces `ON CONFLICT(session_id, artifact_id, relation) DO NOTHING` — it
 * de-dupes on the natural triple regardless of the id encoding.
 *
 * FEA-4377: filter to authoring-evidence branch links only
 * (`branchAuthoringEvidenceSql` — post-v7 `relation='created'` plus the pre-v7
 * write-method workspace fallback; the gate above).
 */
export async function linkBranchSessionsToPr(
  prisma: DesktopPrisma,
  branchArt: BranchArtifactRef,
  prNumber: number,
  repoFullName: string
): Promise<void> {
  const identityKey = computeIdentityKey({
    kind: ArtifactKind.PullRequest,
    repoFullName,
    prNumber,
  });
  const artifactId = artifactIdFromIdentityKey(identityKey);
  const now = new Date().toISOString();

  // RAW (named blocker: conditional ON CONFLICT DO UPDATE): the upsert preserves
  // branch_name/git_dir via per-column COALESCE AND guards the update with
  // `WHERE artifacts.identity_key = EXCLUDED.identity_key` — neither a
  // COALESCE-of-existing-and-excluded nor a conditional DO-UPDATE predicate has
  // a typed Prisma `upsert` form. Runs on the one client via `write`.
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number, branch_name,
          git_dir, created_at, last_seen_at)
       VALUES ($1,$2,'pull_request',$3,$4,$5,$6,$7,$7)
       ON CONFLICT(id) DO UPDATE SET
         last_seen_at = EXCLUDED.last_seen_at,
         branch_name = COALESCE(artifacts.branch_name, EXCLUDED.branch_name),
         git_dir = COALESCE(artifacts.git_dir, EXCLUDED.git_dir)
       WHERE artifacts.identity_key = EXCLUDED.identity_key`,
      artifactId,
      identityKey,
      repoFullName,
      prNumber,
      branchArt.branch_name,
      branchArt.git_dir,
      now
    )
  );

  // Authoring-evidence gate (SSOT `branchAuthoringEvidenceSql`): post-v7
  // `relation='created'` links PLUS the pre-v7 write-method workspace fallback,
  // so a legitimately-authored old session (transcript gone, never re-derived to
  // `created`) is still attributed. Raw query because the fallback is an OR over
  // (relation) and (extractor_version + method) that the typed `where` can't
  // express without duplicating the literals.
  const branchSessions = await prisma.client.$queryRawUnsafe<
    { session_id: string }[]
  >(
    `SELECT DISTINCT link.session_id
       FROM session_artifact_links link
       WHERE link.artifact_id = $1
         AND ${branchAuthoringEvidenceSql("link")}`,
    branchArt.id
  );
  for (const { session_id: sessionId } of branchSessions) {
    const linkId = artifactLinkId(
      sessionId,
      ArtifactKind.PullRequest,
      identityKey,
      PR_WORKSPACE_RELATION
    );
    await prisma.write((client) =>
      client.sessionArtifactLink.upsert({
        where: {
          sessionId_artifactId_relation: {
            sessionId,
            artifactId,
            relation: PR_WORKSPACE_RELATION,
          },
        },
        create: {
          id: linkId,
          sessionId,
          artifactId,
          relation: PR_WORKSPACE_RELATION,
          method: BRANCH_PR_ASSOCIATION_METHOD,
          evidence: "{}",
          isPrimary: false,
          status: "candidate",
          extractorVersion: 1,
          observedAt: now,
          createdAt: now,
        },
        update: {},
        select: { id: true },
      })
    );
  }
}

/**
 * FEA-4377 upgrade remediation. The relation='created' gate prevents NEW false
 * branch→PR links, but an installation upgraded from before the gate may still
 * carry `branch_pr_association` workspace links minted by an OLD propagation
 * pass from a workspace-only branch link. The artifact-link backfill explicitly
 * preserves these rows (`NON_REDERIVED_LINK_METHODS`), so nothing else deletes
 * them — the false PR/cost attribution survives the upgrade.
 *
 * This removes exactly those stale rows: a `branch_pr_association` workspace
 * link to a PR artifact for which the session has NO authoring branch link
 * (`relation='created'`) to a branch whose head ref (via pull_requests) matches
 * that PR. A session with real authoring evidence keeps its link. Idempotent —
 * a clean store (or one already remediated) deletes zero. Returns the delete
 * count so the caller can nudge the renderer.
 */
export async function removeUnauthoredBranchPrLinks(
  prisma: DesktopPrisma,
  log: (msg: string) => void
): Promise<number> {
  try {
    const removed = await prisma.write((client) =>
      client.$executeRawUnsafe(
        `DELETE FROM session_artifact_links
         WHERE id IN (
           SELECT link.id
           FROM session_artifact_links link
           JOIN artifacts pr_art ON pr_art.id = link.artifact_id
             AND pr_art.kind = 'pull_request'
           WHERE link.relation = '${PR_WORKSPACE_RELATION}'
             AND link.method = '${BRANCH_PR_ASSOCIATION_METHOD}'
             AND NOT EXISTS (
               SELECT 1
               FROM session_artifact_links created_link
               JOIN artifacts branch ON branch.id = created_link.artifact_id
                 AND branch.kind = 'branch'
                 AND branch.repo_full_name IS NOT NULL
               JOIN pull_requests pr
                 ON pr.repo_full_name = branch.repo_full_name
                 AND pr.branch_name = branch.branch_name
                 AND pr.repo_full_name = pr_art.repo_full_name
                 AND pr.pr_number = pr_art.pr_number
               WHERE created_link.session_id = link.session_id
                 AND ${branchAuthoringEvidenceSql("created_link")}
             )
         )`
      )
    );
    if (removed > 0) {
      log(
        `branch→PR link remediation: removed ${removed} unauthored association(s)`
      );
    }
    return removed;
  } catch (e) {
    log(
      `branch→PR link remediation failed: ${e instanceof Error ? e.message : String(e)}`
    );
    return 0;
  }
}

/**
 * FEA-1899 per-import propagation: inside the import transaction, link this
 * session to any open PR artifact whose head branch matches a branch the session
 * AUTHORED (the gate above), joining through pull_requests for the correct
 * branch↔PR mapping. Best-effort per row — a failed link retries on next import.
 * Sibling of the boot maintenance `propagateAllBranchPrLinks`.
 */
export async function propagateBranchPrLinks(
  tx: Prisma.TransactionClient,
  sessionId: string,
  now: string
): Promise<void> {
  const prArtifacts = await tx.$queryRawUnsafe<
    { pr_id: string; identity_key: string }[]
  >(
    `SELECT DISTINCT pr_art.id AS pr_id, pr_art.identity_key
     FROM session_artifact_links sal
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
       AND COALESCE(pr_art.pr_state, 'open') NOT IN ('merged', 'closed')
     WHERE sal.session_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM session_artifact_links ex
         WHERE ex.session_id = $1 AND ex.artifact_id = pr_art.id
           AND ex.relation = '${PR_WORKSPACE_RELATION}'
       )`,
    sessionId
  );

  for (const row of prArtifacts) {
    try {
      const linkId = artifactLinkId(
        sessionId,
        "pull_request",
        row.identity_key,
        PR_WORKSPACE_RELATION
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence, is_primary,
            status, extractor_version, observed_at, created_at)
         VALUES ($1,$2,$3,'${PR_WORKSPACE_RELATION}','${BRANCH_PR_ASSOCIATION_METHOD}','{}',0,
                 'candidate',1,$4,$4)
         ON CONFLICT(session_id, artifact_id, relation) DO NOTHING`,
        linkId,
        sessionId,
        row.pr_id,
        now
      );
    } catch {
      // Non-critical — link will be retried on next import
    }
  }
}
