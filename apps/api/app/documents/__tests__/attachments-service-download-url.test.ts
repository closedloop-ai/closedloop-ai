/**
 * `attachmentsService.getDownloadUrl`: signs the stored key with the original
 * filename, and refuses an artifact outside the caller's org or a missing
 * attachment.
 *
 * Split out of `attachments-service.test.ts`, which owns upload, plain listing
 * and delete, so that grandfathered file shrinks rather than grows. Row
 * builders, identifiers and the `withDb` legs are shared through
 * `__tests__/support/documents/`.
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

vi.mock("@paralleldrive/cuid2", () => ({
  createId: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { getSignedDownloadUrlWithDisposition } from "@repo/aws";
import { withDb } from "@repo/database";
import { installArtifactScopeThen } from "@/__tests__/support/documents/attachments-service.test-db";
import {
  ARTIFACT_ID,
  ATTACHMENT_ID,
  makeAttachmentRecord,
  ORG_ID,
} from "@/__tests__/support/documents/attachments-service.test-fixtures";
import {
  ATTACHMENT_NOT_FOUND_ERROR,
  attachmentsService,
  DOCUMENT_NOT_FOUND_ERROR,
} from "../attachments-service";

const mockWithDb = withDb as unknown as Mock & { tx: Mock };
const mockGetSignedDownloadUrlWithDisposition =
  getSignedDownloadUrlWithDisposition as unknown as Mock;

describe("attachmentsService.getDownloadUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSignedDownloadUrlWithDisposition.mockResolvedValue(
      "https://s3.example.com/download-url"
    );
  });

  it("calls getSignedDownloadUrlWithDisposition with (key, filename)", async () => {
    const record = makeAttachmentRecord({
      key: `attachments/${ARTIFACT_ID}/somekey`,
      filename: "report.pdf",
    });

    installArtifactScopeThen({
      findFirst: vi.fn().mockResolvedValue(record),
    });

    await attachmentsService.getDownloadUrl(ARTIFACT_ID, ORG_ID, ATTACHMENT_ID);

    expect(mockGetSignedDownloadUrlWithDisposition).toHaveBeenCalledWith(
      record.key,
      record.filename,
      3600,
      record.bucket
    );
  });

  it("returns the downloadUrl from the signed URL response", async () => {
    const signedUrl = "https://s3.example.com/presigned-download?signature=abc";
    mockGetSignedDownloadUrlWithDisposition.mockResolvedValue(signedUrl);
    const record = makeAttachmentRecord();

    installArtifactScopeThen({
      findFirst: vi.fn().mockResolvedValue(record),
    });

    const result = await attachmentsService.getDownloadUrl(
      ARTIFACT_ID,
      ORG_ID,
      ATTACHMENT_ID
    );

    expect(result).toEqual({ downloadUrl: signedUrl });
  });

  it("throws 'Artifact not found' when artifact ownership check returns null", async () => {
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        artifact: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      })
    );

    await expect(
      attachmentsService.getDownloadUrl(
        "nonexistent-artifact",
        ORG_ID,
        ATTACHMENT_ID
      )
    ).rejects.toThrow(DOCUMENT_NOT_FOUND_ERROR);
  });

  it("throws 'Attachment not found' when attachment lookup returns null", async () => {
    installArtifactScopeThen({
      findFirst: vi.fn().mockResolvedValue(null),
    });

    await expect(
      attachmentsService.getDownloadUrl(
        ARTIFACT_ID,
        ORG_ID,
        "nonexistent-attach"
      )
    ).rejects.toThrow(ATTACHMENT_NOT_FOUND_ERROR);
  });
});
