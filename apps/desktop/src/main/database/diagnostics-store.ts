import type {
  BackfillStats,
  DiagnosticsData,
  DiagnosticsRepoRow,
  DiagnosticsRequest,
  LinkStatsRow,
  LinkTotals,
} from "../../shared/diagnostics-contract.js";
import {
  activityCoverageRawRead,
  readActivityCoverageOrUnknown,
} from "./activity-coverage-read.js";
import {
  listOpencodeWithheldScans,
  listOpencodeWithheldSubagents,
} from "./opencode-withheld-store.js";
import type { DesktopPrisma } from "./prisma-client.js";

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
// projections), so they run through the raw read escape hatch. Through the
// libSQL adapter, COUNT(*) aggregates and plain INTEGER columns (e.g. pr_number,
// extractor_version) both come back as JS `number`; only `BIGINT`-declared
// columns surface as `bigint`, and this file reads none. The `Number(...)`
// wraps on the COUNT results are therefore defensive normalization, not a
// required coercion.
//
// ISS-7037: every one of them dispatches through `prisma.read` onto the READER
// pool, one dispatch per aggregate — the same ISS-5938 shape `dashboard-
// queries.ts` and `activity-coverage-read.ts` already use, and per-read dispatch
// rather than one shared reader `$transaction` for the reason
// `local-insights-delivery.ts` spells out (see `queryLinkStats`). None of
// these reads
// is read-your-writes (the panel polls a rollup; a committed WAL snapshot is
// exactly what it wants), so nothing here belongs on the PRIMARY/writer
// connection that owns sync durability, where a whole-table COUNT would contend
// with the first-launch backfill's write queue in both directions. The FEA-2211
// quirk that keeps TYPED aggregates on `prisma.client` does not apply: every
// read here is raw, and raw SQL on the pool is the proven-safe shape. What the
// pool buys is LOCK-FREEDOM plus the possibility of interleaving, not parallel
// execution (ISS-8246 M4) — the `Promise.all` batches below still resolve
// against one JS thread.
export async function getDiagnosticsData(
  prisma: DesktopPrisma,
  request: DiagnosticsRequest = {},
  log: (message: string) => void = () => {
    // No-op default: a caller with no log sink still gets the payload.
  }
): Promise<DiagnosticsData> {
  const [
    repos,
    backfill,
    linkStats,
    linkTotals,
    opencodeWithheld,
    opencodeWithheldScans,
    activityCoverage,
  ] = await Promise.all([
    queryRepos(prisma),
    queryBackfillStats(prisma),
    queryLinkStats(prisma),
    queryLinkTotals(prisma),
    listOpencodeWithheldSubagents(prisma),
    listOpencodeWithheldScans(prisma),
    // ISS-6758: this read is a full scan plus a temp B-tree over a per-session
    // table, and the panel polls every 5s. Its tab is closed by default, so
    // running it unconditionally would charge every user for a payload they
    // cannot see — the caller asks for it only when the tab is open.
    request.includeActivityCoverage === true
      ? readActivityCoverageOrUnknown(activityCoverageRawRead(prisma), log)
      : undefined,
  ]);

  return {
    repos,
    backfill,
    linkStats,
    linkTotals,
    opencodeWithheld,
    // ISS-5266: the scan verdicts ride alongside the rows because the rows alone
    // cannot say whether an empty set means "nothing withheld" or "nothing
    // scanned". Sending one without the other would leave the consumer guessing,
    // which is the conflation this ticket removes.
    opencodeWithheldScans,
    // ISS-6758 (PRD-488 FR-12): omitted entirely — never zeroed — both when the
    // caller did not ask for it and when the read failed. See
    // `readActivityCoverageOrUnknown` and the contract's field doc.
    ...(activityCoverage ? { activityCoverage } : {}),
  };
}

async function queryRepos(
  prisma: DesktopPrisma
): Promise<DiagnosticsRepoRow[]> {
  const rows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<
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
    )
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
  const [artifactLinksRows] = await Promise.all([
    prisma.read((reader) =>
      reader.$queryRawUnsafe<
        { total_scanned: number; last_scanned_at: string | null }[]
      >(
        `SELECT COUNT(*) AS total_scanned,
                MAX(scanned_at) AS last_scanned_at
         FROM artifact_link_backfill_seen`
      )
    ),
  ]);

  const alRow = artifactLinksRows[0];

  return {
    artifactLinks: {
      totalScanned: Number(alRow?.total_scanned ?? 0),
      lastScannedAt: alRow?.last_scanned_at ?? null,
    },
  };
}

/**
 * The per-relation breakdown of `session_artifact_links`.
 *
 * Deliberately its OWN dispatch, NOT one `read((r) => r.$transaction(...))`
 * shared with {@link queryLinkTotals} — the Links tab renders `totalLinks`
 * directly above the breakdown that is meant to sum to it, so a shared snapshot
 * is tempting. `local-insights-delivery.ts` states in full why the pool refuses
 * that trade: a reader `$transaction` inside a `Promise.all` pins one of the two
 * `DEFAULT_READER_POOL_SIZE` slots for its whole duration, `read()` dispatches
 * strict round-robin with no availability check, a concurrent reader
 * `$transaction` landing on the pinned slot fails outright at
 * `TRANSACTION_MAX_WAIT_MS` rather than queueing, and a held read-mark blocks
 * every form of WAL reclaim (the FEA-3132 runaway-`-wal` mode) — on a panel that
 * polls every 5s. It would also be a NEW guarantee rather than a restored one:
 * these two were separate implicit transactions on the writer before ISS-7037
 * and they still are, so the guarantee CLASS is unchanged. The WINDOW is wider,
 * exactly as it is for Insights: they used to share the writer's connection and
 * its per-connection mutex, and now round-robin to two. Same class, more
 * opportunity to hit it — atomic link aggregates would be a separate change with
 * a second reader-pool slot behind it, not a line in this routing fix.
 */
async function queryLinkStats(prisma: DesktopPrisma): Promise<LinkStatsRow[]> {
  const rows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<
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
    )
  );
  return rows.map((row) => ({
    relation: row.relation,
    method: row.method,
    count: Number(row.count),
  }));
}

/** The headline totals. Own dispatch — see {@link queryLinkStats}. */
async function queryLinkTotals(prisma: DesktopPrisma): Promise<LinkTotals> {
  const rows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<
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
    )
  );
  const row = rows[0];
  return {
    totalLinks: Number(row?.total_links ?? 0),
    linkedSessions: Number(row?.linked_sessions ?? 0),
    linkedArtifacts: Number(row?.linked_artifacts ?? 0),
  };
}
