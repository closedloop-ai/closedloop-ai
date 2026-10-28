import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
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

import { POST as skipTranscript } from "@/app/desktop/transcripts/skip/route";

const harness = createReceiptRouteHarness();
const SKIP_ROUTE = "/desktop/transcripts/skip";
const SESSION_ID = "iss12552-skip-session";
const FILE_KEY = "main";

/**
 * ISS-12552: an API-key transcript skip records one Desktop sync
 * receipt in the skip's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 transcript skip receipts",
  () => {
    afterEach(() => harness.cleanup());

    it("rolls the skip back when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);
      failReceiptInserts();

      const response = await skipTranscript(
        skipRequest(computeTargetId),
        receiptRouteParams({})
      );

      // The lane answers a transaction that threw with its retryable 503.
      expect(response.status).toBe(503);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await readTranscriptStatus(computeTargetId)).toBeNull();
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records a committed skip, and a skip over a verified upload as a no-op", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);
      const skipped = await skipTranscript(
        skipRequest(computeTargetId),
        receiptRouteParams({})
      );
      await markUploaded(computeTargetId);
      const overUpload = await skipTranscript(
        skipRequest(computeTargetId),
        receiptRouteParams({})
      );

      expect([skipped.status, overUpload.status]).toEqual([200, 200]);
      expect((await skipped.json()).data).toMatchObject({
        status: TranscriptUploadStatus.Skipped,
        operationReceipt: { outcome: OperationReceiptOutcome.Committed },
      });
      expect(await readReceipts(world.organizationId)).toEqual(
        [OperationReceiptOutcome.Committed, OperationReceiptOutcome.NoOp].map(
          (outcome) => ({
            operationKind: OperationKind.DesktopSync,
            outcome,
            source: OperationSource.Api,
            targetArtifactId: null,
            createdArtifactId: null,
            changedFields: [],
            route: SKIP_ROUTE,
          })
        )
      );
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      const computeTargetId = await seedOwnedComputeTarget(world);
      turnAttributionFlagOff();

      const response = await skipTranscript(
        skipRequest(computeTargetId),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(await readTranscriptStatus(computeTargetId)).toBe(
        TranscriptUploadStatus.Skipped
      );
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function skipRequest(computeTargetId: string) {
  return apiKeyRouteRequest("POST", SKIP_ROUTE, {
    computeTargetId,
    externalSessionId: SESSION_ID,
    fileKey: FILE_KEY,
    sourceHarness: "claude",
    reason: TranscriptSkipReason.TooLarge,
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

async function markUploaded(computeTargetId: string): Promise<void> {
  await withDb((db) =>
    db.sessionTranscript.update({
      where: {
        computeTargetId_externalSessionId_fileKey: {
          computeTargetId,
          externalSessionId: SESSION_ID,
          fileKey: FILE_KEY,
        },
      },
      data: { uploadStatus: TranscriptUploadStatus.Uploaded },
      select: { id: true },
    })
  );
}
