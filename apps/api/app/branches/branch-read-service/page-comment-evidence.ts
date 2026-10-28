import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { ThreadSource } from "@repo/api/src/types/comment";
import type { PrismaClient } from "@repo/database";
import type { KnownThreadComment } from "@/app/artifacts/collaborators/direct-participation-service";
import type {
  BranchCommentEvidence,
  PagePlatformComment,
} from "./collaborator-projection";
import { readBranchCommentWindows } from "./comment-evidence-windows";
import { BRANCH_COMMENT_EVIDENCE_MAX_ROWS } from "./identity-evidence-limits";
import { readPullRequestCommentProof } from "./pull-request-comment-proof-sql";

type PageCommentEvidenceClient = Pick<
  PrismaClient,
  "$queryRaw" | "comment" | "gitHubCommentProjection"
>;

type PageCommentEvidenceBranch = {
  branchId: string;
  associatedPullRequestCount: number;
};

/**
 * The per-Branch comment-evidence cap. Exported so the ISS-6004 fan-out
 * regression test asserts the page-wide bound against this value rather than
 * re-declaring it (AGENTS.md: tests import contract constants).
 */
export const COMMENT_EVIDENCE_LIMIT = BRANCH_COMMENT_EVIDENCE_MAX_ROWS;

/**
 * Bind-parameter bound on the session-id `IN (…)` list, matching
 * `SESSION_USAGE_BRANCH_ID_CHUNK_SIZE` — the same id list, bounded the same way.
 * Exported so the ISS-6004 fan-out regression test asserts against this value
 * rather than re-declaring it (AGENTS.md: tests import contract constants).
 */
export const SESSION_COMMENT_ID_CHUNK_SIZE = 1000;

/**
 * `createdAt` and `id` are selected, not just filtered on, so the ordering the
 * per-Branch cap depends on survives a chunked read.
 */
const PLATFORM_COMMENT_SELECT = {
  authorId: true,
  createdAt: true,
  id: true,
  thread: { select: { artifactId: true, id: true } },
} as const;

/**
 * Reads independently capped comment evidence for EVERY branch on the page in
 * three source lanes, chunking Session IDs when needed (ISS-6004).
 *
 * The previous shape read one branch at a time through `mapWithDbConcurrency`,
 * so a 100-branch page issued 300 of the request's ~306 statements and 300
 * pooled connection checkouts, each its own round trip — the dominant term in a
 * 1.5–2.0 s `GET /branches`. All three reads are keyed on artifact ids the page
 * already holds, so they batch: one statement per evidence source with an
 * `IN (...)` over the whole page, grouped back per branch in memory.
 *
 * Per-branch cap semantics are preserved, because the wire
 * `BranchIdentityAvailability` is derived from them. Both platform-comment sources are
 * bounded by `COMMENT_EVIDENCE_LIMIT × <branches on the page>` — no looser than
 * the aggregate the per-branch reads already permitted, and keyed on the branch
 * count rather than the session count because a branch can only ever CONSUME its
 * own 1,000 rows however many sessions it links. Every branch's own cap is then
 * applied to its own group.
 *
 * ISS-10992: a saturated flat page is reread with per-Branch windows. Each
 * saturated source costs one additional statement, rather than one per Branch,
 * and retains the same population as detail and list SQL.
 *
 * `pullRequestAvailability` is the shared PR-comment lane proof; a Branch
 * without pull requests is complete.
 */
