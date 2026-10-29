import { randomUUID } from "node:crypto";
import { LinkType } from "@repo/api/src/types/artifact";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyRouteRequest,
  countReceipts,
  createReceiptRouteHarness,
  receiptRouteParams,
  turnAttributionFlagOff,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";
import { receiptRouteState } from "@/__tests__/support/lib/operation-receipt-route.test-mocks";
import { countTransactions } from "@/__tests__/support/lib/transaction-count.test-helpers";
import { createTestAuthContext } from "@/__tests__/utils/auth-helpers";
import { seedBranch as seedBranchRow } from "@/__tests__/utils/branch-identity-sql-fixture";
import type { AuthContext } from "@/lib/auth/with-auth";

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

import { DELETE as deleteLink } from "@/app/artifact-links/[id]/route";
import { POST as createLink } from "@/app/artifact-links/route";
import { DELETE as deleteBranch } from "@/app/branches/[id]/route";
import { consumeRefreshBudget } from "@/app/branches/branch-refresh-support";

const harness = createReceiptRouteHarness();
const rateLimitSubjects: string[] = [];

/** Mirrors `branch-refresh-support.ts`'s private bucket names and limit. */
const ACTOR_BUCKET = "branch_refresh:actor";
const ORG_BUCKET = "branch_refresh:org";
const ORG_BUCKET_LIMIT = 20;

/**
 * ISS-12552: flag-off behavior equals main for branch and link writes. With
 * `attribution-evidence-policy` off, or for a session caller, branch deletes,
 * the refresh budget and link writes run exactly as they do on main.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 branch and link writes match main with attribution evidence off",
  () => {
    afterEach(async () => {
      vi.restoreAllMocks();
      const subjects = rateLimitSubjects.splice(0);
      await withDb((db) =>
        db.oAuthRateLimit.deleteMany({ where: { subject: { in: subjects } } })
      );
      await harness.cleanup();
    });

    it("a branch delete opens no transaction, as on main", async () => {
      const world = await harness.seedWorld();
      const branchId = await seedBranchRow(
        world.organizationId,
        `parity-${randomUUID().slice(0, 8)}`,
        { firstPushedAt: null }
      );
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await deleteBranch(
        apiKeyRouteRequest("DELETE", `/branches/${branchId}`),
        receiptRouteParams({ id: branchId })
      );

      expect(response.status).toBe(200);
      expect(transactions.calls).toBe(0);
      expect(
        await withDb((db) => db.artifact.count({ where: { id: branchId } }))
      ).toBe(0);
    });

    it("an organization refusal keeps the caller's spend, one transaction per bucket, as on main", async () => {
      const world = await harness.seedWorld();
      const actor = { userId: world.userId, authMethod: "session" };
      const actorSubject = `${world.organizationId}:session:${world.userId}`;
      rateLimitSubjects.push(actorSubject, world.organizationId);
      const now = new Date();
      await withDb((db) =>
        db.oAuthRateLimit.create({
          data: {
            bucket: ORG_BUCKET,
            subject: world.organizationId,
            requestCount: ORG_BUCKET_LIMIT,
            windowStartedAt: now,
            windowExpiresAt: new Date(now.getTime() + 60_000),
          },
        })
      );
      const transactions = countTransactions();

      const decision = await consumeRefreshBudget(
        world.organizationId,
        { ...actor, tagPermissions: { canApply: true, canRemove: true } },
        now
      );

      expect(decision.ok).toBe(false);
      expect(transactions.opened).toBe(2);
      const actorBucket = await withDb((db) =>
        db.oAuthRateLimit.findUnique({
          where: {
            bucket_subject: { bucket: ACTOR_BUCKET, subject: actorSubject },
          },
          select: { requestCount: true },
        })
      );
      expect(actorBucket?.requestCount).toBe(1);
    });

    it("a link create and delete open no transaction beyond main's, for a session caller", async () => {
      const world = await harness.seedWorld();
      const sourceId = await harness.seedDocument(world, "Source");
      const targetId = await harness.seedDocument(world, "Target");
      useSessionCaller();
      const transactions = countTransactions();

      const created = await createLink(
        apiKeyRouteRequest("POST", "/artifact-links", {
          sourceId,
          targetId,
          linkType: LinkType.RelatesTo,
        }),
        receiptRouteParams({})
      );
      const createCalls = transactions.calls;
      const linkId = ((await created.json()) as { data: { id: string } }).data
        .id;
      const removed = await deleteLink(
        apiKeyRouteRequest("DELETE", `/artifact-links/${linkId}`),
        receiptRouteParams({ id: linkId })
      );

      expect([created.status, removed.status]).toEqual([200, 200]);
      // Main writes an ordinary link with one autocommit insert, and deletes
      // it in the delete's own transaction; a non-BLOCKS delete unblocks
      // nothing.
      expect(createCalls).toBe(0);
      expect(transactions.opened).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("a link create opens no transaction for an API-key caller with the flag off", async () => {
      const world = await harness.seedWorld();
      const sourceId = await harness.seedDocument(world, "Related");
      const targetId = await harness.seedDocument(world, "Relative");
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const created = await createLink(
        apiKeyRouteRequest("POST", "/artifact-links", {
          sourceId,
          targetId,
          linkType: LinkType.Blocks,
        }),
        receiptRouteParams({})
      );

      expect(created.status).toBe(200);
      expect(transactions.calls).toBe(0);
    });
  }
);

function useSessionCaller(): void {
  const apiKeyContext = receiptRouteState.context as AuthContext;
  receiptRouteState.context = createTestAuthContext({
    user: apiKeyContext.user,
    authMethod: "session",
  });
}
