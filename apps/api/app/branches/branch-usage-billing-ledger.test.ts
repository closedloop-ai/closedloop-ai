/**
 * @file branch-usage-billing-ledger.test.ts
 * @description ISS-5445 — the cloud `getBranchUsage` billing-ledger split.
 *
 * The cloud Branch usage fold must divide subscription-covered spend from
 * metered API spend using each session's stored `billingMode`, through the SAME
 * canonical classifier the desktop projection uses
 * (`@repo/api/src/types/billing-mode`, bound to the desktop canonical sets by
 * `subscription-billing-mode-parity.test.ts`).
 *
 * Before ISS-5445 `branch-read-service.getBranchUsage` hardcoded
 * `subscriptionEstimatedCost: 0` and assigned every dollar to `apiEstimatedCost`
 * — it never even SELECTED `billingMode` — so the same synced session read as
 * subscription on Sessions and as API spend on Branches. That divergence dates
 * to FEA-2532 (#2263) and affected every subscription mode, not just `opencode`.
 *
 * These tests drive the real production read path (`branchReadService
 * .getBranchUsage`), not the pure projection helper, because the defect lived in
 * the call site rather than in the math. Mutation-checked: restoring the
 * hardcoded shape turns the first test RED (`expected +0 to be close to 15`).
 *
 * Lives in its own file rather than in `branch-read-service.test.ts` because that
 * file is on the shrink-only `noExcessiveLinesPerFile` grandfather list and must
 * never grow.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN" },
  });
});

import {
  branchId,
  createMockDb,
  makeBranchRow,
  makeSessionLink,
  mockBranchCandidateIds,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import {
  getMockWithDb,
  mockWithDbCall,
  mockWithDbTx,
} from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

/** `makeSessionLink` positional tail: userId, metadata, participation, timing. */
function sessionWithMode(
  sessionId: string,
  cost: string,
  billingMode: string | null
) {
  return makeSessionLink(
    branchId,
    sessionId,
    cost,
    null,
    null,
    null,
    {},
    billingMode
  );
}

describe("getBranchUsage billing-ledger split (ISS-5445)", () => {
  // Resolves the hoisted `withDb` mock so `mockWithDbCall` can bind this suite's
  // db to it; the handle itself is not asserted on here.
  getMockWithDb();
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
  });

  it("splits subscription vs API spend from billingMode on the production usage path", async () => {
    mockDb.artifactLink.findMany.mockResolvedValue([
      // Subscription-covered seat/plan session: a "would have cost" equivalent
      // that must NOT land in API spend.
      sessionWithMode("s-pro", "10.00", "pro"),
      // Confirmed metered per-token spend. ISS-5445 (operator ruling): a
      // PRICED-model OpenCode session is stamped `api` too, because billing
      // follows the model rather than the harness — so this row stands for both
      // a classic API session and a paid BYOK OpenCode one.
      sessionWithMode("s-api", "2.00", "api"),
      // Unknown ledger, two ways in. A legacy row with no captured mode, and a
      // row still stamped with the bare `opencode` harness value — which names a
      // harness, not a payment method, so its billing was never determined. Both
      // count toward the TOTAL and toward NEITHER sub-bucket, mirroring the
      // desktop projection.
      sessionWithMode("s-legacy", "1.00", null),
      sessionWithMode("s-opencode-legacy", "5.00", "opencode"),
    ]);

    const response = await branchReadService.getBranchUsage(organizationId, {
      limit: 50,
      offset: 0,
    });

    // pro (10) only — NOT the hardcoded 0 this replaced.
    expect(response.subscriptionEstimatedCost).toBeCloseTo(10, 10);
    // api (2) only — NOT the full 18 the old code assigned to API spend.
    expect(response.apiEstimatedCost).toBeCloseTo(2, 10);
    // Every session still counts toward the total, including the unknown rows.
    expect(response.totalEstimatedCost).toBeCloseTo(18, 10);
    // The sub-buckets are DISJOINT and deliberately do NOT sum to the total: the
    // $1 legacy row and the $5 bare-`opencode` row belong to neither. Asserting
    // the residual keeps that explicit, so a change that silently folds unknown
    // into either bucket fails here instead of quietly moving money.
    expect(
      response.totalEstimatedCost -
        response.subscriptionEstimatedCost -
        response.apiEstimatedCost
    ).toBeCloseTo(6, 10);
  });

  it("classifies an unrecognized mode from a newer peer as unknown, never as spend", async () => {
    // Version skew: `billingMode` is an additive union on the relay sync
    // contract, so a newer desktop can store a mode this build has never heard
    // of. It must degrade to the unknown ledger — counted in the total, absent
    // from both sub-buckets — rather than being guessed into one or throwing.
    mockDb.artifactLink.findMany.mockResolvedValue([
      sessionWithMode("s-future", "9.00", "anthropic_flex_2027"),
      sessionWithMode("s-literal-unknown", "3.00", "unknown"),
    ]);

    const response = await branchReadService.getBranchUsage(organizationId, {
      limit: 50,
      offset: 0,
    });

    expect(response.subscriptionEstimatedCost).toBe(0);
    expect(response.apiEstimatedCost).toBe(0);
    expect(response.totalEstimatedCost).toBeCloseTo(12, 10);
  });

  it("counts a session linked to several branches once in each ledger bucket", async () => {
    // `sumDistinctSessionUsage` de-dupes by session identity so a session shared
    // across branches is not multiplied. The ledger split runs on that SAME dedup
    // pass, so it must not double-count either.
    const secondBranchId = "33333333-3333-4333-8333-333333333333";
    mockBranchCandidateIds(mockDb, [branchId, secondBranchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({ id: branchId }),
      makeBranchRow({ id: secondBranchId }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      sessionWithMode("s-shared", "10.00", "pro"),
      makeSessionLink(
        secondBranchId,
        "s-shared",
        "10.00",
        null,
        null,
        null,
        {},
        "pro"
      ),
    ]);

    const response = await branchReadService.getBranchUsage(organizationId, {
      limit: 50,
      offset: 0,
    });

    expect(response.subscriptionEstimatedCost).toBeCloseTo(10, 10);
    expect(response.totalEstimatedCost).toBeCloseTo(10, 10);
    expect(response.apiEstimatedCost).toBe(0);
  });
});
