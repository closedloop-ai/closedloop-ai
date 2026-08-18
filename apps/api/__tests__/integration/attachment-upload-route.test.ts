import {
  AttachmentPurpose,
  INLINE_ATTACHMENT_REF_PREFIX,
} from "@repo/api/src/types/attachment";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as CreateInlineImageAttachment } from "@/app/documents/[id]/attachments/images/route";
import { POST as ResolveInlineImages } from "@/app/documents/[id]/attachments/resolve/route";
import {
  GET as GetAttachments,
  POST,
} from "@/app/documents/[id]/attachments/route";
import { POST as CreateDocumentVersion } from "@/app/documents/[id]/versions/route";
import { isMcpAttachmentUploadEnabled } from "@/app/documents/attachment-upload-feature";
import { ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS } from "@/app/documents/attachments-service";
import { documentService } from "@/app/documents/document-service";
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
import { PNG_BASE64, PNG_BYTES } from "../utils/image-fixtures";

const PINNED_NOW_MS = Date.parse("2026-07-01T00:00:00.000Z");

const mockGetSignedUploadUrl = vi.hoisted(() => vi.fn());
const mockGetSignedDownloadUrl = vi.hoisted(() => vi.fn());
const mockPutAttachmentObject = vi.hoisted(() => vi.fn());

let mockAuthContext: AuthContext | undefined;

vi.mock("@repo/aws", () => ({
  deleteArtifact: vi.fn(),
  getSignedDownloadUrl: mockGetSignedDownloadUrl,
  getSignedDownloadUrlWithDisposition: vi.fn(),
  getSignedUploadUrl: mockGetSignedUploadUrl,
  putAttachmentObject: mockPutAttachmentObject,
}));

