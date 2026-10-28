import {
  CommentSurface,
  CommentTargetType,
  ThreadSource,
  type ThreadStatus,
} from "@repo/api/src/types/comment";
import {
  type CollectionCapabilities,
  CommentPolicyKey,
} from "@repo/api/src/types/comment-capabilities";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import type {
  ArtifactCommentsResponse,
  CommentThreadDto,
} from "@repo/api/src/types/comment-thread-dto";
import { Result } from "@repo/api/src/types/result";
import { type TransactionClient, withDb } from "@repo/database";
import { withBranchProductReadSnapshot } from "@/app/branches/branch-product-read-snapshot";
import { branchHasCloudEligibility } from "@/app/branches/cloud-branch-eligibility";
import { isUuid } from "@/lib/is-uuid";
import {
  decodeTimeIdCursor,
  encodeTimeIdCursor,
  type TimeIdCursor,
} from "@/lib/time-id-cursor";
import {
  type CommentLiveState,
  type CommentViewer,
  collectionCapabilities,
  createCommentLiveState,
} from "./comment-capabilities";
import type { CommentPresenter } from "./comment-command-lookup";
import { mapCommentThreadDto } from "./comment-dto-mapper";
import {
  CommentArtifactType,
  type CommentTarget,
  commentThreadSources,
  nativeCommentPolicyKey,
  resolveCommentTarget,
  resolveThreadCommentTarget,
} from "./comment-target";
import {
  type CommentThreadRow,
  findArtifactThreadRow,
  findArtifactThreadRows,
  loadCommentAuthors,
} from "./comment-thread-rows";
import {
  findArtifactGitHubThreadRow,
  findArtifactGitHubThreadRows,
  type GitHubThreadRow,
  mapGitHubThreadDtos,
} from "./github/github-thread-read";
import { resolveSessionTraceCommentTarget } from "./trace-comment-target-lookup";

export const COMMENT_LIST_DEFAULT_LIMIT = 50;
export const COMMENT_LIST_MAX_LIMIT = 100;

type ReadClient = Pick<
  TransactionClient,
  "commentThread" | "commentAttachment" | "user" | "$queryRaw"
>;

/** `null` for a cursor this read did not mint; the caller answers 400. */
export function decodeCommentListCursor(raw: string): TimeIdCursor | null {
  return decodeTimeIdCursor(raw, isUuid);
}

/**
 * Every thread on an artifact, with a Branch's GitHub threads on a list no
 * surface filters, oldest first, keyset-paged on `(createdAt, id)` with no cap
 * across pages. `limit` is clamped to
 * `[1, 100]`. An `artifactId` that is not an artifact in the org is resolved
 * as a session id the way the legacy session route resolves one (PLN-2121
 * decision 11), so MCP's accepted ids do not change. Listed on the session
 * surface, an artifact that is not a Session is resolved that way too, so it
 * answers what the legacy session route answered (ISS-11212 review).
 */
export async function listArtifactComments(input: {
  viewer: CommentViewer;
  artifactId: string;
  clerkUserId?: string | null;
  computeTargetId?: string | null;
  surface?: CommentSurface;
  status?: ThreadStatus;
  after?: TimeIdCursor;
  limit?: number;
  liveState?: CommentLiveState;
}): Promise<Result<ArtifactCommentsResponse, CommentErrorCode>> {
  const resolved = await resolveListedTarget(input);
  if (!resolved.ok) {
    return resolved;
  }
  const target = resolved.value;
  const liveState = input.liveState ?? createCommentLiveState(input.viewer);
  const capabilities = await collectionCapabilities(
    nativeCommentPolicyKey(target.artifactType),
    liveState
  );
  const githubCapabilities = listsGitHubThreads(target, input.surface)
    ? await collectionCapabilities(CommentPolicyKey.GithubBranch, liveState)
    : null;
  const limit = Math.min(
    Math.max(1, Math.trunc(input.limit ?? COMMENT_LIST_DEFAULT_LIMIT)),
    COMMENT_LIST_MAX_LIMIT
  );

  const page = await readServedTarget(target, async (db) => {
    const query = {
      organizationId: target.organizationId,
      artifactId: target.artifactId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.after ? { after: input.after } : {}),
      take: limit + 1,
    };
    const nativeRows = await findArtifactThreadRows(db, {
      ...query,
      sources: commentThreadSources(target.artifactType),
      ...(input.surface ? { surface: input.surface } : {}),
    });
    const githubRows = githubCapabilities
      ? await findArtifactGitHubThreadRows(db, query)
      : [];
    const rows = mergeThreadRows(nativeRows, githubRows);
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    const dtos = [
      ...(await mapThreadDtos(
        db,
        input.viewer,
        target,
        capabilities,
        pageRows.flatMap((entry) => (entry.native ? [entry.row] : []))
      )),
      ...(githubCapabilities
        ? await mapGitHubThreadDtos(
            db,
            input.viewer,
            githubCapabilities,
            pageRows.flatMap((entry) => (entry.native ? [] : [entry.row]))
          )
        : []),
    ];
    const byId = new Map(dtos.map((dto) => [dto.id, dto]));
    return {
      threads: pageRows.flatMap((entry) => byId.get(entry.row.id) ?? []),
      nextCursor:
        rows.length > limit && last
          ? encodeTimeIdCursor(last.row.createdAt.getTime(), last.row.id)
          : null,
    };
  });
  return page
    ? Result.ok({ artifactId: target.artifactId, capabilities, ...page })
    : Result.err(CommentErrorCode.NotFound);
}

