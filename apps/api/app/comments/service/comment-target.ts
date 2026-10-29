import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  CommentSurface,
  CommentTargetType,
  ThreadSource,
} from "@repo/api/src/types/comment";
import { CommentPolicyKey } from "@repo/api/src/types/comment-capabilities";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import { Result } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";

/** The artifact types that carry unified comments. */
export const CommentArtifactType = {
  Session: ArtifactType.Session,
  Branch: ArtifactType.Branch,
  Document: ArtifactType.Document,
} as const;
export type CommentArtifactType =
  (typeof CommentArtifactType)[keyof typeof CommentArtifactType];

/**
 * An org-scoped artifact a comment command or read runs against. `surface`
 * narrows every lookup to threads stored on that surface; the legacy
 * trace-comment routes always set it, the unified routes leave it unset.
 */
export type CommentTarget = {
  organizationId: string;
  artifactId: string;
  artifactType: CommentArtifactType;
  surface?: CommentSurface;
};

export function commentPolicyKeyFor(
  artifactType: CommentArtifactType,
  source: ThreadSource
): CommentPolicyKey | null {
  const keys: Partial<Record<ThreadSource, CommentPolicyKey>> =
    COMMENT_ARTIFACT_TYPES[artifactType].policyKeys;
  return keys[source] ?? null;
}

export function nativeCommentPolicyKey(
  artifactType: CommentArtifactType
): CommentPolicyKey {
  return COMMENT_ARTIFACT_TYPES[artifactType].policyKeys[ThreadSource.Native];
}

export function commentTargetTypeFor(
  artifactType: CommentArtifactType
): CommentTargetType {
  return COMMENT_ARTIFACT_TYPES[artifactType].targetType;
}

export function commentArtifactTypeFor(
  targetType: CommentTargetType
): CommentArtifactType {
  const artifactType = ARTIFACT_TYPE_BY_TARGET_TYPE.get(targetType);
  if (!artifactType) {
    throw new Error(`No comment artifact type carries target ${targetType}`);
  }
  return artifactType;
}

/** The thread sources the unified reads and commands serve on this type. */
export function commentThreadSources(
  artifactType: CommentArtifactType
): readonly ThreadSource[] {
  return COMMENT_ARTIFACT_TYPES[artifactType].threadSources;
}

/** The surface a create lands on when the caller names none. */
export function defaultCommentSurface(
  artifactType: CommentArtifactType
): CommentSurface {
  return COMMENT_ARTIFACT_TYPES[artifactType].surfaces[0];
}

/** Whether a create may land on `surface` for this artifact type. */
export function isSurfaceOnArtifactType(
  surface: CommentSurface,
  artifactType: CommentArtifactType
): boolean {
  const surfaces: readonly CommentSurface[] =
    COMMENT_ARTIFACT_TYPES[artifactType].surfaces;
  return surfaces.includes(surface);
}

/**
 * Resolves and org-scopes an artifact id. Runs outside the command
 * transaction, as the trace-comment service's resolution always has.
 */
export async function resolveCommentTarget(input: {
  organizationId: string;
  artifactId: string;
}): Promise<Result<CommentTarget, CommentErrorCode>> {
  const artifact = await withDb((db) =>
    db.artifact.findFirst({
      where: { id: input.artifactId, organizationId: input.organizationId },
      select: { id: true, type: true },
    })
  );
  if (!artifact) {
    return Result.err(CommentErrorCode.NotFound);
  }
  const artifactType = toCommentArtifactType(artifact.type);
  if (!artifactType) {
    return Result.err(CommentErrorCode.ArtifactTypeNotSupported);
  }
  return Result.ok({
    organizationId: input.organizationId,
    artifactId: artifact.id,
    artifactType,
  });
}

export type SourcedCommentTarget = {
  target: CommentTarget;
  source: ThreadSource;
};

export async function resolveThreadCommentTarget(input: {
  organizationId: string;
  threadId: string;
}): Promise<Result<SourcedCommentTarget, CommentErrorCode>> {
  const thread = await withDb((db) =>
    db.commentThread.findFirst({
      where: { id: input.threadId, organizationId: input.organizationId },
      select: { artifactId: true, source: true },
    })
  );
  return withSource(input.organizationId, thread);
}

