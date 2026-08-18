import { vi } from "vitest";
import type { TranscriptS3Port } from "@/app/desktop/transcripts/service";
import { TranscriptRateLimiter } from "@/app/desktop/transcripts/transcript-rate-limit";

/**
 * Shared pure fixtures for the transcript sync-service test suites
 * (`service.test.ts` and `skip-service.test.ts` — split so neither file
 * carries the whole surface past the file-size ceiling). Only side-effect-free
 * builders live here; each test file keeps its OWN `vi.hoisted` mocks and
 * `vi.mock` blocks, which vitest hoists per-module and cannot share.
 */

export const NOW = 1_700_000_000_000;
export const ORG = "org-1";
export const USER = "user-1";
export const CT = "11111111-1111-7111-8111-111111111111";
export const SID = "session-abc";
export const STORED_SHA = "a".repeat(64);

export const auth = { organizationId: ORG, userId: USER, clerkUserId: null };

export function s3Port(
  overrides: Partial<TranscriptS3Port> = {}
): TranscriptS3Port {
  return {
    createMultipartUpload: vi.fn().mockResolvedValue({ uploadId: "up-new" }),
    copyPart: vi.fn().mockResolvedValue({ partNumber: 1, etag: "copy-etag" }),
    presignUploadPart: vi.fn().mockResolvedValue("https://s3/part"),
    presignPutObject: vi.fn().mockResolvedValue("https://s3/put"),
    listParts: vi.fn().mockResolvedValue([]),
    completeMultipartUpload: vi
      .fn()
      .mockResolvedValue({ etag: "final-etag", checksumCrc64Nvme: "crc-1" }),
    headObject: vi.fn().mockResolvedValue(null),
    abortMultipartUpload: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export function transcriptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    uploadStatus: "uploading",
    rawSha256: null,
    crc64nvme: null,
    syncedByteOffset: 0n,
    storedEtag: null,
    sessionDetailId: null,
    pendingUploadId: null,
    pendingUploadStartedAt: null,
    ...overrides,
  };
}

export function baseDeps(s3: TranscriptS3Port) {
  return { s3, now: () => NOW, rateLimiter: new TranscriptRateLimiter() };
}
