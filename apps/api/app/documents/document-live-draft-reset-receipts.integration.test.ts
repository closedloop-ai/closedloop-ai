import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { InternalCallFailure } from "@repo/realtime-server/internal-call";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyRouteRequest,
  countReceipts,
  createReceiptRouteHarness,
  receiptRouteParams,
  turnAttributionFlagOff,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";
import { receiptRouteState } from "@/__tests__/support/lib/operation-receipt-route.test-mocks";
import type { AuthContext } from "@/lib/auth/with-auth";

const docSync = vi.hoisted(() => ({ publish: vi.fn() }));

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
vi.mock("@/app/doc-sync/internal/seed-state", () => ({
  publishVersionToLiveDocument: docSync.publish,
}));

import { POST as resetLiveDraft } from "@/app/documents/[id]/live-draft/reset/route";

const harness = createReceiptRouteHarness();
const RESET_ROUTE = "/documents/[id]/live-draft/reset";
/** `createDocumentRecord` stores the seeded document's first version. */
const SEEDED_VERSION = 1;

/**
 * ISS-12552: an API-key live-draft reset records one audit-only receipt once
 * doc-sync confirms it (Daveth, 2026-10-22).
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 live-draft reset receipts",
  () => {
    beforeEach(() => {
      docSync.publish.mockResolvedValue({
        ok: true,
        value: { applied: true, stale: false, updateBytes: 9 },
      });
    });
    afterEach(() => harness.cleanup());

    it("records one reset naming the document and the version it was reset to", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Draft");

      const response = await postReset(documentId);

      expect(response.status).toBe(200);
      expect(await readResetReceipts(world.organizationId)).toEqual([
        {
          operationKind: OperationKind.LiveDraftReset,
          outcome: OperationReceiptOutcome.Committed,
          source: OperationSource.Api,
          targetArtifactId: documentId,
          versionNumber: SEEDED_VERSION,
          route: RESET_ROUTE,
        },
      ]);
    });

    it("records nothing for a signed-in session caller", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Draft");
      receiptRouteState.context = {
        ...(receiptRouteState.context as AuthContext),
        authMethod: "session",
      };

      const response = await postReset(documentId);

      expect(response.status).toBe(200);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records nothing with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Draft");
      turnAttributionFlagOff();

      const response = await postReset(documentId);

      expect(response.status).toBe(200);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records no committed receipt when doc-sync fails the reset", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Draft");
      docSync.publish.mockResolvedValue({
        ok: false,
        failure: InternalCallFailure.Rejected,
        status: 503,
      });

      const response = await postReset(documentId);

      expect(response.status).toBe(503);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function postReset(documentId: string) {
  return resetLiveDraft(
    apiKeyRouteRequest("POST", `/documents/${documentId}/live-draft/reset`),
    receiptRouteParams({ id: documentId })
  );
}

function readResetReceipts(organizationId: string) {
  return withDb((db) =>
    db.artifactOperationReceipt.findMany({
      where: { organizationId },
      select: {
        operationKind: true,
        outcome: true,
        source: true,
        targetArtifactId: true,
        versionNumber: true,
        route: true,
      },
    })
  );
}
