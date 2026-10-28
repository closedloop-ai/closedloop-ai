import { ThreadStatus } from "@repo/api/src/types/comment";
import type { JsonObject } from "@repo/api/src/types/common";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { z } from "zod";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import { commentThreadMetadataObject } from "./liveblocks-thread-read";

export const GitHubReviewThreadResolutionAttributionKind = {
  ConnectedUser: "connected_user",
  ExternalUnconnected: "external_unconnected",
  LegacyMissing: "legacy_missing",
} as const;

export type GitHubReviewThreadResolutionAttributionKind =
  (typeof GitHubReviewThreadResolutionAttributionKind)[keyof typeof GitHubReviewThreadResolutionAttributionKind];

const GITHUB_REVIEW_THREAD_RESOLUTION_ATTRIBUTION_KEY =
  "githubReviewThreadResolutionAttribution";

export type GitHubReviewThreadResolutionAttribution = {
  kind: GitHubReviewThreadResolutionAttributionKind;
  githubUserId: string | null;
  githubNodeId: string | null;
  githubLogin: string | null;
  source: "pull_request_review_thread";
  recordedAt: string;
};

/**
 * ISS-5608 keys-covered guard. This schema is a plain `z.object` read back out
 * of the PERSISTED `comment_threads.metadata` JSON bag (see
 * {@link getResolutionAttribution}), and `z.ZodType<T>` is covariant in its
 * output, so the annotation alone lets the schema omit a key of the
 * independently-declared {@link GitHubReviewThreadResolutionAttribution}. Left
 * unguarded, a field added to the type but never taught here is silently
 * STRIPPED off every stored attribution record with nothing failing anywhere.
 */
const githubReviewThreadResolutionAttributionShape = {
  kind: z.union([
    z.literal(GitHubReviewThreadResolutionAttributionKind.ConnectedUser),
    z.literal(GitHubReviewThreadResolutionAttributionKind.ExternalUnconnected),
    z.literal(GitHubReviewThreadResolutionAttributionKind.LegacyMissing),
  ]),
  githubUserId: z.string().nullable(),
  githubNodeId: z.string().nullable(),
  githubLogin: z.string().nullable(),
  source: z.literal("pull_request_review_thread"),
  recordedAt: z.string(),
} satisfies Record<keyof GitHubReviewThreadResolutionAttribution, z.ZodTypeAny>;

const githubReviewThreadResolutionAttributionSchema: z.ZodType<GitHubReviewThreadResolutionAttribution> =
  z.object(githubReviewThreadResolutionAttributionShape);

export type GitHubReviewThreadResolutionInput = {
  resolvedAt: Date;
  resolvedById?: string | null;
  /**
   * GitHub review-thread resolution attribution. Present for GitHub webhook
   * callers; omitted by native (document/Liveblocks) resolves, which only carry
   * a `resolvedById`. The resolve path reads it optionally.
   */
  attribution?: GitHubReviewThreadResolutionAttribution;
};

type CommentThreadResolutionMutationKind =
  | "transition"
  | "metadata_repair"
  | "noop";

export type CommentThreadResolutionMutationResult =
  CommentThreadResolution | null;

/**
 * A caller's in-transaction record of a resolve or reopen (ISS-12552). It is
 * called with `null` when the thread has no local row, since the provider
 * write it projects has already happened.
 */
export type RecordThreadResolution =
  RecordWriteInTransaction<CommentThreadResolution | null>;

/** A resolution that found its thread; `kind` says whether anything changed. */
export type CommentThreadResolution = {
  kind: CommentThreadResolutionMutationKind;
  thread: {
    id: string;
    status: ThreadStatus;
    resolvedAt: Date | null;
    resolvedById: string | null;
    metadata: JsonObject | null;
  };
};

const RESOLUTION_THREAD_SELECT = {
  id: true,
  status: true,
  resolvedAt: true,
  resolvedById: true,
  metadata: true,
} as const;

/**
 * Mark a thread as resolved and return whether durable state changed.
 * GitHub review-thread webhooks pass attribution metadata; Liveblocks callers
 * keep the legacy behavior by omitting it.
 */