export async function getThread(input: {
  viewer: CommentViewer;
  threadId: string;
  liveState?: CommentLiveState;
}): Promise<Result<CommentThreadDto, CommentErrorCode>> {
  const located = await resolveThreadCommentTarget({
    organizationId: input.viewer.organizationId,
    threadId: input.threadId,
  });
  if (!located.ok) {
    return located;
  }
  const { target, source } = located.value;
  if (source === ThreadSource.Github) {
    const thread = listsGitHubThreads(target, undefined)
      ? await readGitHubThread(input, target)
      : null;
    return thread ? Result.ok(thread) : Result.err(CommentErrorCode.NotFound);
  }
  const present = presentCommentThreadDto({
    viewer: input.viewer,
    target,
    liveState: input.liveState ?? createCommentLiveState(input.viewer),
  });
  const thread = await readServedTarget(target, (db) =>
    present(db, { threadId: input.threadId })
  );
  return thread ? Result.ok(thread) : Result.err(CommentErrorCode.NotFound);
}

/** A command's result as the unified thread DTO, read inside its transaction. */
export function presentCommentThreadDto(input: {
  viewer: CommentViewer;
  target: CommentTarget;
  liveState: CommentLiveState;
}): CommentPresenter<CommentThreadDto> {
  return async (db, written) => {
    const row =
      written.row ??
      (await findArtifactThreadRow(db, {
        organizationId: input.target.organizationId,
        artifactId: input.target.artifactId,
        threadId: written.threadId,
        sources: commentThreadSources(input.target.artifactType),
      }));
    if (!row) {
      return null;
    }
    const capabilities = await collectionCapabilities(
      nativeCommentPolicyKey(input.target.artifactType),
      input.liveState
    );
    const [thread] = await mapThreadDtos(
      db,
      input.viewer,
      input.target,
      capabilities,
      [row]
    );
    return thread ?? null;
  };
}

async function resolveListedTarget(input: {
  viewer: CommentViewer;
  artifactId: string;
  clerkUserId?: string | null;
  computeTargetId?: string | null;
  surface?: CommentSurface;
}): Promise<Result<CommentTarget, CommentErrorCode>> {
  const organizationId = input.viewer.organizationId;
  if (isUuid(input.artifactId)) {
    const resolved = await resolveCommentTarget({
      organizationId,
      artifactId: input.artifactId,
    });
    if (answersListing(resolved, input.surface)) {
      return resolved;
    }
  }
  const session = await resolveSessionTraceCommentTarget({
    organizationId,
    userId: input.viewer.userId,
    clerkUserId: input.clerkUserId ?? null,
    target: { type: CommentTargetType.Session, id: input.artifactId },
    computeTargetId: input.computeTargetId ?? null,
  });
  return session
    ? Result.ok({
        organizationId,
        artifactId: session.artifactId,
        artifactType: CommentArtifactType.Session,
      })
    : Result.err(CommentErrorCode.NotFound);
}

