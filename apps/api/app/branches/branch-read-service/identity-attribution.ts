import {
  BranchCollaboratorSource,
  type BranchCollaborators,
  BranchIdentityAvailability,
  type BranchOwnerIdentity,
  type BranchPerson,
  type BranchPersonCandidate,
  BranchPersonProvider,
  projectBranchPeople,
} from "@repo/api/src/types/branch-identity";
import { ThreadSource } from "@repo/api/src/types/comment";
import { BRANCH_PUSH_METHODS } from "@repo/api/src/types/session-artifact-link";
import type { PrismaClient } from "@repo/database";
import { parseGitHubAuthorProviderDetailActorType } from "@/app/comments/github-author-provider-detail";
import { displayUserName } from "@/lib/user-display-name";
import { collectBranchOwnerIds, resolveOwnerNames } from "./owner-attribution";
import {
  getBranchLifetimeUsage,
  getSessionUsageByBranch,
  type SessionBranchIdentityEvidence,
  type SessionUsage,
  type SessionUsageClient,
  type SessionUsageDateWindow,
} from "./session-usage-window";

/**
 * The per-Branch comment-evidence cap. Exported so the ISS-6004 fan-out
 * regression test asserts the page-wide bound against this value rather than
 * re-declaring it (AGENTS.md: tests import contract constants).
 */
export const COMMENT_EVIDENCE_LIMIT = 1000;

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
const NATIVE_COMMENT_SELECT = {
  authorId: true,
  createdAt: true,
  id: true,
  thread: { select: { artifactId: true } },
} as const;

type BranchIdentityReadClient = Pick<
  PrismaClient,
  "comment" | "gitHubCommentProjection" | "gitHubUserConnection" | "user"
>;

export type BranchIdentityInput = {
  branchId: string;
  firstPushedAt: Date | null;
  associatedPullRequestCount: number;
};

export type BranchIdentityProjection = {
  ownerIdentity: BranchOwnerIdentity;
  collaborators: BranchCollaborators;
};

/**
 * Resolves Branch people from persisted, organization-scoped evidence only.
 * This projector performs no provider reads, refreshes, sync, or backfill.
 */
export async function resolveBranchIdentities(
  db: BranchIdentityReadClient,
  organizationId: string,
  branches: readonly BranchIdentityInput[],
  linkEvidence: readonly SessionBranchIdentityEvidence[]
): Promise<Map<string, BranchIdentityProjection>> {
  if (branches.length === 0) {
    return new Map();
  }
  const sessionIdsByBranch = new Map<string, Set<string>>();
  for (const link of linkEvidence) {
    const sessionIds =
      sessionIdsByBranch.get(link.targetId) ?? new Set<string>();
    sessionIds.add(link.sourceId);
    sessionIdsByBranch.set(link.targetId, sessionIds);
  }
  const evidenceByBranch = await readPageCommentEvidence(
    db,
    organizationId,
    branches.map((branch) => branch.branchId),
    sessionIdsByBranch
  );
  const userIds = new Set<string>();
  for (const link of linkEvidence) {
    if (link.userId && isPushMethod(link.branchParticipationMethod)) {
      userIds.add(link.userId);
    }
  }
  for (const evidence of evidenceByBranch.values()) {
    for (const comment of [
      ...evidence.branchComments,
      ...evidence.sessionComments,
    ]) {
      userIds.add(comment.authorId);
    }
  }
  const [users, connections] = await Promise.all([
    db.user.findMany({
      where: { organizationId, id: { in: [...userIds] } },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
      },
    }),
    db.gitHubUserConnection.findMany({
      where: { organizationId, userId: { in: [...userIds] } },
      select: {
        userId: true,
        githubUserId: true,
        login: true,
        avatarUrl: true,
        profileUrl: true,
      },
    }),
  ]);
  const usersById = new Map(users.map((user) => [user.id, user]));
  const connectionsByUserId = new Map(
    connections.map((connection) => [connection.userId, connection])
  );
  const projections = new Map<string, BranchIdentityProjection>();
  for (const branch of branches) {
    const evidence = evidenceByBranch.get(branch.branchId);
    const ownerIdentity = projectOwner(
      branch,
      linkEvidence,
      connectionsByUserId,
      usersById
    );
    const candidates = [
      ...nativeCandidates(evidence?.branchComments ?? [], usersById),
      ...nativeCandidates(evidence?.sessionComments ?? [], usersById),
      ...githubCandidates(evidence?.githubComments ?? []),
    ];
    projections.set(branch.branchId, {
      ownerIdentity,
      collaborators: projectBranchPeople(candidates, {
        [BranchCollaboratorSource.PullRequestComments]:
          pullRequestCommentAvailability(branch, evidence),
        [BranchCollaboratorSource.BranchComments]: evidence?.branchCapped
          ? BranchIdentityAvailability.Incomplete
          : BranchIdentityAvailability.Complete,
        [BranchCollaboratorSource.SessionComments]: evidence?.sessionCapped
          ? BranchIdentityAvailability.Incomplete
          : BranchIdentityAvailability.Complete,
      }),
    });
  }
  return projections;
}

