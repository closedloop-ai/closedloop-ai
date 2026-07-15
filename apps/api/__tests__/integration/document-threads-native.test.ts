/**
 * Integration tests for commentsService.createUnanchoredDocumentThread.
 *
 * Verifies the full real-database path introduced in FEA-2536: a NATIVE thread
 * is created atomically with its root comment, both rows carry the expected
 * shape, and subsequent reads via findThreadsByDocument surface the thread with
 * source NATIVE, no externalId/roomId (since it was never in Liveblocks), and
 * a ProseMirror body in the root comment.
 *
 * All DB writes are wrapped in autoRollbackTransaction so no data persists
 * after each test.
 */

import { ThreadSource, ThreadStatus } from "@repo/api/src/types/comment";
import { DocumentType } from "@repo/api/src/types/document";
import { keys } from "@repo/database/keys";
import { commentsService } from "@/app/comments/service";
import { documentService } from "@/app/documents/document-service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const hasDatabase = !!keys().DATABASE_URL;

describe.skipIf(!hasDatabase)(
  "commentsService.createUnanchoredDocumentThread — integration",
  () => {
    it("creates a NATIVE thread with root comment, no Liveblocks fields", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);
        const projectId = await createTestProject(orgId, user.id);

        const artifact = await documentService.create(orgId, user.id, {
          projectId,
          type: DocumentType.Prd,
          title: "Thread Test Document",
          content: "Content for native thread test",
        });

        const bodyText = "This is a native artifact-level note";

        const { threadId, commentId } =
          await commentsService.createUnanchoredDocumentThread(
            orgId,
            artifact!.id,
            user.id,
            bodyText
          );

        expect(threadId).toBeDefined();
        expect(commentId).toBeDefined();

        const threads = await commentsService.findThreadsByDocument(
          orgId,
          artifact!.id
        );

        expect(threads).toHaveLength(1);
        const thread = threads[0];

        // Thread metadata
        expect(thread?.source).toBe(ThreadSource.Native);
        expect(thread?.status).toBe(ThreadStatus.Open);
        expect(thread?.artifactId).toBe(artifact!.id);
        expect(thread?.id).toBe(threadId);

        // No Liveblocks fields on a native thread
        expect(thread?.externalId).toBeNull();
        expect(thread?.roomId).toBeNull();

        // Root comment is included
        expect(thread?.comments).toHaveLength(1);
        const rootComment = thread?.comments[0];

        expect(rootComment?.id).toBe(commentId);
        expect(rootComment?.authorId).toBe(user.id);
        expect(rootComment?.plainText).toBe(bodyText);

        // Body must be the ProseMirror textBody shape produced by textBody()
        expect(rootComment?.body).toEqual({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: bodyText }],
            },
          ],
        });
      });
    });

    it("returns { threadId, commentId } referencing the created rows", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);
        const projectId = await createTestProject(orgId, user.id);

        const artifact = await documentService.create(orgId, user.id, {
          projectId,
          type: DocumentType.Prd,
          title: "ID reference test document",
          content: "Content",
        });

        const result = await commentsService.createUnanchoredDocumentThread(
          orgId,
          artifact!.id,
          user.id,
          "Reference check note"
        );

        const threads = await commentsService.findThreadsByDocument(
          orgId,
          artifact!.id
        );

        // The returned threadId / commentId match the stored rows
        expect(threads[0]?.id).toBe(result.threadId);
        expect(threads[0]?.comments[0]?.id).toBe(result.commentId);
      });
    });

    it("does not appear in findThreadsByDocument for a different artifact", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);
        const projectId = await createTestProject(orgId, user.id);

        const artifactA = await documentService.create(orgId, user.id, {
          projectId,
          type: DocumentType.Prd,
          title: "Artifact A",
          content: "Content A",
        });

        const artifactB = await documentService.create(orgId, user.id, {
          projectId,
          type: DocumentType.Prd,
          title: "Artifact B",
          content: "Content B",
        });

        await commentsService.createUnanchoredDocumentThread(
          orgId,
          artifactA!.id,
          user.id,
          "Only on A"
        );

        const threadsOnB = await commentsService.findThreadsByDocument(
          orgId,
          artifactB!.id
        );

        // Thread scoped to artifact A must not appear under artifact B
        expect(threadsOnB).toHaveLength(0);
      });
    });

    it("rejects an artifactId that belongs to a different organization", async () => {
      await autoRollbackTransaction(async () => {
        const orgA = await createTestOrganization();
        const userA = await createTestUser(orgA);
        const projectA = await createTestProject(orgA, userA.id);

        const artifactInA = await documentService.create(orgA, userA.id, {
          projectId: projectA,
          type: DocumentType.Prd,
          title: "Org A document",
          content: "Content",
        });

        const orgB = await createTestOrganization();
        const userB = await createTestUser(orgB);

        // Caller from org B must not be able to attach a note to org A's artifact
        await expect(
          commentsService.createUnanchoredDocumentThread(
            orgB,
            artifactInA!.id,
            userB.id,
            "cross-org note"
          )
        ).rejects.toThrow("Artifact not found in this organization");

        const threadsOnA = await commentsService.findThreadsByDocument(
          orgA,
          artifactInA!.id
        );
        expect(threadsOnA).toHaveLength(0);
      });
    });
  }
);