async function mapThreadDtos(
  db: Pick<TransactionClient, "user">,
  viewer: CommentViewer,
  target: CommentTarget,
  capabilities: CollectionCapabilities,
  rows: readonly CommentThreadRow[]
): Promise<CommentThreadDto[]> {
  const authors = await loadCommentAuthors(db, target.organizationId, rows);
  const context = {
    viewerUserId: viewer.userId,
    policyKey: nativeCommentPolicyKey(target.artifactType),
    capabilities,
    authors,
  };
  return rows.flatMap((row) => mapCommentThreadDto(row, context) ?? []);
}

/**
 * Runs a read against a target the product still serves. A Branch is read in
 * its product snapshot and must be cloud-eligible before and after the read,
 * as the trace-comment list has always checked it; `null` means not served.
 * A Session or a Document is served whenever it resolves in the org.
 */
export function readServedTarget<Value>(
  target: CommentTarget,
  read: (db: ReadClient) => Promise<Value>
): Promise<Value | null> {
  switch (target.artifactType) {
    case CommentArtifactType.Session:
    case CommentArtifactType.Document:
      return withDb((db) => read(db));
    case CommentArtifactType.Branch:
      return readServedBranch(target, read);
    default: {
      const exhaustive: never = target.artifactType;
      return exhaustive;
    }
  }
}

function readServedBranch<Value>(
  target: CommentTarget,
  read: (db: ReadClient) => Promise<Value>
): Promise<Value | null> {
  return withBranchProductReadSnapshot(target.organizationId, async (db) => {
    const eligible = () =>
      branchHasCloudEligibility(db, target.organizationId, target.artifactId);
    if (!(await eligible())) {
      return null;
    }
    const value = await read(db);
    return (await eligible()) ? value : null;
  });
}

/**
 * PLN-2122 Step 7: a Branch's GitHub threads are listed beside its native
 * ones. They are stored on no surface, so a surface-filtered list leaves them
 * out.
 */
function listsGitHubThreads(
  target: CommentTarget,
  surface: CommentSurface | undefined
): boolean {
  return target.artifactType === CommentArtifactType.Branch && !surface;
}

async function readGitHubThread(
  input: {
    viewer: CommentViewer;
    threadId: string;
    liveState?: CommentLiveState;
  },
  target: CommentTarget
): Promise<CommentThreadDto | null> {
  const capabilities = await collectionCapabilities(
    CommentPolicyKey.GithubBranch,
    input.liveState ?? createCommentLiveState(input.viewer)
  );
  const thread = await readServedTarget(target, async (db) => {
    const row = await findArtifactGitHubThreadRow(db, {
      organizationId: target.organizationId,
      artifactId: target.artifactId,
      threadId: input.threadId,
    });
    if (!row) {
      return null;
    }
    const [dto] = await mapGitHubThreadDtos(db, input.viewer, capabilities, [
      row,
    ]);
    return dto ?? null;
  });
  return thread ?? null;
}

type ListedThreadRow =
  | { native: true; row: CommentThreadRow }
  | { native: false; row: GitHubThreadRow };

/**
 * Both sources in the `(createdAt, id)` order each is read in. A thread id is
 * unique across sources, so the order is total, and a lowercase UUID string
 * compares as Postgres orders the `uuid` column.
 */
function mergeThreadRows(
  nativeRows: readonly CommentThreadRow[],
  githubRows: readonly GitHubThreadRow[]
): ListedThreadRow[] {
  const rows: ListedThreadRow[] = [
    ...nativeRows.map((row) => ({ native: true as const, row })),
    ...githubRows.map((row) => ({ native: false as const, row })),
  ];
  return rows.sort((a, b) => {
    const byTime = a.row.createdAt.getTime() - b.row.createdAt.getTime();
    if (byTime !== 0) {
      return byTime;
    }
    if (a.row.id === b.row.id) {
      return 0;
    }
    return a.row.id < b.row.id ? -1 : 1;
  });
}

/**
 * Whether the artifact-id probe answers the list, or the id is resolved again
 * as a session id. Only a Session carries the session surface, so there any
 * other artifact falls through to the session lookup.
 */
function answersListing(
  resolved: Result<CommentTarget, CommentErrorCode>,
  surface: CommentSurface | undefined
): boolean {
  if (surface === CommentSurface.SessionDetail) {
    return (
      resolved.ok && resolved.value.artifactType === CommentArtifactType.Session
    );
  }
  return resolved.ok || resolved.error !== CommentErrorCode.NotFound;
}