function projectOwner(
  branch: BranchIdentityInput,
  links: readonly SessionBranchIdentityEvidence[],
  connectionsByUserId: ReadonlyMap<string, GitHubConnection>,
  usersById: ReadonlyMap<string, NativeUser>
): BranchOwnerIdentity {
  if (!branch.firstPushedAt) {
    return {
      availability: links.some(
        (link) =>
          link.targetId === branch.branchId &&
          isPushMethod(link.branchParticipationMethod)
      )
        ? BranchIdentityAvailability.Incomplete
        : BranchIdentityAvailability.Complete,
      person: null,
    };
  }
  const pushLinks = links.filter(
    (link) =>
      link.targetId === branch.branchId &&
      isPushMethod(link.branchParticipationMethod) &&
      link.branchParticipationObservedAt
  );
  const earliestLinks = authoritativeOwnerLinks(branch, pushLinks);
  const exactCandidates: BranchPerson[] = [];
  for (const link of earliestLinks) {
    const userId = link.userId;
    const connection = userId ? connectionsByUserId.get(userId) : undefined;
    const user = userId ? usersById.get(userId) : undefined;
    if (!(userId && connection)) {
      continue;
    }
    exactCandidates.push({
      provider: BranchPersonProvider.GitHub,
      id: connection.githubUserId,
      userId,
      login: connection.login,
      displayName: user ? displayUserName(user) : undefined,
      avatarUrl: connection.avatarUrl ?? undefined,
      profileUrl: connection.profileUrl ?? undefined,
    });
  }
  exactCandidates.sort((left, right) => left.id.localeCompare(right.id));
  const complete =
    exactCandidates.length > 0 &&
    exactCandidates.length === earliestLinks.length;
  return {
    availability: complete
      ? BranchIdentityAvailability.Complete
      : BranchIdentityAvailability.Incomplete,
    person: complete ? exactCandidates[0] : null,
  };
}

function authoritativeOwnerLinks(
  branch: BranchIdentityInput,
  pushLinks: readonly SessionBranchIdentityEvidence[]
): readonly SessionBranchIdentityEvidence[] {
  if (pushLinks.length <= 1) {
    return pushLinks;
  }
  return pushLinks.filter(
    (link) =>
      link.branchParticipationObservedAt?.getTime() ===
      branch.firstPushedAt?.getTime()
  );
}

function nativeCandidates(
  comments: readonly NativeComment[],
  usersById: ReadonlyMap<string, NativeUser>
): BranchPersonCandidate[] {
  return comments.map((comment) => {
    const user = usersById.get(comment.authorId);
    return user
      ? {
          person: {
            provider: BranchPersonProvider.ClosedLoop,
            id: user.id,
            userId: user.id,
            displayName: displayUserName(user),
            avatarUrl: user.avatarUrl ?? undefined,
          },
        }
      : {};
  });
}

function githubCandidates(
  comments: readonly GitHubComment[]
): BranchPersonCandidate[] {
  return comments.map((comment) => {
    const author = comment.externalAuthor;
    const actorType = parseGitHubAuthorProviderDetailActorType(
      author?.providerDetail
    );
    const candidate: BranchPersonCandidate = author
      ? {
          actorType,
          person: {
            provider: BranchPersonProvider.GitHub,
            id: author.providerUserId,
            userId: author.userId,
            login: author.providerLogin,
            displayName: author.displayName ?? undefined,
            avatarUrl: author.avatarUrl ?? undefined,
            profileUrl: author.profileUrl ?? undefined,
            ...(actorType ? { actorType } : {}),
          },
        }
      : {};
    return candidate;
  });
}

function isPushMethod(method: string | null): boolean {
  return method !== null && BRANCH_PUSH_METHODS.has(method);
}

function pullRequestCommentAvailability(
  branch: BranchIdentityInput,
  _evidence: BranchCommentEvidence | undefined
): BranchIdentityAvailability {
  if (branch.associatedPullRequestCount === 0) {
    return BranchIdentityAvailability.Complete;
  }
  // Persisted child rows prove known people, not that both independently
  // fetched GitHub comment lanes completed (including a successful empty
  // fetch). Until that existing acquisition boundary persists lane-level proof,
  // this downstream projection must not claim a complete collaborator corpus.
  return BranchIdentityAvailability.Incomplete;
}

