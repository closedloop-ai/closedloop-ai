import type {
  BackfillStats,
  DiagnosticsData,
  DiagnosticsRepoRow,
  EnrichmentQueueRow,
  LinkStatsRow,
  LinkTotals,
  PendingArtifactRow,
  StalledArtifactRow,
} from "../../shared/diagnostics-contract.js";
import type { DesktopPrisma } from "./prisma-client.js";

const MAX_PENDING_ROWS = 200;
const MAX_STALLED_ROWS = 50;
const STALLED_ATTEMPT_THRESHOLD = 5;

function sanitizeRemoteUrl(remoteUrl: string | null): string | null {
  if (!remoteUrl) {
    return remoteUrl;
  }
  try {
    const parsed = new URL(remoteUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    // Non-URL remotes (e.g. scp-style git@host:owner/repo.git) carry no
    // userinfo/query/fragment to leak, so return them unchanged.
    return remoteUrl;
  }
}

// These diagnostics reads have no clean typed-delegate form (GROUP BY rollups,
// COUNT(*)/COUNT(DISTINCT) aggregates, LEFT JOIN counts, plain-column
// projections), so they run on the single DesktopPrisma client's raw read
// escape hatch (`prisma.client.$queryRawUnsafe`). Through the libSQL adapter,
// COUNT(*) aggregates and plain INTEGER columns (e.g. pr_number,
// enrichment_attempts) both come back as JS `number`; only `BIGINT`-declared
// columns surface as `bigint`, and this file reads none. The `Number(...)`
// wraps on the COUNT results are therefore defensive normalization, not a
// required coercion.
export async function getDiagnosticsData(
  prisma: DesktopPrisma
): Promise<DiagnosticsData> {
  const [
    enrichmentQueue,
    pendingArtifacts,
    stalledArtifacts,
    repos,
    backfill,
    linkStats,
    linkTotals,
  ] = await Promise.all([
    queryEnrichmentQueue(prisma),
    queryPendingArtifacts(prisma),
    queryStalledArtifacts(prisma),
    queryRepos(prisma),
    queryBackfillStats(prisma),
    queryLinkStats(prisma),
    queryLinkTotals(prisma),
  ]);

  return {
    enrichmentQueue,
    pendingArtifacts,
    stalledArtifacts,
    repos,
    backfill,
    linkStats,
    linkTotals,
  };
}

async function queryEnrichmentQueue(
  prisma: DesktopPrisma
): Promise<EnrichmentQueueRow[]> {
  const rows = await prisma.client.$queryRawUnsafe<
    {
      kind: string;
      state: string;
      count: number;
    }[]
  >(
    `SELECT kind,
            COALESCE(enrichment_state, 'pending') AS state,
            COUNT(*) AS count
     FROM artifacts
     WHERE kind != 'closedloop_artifact'
     GROUP BY kind, COALESCE(enrichment_state, 'pending')
     ORDER BY kind, state`
  );
  return rows.map((row) => ({
    kind: row.kind,
    state: row.state,
    count: Number(row.count),
  }));
}

async function queryPendingArtifacts(
  prisma: DesktopPrisma
): Promise<PendingArtifactRow[]> {
  const rows = await prisma.client.$queryRawUnsafe<
    {
      id: string;
      identity_key: string;
      kind: string;
      repo_full_name: string | null;
      git_dir: string | null;
      sha: string | null;
      branch_name: string | null;
      pr_number: number | null;
      enrichment_state: string | null;
      enrichment_attempts: number;
      lease_at: string | null;
      last_seen_at: string;
    }[]
  >(
    `SELECT id, identity_key, kind, repo_full_name,
            git_dir, sha, branch_name, pr_number,
            enrichment_state, enrichment_attempts,
            lease_at, last_seen_at
     FROM artifacts
     WHERE (enrichment_state IS NULL OR enrichment_state = 'provisional')
       AND kind != 'closedloop_artifact'
     ORDER BY
       CASE WHEN lease_at IS NOT NULL THEN 0 ELSE 1 END,
       enrichment_attempts DESC,
       last_seen_at DESC
     LIMIT $1`,
    MAX_PENDING_ROWS
  );
  return rows.map((row) => ({
    id: row.id,
    identityKey: row.identity_key,
    kind: row.kind,
    repoFullName: row.repo_full_name,
    gitDir: row.git_dir,
    sha: row.sha,
    branchName: row.branch_name,
    prNumber: row.pr_number,
    enrichmentState: row.enrichment_state,
    enrichmentAttempts: row.enrichment_attempts,
    leasedAt: row.lease_at,
    lastSeenAt: row.last_seen_at,
  }));
}

async function queryStalledArtifacts(
  prisma: DesktopPrisma
): Promise<StalledArtifactRow[]> {
  const rows = await prisma.client.$queryRawUnsafe<
    {
      id: string;
      identity_key: string;
      kind: string;
      repo_full_name: string | null;
      enrichment_state: string | null;
      enrichment_attempts: number;
      enriched_at: string | null;
      last_seen_at: string;
    }[]
  >(
    `SELECT id, identity_key, kind, repo_full_name,
            enrichment_state, enrichment_attempts,
            enriched_at, last_seen_at
     FROM artifacts
     WHERE enrichment_attempts >= $1
       AND (enrichment_state IS NULL
            OR enrichment_state NOT IN ('final', 'not_applicable'))
     ORDER BY last_seen_at DESC
     LIMIT $2`,
    STALLED_ATTEMPT_THRESHOLD,
    MAX_STALLED_ROWS
  );
  return rows.map((row) => ({
    id: row.id,
    identityKey: row.identity_key,
    kind: row.kind,
    repoFullName: row.repo_full_name,
    enrichmentState: row.enrichment_state,
    enrichmentAttempts: row.enrichment_attempts,
    enrichedAt: row.enriched_at,
    lastSeenAt: row.last_seen_at,
  }));
}

async function queryRepos(
  prisma: DesktopPrisma
): Promise<DiagnosticsRepoRow[]> {
  const rows = await prisma.client.$queryRawUnsafe<
    {
      id: string;
      git_dir: string;
      remote_url: string | null;
      repo_full_name: string | null;
      default_branch: string | null;
      last_seen_at: string;
      worktree_count: number;
    }[]
  >(
    `SELECT r.id, r.git_dir, r.remote_url, r.repo_full_name,
            r.default_branch, r.last_seen_at,
            COUNT(rw.id) AS worktree_count
     FROM repos r
     LEFT JOIN repo_worktrees rw ON rw.repo_id = r.id
     GROUP BY r.id
     ORDER BY r.last_seen_at DESC`
  );
  return rows.map((row) => ({
    id: row.id,
    gitDir: row.git_dir,
    remoteUrl: sanitizeRemoteUrl(row.remote_url),
    repoFullName: row.repo_full_name,
    defaultBranch: row.default_branch,
    lastSeenAt: row.last_seen_at,
    worktreeCount: Number(row.worktree_count),
  }));
}

async function queryBackfillStats(
  prisma: DesktopPrisma
): Promise<BackfillStats> {
  const [artifactLinksRows, prRows] = await Promise.all([
    prisma.client.$queryRawUnsafe<
      { total_scanned: number; last_scanned_at: string | null }[]
    >(
      `SELECT COUNT(*) AS total_scanned,
              MAX(scanned_at) AS last_scanned_at
       FROM artifact_link_backfill_seen`
    ),
    prisma.client.$queryRawUnsafe<
      { total_scanned: number; last_scanned_at: string | null }[]
    >(
      `SELECT COUNT(*) AS total_scanned,
              MAX(scanned_at) AS last_scanned_at
       FROM pr_backfill_seen`
    ),
  ]);

  const alRow = artifactLinksRows[0];
  const prRow = prRows[0];

  return {
    artifactLinks: {
      totalScanned: Number(alRow?.total_scanned ?? 0),
      lastScannedAt: alRow?.last_scanned_at ?? null,
    },
    prBackfill: {
      totalScanned: Number(prRow?.total_scanned ?? 0),
      lastScannedAt: prRow?.last_scanned_at ?? null,
    },
  };
}

async function queryLinkStats(prisma: DesktopPrisma): Promise<LinkStatsRow[]> {
  const rows = await prisma.client.$queryRawUnsafe<
    {
      relation: string;
      method: string;
      count: number;
    }[]
  >(
    `SELECT relation, method, COUNT(*) AS count
     FROM session_artifact_links
     GROUP BY relation, method
     ORDER BY count DESC`
  );
  return rows.map((row) => ({
    relation: row.relation,
    method: row.method,
    count: Number(row.count),
  }));
}

async function queryLinkTotals(prisma: DesktopPrisma): Promise<LinkTotals> {
  const rows = await prisma.client.$queryRawUnsafe<
    {
      total_links: number;
      linked_sessions: number;
      linked_artifacts: number;
    }[]
  >(
    `SELECT COUNT(*) AS total_links,
            COUNT(DISTINCT session_id) AS linked_sessions,
            COUNT(DISTINCT artifact_id) AS linked_artifacts
     FROM session_artifact_links`
  );
  const row = rows[0];
  return {
    totalLinks: Number(row?.total_links ?? 0),
    linkedSessions: Number(row?.linked_sessions ?? 0),
    linkedArtifacts: Number(row?.linked_artifacts ?? 0),
  };
}
