import {
  AttachmentPurpose,
  InlineImageResolveSkipReason,
} from "@repo/api/src/types/attachment";
import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELETE,
  GET as GetDownloadUrl,
} from "@/app/documents/[id]/attachments/[attachmentId]/route";
import { POST as ResolveInlineImages } from "@/app/documents/[id]/attachments/resolve/route";
import { GET as GetAttachments } from "@/app/documents/[id]/attachments/route";
import { attachmentsService } from "@/app/documents/attachments-service";
import { generateSlug } from "@/app/documents/document-utils";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
} from "../utils/auth-helpers";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const mockDeleteArtifact = vi.hoisted(() => vi.fn());
const mockGetSignedDownloadUrl = vi.hoisted(() => vi.fn());
const mockGetSignedDownloadUrlWithDisposition = vi.hoisted(() => vi.fn());
const mockLogError = vi.hoisted(() => vi.fn());

let mockAuthContext: AuthContext | undefined;

vi.mock("@repo/aws", () => ({
  deleteArtifact: mockDeleteArtifact,
  getSignedDownloadUrl: mockGetSignedDownloadUrl,
  getSignedDownloadUrlWithDisposition: mockGetSignedDownloadUrlWithDisposition,
  getSignedUploadUrl: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: mockLogError,
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (
      handler: (
        authContext: AuthContext,
        request: Request,
        params: Promise<{ attachmentId: string; id: string }>
      ) => Promise<Response>
    ) =>
    (
      request: Request,
      context: { params: Promise<{ attachmentId: string; id: string }> }
    ) => {
      if (!mockAuthContext) {
        throw new Error(
          "mockAuthContext must be set before invoking the route"
        );
      }
      return handler(mockAuthContext, request, context.params);
    },
}));

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

function createDocumentArtifact({
  organizationId,
  projectId,
  userId,
}: {
  organizationId: string;
  projectId: string;
  userId: string;
}) {
  return withDb((db) =>
    db.artifact.create({
      data: {
        createdById: userId,
        name: "Attachment delete target",
        organizationId,
        projectId,
        slug: generateSlug(),
        status: DocumentStatus.Draft,
        subtype: ArtifactSubtype.PRD,
        type: ArtifactType.DOCUMENT,
      },
      select: { id: true },
    })
  );
}

function createAttachment({
  createdById,
  documentId,
  filename,
  key,
  mimeType = "text/markdown",
  purpose = AttachmentPurpose.Context,
}: {
  createdById: string;
  documentId: string;
  filename: string;
  key: string;
  mimeType?: string;
  purpose?: AttachmentPurpose;
}) {
  return withDb((db) =>
    db.fileAttachment.create({
      data: {
        artifactId: documentId,
        bucket: "test-attachment-bucket",
        createdById,
        filename,
        key,
        mimeType,
        purpose,
        sizeBytes: 128,
      },
      select: { id: true },
    })
  );
}

async function listAttachmentIds(documentId: string): Promise<string[]> {
  const response = await GetAttachments(
    createMockRequest({
      method: "GET",
      url: `http://localhost:3002/documents/${documentId}/attachments?purpose=all`,
    }),
    createMockRouteContext({ id: documentId })
  );
  if (response.status !== 200) {
    throw new Error(
      `Expected list attachments to return 200, got ${response.status}`
    );
  }
  const json = await response.json();
  return json.data.map((attachment: { id: string }) => attachment.id);
}

async function getDownloadStatus(
  documentId: string,
  attachmentId: string
): Promise<number> {
  const response = await GetDownloadUrl(
    createMockRequest({
      method: "GET",
      url: `http://localhost:3002/documents/${documentId}/attachments/${attachmentId}`,
    }),
    createMockRouteContext({ attachmentId, id: documentId })
  );

  return response.status;
}

async function getInlineSkipped(
  documentId: string,
  attachmentId: string
): Promise<
  Array<{ attachmentId: string; reason: InlineImageResolveSkipReason }>
> {
  const response = await ResolveInlineImages(
    createMockRequest({
      body: { attachmentIds: [attachmentId] },
      method: "POST",
      url: `http://localhost:3002/documents/${documentId}/attachments/resolve`,
    }),
    createMockRouteContext({ id: documentId })
  );

  const json = await response.json();
  return json.data.skipped;
}