type NativeComment = {
  authorId: string;
};
/** A native comment row as the page-wide read selects it (ISS-6004). */
type PageNativeComment = NativeComment & {
  createdAt: Date;
  id: string;
  thread: { artifactId: string | null };
};
type GitHubComment = {
  threadProjection: {
    branchArtifactId: string;
    pullRequestDetailId: string;
    fetchResultReason: string | null;
  };
  externalAuthor: {
    providerUserId: string;
    providerLogin: string;
    displayName: string | null;
    avatarUrl: string | null;
    profileUrl: string | null;
    userId: string;
    providerDetail: unknown;
  } | null;
};
type BranchCommentEvidence = {
  branchComments: NativeComment[];
  sessionComments: NativeComment[];
  githubComments: GitHubComment[];
  branchCapped: boolean;
  sessionCapped: boolean;
  githubCapped: boolean;
};
type NativeUser = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
};
type GitHubConnection = {
  userId: string;
  githubUserId: string;
  login: string;
  avatarUrl: string | null;
  profileUrl: string | null;
};

type BranchIdentityRow = {
  id: string;
  branch: { firstPushedAt: Date | null };
  pullRequestDetails: readonly unknown[];
};

type BranchIdentityClient = BranchIdentityReadClient & SessionUsageClient;

/** Reads list usage and canonical identities from one Session-link scan. */
export async function resolveBranchListIdentityData(
  db: BranchIdentityClient,
  organizationId: string,
  rows: readonly BranchIdentityRow[],
  dateWindow: SessionUsageDateWindow | undefined
): Promise<{
  windowed: Map<string, SessionUsage>;
  lifetime: Map<string, SessionUsage>;
  identityByBranch: Map<string, BranchIdentityProjection>;
}> {
  const evidence: SessionBranchIdentityEvidence[] = [];
  const usage = await getBranchLifetimeUsage(
    db,
    organizationId,
    rows.map((row) => row.id),
    dateWindow,
    evidence
  );
  const identityByBranch = await resolveBranchIdentities(
    db,
    organizationId,
    identityInputs(rows),
    evidence
  );
  return { ...usage, identityByBranch };
}

/** Reads detail usage and canonical identity from one Session-link scan. */
export async function resolveBranchDetailIdentityData(
  db: BranchIdentityClient,
  organizationId: string,
  row: BranchIdentityRow
): Promise<{
  usageByBranch: Map<string, SessionUsage>;
  identityByBranch: Map<string, BranchIdentityProjection>;
  nameById: Map<string, string>;
}> {
  const evidence: SessionBranchIdentityEvidence[] = [];
  const usageByBranch = await getSessionUsageByBranch(
    db,
    organizationId,
    [row.id],
    { includeReviewedParticipation: true, identityEvidenceOut: evidence }
  );
  const [identityByBranch, nameById] = await Promise.all([
    resolveBranchIdentities(
      db,
      organizationId,
      identityInputs([row]),
      evidence
    ),
    resolveOwnerNames(db, organizationId, collectBranchOwnerIds(usageByBranch)),
  ]);
  return { usageByBranch, identityByBranch, nameById };
}

function identityInputs(
  rows: readonly BranchIdentityRow[]
): BranchIdentityInput[] {
  return rows.map((row) => ({
    branchId: row.id,
    firstPushedAt: row.branch.firstPushedAt,
    associatedPullRequestCount: row.pullRequestDetails.length,
  }));
}

/**
 * Reads independently capped comment evidence for EVERY branch on the page in
 * THREE queries — not three per branch (ISS-6004).
 *
 * The previous shape read one branch at a time through `mapWithDbConcurrency`,
 * so a 100-branch page issued 300 of the request's ~306 statements and 300
 * pooled connection checkouts, each its own round trip — the dominant term in a
 * 1.5–2.0 s `GET /branches`. All three reads are keyed on artifact ids the page
 * already holds, so they batch: one statement per evidence source with an
 * `IN (...)` over the whole page, grouped back per branch in memory.
 *
 * Per-branch cap semantics are preserved, because the wire
 * `BranchIdentityAvailability` is derived from them. BOTH native sources are
 * bounded by `COMMENT_EVIDENCE_LIMIT × <branches on the page>` — no looser than
 * the aggregate the per-branch reads already permitted, and keyed on the branch
 * count rather than the session count because a branch can only ever CONSUME its
 * own 1,000 rows however many sessions it links. Every branch's own cap is then
 * applied to its own group.
 *
 * KNOWN LIMIT, deliberate: that page-wide `take` is one flat budget spent in
 * global `createdAt` order, so if it is ever exhausted the branches owning the
 * OLDEST comments consume it and a branch whose comments are all newer can group
 * to empty — where the old per-branch `take` guaranteed each branch its own
 * earliest 1,000. Such a page reports every branch's source `Incomplete`, so the
 * availability signal stays honest and no branch claims a corpus it did not
 * read, but its people list can be shorter than it was. Reaching this needs
 * >100,000 native comments across ONE page's branches. The shape that would give
 * both a single statement AND per-branch fairness is a windowed read
 * (`ROW_NUMBER() OVER (PARTITION BY thread.artifact_id ORDER BY created_at, id)
 * <= 1000`) in `$queryRaw`; take that upgrade if the truncation is ever observed.
 */
