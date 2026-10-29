import { randomUUID } from "node:crypto";
import { LinkType } from "@repo/api/src/types/artifact";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReceiptRouteHarness } from "@/__tests__/support/lib/operation-receipt-route.test-helpers";
import { seedBranch } from "@/__tests__/utils/branch-identity-sql-fixture";

/**
 * Every PostHog organization evaluation of the flag, with whether a
 * `withDb.tx` was open when it ran. The open count is tracked by wrapping
 * `withDb.tx` itself, not by the code under test.
 */
const flag = vi.hoisted(() => ({
  openTransactions: 0,
  evaluations: [] as { duringTransaction: boolean }[],
}));
vi.mock(
  "@/lib/feature-flags/server-feature-flag-evaluation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/feature-flags/server-feature-flag-evaluation")
    >()),
    evaluateServerFeatureFlagForOrganization: vi.fn(() => {
      flag.evaluations.push({ duringTransaction: flag.openTransactions > 0 });
      return Promise.resolve(true);
    }),
  })
);
vi.mock(
  "@/app/agent-sessions/service/attribution/derive-implementation-evidence",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/app/agent-sessions/service/attribution/derive-implementation-evidence")
      >();
    return {
      ...actual,
      deriveImplementationEvidence: vi.fn(actual.deriveImplementationEvidence),
    };
  }
);
vi.mock("@vercel/functions", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteWaitUntilMock()
);
vi.mock("@/lib/liveblocks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveblocks")>()),
  createLiveblocksRoom: () => Promise.resolve({ success: true }),
}));

import { deriveImplementationEvidence } from "@/app/agent-sessions/service/attribution/derive-implementation-evidence";
import { LINK_WRITE_FLAG_UNREAD_IN_TRANSACTION } from "@/app/artifact-links/link-implementation-evidence";
import { artifactLinksService } from "@/app/artifact-links/service";
import { contextDocumentService } from "@/app/documents/context-document-service";
import {
  ATTRIBUTION_EVIDENCE_POLICY_FLAG_UNAVAILABLE_LOG_KEY,
  clearAttributionEvidenceGateMemo,
} from "@/lib/attribution-evidence-policy-feature";

const harness = createReceiptRouteHarness();
type World = Awaited<ReturnType<typeof harness.seedWorld>>;

/**
 * ISS-12552: a link write never
 * evaluates `attribution-evidence-policy` while a transaction is open. A
 * caller whose link joins its own transaction, with the request's answer
 * unread, derives nothing and logs it; outside a transaction the memoized
 * organization gate still answers.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 link writes never evaluate the attribution flag inside a transaction",
  () => {
    beforeEach(() => {
      clearAttributionEvidenceGateMemo();
      flag.openTransactions = 0;
      flag.evaluations = [];
      vi.mocked(deriveImplementationEvidence).mockClear();
      const realTx = withDb.tx;
      vi.spyOn(withDb, "tx").mockImplementation(async (run, options) => {
        flag.openTransactions += 1;
        try {
          return await realTx(run, options);
        } finally {
          flag.openTransactions -= 1;
        }
      });
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      clearAttributionEvidenceGateMemo();
      await harness.cleanup();
    });

    it("reads an unread answer as off inside the context PRD's transaction, evaluating nothing", async () => {
      const world = await harness.seedWorld();
      const branchId = await seedWorldBranch(world);
      const warn = vi.spyOn(log, "warn");

      const created = await contextDocumentService.createWithContent(
        {
          organizationId: world.organizationId,
          userId: world.userId,
          sourceDocumentId: branchId,
          projectId: world.projectId,
          title: "Context for a branch",
          content: "context",
          fileName: "context.md",
        },
        () => Promise.resolve()
      );

      expect(created.ok).toBe(true);
      expect(
        flag.evaluations.filter((evaluation) => evaluation.duringTransaction)
      ).toEqual([]);
      expect(deriveImplementationEvidence).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        ATTRIBUTION_EVIDENCE_POLICY_FLAG_UNAVAILABLE_LOG_KEY,
        expect.objectContaining({
          level: "warn",
          status: "warn",
          organizationId: world.organizationId,
          reason: LINK_WRITE_FLAG_UNREAD_IN_TRANSACTION,
        })
      );
    });

    it("still evaluates an unread answer outside a transaction, once per organization", async () => {
      const world = await harness.seedWorld();
      const branchId = await seedWorldBranch(world);
      const first = await harness.seedDocument(world, "Producer one");
      const second = await harness.seedDocument(world, "Producer two");

      const links = [
        await artifactLinksService.createLink(world.organizationId, {
          sourceId: first,
          targetId: branchId,
          linkType: LinkType.Produces,
        }),
        await artifactLinksService.createLink(world.organizationId, {
          sourceId: second,
          targetId: branchId,
          linkType: LinkType.Produces,
        }),
      ];

      expect(links.map((link) => link.ok)).toEqual([true, true]);
      expect(flag.evaluations).toEqual([{ duringTransaction: false }]);
      expect(deriveImplementationEvidence).toHaveBeenCalledTimes(2);
    });
  }
);

function seedWorldBranch(world: World): Promise<string> {
  return seedBranch(
    world.organizationId,
    `link-tx-${randomUUID().slice(0, 8)}`,
    { firstPushedAt: null }
  );
}