/** The artifact a live comment's thread is on, for routes addressed by comment id. */
export async function resolveCommentIdTarget(input: {
  organizationId: string;
  commentId: string;
}): Promise<Result<SourcedCommentTarget, CommentErrorCode>> {
  const comment = await withDb((db) =>
    db.comment.findFirst({
      where: {
        id: input.commentId,
        deletedAt: null,
        thread: { organizationId: input.organizationId },
      },
      select: { thread: { select: { artifactId: true, source: true } } },
    })
  );
  return withSource(input.organizationId, comment?.thread ?? null);
}

async function withSource(
  organizationId: string,
  thread: { artifactId: string; source: ThreadSource } | null
): Promise<Result<SourcedCommentTarget, CommentErrorCode>> {
  if (!thread) {
    return Result.err(CommentErrorCode.NotFound);
  }
  const target = await resolveCommentTarget({
    organizationId,
    artifactId: thread.artifactId,
  });
  return target.ok
    ? Result.ok({ target: target.value, source: thread.source })
    : target;
}

/**
 * Every comment artifact type resolves, Documents included (PLN-2187 T-2.6):
 * reads are ungated, and the unified write requests gate a Document target on
 * the org's switch (`resolveAndLatchDocumentCommentsSwitch`).
 */
function toCommentArtifactType(type: string): CommentArtifactType | null {
  return COMMENT_ARTIFACT_TYPE_VALUES.get(type) ?? null;
}

type CommentArtifactTypeEntry = {
  targetType: CommentTargetType;
  /** The first surface is where a create lands when the caller names none. */
  surfaces: readonly [CommentSurface, ...CommentSurface[]];
  threadSources: readonly [ThreadSource, ...ThreadSource[]];
  policyKeys: { [ThreadSource.Native]: CommentPolicyKey } & Partial<
    Record<ThreadSource, CommentPolicyKey>
  >;
};

/**
 * One row per artifact type. `branch_timeline` is a Branch surface: the
 * branch Sessions tab stores a trace selection on the Branch whenever the
 * selected session is not loaded (ISS-4473).
 */
const COMMENT_ARTIFACT_TYPES = {
  [CommentArtifactType.Session]: {
    targetType: CommentTargetType.Session,
    surfaces: [CommentSurface.SessionDetail],
    threadSources: [ThreadSource.Native],
    policyKeys: { [ThreadSource.Native]: CommentPolicyKey.NativeSession },
  },
  [CommentArtifactType.Branch]: {
    targetType: CommentTargetType.Branch,
    surfaces: [CommentSurface.BranchDetail, CommentSurface.BranchTimeline],
    // GitHub threads have their own read and commands (PLN-2122).
    threadSources: [ThreadSource.Native],
    policyKeys: {
      [ThreadSource.Native]: CommentPolicyKey.NativeBranch,
      [ThreadSource.Github]: CommentPolicyKey.GithubBranch,
    },
  },
  // PLN-2187: threads the Liveblocks webhook sync already wrote keep their
  // source and stay on the same policy as new ones, readable, repliable and
  // reactable after the org switches; nothing is imported (operator ruling,
  // #8828, 2026-10-15).
  [CommentArtifactType.Document]: {
    targetType: CommentTargetType.Document,
    surfaces: [CommentSurface.DocumentDetail],
    threadSources: [ThreadSource.Native, ThreadSource.Liveblocks],
    policyKeys: {
      [ThreadSource.Native]: CommentPolicyKey.NativeDocument,
      [ThreadSource.Liveblocks]: CommentPolicyKey.NativeDocument,
    },
  },
} as const satisfies Record<CommentArtifactType, CommentArtifactTypeEntry>;

const COMMENT_ARTIFACT_TYPE_VALUES: ReadonlyMap<string, CommentArtifactType> =
  new Map(
    Object.values(CommentArtifactType).map((artifactType) => [
      artifactType,
      artifactType,
    ])
  );

const ARTIFACT_TYPE_BY_TARGET_TYPE: ReadonlyMap<
  CommentTargetType,
  CommentArtifactType
> = new Map(
  Object.values(CommentArtifactType).map((artifactType) => [
    COMMENT_ARTIFACT_TYPES[artifactType].targetType,
    artifactType,
  ])
);