async function readPageCommentEvidence(
  db: BranchIdentityReadClient,
  organizationId: string,
  branchIds: readonly string[],
  sessionIdsByBranch: ReadonlyMap<string, ReadonlySet<string>>
): Promise<Map<string, BranchCommentEvidence>> {
  const branchIdsBySession = invertSessionIndex(sessionIdsByBranch);
  const sessionIds = [...branchIdsBySession.keys()];
  const pageCap = pageEvidenceCap(branchIds.length);
  const [branchRows, sessionEvidence, githubRows] = await Promise.all([
    db.comment.findMany({
      where: {
        deletedAt: null,
        thread: {
          organizationId,
          source: ThreadSource.Native,
          artifactId: { in: [...branchIds] },
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: pageCap + 1,
      select: NATIVE_COMMENT_SELECT,
    }),
    readSessionCommentRows(db, organizationId, sessionIds, pageCap),
    db.gitHubCommentProjection.findMany({
      where: {
        githubDeletedAt: null,
        comment: { deletedAt: null },
        threadProjection: {
          branchArtifactId: { in: [...branchIds] },
          deletedAt: null,
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
  ]);
  const branchPageTruncated = branchRows.length > pageCap;
  const githubPageTruncated = githubRows.length > pageCap;
  // `CommentThread.artifactId` is nullable, and an unattached thread belongs to
  // no Branch. The `artifactId: { in: … }` predicate already excludes those rows
  // (SQL `NULL IN (…)` is never true), so this is the type-level counterpart of
  // that filter, not a second policy.
  const branchCommentsByBranch = groupByBranch(branchRows, (row) =>
    row.thread.artifactId ? [row.thread.artifactId] : []
  );
  const sessionCommentsByBranch = groupByBranch(sessionEvidence.rows, (row) =>
    row.thread.artifactId
      ? (branchIdsBySession.get(row.thread.artifactId) ?? [])
      : []
  );
  const githubByBranch = groupByBranch(githubRows, (row) => [
    row.threadProjection.branchArtifactId,
  ]);
  const evidenceByBranch = new Map<string, BranchCommentEvidence>();
  for (const branchId of branchIds) {
    const branchComments = branchCommentsByBranch.get(branchId) ?? [];
    const sessionComments = sessionCommentsByBranch.get(branchId) ?? [];
    const githubComments = githubByBranch.get(branchId) ?? [];
    evidenceByBranch.set(branchId, {
      branchComments: branchComments.slice(0, COMMENT_EVIDENCE_LIMIT),
      sessionComments: sessionComments.slice(0, COMMENT_EVIDENCE_LIMIT),
      githubComments: githubComments.slice(0, COMMENT_EVIDENCE_LIMIT),
      branchCapped:
        branchPageTruncated || branchComments.length > COMMENT_EVIDENCE_LIMIT,
      sessionCapped:
        sessionEvidence.truncated ||
        sessionComments.length > COMMENT_EVIDENCE_LIMIT,
      githubCapped:
        githubPageTruncated || githubComments.length > COMMENT_EVIDENCE_LIMIT,
    });
  }
  return evidenceByBranch;
}

/**
 * The page's session-linked native comments, in one ordered list.
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
  db: BranchIdentityReadClient,
  organizationId: string,
  sessionIds: readonly string[],
  pageCap: number
): Promise<{ rows: PageNativeComment[]; truncated: boolean }> {
  const rows: PageNativeComment[] = [];
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
          source: ThreadSource.Native,
          artifactId: { in: idChunk },
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: remaining,
      select: NATIVE_COMMENT_SELECT,
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
function sortByCommentOrder(rows: PageNativeComment[]): void {
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
function groupByBranch<T>(
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
