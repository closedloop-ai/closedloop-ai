/**
 * customization-comments.ts — seeds the CommentThread tree.
 *
 * Split out of `customization.ts` (ISS-6317): threads, comments, reactions, and
 * attachments are a self-contained responsibility with their own scaling model
 * and RNG, sharing nothing with the CustomField seeding beyond the seed context.
 */

import { ThreadSource, ThreadStatus } from "../../generated/client";
import type { TransactionClient } from "../../generated/internal/prismaNamespace";
import { pickRequired } from "./allocations";
import type { CoreSeedResult } from "./core";
import {
  createSeedBatchTransactionRunner,
  createUpsertCounts,
  deterministicUuid,
  forEachSeedBatch,
  logUpsertSummary,
  seedLog,
  upsertRow,
} from "./helpers";
import type { SeedContext } from "./index";
import { SeedRngMode, type SeedRunPlan } from "./profiles";
import { createSeedRng, distributeLongTail } from "./rng";

/**
 * Builds a minimal ProseMirror document object containing a single paragraph
 * with the given text. Used for seeding comment body fields.
 */
function proseMirrorDoc(text: string): object {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function getScaledThreadState({
  source,
  organizationId,
  userId,
  baseDate,
  threadIndex,
}: {
  source: ThreadSource;
  organizationId: string;
  userId: string;
  baseDate: Date;
  threadIndex: number;
}): {
  status: ThreadStatus;
  resolvedById: string | null;
  resolvedAt: Date | null;
  roomId: string | null;
} {
  const isGithub = source === ThreadSource.GITHUB;
  const isLiveblocks = source === ThreadSource.LIVEBLOCKS;

  return {
    status: isGithub ? ThreadStatus.RESOLVED : ThreadStatus.OPEN,
    resolvedById: isGithub ? userId : null,
    resolvedAt: isGithub ? baseDate : null,
    roomId: isLiveblocks
      ? `seed-room-${organizationId.slice(0, 8)}-scaled-${threadIndex + 1}`
      : null,
  };
}

/**
 * Seeds CommentThread rows covering all three ThreadSource values (NATIVE,
 * LIVEBLOCKS, GITHUB) with associated Comment, CommentReaction, and
 * CommentAttachment children.
 *
 * Thread layout:
 * - NATIVE thread    → 2 comments, reaction on comment 1, attachment on comment 2
 * - LIVEBLOCKS thread → 2 comments, reaction on comment 1, attachment on comment 1
 * - GITHUB thread    → 1 comment, reaction on comment 1 (thread is RESOLVED)
 *
 * All operations are idempotent — re-running the seed updates in place.
 *
 * @param prisma - Initialized PrismaClient.
 * @param context - Resolved organization and user identifiers.
 * @param coreResult - Core seed result providing seeded artifact IDs.
 */
export async function seedComments(
  prisma: TransactionClient,
  context: SeedContext,
  coreResult: CoreSeedResult,
  plan: SeedRunPlan
): Promise<void> {
  const { organizationId, userId } = context;
  const counts = createUpsertCounts();

  seedLog(
    "Seeding CommentThread, Comment, CommentReaction, and CommentAttachment rows…"
  );

  // Use the first three artifact IDs as anchor entities for each thread source.
  const nativeArtifactId = pickRequired(
    coreResult.artifactIds,
    0,
    "seedComments.artifactIds"
  );
  const liveblocksArtifactId = pickRequired(
    coreResult.artifactIds,
    1,
    "seedComments.artifactIds"
  );
  const githubArtifactId = pickRequired(
    coreResult.artifactIds,
    2,
    "seedComments.artifactIds"
  );

  // -------------------------------------------------------------------------
  // NATIVE thread
  // -------------------------------------------------------------------------

  const nativeThreadId = deterministicUuid(
    `comment-thread:${organizationId}:native`
  );

  await upsertRow({
    model: "CommentThread",
    id: nativeThreadId,
    upsert: () =>
      prisma.commentThread.upsert({
        where: { id: nativeThreadId },
        create: {
          id: nativeThreadId,
          organizationId,
          source: ThreadSource.NATIVE,
          artifactId: nativeArtifactId,
          status: ThreadStatus.OPEN,
          createdById: userId,
        },
        update: {
          status: ThreadStatus.OPEN,
        },
        select: { id: true },
      }),
    counts,
  });

  const nativeComment1Id = deterministicUuid(`comment:${nativeThreadId}:1`);

  await upsertRow({
    model: "Comment",
    id: nativeComment1Id,
    upsert: () =>
      prisma.comment.upsert({
        where: { id: nativeComment1Id },
        create: {
          id: nativeComment1Id,
          threadId: nativeThreadId,
          authorId: userId,
          body: proseMirrorDoc("Initial feedback on this document."),
          plainText: "Initial feedback on this document.",
        },
        update: {
          plainText: "Initial feedback on this document.",
        },
        select: { id: true },
      }),
    counts,
  });

  const nativeComment2Id = deterministicUuid(`comment:${nativeThreadId}:2`);

  await upsertRow({
    model: "Comment",
    id: nativeComment2Id,
    upsert: () =>
      prisma.comment.upsert({
        where: { id: nativeComment2Id },
        create: {
          id: nativeComment2Id,
          threadId: nativeThreadId,
          authorId: userId,
          body: proseMirrorDoc("Follow-up: looks good after review."),
          plainText: "Follow-up: looks good after review.",
          parentCommentId: nativeComment1Id,
        },
        update: {
          plainText: "Follow-up: looks good after review.",
        },
        select: { id: true },
      }),
    counts,
  });

  // Reaction on comment 1 of the NATIVE thread.
  const nativeReactionId = deterministicUuid(
    `comment-reaction:${nativeComment1Id}:${userId}:thumbs-up`
  );

  await upsertRow({
    model: "CommentReaction",
    id: nativeReactionId,
    upsert: () =>
      prisma.commentReaction.upsert({
        where: {
          commentId_userId_emoji: {
            commentId: nativeComment1Id,
            userId,
            emoji: "👍",
          },
        },
        create: {
          id: nativeReactionId,
          commentId: nativeComment1Id,
          userId,
          emoji: "👍",
        },
        update: {},
        select: { id: true },
      }),
    counts,
  });

  // Attachment on comment 2 of the NATIVE thread.
  const nativeAttachmentId = deterministicUuid(
    `comment-attachment:${nativeComment2Id}:spec-pdf`
  );

  await upsertRow({
    model: "CommentAttachment",
    id: nativeAttachmentId,
    upsert: () =>
      prisma.commentAttachment.upsert({
        where: { id: nativeAttachmentId },
        create: {
          id: nativeAttachmentId,
          commentId: nativeComment2Id,
          name: "seed-spec.pdf",
          size: 204_800,
          mimeType: "application/pdf",
          url: "https://example.com/seed-spec.pdf",
        },
        update: {
          name: "seed-spec.pdf",
        },
        select: { id: true },
      }),
    counts,
  });

  // -------------------------------------------------------------------------
  // LIVEBLOCKS thread
  // -------------------------------------------------------------------------

  const liveblocksThreadId = deterministicUuid(
    `comment-thread:${organizationId}:liveblocks`
  );

  await upsertRow({
    model: "CommentThread",
    id: liveblocksThreadId,
    upsert: () =>
      prisma.commentThread.upsert({
        where: { id: liveblocksThreadId },
        create: {
          id: liveblocksThreadId,
          organizationId,
          source: ThreadSource.LIVEBLOCKS,
          artifactId: liveblocksArtifactId,
          roomId: `seed-room-${organizationId.slice(0, 8)}`,
          status: ThreadStatus.OPEN,
          createdById: userId,
        },
        update: {
          roomId: `seed-room-${organizationId.slice(0, 8)}`,
          status: ThreadStatus.OPEN,
        },
        select: { id: true },
      }),
    counts,
  });

  const liveblocksComment1Id = deterministicUuid(
    `comment:${liveblocksThreadId}:1`
  );

  await upsertRow({
    model: "Comment",
    id: liveblocksComment1Id,
    upsert: () =>
      prisma.comment.upsert({
        where: { id: liveblocksComment1Id },
        create: {
          id: liveblocksComment1Id,
          threadId: liveblocksThreadId,
          authorId: userId,
          body: proseMirrorDoc("Liveblocks collaborative comment."),
          plainText: "Liveblocks collaborative comment.",
        },
        update: {
          plainText: "Liveblocks collaborative comment.",
        },
        select: { id: true },
      }),
    counts,
  });

  const liveblocksComment2Id = deterministicUuid(
    `comment:${liveblocksThreadId}:2`
  );

  await upsertRow({
    model: "Comment",
    id: liveblocksComment2Id,
    upsert: () =>
      prisma.comment.upsert({
        where: { id: liveblocksComment2Id },
        create: {
          id: liveblocksComment2Id,
          threadId: liveblocksThreadId,
          authorId: userId,
          body: proseMirrorDoc("Resolved the concern mentioned above."),
          plainText: "Resolved the concern mentioned above.",
          parentCommentId: liveblocksComment1Id,
        },
        update: {
          plainText: "Resolved the concern mentioned above.",
        },
        select: { id: true },
      }),
    counts,
  });

  // Reaction on comment 1 of the LIVEBLOCKS thread.
  const liveblocksReactionId = deterministicUuid(
    `comment-reaction:${liveblocksComment1Id}:${userId}:rocket`
  );

  await upsertRow({
    model: "CommentReaction",
    id: liveblocksReactionId,
    upsert: () =>
      prisma.commentReaction.upsert({
        where: {
          commentId_userId_emoji: {
            commentId: liveblocksComment1Id,
            userId,
            emoji: "🚀",
          },
        },
        create: {
          id: liveblocksReactionId,
          commentId: liveblocksComment1Id,
          userId,
          emoji: "🚀",
        },
        update: {},
        select: { id: true },
      }),
    counts,
  });

  // Attachment on comment 1 of the LIVEBLOCKS thread.
  const liveblocksAttachmentId = deterministicUuid(
    `comment-attachment:${liveblocksComment1Id}:screenshot-png`
  );

  await upsertRow({
    model: "CommentAttachment",
    id: liveblocksAttachmentId,
    upsert: () =>
      prisma.commentAttachment.upsert({
        where: { id: liveblocksAttachmentId },
        create: {
          id: liveblocksAttachmentId,
          commentId: liveblocksComment1Id,
          name: "seed-screenshot.png",
          size: 51_200,
          mimeType: "image/png",
          url: "https://example.com/seed-screenshot.png",
        },
        update: {
          name: "seed-screenshot.png",
        },
        select: { id: true },
      }),
    counts,
  });

  // -------------------------------------------------------------------------
  // GITHUB thread
  // -------------------------------------------------------------------------

  const githubThreadId = deterministicUuid(
    `comment-thread:${organizationId}:github`
  );

  await upsertRow({
    model: "CommentThread",
    id: githubThreadId,
    upsert: () =>
      prisma.commentThread.upsert({
        where: { id: githubThreadId },
        create: {
          id: githubThreadId,
          organizationId,
          source: ThreadSource.GITHUB,
          artifactId: githubArtifactId,
          status: ThreadStatus.RESOLVED,
          resolvedById: userId,
          resolvedAt: plan.clock.baseDate,
          createdById: userId,
        },
        update: {
          status: ThreadStatus.RESOLVED,
        },
        select: { id: true },
      }),
    counts,
  });

  const githubComment1Id = deterministicUuid(`comment:${githubThreadId}:1`);

  await upsertRow({
    model: "Comment",
    id: githubComment1Id,
    upsert: () =>
      prisma.comment.upsert({
        where: { id: githubComment1Id },
        create: {
          id: githubComment1Id,
          threadId: githubThreadId,
          authorId: userId,
          body: proseMirrorDoc(
            "GitHub PR review comment — please address the naming convention."
          ),
          plainText:
            "GitHub PR review comment — please address the naming convention.",
        },
        update: {
          plainText:
            "GitHub PR review comment — please address the naming convention.",
        },
        select: { id: true },
      }),
    counts,
  });

  // Reaction on comment 1 of the GITHUB thread.
  const githubReactionId = deterministicUuid(
    `comment-reaction:${githubComment1Id}:${userId}:eyes`
  );

  await upsertRow({
    model: "CommentReaction",
    id: githubReactionId,
    upsert: () =>
      prisma.commentReaction.upsert({
        where: {
          commentId_userId_emoji: {
            commentId: githubComment1Id,
            userId,
            emoji: "👀",
          },
        },
        create: {
          id: githubReactionId,
          commentId: githubComment1Id,
          userId,
          emoji: "👀",
        },
        update: {},
        select: { id: true },
      }),
    counts,
  });

  const existingCommentCount = 5;
  const remainingCommentCount = Math.max(
    0,
    plan.targets.comments - existingCommentCount
  );
  const sourceCycle = [
    ThreadSource.NATIVE,
    ThreadSource.LIVEBLOCKS,
    ThreadSource.GITHUB,
  ] as const;
  const commentThreadSizes =
    plan.rngMode === SeedRngMode.Perf && remainingCommentCount > 0
      ? distributeLongTail(
          remainingCommentCount,
          Math.min(
            coreResult.artifactIds.length,
            Math.max(1, Math.ceil(Math.sqrt(remainingCommentCount)))
          )
        )
      : Array.from({ length: remainingCommentCount }, () => 1);
  const commentRng =
    plan.rngMode === SeedRngMode.Perf
      ? createSeedRng(`${plan.rngSeed}:comments`)
      : null;
  let commentIndex = existingCommentCount + 1;

  await forEachSeedBatch({
    items: commentThreadSizes,
    batchSize: plan.transaction.batchSize,
    label: "comment threads",
    runBatch: createSeedBatchTransactionRunner(prisma, plan.transaction),
    run: async (commentsInThread, threadIndex, batchClient) => {
      if (commentsInThread === 0) {
        return;
      }
      const batchPrisma = batchClient ?? prisma;
      const source = commentRng
        ? commentRng.pick(sourceCycle)
        : sourceCycle[commentIndex % sourceCycle.length];
      const threadId = deterministicUuid(
        `comment-thread:${organizationId}:scaled-${threadIndex + 1}`
      );
      const threadState = getScaledThreadState({
        source,
        organizationId,
        userId,
        baseDate: plan.clock.baseDate,
        threadIndex,
      });

      await upsertRow({
        model: "CommentThread",
        id: threadId,
        upsert: () =>
          batchPrisma.commentThread.upsert({
            where: { id: threadId },
            create: {
              id: threadId,
              organizationId,
              source,
              artifactId: pickRequired(
                coreResult.artifactIds,
                commentRng
                  ? commentRng.integer(0, coreResult.artifactIds.length - 1)
                  : commentIndex,
                "seedComments.scaled.artifactIds"
              ),
              status: threadState.status,
              resolvedById: threadState.resolvedById,
              resolvedAt: threadState.resolvedAt,
              roomId: threadState.roomId,
              createdById: userId,
            },
            update: {
              status: threadState.status,
              roomId: threadState.roomId,
            },
            select: { id: true },
          }),
        counts,
      });

      for (
        let threadCommentIndex = 1;
        threadCommentIndex <= commentsInThread;
        threadCommentIndex++
      ) {
        const commentId = deterministicUuid(
          `comment:${threadId}:${threadCommentIndex}`
        );
        const parentCommentId =
          threadCommentIndex === 1
            ? null
            : deterministicUuid(
                `comment:${threadId}:${threadCommentIndex - 1}`
              );
        await upsertRow({
          model: "Comment",
          id: commentId,
          upsert: () =>
            batchPrisma.comment.upsert({
              where: { id: commentId },
              create: {
                id: commentId,
                threadId,
                authorId: userId,
                body: proseMirrorDoc(`Scaled seed comment ${commentIndex}.`),
                plainText: `Scaled seed comment ${commentIndex}.`,
                parentCommentId,
              },
              update: {
                plainText: `Scaled seed comment ${commentIndex}.`,
              },
              select: { id: true },
            }),
          counts,
        });
        commentIndex++;
      }
    },
  });

  logUpsertSummary(counts);
}
