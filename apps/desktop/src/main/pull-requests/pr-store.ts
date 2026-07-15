/**
 * @file pr-store.ts
 * @description SQLite persistence and backfill for captured pull requests.
 * Combines the old pull-request-store.js and pr-backfill.js into a single
 * first-party ESM module for the design-system dashboard runtime.
 *
 * Schema is owned by the Prisma schema + migration runner — no schema creation
 * here. The READ functions run on the single DesktopPrisma client via typed
 * delegates (one raw GROUP BY remains in listPrSessions). The write path
 * (`upsertPullRequest`) takes a `Prisma.TransactionClient` and runs its
 * COALESCE-preserve UPDATE + INSERT on `$executeRawUnsafe` (not expressible via a
 * Prisma upsert; see the note below).
 *
 * Part of CLOSEDLOOP engineer GitHub activity capture (FEA-1226).
 */

import { createHash } from "node:crypto";
import type {
  PrRecord,
  PrSessionGroup,
  PrStats,
} from "../../shared/agent-db-contract.js";
import type { Prisma } from "../database/generated/client.js";
import type { DbHostPrisma } from "../database/prisma-client.js";

// upsertPullRequest runs inside the importer / lifecycle / sync `$transaction`
// on the single DesktopPrisma client, so it takes a `Prisma.TransactionClient`;
// its hand-written COALESCE-preserve UPDATE + the INSERT stay raw on
// `$executeRawUnsafe` (not expressible via a Prisma upsert).
//
// The READ functions run on the single DesktopPrisma client via typed delegates
// (`artifact`/`sessionArtifactLink` findMany/count/groupBy, using the
// `artifactLinks`/`artifact` relation filters to express the
// session_artifact_links join). Only the listPrSessions OUTER query stays on
// `prisma.client.$queryRawUnsafe`: it GROUP BYs link rows while aggregating
// MAX(observed_at)/MIN(harness) off the joined artifact and pulling session
// columns — a cross-table grouped aggregation no single typed delegate expresses.

/** Every PR read scopes to artifacts of this kind. */
const PR_KIND = "pull_request";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

