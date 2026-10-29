import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DesktopReceiptWorld,
  seedOwnedComputeTarget,
} from "@/__tests__/support/desktop/desktop-sync-receipt.test-helpers";
import {
  apiKeyRouteRequest,
  countReceipts,
  createReceiptRouteHarness,
  failReceiptInserts,
  forcedReceiptFailures,
  readReceipts,
  receiptRouteParams,
  turnAttributionFlagOff,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";

const s3 = vi.hoisted(() => ({
  listParts: vi.fn(),
  completeMultipartUpload: vi.fn(),
  headObject: vi.fn(),
  abortMultipartUpload: vi.fn(),
}));

vi.mock("@/lib/attribution-evidence-policy-feature", async (importOriginal) =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteFlagMock(await importOriginal())
);
vi.mock("@/lib/auth/with-any-auth", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteAuthMock()
);
vi.mock("@vercel/functions", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteWaitUntilMock()
);
vi.mock(
  "@/lib/operation-receipts/operation-receipt-writer",
  async (importOriginal) =>
    (
      await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
    ).failingReceiptWriterMock(await importOriginal())
);
vi.mock("@/app/desktop/transcripts/transcript-s3-port", () => ({
  defaultS3Port: {
    createMultipartUpload: vi.fn(),
    copyPart: vi.fn(),
    presignUploadPart: vi.fn(),
    presignPutObject: vi.fn(),
    listParts: s3.listParts,
    completeMultipartUpload: s3.completeMultipartUpload,
    headObject: s3.headObject,
    abortMultipartUpload: s3.abortMultipartUpload,
  },
}));
vi.mock("@/app/search/transcript-search-indexer", () => ({
  transcriptSearchIndexService: { indexAfterCommit: () => undefined },
}));

import { POST as completeTranscript } from "@/app/desktop/transcripts/complete/route";

const harness = createReceiptRouteHarness();
const COMPLETE_ROUTE = "/desktop/transcripts/complete";
const SESSION_ID = "iss12552-complete-session";
const FILE_KEY = "main";
const UPLOAD_ID = "iss12552-upload";
const PLAN_END_OFFSET = 1000;
const CRC = "crc-iss12552";

/**
 * ISS-12552: an API-key transcript completion records one
 * Desktop sync receipt in the completion's transaction, before any S3 call.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 transcript complete receipts",
  () => {
    beforeEach(() => {
      for (const mock of Object.values(s3)) {
        mock.mockReset();
      }
      s3.listParts.mockResolvedValue([
        { partNumber: 1, etag: "part-etag", checksumCrc64Nvme: "part-crc" },
      ]);
      s3.completeMultipartUpload.mockResolvedValue({ etag: "final-etag" });
      s3.headObject.mockResolvedValue({
        byteSize: PLAN_END_OFFSET,
        checksumCrc64Nvme: CRC,
        etag: "final-etag",
      });
      s3.abortMultipartUpload.mockResolvedValue(undefined);
    });
    afterEach(() => harness.cleanup());

    it("fails the receipt before any S3 call and rolls the completion back", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedPendingUpload(world);
      failReceiptInserts();

      const response = await completeTranscript(
        completeRequest(computeTargetId, "multipart"),
        receiptRouteParams({})
      );

      // The lane answers a transaction that threw with its retryable 503.
      expect(response.status).toBe(503);
      expect(forcedReceiptFailures()).toBe(1);
      expect(s3.listParts).not.toHaveBeenCalled();
      expect(s3.completeMultipartUpload).not.toHaveBeenCalled();
      expect(await readTranscriptStatus(computeTargetId)).toBe(
        TranscriptUploadStatus.Uploading
      );
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("commits the row as failed with one receipt when S3 rejects the completion", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedPendingUpload(world);
      s3.completeMultipartUpload.mockRejectedValue(
        Object.assign(new Error("PreconditionFailed"), {
          $metadata: { httpStatusCode: 412 },
        })
      );

      const response = await completeTranscript(
        completeRequest(computeTargetId, "multipart"),
        receiptRouteParams({})
      );

      expect(response.status).toBe(409);
      expect(s3.completeMultipartUpload).toHaveBeenCalledTimes(1);
      expect(await readTranscriptStatus(computeTargetId)).toBe(
        TranscriptUploadStatus.Failed
      );
      expect(await readReceipts(world.organizationId)).toEqual([
        completeReceipt(),
      ]);
    });

    it("records one receipt for a completed multipart upload", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedPendingUpload(world);

      const response = await completeTranscript(
        completeRequest(computeTargetId, "multipart"),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect((await response.json()).data).toMatchObject({
        status: TranscriptUploadStatus.Uploaded,
        operationReceipt: { outcome: OperationReceiptOutcome.Committed },
      });
      expect(await readTranscriptStatus(computeTargetId)).toBe(
        TranscriptUploadStatus.Uploaded
      );
      expect(await readReceipts(world.organizationId)).toEqual([
        completeReceipt(),
      ]);
    });

    it("records one receipt for a completed full put", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedPendingUpload(world);

      const response = await completeTranscript(
        completeRequest(computeTargetId, "fullPut"),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(s3.completeMultipartUpload).not.toHaveBeenCalled();
      expect(await readTranscriptStatus(computeTargetId)).toBe(
        TranscriptUploadStatus.Uploaded
      );
      expect(await readReceipts(world.organizationId)).toEqual([
        completeReceipt(),
      ]);
    });

    it("fails a full put's receipt before the S3 check and rolls it back", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedPendingUpload(world);
      failReceiptInserts();

      const response = await completeTranscript(
        completeRequest(computeTargetId, "fullPut"),
        receiptRouteParams({})
      );

      expect(response.status).toBe(503);
      expect(forcedReceiptFailures()).toBe(1);
      expect(s3.headObject).not.toHaveBeenCalled();
      expect(await readTranscriptStatus(computeTargetId)).toBe(
        TranscriptUploadStatus.Uploading
      );
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedPendingUpload(world);
      turnAttributionFlagOff();

      const response = await completeTranscript(
        completeRequest(computeTargetId, "multipart"),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect((await response.json()).data).not.toHaveProperty(
        "operationReceipt"
      );
      expect(await readTranscriptStatus(computeTargetId)).toBe(
        TranscriptUploadStatus.Uploaded
      );
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function completeReceipt() {
  return {
    operationKind: OperationKind.DesktopSync,
    outcome: OperationReceiptOutcome.Committed,
    source: OperationSource.Api,
    targetArtifactId: null,
    createdArtifactId: null,
    changedFields: [],
    route: COMPLETE_ROUTE,
  };
}

function completeRequest(
  computeTargetId: string,
  mode: "multipart" | "fullPut"
) {
  return apiKeyRouteRequest("POST", COMPLETE_ROUTE, {
    computeTargetId,
    externalSessionId: SESSION_ID,
    fileKey: FILE_KEY,
    mode,
    ...(mode === "multipart" ? { uploadId: UPLOAD_ID } : {}),
    planEndOffset: PLAN_END_OFFSET,
    sha256: "b".repeat(64),
    crc64nvme: CRC,
  });
}

/** A transcript row mid-upload, as a sync plan leaves it. */
async function seedPendingUpload(world: DesktopReceiptWorld): Promise<string> {
  const computeTargetId = await seedOwnedComputeTarget(world);
  await withDb((db) =>
    db.sessionTranscript.create({
      data: {
        organizationId: world.organizationId,
        computeTargetId,
        externalSessionId: SESSION_ID,
        sourceHarness: "claude_code",
        fileKey: FILE_KEY,
        objectStorageKey: `iss12552/${computeTargetId}/${SESSION_ID}`,
        uploadStatus: TranscriptUploadStatus.Uploading,
        pendingUploadId: UPLOAD_ID,
        pendingUploadStartedAt: new Date(),
      },
      select: { id: true },
    })
  );
  return computeTargetId;
}

async function readTranscriptStatus(
  computeTargetId: string
): Promise<string | null> {
  const row = await withDb((db) =>
    db.sessionTranscript.findUnique({
      where: {
        computeTargetId_externalSessionId_fileKey: {
          computeTargetId,
          externalSessionId: SESSION_ID,
          fileKey: FILE_KEY,
        },
      },
      select: { uploadStatus: true },
    })
  );
  return row?.uploadStatus ?? null;
}
