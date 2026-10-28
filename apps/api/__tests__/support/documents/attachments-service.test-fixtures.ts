/**
 * Shared identifiers and the `FileAttachment` row builder for the
 * attachments-service suites.
 *
 * They live here rather than inside one suite because the attachment tests are
 * split by concern — `attachments-service.test.ts` owns upload, listing and
 * delete, its `-inline-images` and `-download-url` siblings own those paths,
 * and `attachments-service-org-scope.test.ts` owns the cross-organization
 * guard — and all of them drive the same row shape.
 */

import { AttachmentPurpose } from "@repo/api/src/types/attachment";

export const ARTIFACT_ID = "artifact-123";
export const ORG_ID = "org-abc";
export const USER_ID = "user-xyz";
export const ATTACHMENT_ID = "attach-456";
export const MOCK_CUID = "cuid2mockval01";

export function makeAttachmentRecord(
  overrides: Partial<{
    id: string;
    artifactId: string | undefined;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    createdAt: Date;
    createdById: string;
    key: string;
    bucket: string;
    purpose: string;
  }> = {}
) {
  return {
    id: ATTACHMENT_ID,
    artifactId: ARTIFACT_ID,
    filename: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 4096,
    createdAt: new Date("2026-01-15T12:00:00.000Z"),
    createdById: USER_ID,
    key: `attachments/${ORG_ID}/${ARTIFACT_ID}/${MOCK_CUID}`,
    bucket: "test-bucket",
    purpose: AttachmentPurpose.Context,
    ...overrides,
  };
}
