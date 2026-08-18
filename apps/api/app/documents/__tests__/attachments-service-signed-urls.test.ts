/**
 * `attachmentsService.listWithSignedUrlsByDocument` — the context-pack listing
 * that returns each attachment alongside a freshly signed download URL.
 *
 * Split out of `attachments-service.test.ts`, which owns upload, inline images,
 * plain listing, delete and download. Row builders and identifiers are shared
 * through `__tests__/support/documents/attachments-service.test-fixtures`.
 */
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => {
  const tx = vi.fn();
  const withDbFn = Object.assign(vi.fn(), { tx });
  return {
    withDb: withDbFn,
    ArtifactType: {
      DOCUMENT: "DOCUMENT",
      BRANCH: "BRANCH",
      DEPLOYMENT: "DEPLOYMENT",
    },
  };
});

vi.mock("@repo/aws", () => ({
  deleteArtifact: vi.fn(),
  getSignedDownloadUrl: vi.fn(),
  getSignedDownloadUrlWithDisposition: vi.fn(),
  getSignedUploadUrl: vi.fn(),
  putAttachmentObject: vi.fn(),
}));

vi.mock("@repo/aws/keys", () => ({
  keys: () => ({
    FILE_ATTACHMENTS_BUCKET: process.env.FILE_ATTACHMENTS_BUCKET,
  }),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { AttachmentPurpose } from "@repo/api/src/types/attachment";
import { getSignedDownloadUrl } from "@repo/aws";
import { withDb } from "@repo/database";
import {
  ARTIFACT_ID,
  ATTACHMENT_ID,
  makeAttachmentRecord,
  ORG_ID,
} from "@/__tests__/support/documents/attachments-service.test-fixtures";
import {
  attachmentServiceInternalsForTesting,
  attachmentsService,
} from "../attachments-service";

const mockWithDb = withDb as unknown as Mock & { tx: Mock };
const mockGetSignedDownloadUrl = getSignedDownloadUrl as unknown as Mock;

describe("attachmentsService.listWithSignedUrlsByDocument", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The module-scope signature cache outlives clearAllMocks, so a re-run of
    // the same test would be served from it and never call the signer.
    attachmentServiceInternalsForTesting.clearSignedDownloadUrlCache();
  });

  it("queries with org-scoped where clause and returns ContextPackAttachment shape", async () => {
    const record = makeAttachmentRecord();
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        fileAttachment: {
          findMany: vi.fn().mockResolvedValue([record]),
        },
      })
    );
    mockGetSignedDownloadUrl.mockResolvedValue("https://s3.example.com/signed");

    const result = await attachmentsService.listWithSignedUrlsByDocument(
      ARTIFACT_ID,
      ORG_ID
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: ATTACHMENT_ID,
      filename: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4096,
      signedUrl: "https://s3.example.com/signed",
    });
    expect(result[0].signedUrlExpiresAt).toBeDefined();
  });

  it("passes org-scoped where clause to fileAttachment.findMany", async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        fileAttachment: {
          findMany: vi.fn((args: Record<string, unknown>) => {
            capturedArgs = args;
            return Promise.resolve([]);
          }),
        },
      })
    );

    await attachmentsService.listWithSignedUrlsByDocument(ARTIFACT_ID, ORG_ID);

    expect(capturedArgs).toMatchObject({
      where: {
        artifactId: ARTIFACT_ID,
        artifact: { organizationId: ORG_ID },
        purpose: AttachmentPurpose.Context,
      },
      orderBy: { createdAt: "desc" },
    });
  });

  it("calls getSignedDownloadUrl with the record's key and bucket", async () => {
    const record = makeAttachmentRecord({
      key: "attachments/org-abc/artifact-123/specific-key",
      bucket: "my-bucket",
    });
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        fileAttachment: {
          findMany: vi.fn().mockResolvedValue([record]),
        },
      })
    );
    mockGetSignedDownloadUrl.mockResolvedValue("https://s3.example.com/url");

    await attachmentsService.listWithSignedUrlsByDocument(ARTIFACT_ID, ORG_ID);

    expect(mockGetSignedDownloadUrl).toHaveBeenCalledWith(
      record.key,
      3600,
      "my-bucket"
    );
  });

  it("reports the cached signature's real expiry, not a fresh full lifetime, when a signed URL is reused", async () => {
    vi.useFakeTimers();
    attachmentServiceInternalsForTesting.clearSignedDownloadUrlCache();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const record = makeAttachmentRecord({
        key: "attachments/org-abc/artifact-123/context-key",
        bucket: "context-bucket",
      });
      mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
        callback({
          fileAttachment: {
            findMany: vi.fn().mockResolvedValue([record]),
          },
        })
      );
      mockGetSignedDownloadUrl.mockResolvedValue("https://s3.example.com/ctx");

      const first = await attachmentsService.listWithSignedUrlsByDocument(
        ARTIFACT_ID,
        ORG_ID
      );

      // Reuse the cached signature 10 minutes later — still inside the reuse
      // window, beyond the 5-minute safety margin, so no re-sign happens.
      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
      const second = await attachmentsService.listWithSignedUrlsByDocument(
        ARTIFACT_ID,
        ORG_ID
      );

      expect(mockGetSignedDownloadUrl).toHaveBeenCalledTimes(1);
      expect(second[0].signedUrl).toBe(first[0].signedUrl);
      // The reused URL really expires one hour after it was first signed, NOT
      // one hour after the second call. Reporting the latter would let a
      // consumer (e.g. the desktop loop materializer) treat an already-expired
      // URL as still valid.
      expect(second[0].signedUrlExpiresAt).toBe(first[0].signedUrlExpiresAt);
      expect(second[0].signedUrlExpiresAt).toBe("2026-01-01T01:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns empty array and does not call getSignedDownloadUrl when no records exist", async () => {
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        fileAttachment: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      })
    );

    const result = await attachmentsService.listWithSignedUrlsByDocument(
      ARTIFACT_ID,
      ORG_ID
    );

    expect(result).toHaveLength(0);
    expect(mockGetSignedDownloadUrl).not.toHaveBeenCalled();
  });
});
