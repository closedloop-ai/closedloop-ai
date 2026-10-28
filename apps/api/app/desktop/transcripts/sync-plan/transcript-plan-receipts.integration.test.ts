import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedOwnedComputeTarget } from "@/__tests__/support/desktop/desktop-sync-receipt.test-helpers";
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
    createMultipartUpload: vi.fn(async () => ({ uploadId: "up-new" })),
    copyPart: vi.fn(async () => ({ partNumber: 1, etag: "copy-etag" })),
    presignUploadPart: vi.fn(async () => "https://s3/part"),
    presignPutObject: vi.fn(async () => "https://s3/put"),
    listParts: vi.fn(async () => []),
    completeMultipartUpload: vi.fn(async () => ({ etag: "final-etag" })),
    headObject: vi.fn(async () => null),
    abortMultipartUpload: vi.fn(async () => undefined),
  },
}));

import { POST as planTranscript } from "@/app/desktop/transcripts/sync-plan/route";

const harness = createReceiptRouteHarness();
const PLAN_ROUTE = "/desktop/transcripts/sync-plan";
const SESSION_ID = "iss12552-plan-session";
const FILE_KEY = "main";

/**
 * ISS-12552: an API-key transcript sync plan records one
 * Desktop sync receipt in the plan's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 transcript sync-plan receipts",
  () => {
    afterEach(() => harness.cleanup());

    it("rolls the plan back when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);
      failReceiptInserts();

      const response = await planTranscript(
        planRequest(computeTargetId),
        receiptRouteParams({})
      );

      // The lane answers a transaction that threw with its retryable 503.
      expect(response.status).toBe(503);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await readTranscriptStatus(computeTargetId)).toBeNull();
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records one committed receipt for a new plan", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);

      const response = await planTranscript(
        planRequest(computeTargetId),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect((await response.json()).data).toMatchObject({
        mode: "fullPut",
        operationReceipt: { outcome: OperationReceiptOutcome.Committed },
      });
      expect(await readTranscriptStatus(computeTargetId)).toBe(
        TranscriptUploadStatus.Uploading
      );
      expect(await readReceipts(world.organizationId)).toEqual([
        {
          operationKind: OperationKind.DesktopSync,
          outcome: OperationReceiptOutcome.Committed,
          source: OperationSource.Api,
          targetArtifactId: null,
          createdArtifactId: null,
          changedFields: [],
          route: PLAN_ROUTE,
        },
      ]);
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);
      turnAttributionFlagOff();

      const response = await planTranscript(
        planRequest(computeTargetId),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect((await response.json()).data).not.toHaveProperty(
        "operationReceipt"
      );
      expect(await readTranscriptStatus(computeTargetId)).toBe(
        TranscriptUploadStatus.Uploading
      );
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function planRequest(computeTargetId: string) {
  return apiKeyRouteRequest("POST", PLAN_ROUTE, {
    computeTargetId,
    externalSessionId: SESSION_ID,
    fileKey: FILE_KEY,
    sourceHarness: "claude_code",
    sourcePathHash: "path-hash",
    planEndOffset: 1000,
    sha256: "a".repeat(64),
    crc64nvme: "crc-1",
    sourceMtime: new Date(1_700_000_000_000).toISOString(),
  });
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
