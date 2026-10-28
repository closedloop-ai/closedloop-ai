/**
 * The legacy per-session `byActor` usage buckets. Split out of
 * `branch-read-service.owner.test.ts`, which owns the canonical Branch
 * Owner/Collaborators identity projection: these cover how already-resolved
 * owners are ROLLED UP into per-actor spend, not how an owner is resolved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN" },
  });
});

vi.mock("@repo/github", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/github")>("@repo/github");
  return {
    ...actual,
    getSinglePullRequestWithProviderResult: vi.fn(),
  };
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
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

afterEach(() => {
  vi.useRealTimers();
});

describe("branchReadService byActor usage buckets (FEA-3457)", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
  });

  const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("groups byActor buckets by resolved owner over distinct sessions", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(branchId, "s1", "2.00", ownerA),
      makeSessionLink(branchId, "s2", "1.00", ownerB),
    ]);
    mockDb.user.findMany.mockResolvedValue([
      {
        id: ownerA,
        email: "ada@example.com",
        firstName: "Ada",
        lastName: null,
      },
      {
        id: ownerB,
        email: "bob@example.com",
        firstName: "Bob",
        lastName: null,
      },
    ]);

    const response = await branchReadService.getBranchUsage(organizationId, {
      limit: 50,
      offset: 0,
    });

    // One bucket per owner, ordered by cost desc (Ada 2.0 before Bob 1.0).
    expect(response.byActor.map((bucket) => bucket.owner)).toEqual([
      "Ada",
      "Bob",
    ]);
    expect(response.byActor[0].estimatedCostUsd).toBeCloseTo(2, 10);
  });

  it("keeps distinct owner ids that resolve to the SAME display name as separate byActor buckets (no name-merge double-count)", async () => {
    // Two different users who happen to share a display name ("Alex Kim").
    // Grouping byActor by name would collapse them into one bucket and
    // double-count cost/tokens under a single owner — an attribution bug. They
    // must stay as two distinct buckets keyed by owner id.
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(branchId, "s1", "2.00", ownerA),
      makeSessionLink(branchId, "s2", "1.00", ownerB),
    ]);
    mockDb.user.findMany.mockResolvedValue([
      {
        id: ownerA,
        email: "alex.kim.a@example.com",
        firstName: "Alex",
        lastName: "Kim",
      },
      {
        id: ownerB,
        email: "alex.kim.b@example.com",
        firstName: "Alex",
        lastName: "Kim",
      },
    ]);

    const response = await branchReadService.getBranchUsage(organizationId, {
      limit: 50,
      offset: 0,
    });

    // Two separate buckets (not one merged "Alex Kim" bucket at 3.00).
    expect(response.byActor).toHaveLength(2);
    expect(response.byActor.map((bucket) => bucket.owner)).toEqual([
      "Alex Kim",
      "Alex Kim",
    ]);
    // Each bucket keeps its own session's cost — no double-count.
    expect(response.byActor[0].estimatedCostUsd).toBeCloseTo(2, 10);
    expect(response.byActor[1].estimatedCostUsd).toBeCloseTo(1, 10);
  });

  it("folds ownerless sessions into a trailing unattributed byActor bucket", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(branchId, "s1", "2.00", ownerA),
      makeSessionLink(branchId, "s2", "1.00", null),
    ]);
    mockDb.user.findMany.mockResolvedValue([
      {
        id: ownerA,
        email: "ada@example.com",
        firstName: "Ada",
        lastName: null,
      },
    ]);

    const response = await branchReadService.getBranchUsage(organizationId, {
      limit: 50,
      offset: 0,
    });

    // Named owner first, the null (unattributed) bucket last.
    expect(response.byActor.map((bucket) => bucket.owner)).toEqual([
      "Ada",
      null,
    ]);
  });
});