vi.mock("@/app/documents/attachment-upload-feature", () => ({
  isMcpAttachmentUploadEnabled: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (
      handler: (
        authContext: AuthContext,
        request: Request,
        params: Promise<{ id: string }>
      ) => Promise<Response>
    ) =>
    (request: Request, context: { params: Promise<{ id: string }> }) => {
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
const ORIGINAL_FILE_ATTACHMENTS_BUCKET = process.env.FILE_ATTACHMENTS_BUCKET;
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
        name: "MCP attachment upload target",
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

describe.skipIf(!hasDatabase)(
  "POST /documents/:id/attachments integration",
  () => {
    beforeEach(() => {
      vi.clearAllMocks();
      process.env.FILE_ATTACHMENTS_BUCKET = "test-attachment-bucket";
      mockGetSignedDownloadUrl.mockResolvedValue(
        "https://s3.example.com/inline-preview"
      );
      mockGetSignedUploadUrl.mockResolvedValue("https://s3.example.com/upload");
      mockPutAttachmentObject.mockResolvedValue(undefined);
      vi.mocked(isMcpAttachmentUploadEnabled).mockResolvedValue(true);
    });

    afterEach(() => {
      mockAuthContext = undefined;
      if (ORIGINAL_FILE_ATTACHMENTS_BUCKET === undefined) {
        Reflect.deleteProperty(process.env, "FILE_ATTACHMENTS_BUCKET");
      } else {
        process.env.FILE_ATTACHMENTS_BUCKET = ORIGINAL_FILE_ATTACHMENTS_BUCKET;
      }
    });

    it("creates a document attachment row for a write-scoped MCP upload request with AWS signing mocked", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        const projectId = await createTestProject(organizationId, user.id);
        const document = await createDocumentArtifact({
          organizationId,
          projectId,
          userId: user.id,
        });

        mockAuthContext = {
          apiKeyScopes: ["write"],
          authMethod: "api_key",
          clerkOrgId: "org_test",
          clerkUserId: user.clerkId,
          user,
        };

        // Pin only `Date.now` — not the timers a live pg pool depends on — so
        // the advertised expiry is asserted exactly rather than inside a ±1 s
        // window that a slow DB round-trip on a loaded runner can breach.
        // Restored in a `finally`: this config sets no `restoreMocks`, so a
        // throw from POST would otherwise leak the pinned clock into every
        // later test in the file.
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(PINNED_NOW_MS);
        let response: Response;
        try {
          response = await POST(
            createMockRequest({
              body: {
                filename: "context.md",
                mimeType: "text/markdown",
                sizeBytes: 2048,
              },
              method: "POST",
              url: `http://localhost:3002/documents/${document.id}/attachments`,
            }),
            createMockRouteContext({ id: document.id })
          );
        } finally {
          nowSpy.mockRestore();
        }

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.success).toBe(true);
        expect(json.data).toMatchObject({
          uploadUrl: "https://s3.example.com/upload",
        });

        const attachment = await withDb((db) =>
          db.fileAttachment.findUnique({
            where: { id: json.data.attachmentId },
          })
        );

        expect(attachment).toMatchObject({
          artifactId: document.id,
          bucket: "test-attachment-bucket",
          createdById: user.id,
          filename: "context.md",
          mimeType: "text/markdown",
          purpose: AttachmentPurpose.Context,
          sizeBytes: 2048,
        });
        expect(attachment?.key).toBe(json.data.key);
        expect(attachment?.key).toMatch(
          new RegExp(`^attachments/${organizationId}/${document.id}/`)
        );
        expect(Date.parse(json.data.expiresAt)).toBe(
          PINNED_NOW_MS + ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS * 1000
        );
        expect(mockGetSignedUploadUrl).toHaveBeenCalledWith(
          attachment?.key,
          "text/markdown",
          900,
          "test-attachment-bucket",
          2048
        );
        expect(isMcpAttachmentUploadEnabled).toHaveBeenCalledWith({
          clerkUserId: user.clerkId,
          userId: user.id,
        });
      });
    });

    it("creates an inline image attachment row and exposes it through the existing inline list selector", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        const projectId = await createTestProject(organizationId, user.id);
        const document = await createDocumentArtifact({
          organizationId,
          projectId,
          userId: user.id,
        });

        mockAuthContext = {
          apiKeyScopes: ["write"],
          authMethod: "api_key",
          clerkOrgId: "org_test",
          clerkUserId: user.clerkId,
          user,
        };

        const response = await CreateInlineImageAttachment(
          createMockRequest({
            body: {
              filename: "diagram.png",
              mimeType: "image/png",
              dataBase64: PNG_BASE64,
            },
            method: "POST",
            url: `http://localhost:3002/documents/${document.id}/attachments/images`,
          }),
          createMockRouteContext({ id: document.id })
        );

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.success).toBe(true);
        expect(json.data).toMatchObject({
          attachmentRef: `${INLINE_ATTACHMENT_REF_PREFIX}${json.data.attachmentId}`,
          attachment: {
            artifactId: document.id,
            filename: "diagram.png",
            mimeType: "image/png",
            purpose: AttachmentPurpose.Inline,
            sizeBytes: PNG_BYTES.byteLength,
          },
        });
        expect(json.data).not.toHaveProperty("key");
        expect(json.data).not.toHaveProperty("uploadUrl");

        const attachment = await withDb((db) =>
          db.fileAttachment.findUnique({
            where: { id: json.data.attachmentId },
          })
        );

        expect(attachment).toMatchObject({
          artifactId: document.id,
          bucket: "test-attachment-bucket",
          createdById: user.id,
          filename: "diagram.png",
          mimeType: "image/png",
          purpose: AttachmentPurpose.Inline,
          sizeBytes: PNG_BYTES.byteLength,
        });
        expect(attachment?.key).toMatch(
          new RegExp(`^attachments/${organizationId}/${document.id}/`)
        );
        expect(mockPutAttachmentObject).toHaveBeenCalledWith({
          body: expect.any(Uint8Array),
          bucket: "test-attachment-bucket",
          contentLength: PNG_BYTES.byteLength,
          contentType: "image/png",
          key: attachment?.key,
        });
        expect(
          Buffer.from(mockPutAttachmentObject.mock.calls[0][0].body)
        ).toEqual(Buffer.from(PNG_BYTES));

        mockAuthContext = {
          ...mockAuthContext,
          apiKeyScopes: ["read"],
        };

        const listResponse = await GetAttachments(
          createMockRequest({
            method: "GET",
            url: `http://localhost:3002/documents/${document.id}/attachments?purpose=inline`,
          }),
          createMockRouteContext({ id: document.id })
        );

        expect(listResponse.status).toBe(200);
        const listJson = await listResponse.json();
        expect(listJson.success).toBe(true);
        expect(listJson.data).toEqual([
          expect.objectContaining({
            id: json.data.attachmentId,
            artifactId: document.id,
            filename: "diagram.png",
            mimeType: "image/png",
            purpose: AttachmentPurpose.Inline,
            sizeBytes: PNG_BYTES.byteLength,
          }),
        ]);
      });
    });

    it("creates inline images inside a document version and exposes them through list and resolve APIs", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        const projectId = await createTestProject(organizationId, user.id);
        const document = await documentService.create(organizationId, user.id, {
          content: "Initial content",
          projectId,
          status: DocumentStatus.Draft,
          title: "Inline version target",
          type: DocumentType.Prd,
        });

        expect(document).not.toBeNull();

        mockAuthContext = {
          apiKeyScopes: ["write"],
          authMethod: "api_key",
          clerkOrgId: "org_test",
          clerkUserId: user.clerkId,
          user,
        };

        const response = await CreateDocumentVersion(
          createMockRequest({
            body: {
              content: "Updated [[first]] and [[second]]",
              inlineImages: [
                {
                  altText: "First",
                  dataBase64: PNG_BASE64,
                  filename: "first.png",
                  mimeType: "image/png",
                  placeholder: "[[first]]",
                },
                {
                  altText: "Second",
                  dataBase64: PNG_BASE64,
                  filename: "second.png",
                  mimeType: "image/png",
                  placeholder: "[[second]]",
                },
              ],
            },
            method: "POST",
            url: `http://localhost:3002/documents/${document!.id}/versions?reset-room=false`,
          }),
          createMockRouteContext({ id: document!.id })
        );

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.success).toBe(true);
        expect(json.data.inlineImages).toHaveLength(2);
        expect(json.data.versionContent).toContain("![First](attachment://");
        expect(json.data.versionContent).toContain("![Second](attachment://");
        expect(JSON.stringify(json)).not.toContain(PNG_BASE64);
        expect(mockPutAttachmentObject).toHaveBeenCalledTimes(2);

        const attachmentIds = json.data.inlineImages.map(
          (inlineImage: { attachmentId: string }) => inlineImage.attachmentId
        );
        expect(json.data.versionContent).toContain(
          `${INLINE_ATTACHMENT_REF_PREFIX}${attachmentIds[0]}`
        );
        expect(json.data.versionContent).toContain(
          `${INLINE_ATTACHMENT_REF_PREFIX}${attachmentIds[1]}`
        );

        const latestVersion = await withDb((db) =>
          db.documentVersion.findFirst({
            where: { documentId: document!.id },
            orderBy: { version: "desc" },
            select: { content: true },
          })
        );
        expect(latestVersion?.content).toBe(json.data.versionContent);

        mockAuthContext = {
          ...mockAuthContext,
          apiKeyScopes: ["read"],
        };

        const listResponse = await GetAttachments(
          createMockRequest({
            method: "GET",
            url: `http://localhost:3002/documents/${document!.id}/attachments?purpose=inline`,
          }),
          createMockRouteContext({ id: document!.id })
        );

        expect(listResponse.status).toBe(200);
        const listJson = await listResponse.json();
        expect(listJson.success).toBe(true);
        expect(listJson.data).toEqual(
          expect.arrayContaining(
            attachmentIds.map((attachmentId: string) =>
              expect.objectContaining({
                id: attachmentId,
                artifactId: document!.id,
                mimeType: "image/png",
                purpose: AttachmentPurpose.Inline,
                sizeBytes: PNG_BYTES.byteLength,
              })
            )
          )
        );

        const resolveResponse = await ResolveInlineImages(
          createMockRequest({
            body: { attachmentIds },
            method: "POST",
            url: `http://localhost:3002/documents/${document!.id}/attachments/resolve`,
          }),
          createMockRouteContext({ id: document!.id })
        );

        expect(resolveResponse.status).toBe(200);
        const resolveJson = await resolveResponse.json();
        expect(resolveJson.success).toBe(true);
        expect(resolveJson.data.skipped).toEqual([]);
        expect(resolveJson.data.images).toEqual(
          expect.arrayContaining(
            attachmentIds.map((attachmentId: string) =>
              expect.objectContaining({
                attachmentId,
                mimeType: "image/png",
                sizeBytes: PNG_BYTES.byteLength,
                url: "https://s3.example.com/inline-preview",
              })
            )
          )
        );
        expect(mockGetSignedDownloadUrl).toHaveBeenCalledTimes(2);
      });
    });
  }
);