async function listContextPackAttachmentIds(
  documentId: string,
  organizationId: string
): Promise<string[]> {
  const attachments = await attachmentsService.listWithSignedUrlsByDocument(
    documentId,
    organizationId
  );

  return attachments.map((item) => item.id);
}

describe.skipIf(!hasDatabase)(
  "DELETE /documents/:id/attachments/:attachmentId integration",
  () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockDeleteArtifact.mockResolvedValue(undefined);
      mockGetSignedDownloadUrl.mockResolvedValue(
        "https://s3.example.com/context-pack-download"
      );
      mockGetSignedDownloadUrlWithDisposition.mockResolvedValue(
        "https://s3.example.com/direct-download"
      );
    });

    afterEach(() => {
      mockAuthContext = undefined;
    });

    it("enforces creator-owned deletes for API-key automation and all readers reflect the persisted state", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const creator = await createTestUser(organizationId);
        const otherUser = await createTestUser(organizationId);
        const projectId = await createTestProject(organizationId, creator.id);
        const document = await createDocumentArtifact({
          organizationId,
          projectId,
          userId: creator.id,
        });
        const deletedAttachment = await createAttachment({
          createdById: creator.id,
          documentId: document.id,
          filename: "delete-me.md",
          key: "attachments/delete-me",
        });
        const survivingAttachment = await createAttachment({
          createdById: creator.id,
          documentId: document.id,
          filename: "keep-me.md",
          key: "attachments/keep-me",
        });
        const otherUserAttachment = await createAttachment({
          createdById: otherUser.id,
          documentId: document.id,
          filename: "other-user.md",
          key: "attachments/other-user",
        });

        mockAuthContext = {
          apiKeyScopes: ["delete"],
          authMethod: "api_key",
          clerkOrgId: "org_test",
          clerkUserId: creator.clerkId,
          user: creator,
        };

        const deniedResponse = await DELETE(
          createMockRequest({
            method: "DELETE",
            url: `http://localhost:3002/documents/${document.id}/attachments/${otherUserAttachment.id}`,
          }),
          createMockRouteContext({
            attachmentId: otherUserAttachment.id,
            id: document.id,
          })
        );

        expect(deniedResponse.status).toBe(404);
        expect(mockDeleteArtifact).not.toHaveBeenCalled();
        expect(await listAttachmentIds(document.id)).toContain(
          otherUserAttachment.id
        );
        await expect(
          getDownloadStatus(document.id, otherUserAttachment.id)
        ).resolves.toBe(200);
        await expect(
          getInlineSkipped(document.id, otherUserAttachment.id)
        ).resolves.toEqual([
          {
            attachmentId: otherUserAttachment.id,
            reason: InlineImageResolveSkipReason.NotInline,
          },
        ]);
        await expect(
          listContextPackAttachmentIds(document.id, organizationId)
        ).resolves.toContain(otherUserAttachment.id);

        const deleteResponse = await DELETE(
          createMockRequest({
            method: "DELETE",
            url: `http://localhost:3002/documents/${document.id}/attachments/${deletedAttachment.id}`,
          }),
          createMockRouteContext({
            attachmentId: deletedAttachment.id,
            id: document.id,
          })
        );

        expect(deleteResponse.status).toBe(200);
        expect(mockDeleteArtifact).toHaveBeenCalledWith(
          "attachments/delete-me",
          "test-attachment-bucket"
        );

        const dbDeletedRow = await withDb((db) =>
          db.fileAttachment.findUnique({
            where: { id: deletedAttachment.id },
          })
        );
        expect(dbDeletedRow).toBeNull();

        const visibleIds = await listAttachmentIds(document.id);
        expect(visibleIds).not.toContain(deletedAttachment.id);
        expect(visibleIds).toContain(survivingAttachment.id);
        expect(visibleIds).toContain(otherUserAttachment.id);

        await expect(
          getDownloadStatus(document.id, deletedAttachment.id)
        ).resolves.toBe(404);
        await expect(
          getDownloadStatus(document.id, survivingAttachment.id)
        ).resolves.toBe(200);
        await expect(
          getInlineSkipped(document.id, deletedAttachment.id)
        ).resolves.toEqual([
          {
            attachmentId: deletedAttachment.id,
            reason: InlineImageResolveSkipReason.NotFound,
          },
        ]);

        const contextPackAttachmentIds = await listContextPackAttachmentIds(
          document.id,
          organizationId
        );
        expect(contextPackAttachmentIds).not.toContain(deletedAttachment.id);
        expect(contextPackAttachmentIds).toEqual(
          expect.arrayContaining([
            survivingAttachment.id,
            otherUserAttachment.id,
          ])
        );
      });
    });

    it("preserves first-party session deletes for same-org attachments created by another user", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const creator = await createTestUser(organizationId);
        const otherUser = await createTestUser(organizationId);
        const projectId = await createTestProject(organizationId, creator.id);
        const document = await createDocumentArtifact({
          organizationId,
          projectId,
          userId: creator.id,
        });
        const otherUserAttachment = await createAttachment({
          createdById: otherUser.id,
          documentId: document.id,
          filename: "session-delete.md",
          key: "attachments/session-delete",
        });

        mockAuthContext = {
          authMethod: "session",
          clerkOrgId: "org_test",
          clerkUserId: creator.clerkId,
          user: creator,
        };

        const response = await DELETE(
          createMockRequest({
            method: "DELETE",
            url: `http://localhost:3002/documents/${document.id}/attachments/${otherUserAttachment.id}`,
          }),
          createMockRouteContext({
            attachmentId: otherUserAttachment.id,
            id: document.id,
          })
        );

        expect(response.status).toBe(200);
        expect(mockDeleteArtifact).toHaveBeenCalledWith(
          "attachments/session-delete",
          "test-attachment-bucket"
        );
        await expect(
          withDb((db) =>
            db.fileAttachment.findUnique({
              where: { id: otherUserAttachment.id },
            })
          )
        ).resolves.toBeNull();
        await expect(
          getDownloadStatus(document.id, otherUserAttachment.id)
        ).resolves.toBe(404);
      });
    });

    it("succeeds and logs when S3 deletion fails after the DB row is removed", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const creator = await createTestUser(organizationId);
        const projectId = await createTestProject(organizationId, creator.id);
        const document = await createDocumentArtifact({
          organizationId,
          projectId,
          userId: creator.id,
        });
        const deletedAttachment = await createAttachment({
          createdById: creator.id,
          documentId: document.id,
          filename: "s3-fails.md",
          key: "attachments/s3-fails",
        });
        const survivingAttachment = await createAttachment({
          createdById: creator.id,
          documentId: document.id,
          filename: "s3-survives.md",
          key: "attachments/s3-survives",
        });

        mockDeleteArtifact.mockRejectedValue(new Error("S3 unavailable"));
        mockAuthContext = {
          apiKeyScopes: ["delete"],
          authMethod: "api_key",
          clerkOrgId: "org_test",
          clerkUserId: creator.clerkId,
          user: creator,
        };

        const response = await DELETE(
          createMockRequest({
            method: "DELETE",
            url: `http://localhost:3002/documents/${document.id}/attachments/${deletedAttachment.id}`,
          }),
          createMockRouteContext({
            attachmentId: deletedAttachment.id,
            id: document.id,
          })
        );

        expect(response.status).toBe(200);
        await expect(
          withDb((db) =>
            db.fileAttachment.findUnique({
              where: { id: deletedAttachment.id },
            })
          )
        ).resolves.toBeNull();
        const visibleIds = await listAttachmentIds(document.id);
        expect(visibleIds).not.toContain(deletedAttachment.id);
        expect(visibleIds).toContain(survivingAttachment.id);
        await expect(
          getDownloadStatus(document.id, deletedAttachment.id)
        ).resolves.toBe(404);
        await expect(
          getDownloadStatus(document.id, survivingAttachment.id)
        ).resolves.toBe(200);
        await expect(
          getInlineSkipped(document.id, deletedAttachment.id)
        ).resolves.toEqual([
          {
            attachmentId: deletedAttachment.id,
            reason: InlineImageResolveSkipReason.NotFound,
          },
        ]);
        const contextPackAttachmentIds = await listContextPackAttachmentIds(
          document.id,
          organizationId
        );
        expect(contextPackAttachmentIds).not.toContain(deletedAttachment.id);
        expect(contextPackAttachmentIds).toContain(survivingAttachment.id);
        expect(mockLogError).toHaveBeenCalledWith(
          "[attachments-service] Failed to delete S3 object",
          {
            attachmentId: deletedAttachment.id,
            documentId: document.id,
            error: "S3 unavailable",
            organizationId,
          }
        );
      });
    });
  }
);
