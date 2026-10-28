import { randomUUID } from "node:crypto";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import type { CreateCommentThreadRequest } from "@repo/api/src/types/comment-thread-dto";
import { withDb } from "@repo/database";
import { commentTraceAnchor } from "@/__tests__/support/comments/comment-service.test-fixtures";
import {
  createEligibleBranch,
  createLegacySession,
} from "@/__tests__/support/trace-comments/legacy-route.test-fixtures";
import { commentsService } from "@/app/comments/service";

/**
 * ISS-12552: seeds for the comment routes' receipt suites. Pair with the
 * shared `operation-receipt-route` harness, whose world names the API-key
 * caller every seed here acts as.
 */
type ReceiptWorld = { organizationId: string; userId: string };

/** The anchor a Document's native thread takes. */
export const DOCUMENT_THREAD_ANCHOR = {
  kind: CommentAnchorKind.Artifact,
} as const;

/** A Session in the world's org, written without a receipt. */
export async function seedReceiptSession(world: ReceiptWorld): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const session = await withDb((db) =>
    createLegacySession(db, world.organizationId, world.userId, {
      name: `receipt-session-${suffix}`,
      externalSessionId: `receipt-session-${suffix}`,
    })
  );
  return session.artifactId;
}

/** A cloud-eligible Branch in the world's org, written without a receipt. */
export function seedReceiptBranch(world: ReceiptWorld): Promise<string> {
  return withDb((db) =>
    createEligibleBranch(
      db,
      world.organizationId,
      world.userId,
      randomUUID().slice(0, 8)
    )
  );
}

/** Latches the org onto unified document comments, as its first lookup would. */
export async function switchDocumentComments(
  organizationId: string
): Promise<void> {
  await withDb((db) =>
    db.organization.update({
      where: { id: organizationId },
      data: { documentCommentsSwitchedAt: new Date() },
      select: { id: true },
    })
  );
}

/** A native thread the world's caller opened on the artifact, with no receipt. */
export async function seedReceiptThread(
  world: ReceiptWorld,
  artifactId: string,
  anchor: CreateCommentThreadRequest["anchor"] = commentTraceAnchor(1)
): Promise<{ threadId: string; rootCommentId: string }> {
  const created = await commentsService.createArtifactCommentThread({
    viewer: { organizationId: world.organizationId, userId: world.userId },
    artifactId,
    request: { anchor, body: "seeded root", clientId: randomUUID() },
  });
  const rootCommentId = created.ok ? created.value.comments[0]?.id : undefined;
  if (!(created.ok && rootCommentId)) {
    throw new Error("Failed to seed the ISS-12552 comment thread");
  }
  return { threadId: created.value.id, rootCommentId };
}