/** Deterministic 16-hex id — same PR in the same session dedups to one row. */
function pullRequestId(
  harness: string,
  sessionId: string,
  prUrl: string
): string {
  return createHash("sha256")
    .update(`${harness}|${sessionId}|${prUrl}`)
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// DB: upsertPullRequest
// ---------------------------------------------------------------------------

type PullRequestInput = {
  externalSessionId: string;
  prUrl: string;
  prNumber: number;
  repoFullName: string;
  branchName?: string | null;
  headSha?: string | null;
  title?: string | null;
  state?: string | null;
  closedAt?: string | null;
  mergedAt?: string | null;
  harness: string;
  observedAt?: string;
};

export async function upsertPullRequest(
  tx: Prisma.TransactionClient,
  pr: PullRequestInput
): Promise<{ id: string; created: boolean }> {
  const id = pullRequestId(pr.harness, pr.externalSessionId, pr.prUrl);
  const existingResult = await tx.$queryRawUnsafe<{ id: string }[]>(
    "SELECT id FROM pull_requests WHERE id = $1",
    id
  );

  if (existingResult.length > 0) {
    await tx.$executeRawUnsafe(
      // branch_name is AUTHORITATIVE from the import (not COALESCE-preserved):
      // it is the per-session head ref for a PR this session created, or null for
      // a merely-referenced PR. The import is the sole writer of this per-session
      // row, so "latest import wins" is correct AND lets a re-derive clear rows
      // mis-stamped by the prior session-branch behavior. The remaining fields
      // stay COALESCE — enrichment fills state/closed_at/merged_at later.
      `UPDATE pull_requests
         SET branch_name = $1,
             head_sha    = COALESCE(head_sha, $2),
             title       = COALESCE(title, $3),
             state       = COALESCE($4, state),
             closed_at   = COALESCE($5, closed_at),
             merged_at   = COALESCE($6, merged_at)
       WHERE id = $7`,
      pr.branchName || null,
      pr.headSha || null,
      pr.title || null,
      pr.state || null,
      pr.closedAt || null,
      pr.mergedAt || null,
      id
    );
    return { id, created: false };
  }

  await tx.$executeRawUnsafe(
    `INSERT INTO pull_requests
       (id, session_id, pr_url, pr_number, repo_full_name, branch_name,
        head_sha, title, state, closed_at, merged_at, harness, observed_at,
        created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    id,
    pr.externalSessionId || null,
    pr.prUrl,
    pr.prNumber,
    pr.repoFullName,
    pr.branchName || null,
    pr.headSha || null,
    pr.title || null,
    pr.state || null,
    pr.closedAt || null,
    pr.mergedAt || null,
    pr.harness,
    pr.observedAt || nowIso(),
    nowIso()
  );
  return { id, created: true };
}

// ---------------------------------------------------------------------------
// DB: list / count / stats
// ---------------------------------------------------------------------------

type PrListFilters = {
  sessionId?: string | null;
  repo?: string | null;
  limit?: number;
  offset?: number;
};

/**
 * Shared WHERE for PR-artifact reads: always scope to PR artifacts, optionally
 * to a repo and/or a session. The `artifactLinks.some` session filter expresses
 * the prior `session_artifact_links` JOIN WITHOUT row-multiplication — each
 * artifact matches once — so it serves the list, the count, and the per-session
 * list alike, retiring both the `SELECT DISTINCT` and the `IS NOT DISTINCT FROM`
 * per-session subquery the prior raw reads used.
 */
function buildPrWhere(opts: {
  sessionId?: string | null;
  repo?: string | null;
}) {
  return {
    kind: PR_KIND,
    ...(opts.repo ? { repoFullName: opts.repo } : {}),
    ...(opts.sessionId
      ? { artifactLinks: { some: { sessionId: opts.sessionId } } }
      : {}),
  };
}

/**
 * Shared typed read for `pull_request` artifacts. `sessionId` is echoed onto
 * each DTO from the scoping value (the artifact has no session column), matching
 * the prior `SELECT sal.session_id AS session_id` / NULL-when-unscoped.
 */
async function findPrArtifacts(
  prisma: DbHostPrisma,
  opts: PrListFilters = {}
): Promise<PrRecord[]> {
  const sessionId = opts.sessionId ?? null;
  const rows = await prisma.client.artifact.findMany({
    where: buildPrWhere(opts),
    select: {
      id: true,
      url: true,
      prNumber: true,
      repoFullName: true,
      branchName: true,
      headSha: true,
      title: true,
      harness: true,
      observedAt: true,
      createdAt: true,
    },
    orderBy: { observedAt: "desc" },
    ...(opts.limit === undefined ? {} : { take: opts.limit }),
    ...(opts.offset ? { skip: opts.offset } : {}),
  });
  return rows.map((row) => ({
    id: row.id,
    sessionId,
    prUrl: row.url ?? "",
    prNumber: row.prNumber,
    repoFullName: row.repoFullName,
    branchName: row.branchName,
    headSha: row.headSha,
    title: row.title,
    harness: row.harness,
    observedAt: row.observedAt,
    createdAt: row.createdAt,
  }));
}

export function listPullRequests(
  prisma: DbHostPrisma,
  opts: PrListFilters = {}
): Promise<PrRecord[]> {
  const { limit = 100, offset = 0 } = opts;
  return findPrArtifacts(prisma, {
    sessionId: opts.sessionId,
    repo: opts.repo,
    limit,
    offset,
  });
}

export function countPullRequests(
  prisma: DbHostPrisma,
  opts: Omit<PrListFilters, "limit" | "offset"> = {}
): Promise<number> {
  // The `some` relation filter (see buildPrWhere) counts each PR artifact once,
  // so a plain `count` reproduces the prior `COUNT(DISTINCT a.id)`.
  return prisma.client.artifact.count({ where: buildPrWhere(opts) });
}

/**
 * Distinct PR repos = `COUNT(DISTINCT repo_full_name)`. groupBy yields one row
 * per distinct value; `repoFullName: { not: null }` drops the NULL group to
 * match SQL `COUNT(DISTINCT …)`, which never counts NULL.
 */
export async function countRepos(prisma: DbHostPrisma): Promise<number> {
  const groups = await prisma.client.artifact.groupBy({
    by: ["repoFullName"],
    where: { kind: PR_KIND, repoFullName: { not: null } },
  });
  return groups.length;
}

export async function getPrStats(prisma: DbHostPrisma): Promise<PrStats> {
  // Three typed counts over the in-process SQLite handle; the prior single raw
  // query only fused them via a correlated subquery for the session count.
  const totalPrs = await prisma.client.artifact.count({
    where: { kind: PR_KIND },
  });
  const repos = await countRepos(prisma);
  const sessionsWithPrs = await countSessionsWithPullRequests(prisma);
  return { totalPrs, repos, sessionsWithPrs };
}

// ---------------------------------------------------------------------------
// DB: session-grouped PR listing
// ---------------------------------------------------------------------------

export async function listPrSessions(
  prisma: DbHostPrisma,
  opts: { limit?: number; offset?: number } = {}
): Promise<PrSessionGroup[]> {
  const { limit = 100, offset = 0 } = opts;
  const groups = await prisma.client.$queryRawUnsafe<
    {
      session_id: string | null;
      session_name: string | null;
      session_started_at: string | null;
      session_cwd: string | null;
      pr_count: number;
      last_pr_at: string | null;
      harness: string | null;
    }[]
  >(
    `SELECT
       sal.session_id                        AS session_id,
       s.name                                AS session_name,
       s.started_at                          AS session_started_at,
       s.cwd                                 AS session_cwd,
       COUNT(*)                              AS pr_count,
       MAX(a.observed_at)                    AS last_pr_at,
       MIN(a.harness)                        AS harness
     FROM session_artifact_links sal
     JOIN artifacts a ON a.id = sal.artifact_id AND a.kind = 'pull_request'
     LEFT JOIN sessions s ON s.id = sal.session_id
     GROUP BY sal.session_id, s.name, s.started_at, s.cwd
     ORDER BY last_pr_at DESC
     LIMIT $1 OFFSET $2`,
    limit,
    offset
  );

  const rows: PrSessionGroup[] = [];
  for (const row of groups) {
    // Per-session PR list via the same typed read the unscoped list uses. The
    // outer GROUP BY is on the NOT-NULL `sal.session_id`, so `row.session_id` is
    // always a concrete id here and the `some` filter scopes exactly to it.
    const prs = await findPrArtifacts(prisma, { sessionId: row.session_id });
    rows.push({
      sessionId: row.session_id ?? "unknown",
      sessionName: row.session_name,
      cwd: row.session_cwd,
      harness: row.harness,
      startedAt: row.session_started_at,
      prs,
    });
  }
  return rows;
}

export async function countSessionsWithPullRequests(
  prisma: DbHostPrisma
): Promise<number> {
  // COUNT(DISTINCT session_id) over links to PR artifacts → one groupBy row per
  // distinct session. `session_id` is non-null in the model, so there is no NULL
  // group to exclude.
  const groups = await prisma.client.sessionArtifactLink.groupBy({
    by: ["sessionId"],
    where: { artifact: { kind: PR_KIND } },
  });
  return groups.length;
}

export async function sessionIdsWithPullRequests(
  prisma: DbHostPrisma
): Promise<{ session_id: string; c: number }[]> {
  // Per-session link counts (the prior `COUNT(*)` per session_id over links to
  // PR artifacts). `_count._all` returns a real JS number through the typed
  // delegate — no bigint coercion needed, unlike the COUNT(*)::int the raw
  // $queryRawUnsafe path could surface.
  const groups = await prisma.client.sessionArtifactLink.groupBy({
    by: ["sessionId"],
    where: { artifact: { kind: PR_KIND } },
    _count: { _all: true },
  });
  return groups.map((g) => ({ session_id: g.sessionId, c: g._count._all }));
}
