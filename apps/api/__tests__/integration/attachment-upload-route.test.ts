import { AttachmentPurpose } from "@repo/api/src/types/attachment";
import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/documents/[id]/attachments/route";
import { isMcpAttachmentUploadEnabled } from "@/app/documents/attachment-upload-feature";
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

const mockGetSignedUploadUrl = vi.hoisted(() => vi.fn());

let mockAuthContext: AuthContext | undefined;

vi.mock("@repo/aws", () => ({
  deleteArtifact: vi.fn(),
  getSignedDownloadUrl: vi.fn(),
  getSignedDownloadUrlWithDisposition: vi.fn(),
  getSignedUploadUrl: mockGetSignedUploadUrl,
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
      mockGetSignedUploadUrl.mockResolvedValue("https://s3.example.com/upload");
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

        const requestedAt = Date.now();
        const response = await POST(
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
        const completedAt = Date.now();

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
        expect(Date.parse(json.data.expiresAt)).toBeGreaterThanOrEqual(
          requestedAt + 900_000 - 1000
        );
        expect(Date.parse(json.data.expiresAt)).toBeLessThanOrEqual(
          completedAt + 900_000 + 1000
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
  }
);