export async function readPageCommentEvidence(
  db: PageCommentEvidenceClient,
  organizationId: string,
  branches: readonly PageCommentEvidenceBranch[],
  sessionIdsByBranch: ReadonlyMap<string, ReadonlySet<string>>,
  preloadedSessionRows?: ReadonlyMap<string, readonly { authorId: string }[]>,
  completeBranchCommentsOut?: Map<string, KnownThreadComment[]>
): Promise<Map<string, BranchCommentEvidence>> {
  const branchIds = branches.map((branch) => branch.branchId);
  const branchIdsBySession = invertSessionIndex(sessionIdsByBranch);
  const sessionIds = [...branchIdsBySession.keys()];
  const pageCap = pageEvidenceCap(branchIds.length);
  const [branchRows, sessionEvidence, githubRows, proofIncomplete] =
    await Promise.all([
      db.comment.findMany({
        where: {
          deletedAt: null,
          thread: {
            organizationId,
            source: { in: [ThreadSource.Native, ThreadSource.Liveblocks] },
            artifactId: { in: [...branchIds] },
          },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: pageCap + 1,
        select: PLATFORM_COMMENT_SELECT,
      }),
      preloadedSessionRows
        ? { rows: [], truncated: false }
        : readSessionCommentRows(db, organizationId, sessionIds, pageCap),
      db.gitHubCommentProjection.findMany({
        where: {
          githubDeletedAt: null,
          comment: { deletedAt: null, thread: { organizationId } },
          threadProjection: {
            branchArtifactId: { in: [...branchIds] },
            deletedAt: null,
            pullRequestDetail: { organizationId },
          },
        },
        orderBy: [{ comment: { createdAt: "asc" } }, { commentId: "asc" }],
        take: pageCap + 1,
        select: {
          threadProjection: {
            select: {
              branchArtifactId: true,
              pullRequestDetailId: true,
              fetchResultReason: true,
            },
          },
          externalAuthor: {
            where: { organizationId },
            select: {
              providerUserId: true,
              providerLogin: true,
              displayName: true,
              avatarUrl: true,
              profileUrl: true,
              userId: true,
              providerDetail: true,
            },
          },
        },
      }),
      readPullRequestCommentProof(
        db,
        organizationId,
        branches
          .filter((branch) => branch.associatedPullRequestCount > 0)
          .map((branch) => branch.branchId)
      ),
    ]);
  const windows = await readBranchCommentWindows(db, {
    organizationId,
    branchIds,
    sessionIdsByBranch,
    limit: COMMENT_EVIDENCE_LIMIT,
    saturated: {
      branch: branchRows.length > pageCap,
      session: sessionEvidence.truncated,
      github: githubRows.length > pageCap,
    },
  });
  const branchCommentsByBranch =
    windows.branch ??
    groupByBranch(branchRows, (row) => [row.thread.artifactId]);
  if (completeBranchCommentsOut && branchRows.length <= pageCap) {
    fillCompleteBranchComments(
      completeBranchCommentsOut,
      branchIds,
      branchRows
    );
  }
  const sessionCommentsByBranch =
    preloadedSessionRows ??
    windows.session ??
    groupByBranch(
      sessionEvidence.rows,
      (row) => branchIdsBySession.get(row.thread.artifactId) ?? []
    );
  const githubByBranch =
    windows.github ??
    groupByBranch(githubRows, (row) => [row.threadProjection.branchArtifactId]);
  const evidenceByBranch = new Map<string, BranchCommentEvidence>();
  for (const branch of branches) {
    const branchId = branch.branchId;
    const branchComments = branchCommentsByBranch.get(branchId) ?? [];
    const sessionComments = sessionCommentsByBranch.get(branchId) ?? [];
    const githubComments = githubByBranch.get(branchId) ?? [];
    evidenceByBranch.set(branchId, {
      branchComments: branchComments.slice(0, COMMENT_EVIDENCE_LIMIT),
      sessionComments: sessionComments.slice(0, COMMENT_EVIDENCE_LIMIT),
      githubComments: githubComments.slice(0, COMMENT_EVIDENCE_LIMIT),
      branchCapped: branchComments.length > COMMENT_EVIDENCE_LIMIT,
      sessionCapped: sessionComments.length > COMMENT_EVIDENCE_LIMIT,
      githubCapped: githubComments.length > COMMENT_EVIDENCE_LIMIT,
      pullRequestAvailability: proofIncomplete.has(branchId)
        ? BranchIdentityAvailability.Incomplete
        : BranchIdentityAvailability.Complete,
    });
  }
  return evidenceByBranch;
}

/**
 * The page's session-linked platform comments, in one ordered list.
 *
 * The session-id list is the union across every branch on the page, so unlike
 * the branch-id list it is not bounded by the page size — a Prisma `IN (…)`
 * emits one bind parameter per id, and Postgres rejects a statement past 65,535
 * of them. Chunking it keeps a link-heavy org from turning `GET /branches` into
 * a 500, and matches how `getSessionUsageByBranch` and `getSessionBranchCounts`
 * already bound the same id list. Chunk count is `ceil(sessions / 1000)` — small
 * and page-bounded, not per-branch.
 *
 * Chunk results are concatenated, so the merged list is chunk-major rather than
 * globally ordered; {@link sortByCommentOrder} restores the query's
 * `createdAt, id` order before any branch's cap is applied.
 *
 * `pageCap + 1` is ONE budget for the whole page, spent across the chunks — not
 * a per-chunk allowance. Giving each chunk its own full `take` bounds a single
 * statement while leaving the accumulated set at `chunks × (pageCap + 1)`, so an
 * org with 30k linked sessions could hold ~3M rows before the sort and group.
 * Each chunk therefore takes only the remainder, and once the remainder is spent
 * the read stops issuing statements and reports `truncated` — the same thing it
 * reports for a chunk that filled its own `take`: rows matched that this read did
 * not return, so no branch may claim a complete corpus.
 */
async function readSessionCommentRows(
  db: PageCommentEvidenceClient,
  organizationId: string,
  sessionIds: readonly string[],
  pageCap: number
): Promise<{ rows: PagePlatformComment[]; truncated: boolean }> {
  const rows: PagePlatformComment[] = [];
  let truncated = false;
  for (
    let start = 0;
    start < sessionIds.length;
    start += SESSION_COMMENT_ID_CHUNK_SIZE
  ) {
    // Every `take` is the remainder, so `rows.length` can never pass the budget
    // and `remaining` can never go negative. The guard also keeps the `take`
    // below positive: a chunk either runs with `remaining >= 1` or not at all.
    const remaining = pageCap + 1 - rows.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const idChunk = sessionIds.slice(
      start,
      start + SESSION_COMMENT_ID_CHUNK_SIZE
    );
    const chunkRows = await db.comment.findMany({
      where: {
        deletedAt: null,
        thread: {
          organizationId,
          source: { in: [ThreadSource.Native, ThreadSource.Liveblocks] },
          artifactId: { in: idChunk },
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: remaining,
      select: PLATFORM_COMMENT_SELECT,
    });
    // A chunk that filled its `take` may have left matching rows behind. On the
    // first chunk `remaining` is `pageCap + 1`, so this is exactly the
    // `> pageCap` test the per-chunk budget used — unchanged for the single-chunk
    // read every page under 1,000 sessions performs.
    truncated = truncated || chunkRows.length >= remaining;
    for (const row of chunkRows) {
      rows.push(row);
    }
  }
  sortByCommentOrder(rows);
  return { rows, truncated };
}

/**
 * Restore the read's `createdAt, id` order over rows that may have arrived in
 * separate chunks, so each branch's cap keeps the SAME earliest rows the
 * per-branch `take` kept.
 */
function sortByCommentOrder(rows: PagePlatformComment[]): void {
  rows.sort((left, right) => {
    const byCreatedAt = left.createdAt.getTime() - right.createdAt.getTime();
    if (byCreatedAt !== 0) {
      return byCreatedAt;
    }
    return left.id.localeCompare(right.id);
  });
}

/**
 * Session id → the branches that link it. A session shared by N branches feeds
 * all N, exactly as N per-branch reads each returning that session's comments
 * did.
 */
function invertSessionIndex(
  sessionIdsByBranch: ReadonlyMap<string, ReadonlySet<string>>
): Map<string, string[]> {
  const branchIdsBySession = new Map<string, string[]>();
  for (const [branchId, sessionIds] of sessionIdsByBranch) {
    for (const sessionId of sessionIds) {
      const branches = branchIdsBySession.get(sessionId);
      if (branches) {
        branches.push(branchId);
      } else {
        branchIdsBySession.set(sessionId, [branchId]);
      }
    }
  }
  return branchIdsBySession;
}

/**
 * The page-wide row bound for one evidence source: every BRANCH on the page may
 * still contribute its own full `COMMENT_EVIDENCE_LIMIT`, which is all any
 * branch can consume. Floors the count at 1 so an empty page still asks for a
 * positive `take`.
 */
function pageEvidenceCap(branchCount: number): number {
  return COMMENT_EVIDENCE_LIMIT * Math.max(1, branchCount);
}

/**
 * Bucket page-wide rows by the branch(es) they belong to in ONE pass over the
 * ordered result. A filtered subsequence of an ordered list stays ordered, so
 * each bucket keeps the query's `createdAt, id` order — including a branch whose
 * session comments come from several interleaved session ids — and every
 * branch's cap therefore retains the SAME earliest rows the per-branch `take`
 * retained.
 */
export function groupByBranch<T>(
  rows: readonly T[],
  branchesOf: (row: T) => readonly string[]
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    for (const branchId of branchesOf(row)) {
      const bucket = grouped.get(branchId);
      if (bucket) {
        bucket.push(row);
      } else {
        grouped.set(branchId, [row]);
      }
    }
  }
  return grouped;
}

/**
 * The unsaturated page read holds every Branch comment uncut (the per-Branch
 * cap applies later, to the evidence slice), so these are complete sets.
 */
function fillCompleteBranchComments(
  out: Map<string, KnownThreadComment[]>,
  branchIds: readonly string[],
  rows: readonly {
    authorId: string;
    thread: { artifactId: string; id: string };
  }[]
): void {
  for (const branchId of branchIds) {
    out.set(branchId, []);
  }
  for (const row of rows) {
    out
      .get(row.thread.artifactId)
      ?.push({ threadId: row.thread.id, authorId: row.authorId });
  }
}