export function resolveThreadByExternalId(
  organizationId: string,
  threadExternalId: string,
  resolvedAt: Date,
  options?: Omit<GitHubReviewThreadResolutionInput, "resolvedAt">,
  recordWrite?: RecordThreadResolution
): Promise<CommentThreadResolutionMutationResult> {
  // Read-mutate-write in a single transaction, locking the row up front with
  // SELECT ... FOR UPDATE so concurrent resolve calls can't lost-update each
  // other's metadata mutation under READ COMMITTED.
  return withRecordedResolution(recordWrite, async (tx) => {
    await lockCommentThreadRow(tx, organizationId, threadExternalId);
    const existing = await tx.commentThread.findUnique({
      where: {
        organizationId_externalId: {
          organizationId,
          externalId: threadExternalId,
        },
      },
      select: RESOLUTION_THREAD_SELECT,
    });
    if (!existing) {
      return null;
    }

    const metadata = commentThreadMetadataObject(existing.metadata);
    const nextMetadata = options?.attribution
      ? {
          ...metadata,
          [GITHUB_REVIEW_THREAD_RESOLUTION_ATTRIBUTION_KEY]:
            options.attribution,
        }
      : metadata;
    const isResolved = existing.status === ThreadStatus.Resolved;
    const { shouldRepairMetadata, shouldRepairResolvedById } =
      computeResolveRepair({
        isResolved,
        existingResolvedById: existing.resolvedById,
        existingAttribution: getResolutionAttribution(metadata),
        options,
      });

    if (isResolved && !(shouldRepairMetadata || shouldRepairResolvedById)) {
      return {
        kind: "noop",
        thread: {
          ...existing,
          status: existing.status as ThreadStatus,
          metadata,
        },
      };
    }

    const thread = await tx.commentThread.update({
      where: { id: existing.id },
      data: {
        status: ThreadStatus.Resolved,
        resolvedAt: isResolved
          ? (existing.resolvedAt ?? resolvedAt)
          : resolvedAt,
        resolvedById: isResolved
          ? (existing.resolvedById ?? options?.resolvedById ?? null)
          : (options?.resolvedById ?? null),
        metadata: nextMetadata,
      },
      select: RESOLUTION_THREAD_SELECT,
    });
    return {
      kind:
        shouldRepairMetadata || shouldRepairResolvedById
          ? "metadata_repair"
          : "transition",
      thread: toResolutionThreadResult(thread),
    };
  });
}

/**
 * Mark a thread as unresolved, clearing resolution attribution without
 * disturbing unrelated thread metadata.
 */
export function unresolveThreadByExternalId(
  organizationId: string,
  threadExternalId: string,
  recordWrite?: RecordThreadResolution
): Promise<CommentThreadResolutionMutationResult> {
  // Read-mutate-write in a single transaction, locking the row up front with
  // SELECT ... FOR UPDATE so concurrent unresolve calls can't lost-update
  // each other's metadata mutation under READ COMMITTED.
  return withRecordedResolution(recordWrite, async (tx) => {
    await lockCommentThreadRow(tx, organizationId, threadExternalId);
    const existing = await tx.commentThread.findUnique({
      where: {
        organizationId_externalId: {
          organizationId,
          externalId: threadExternalId,
        },
      },
      select: RESOLUTION_THREAD_SELECT,
    });
    if (!existing) {
      return null;
    }

    const metadata = commentThreadMetadataObject(existing.metadata);
    const nextMetadata = clearResolutionAttribution(metadata);
    const hadStaleResolutionData =
      existing.resolvedAt !== null ||
      existing.resolvedById !== null ||
      getResolutionAttribution(metadata) !== null;
    const isTransition = existing.status === ThreadStatus.Resolved;

    if (!(isTransition || hadStaleResolutionData)) {
      return {
        kind: "noop",
        thread: {
          ...existing,
          status: existing.status as ThreadStatus,
          metadata,
        },
      };
    }

    const thread = await tx.commentThread.update({
      where: { id: existing.id },
      data: {
        status: ThreadStatus.Open,
        resolvedAt: null,
        resolvedById: null,
        metadata: nextMetadata,
      },
      select: RESOLUTION_THREAD_SELECT,
    });
    return {
      kind: isTransition ? "transition" : "metadata_repair",
      thread: toResolutionThreadResult(thread),
    };
  });
}

