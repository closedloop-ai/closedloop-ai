import { randomUUID } from "node:crypto";
import { keys } from "@repo/database/keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyRouteRequest,
  countReceipts,
  createReceiptRouteHarness,
  receiptRouteParams,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";

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
vi.mock("@/lib/mention-notifications", () => ({
  dispatchMentionNotifications: vi.fn(),
}));
/** PostHog answers nothing for the organization's group. */
vi.mock(
  "@/lib/feature-flags/server-feature-flag-evaluation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/feature-flags/server-feature-flag-evaluation")
    >()),
    evaluateServerFeatureFlagForOrganization: vi.fn(async () => null),
    resolveUnmemoizedFeatureFlagValue: vi.fn(async () => undefined),
  })
);

import { seedReceiptSession } from "@/__tests__/support/comments/comment-receipt-route.test-fixtures";
import { commentTraceAnchor } from "@/__tests__/support/comments/comment-service.test-fixtures";
import { legacyTraceAnchor } from "@/__tests__/support/trace-comments/legacy-route.test-fixtures";
import { POST as createSessionComment } from "@/app/agent-sessions/[id]/trace-comments/route";
import { POST as createThread } from "@/app/artifacts/[id]/comments/threads/route";
import { commentsService } from "@/app/comments/service";
import { traceCommentsService } from "@/app/trace-comments/service";
import { clearAttributionEvidenceGateMemo } from "@/lib/attribution-evidence-policy-feature";
import { evaluateServerFeatureFlagForOrganization } from "@/lib/feature-flags/server-feature-flag-evaluation";

const harness = createReceiptRouteHarness();

/**
 * ISS-12552: flag-off behavior equals main for comment writes while PostHog
 * is unavailable. An unavailable answer reads as off through the real
 * evaluation path, so an API-key comment write hands its service no record
 * and records no receipt, as on main.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 comment writes with the attribution flag unavailable",
  () => {
    beforeEach(() => {
      clearAttributionEvidenceGateMemo();
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await harness.cleanup();
    });

    it("POST threads hands no record and records nothing", async () => {
      const world = await harness.seedWorld();
      const sessionId = await seedReceiptSession(world);
      const service = vi.spyOn(commentsService, "createArtifactCommentThread");

      const response = await createThread(
        apiKeyRouteRequest("POST", `/artifacts/${sessionId}/comments/threads`, {
          anchor: commentTraceAnchor(1),
          body: "root",
          clientId: randomUUID(),
        }),
        receiptRouteParams({ id: sessionId })
      );

      expect(response.status).toBe(200);
      expect(evaluateServerFeatureFlagForOrganization).toHaveBeenCalled();
      expect(service).toHaveBeenCalledTimes(1);
      expect(service.mock.calls[0]?.[1]).toBeUndefined();
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST a Session trace comment hands no record and records nothing", async () => {
      const world = await harness.seedWorld();
      const sessionId = await seedReceiptSession(world);
      const service = vi.spyOn(traceCommentsService, "create");

      const response = await createSessionComment(
        apiKeyRouteRequest(
          "POST",
          `/agent-sessions/${sessionId}/trace-comments`,
          { anchor: legacyTraceAnchor(1), body: "root", clientId: randomUUID() }
        ),
        receiptRouteParams({ id: sessionId })
      );

      expect(response.status).toBe(200);
      expect(evaluateServerFeatureFlagForOrganization).toHaveBeenCalled();
      expect(service).toHaveBeenCalledTimes(1);
      expect(service.mock.calls[0]?.[1]).toBeUndefined();
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);