/**
 * Acquire a row-level lock on the `comment_threads` row for this
 * organization + externalId so a read-modify-write of `metadata` inside a
 * `withDb.tx` transaction can't lost-update a concurrent mutation. Under the
 * default READ COMMITTED isolation a plain read-then-`update` does NOT prevent
 * lost updates: two concurrent resolves can both read `metadata: {}` and the
 * second `update` silently overwrites the first's attribution. `SELECT ... FOR
 * UPDATE` serializes them — the second transaction blocks until the first
 * commits, then re-reads the now-committed metadata. The lock is released when
 * the surrounding transaction commits or rolls back. A no-op when the row does
 * not exist (the subsequent `findUnique` returns null and the caller bails).
 */
async function lockCommentThreadRow(
  tx: TransactionClient,
  organizationId: string,
  externalId: string
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT id
    FROM comment_threads
    WHERE organization_id = ${organizationId}::uuid
      AND external_id = ${externalId}
    FOR UPDATE
  `);
}

function getResolutionAttribution(
  metadata: JsonObject
): GitHubReviewThreadResolutionAttribution | null {
  const value = metadata[GITHUB_REVIEW_THREAD_RESOLUTION_ATTRIBUTION_KEY];
  const parsed = githubReviewThreadResolutionAttributionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function isRepairableResolutionAttribution(
  attribution: GitHubReviewThreadResolutionAttribution | null
): boolean {
  return (
    attribution === null ||
    attribution.kind ===
      GitHubReviewThreadResolutionAttributionKind.LegacyMissing
  );
}

/**
 * Decide whether an already-resolved thread's row should be rewritten to repair
 * stale attribution:
 * - `shouldRepairMetadata` — a GitHub caller supplies attribution and the row's
 *   existing attribution is repairable (missing/legacy).
 * - `shouldRepairResolvedById` — a caller supplies a resolver, the row's
 *   `resolvedById` is still null, and no authoritative attribution owns the row
 *   (so a webhook-first native resolve can backfill the resolver, but an
 *   ExternalUnconnected GitHub resolve — legitimately null-resolver — is not
 *   overwritten). FEA-3950.
 * Both are false when the thread is not yet resolved (that path is a normal
 * transition, handled by the caller).
 */
function computeResolveRepair(input: {
  isResolved: boolean;
  existingResolvedById: string | null;
  existingAttribution: GitHubReviewThreadResolutionAttribution | null;
  options?: Omit<GitHubReviewThreadResolutionInput, "resolvedAt">;
}): { shouldRepairMetadata: boolean; shouldRepairResolvedById: boolean } {
  if (!input.isResolved) {
    return { shouldRepairMetadata: false, shouldRepairResolvedById: false };
  }
  const attributionRepairable = isRepairableResolutionAttribution(
    input.existingAttribution
  );
  return {
    shouldRepairMetadata:
      input.options?.attribution !== undefined && attributionRepairable,
    shouldRepairResolvedById:
      input.existingResolvedById === null &&
      (input.options?.resolvedById ?? null) !== null &&
      attributionRepairable,
  };
}

export function clearResolutionAttribution(metadata: JsonObject): JsonObject {
  const nextMetadata = { ...metadata };
  Reflect.deleteProperty(
    nextMetadata,
    GITHUB_REVIEW_THREAD_RESOLUTION_ATTRIBUTION_KEY
  );
  return nextMetadata;
}

function toResolutionThreadResult(thread: {
  id: string;
  status: string;
  resolvedAt: Date | null;
  resolvedById: string | null;
  metadata: unknown;
}): NonNullable<CommentThreadResolutionMutationResult>["thread"] {
  return {
    id: thread.id,
    status: thread.status as ThreadStatus,
    resolvedAt: thread.resolvedAt,
    resolvedById: thread.resolvedById,
    metadata: commentThreadMetadataObject(thread.metadata),
  };
}

/**
 * One resolution transaction, with the caller's record of it written on the
 * same transaction (ISS-12552).
 */
function withRecordedResolution(
  recordWrite: RecordThreadResolution | undefined,
  resolve: (
    tx: TransactionClient
  ) => Promise<CommentThreadResolutionMutationResult>
): Promise<CommentThreadResolutionMutationResult> {
  return withDb.tx(async (tx) => {
    const resolution = await resolve(tx);
    await recordWrite?.(tx, resolution);
    return resolution;
  });
}
