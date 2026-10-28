import { BranchListPageMode } from "@repo/api/src/types/branch-list-contract";
import { Prisma } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  organizationId as branchFixtureOrganizationId,
  branchId,
  createMockDb,
  makeBranchRow,
  mockBranchCandidateIds,
  mockBranchCandidatePage,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import {
  getMockWithDb,
  mockWithDbAll,
  mockWithDbTx,
} from "@/__tests__/utils/db-helpers";
import {
  BRANCH_PRODUCT_READ_SNAPSHOT_BOUNDED_TIMEOUT_MS,
  BRANCH_PRODUCT_READ_SNAPSHOT_FULL_CORPUS_TIMEOUT_MS,
  BRANCH_PRODUCT_READ_SNAPSHOT_MAX_WAIT_MS,
  BranchProductReadWorkload,
  withBranchProductReadSnapshot,
} from "./branch-product-read-snapshot";
import { branchReadService } from "./branch-read-service";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

const organizationId = "11111111-1111-4111-8111-111111111111";
const executeRaw = vi.fn().mockResolvedValue(1);

const snapshotOptions = (timeout: number) => ({
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  maxWait: BRANCH_PRODUCT_READ_SNAPSHOT_MAX_WAIT_MS,
  timeout,
});

const expectedTimeoutByWorkload = {
  [BranchProductReadWorkload.Bounded]:
    BRANCH_PRODUCT_READ_SNAPSHOT_BOUNDED_TIMEOUT_MS,
  [BranchProductReadWorkload.FullCorpus]:
    BRANCH_PRODUCT_READ_SNAPSHOT_FULL_CORPUS_TIMEOUT_MS,
} satisfies Record<BranchProductReadWorkload, number>;

describe("withBranchProductReadSnapshot", () => {
  // ISS-10295/ISS-10300: the LITERAL budgets, not the imported constants. Every
  // other assertion in this file compares the wiring against those constants,
  // so reverting the bounded budget to 15s — or collapsing the full-corpus
  // budget back onto the bounded one — would leave them all green. This case is
  // the one that fails.
  it("pins the bounded budget at 45s, the full-corpus budget at 90s, and the wait at 2s", () => {
    expect(BRANCH_PRODUCT_READ_SNAPSHOT_BOUNDED_TIMEOUT_MS).toBe(45_000);
    expect(BRANCH_PRODUCT_READ_SNAPSHOT_FULL_CORPUS_TIMEOUT_MS).toBe(90_000);
    expect(BRANCH_PRODUCT_READ_SNAPSHOT_MAX_WAIT_MS).toBe(2000);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockWithDbTx({ $executeRaw: executeRaw });
  });

  it.each([
    BranchProductReadWorkload.Bounded,
    BranchProductReadWorkload.FullCorpus,
  ])(
    "bounds %s repeatable reads with that workload's own execution budget",
    async (workload) => {
      await expect(
        withBranchProductReadSnapshot(
          organizationId,
          async () => "read",
          workload
        )
      ).resolves.toBe("read");

      expect(getMockWithDb().tx).toHaveBeenCalledWith(
        expect.any(Function),
        snapshotOptions(expectedTimeoutByWorkload[workload])
      );
      expect(executeRaw).not.toHaveBeenCalled();
    }
  );

  // The two budgets must not be the same number: that was the ISS-10300 defect
  // — both workloads mapped to one budget, so the parameter every caller passes
  // changed no behavior at all.
  it("gives the full corpus a strictly larger execution budget than a bounded read", () => {
    expect(BRANCH_PRODUCT_READ_SNAPSHOT_FULL_CORPUS_TIMEOUT_MS).toBeGreaterThan(
      BRANCH_PRODUCT_READ_SNAPSHOT_BOUNDED_TIMEOUT_MS
    );
  });

  it("treats an unspecified workload as bounded", async () => {
    await expect(
      withBranchProductReadSnapshot(organizationId, async () => "read")
    ).resolves.toBe("read");

    expect(getMockWithDb().tx).toHaveBeenCalledWith(
      expect.any(Function),
      snapshotOptions(BRANCH_PRODUCT_READ_SNAPSHOT_BOUNDED_TIMEOUT_MS)
    );
  });
});

describe("branchReadService snapshot wiring", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockWithDbAll(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
  });

  // ISS-10300 (#7314 review): which workload each service read opens is the
  // contract this case exists to pin, and the first version of it pinned the
  // WRONG one — it drove only the legacy list arm and asserted `Bounded`, so it
  // documented the defect instead of catching it. `pageMode=server` is what Web
  // and Desktop request, it reads the whole corpus before slicing the page, and
  // it is the path that expired the budget in the ISS-10295 incident, so it is
  // full-corpus. Asserting per call — rather than looping every call against one
  // shared options object, as this case also did before — is what proves the
  // workload argument actually reaches the transaction instead of being inert.
  it("opens each corpus response on its own workload's snapshot budget", async () => {
    mockDb.$queryRaw.mockResolvedValue([]);
    mockDb.artifact.findMany.mockResolvedValue([]);

    await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });
    await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
      pageMode: BranchListPageMode.Server,
    });
    await branchReadService.getBranchUsage(organizationId, {
      limit: 50,
      offset: 0,
    });
    await branchReadService.getBranchAnalytics(organizationId, {
      limit: 50,
      offset: 0,
    });
    await branchReadService.getBranchCohortAnalytics(organizationId, {
      branchIds: [branchId],
    });

    const expectedWorkloadsInCallOrder = [
      BranchProductReadWorkload.Bounded,
      BranchProductReadWorkload.FullCorpus,
      BranchProductReadWorkload.FullCorpus,
      // The two analytics reads each open a SECOND full-corpus transaction for
      // the cohort cost facts (ISS-12346): the rollup freshness gate and the
      // aggregation that trusts it must share one snapshot, and they run on
      // their own connection, so they cannot borrow the branch read's.
      BranchProductReadWorkload.FullCorpus,
      BranchProductReadWorkload.FullCorpus,
      BranchProductReadWorkload.FullCorpus,
      BranchProductReadWorkload.FullCorpus,
    ];
    const calls = getMockWithDb().tx.mock.calls;

    expect(calls).toHaveLength(expectedWorkloadsInCallOrder.length);
    expect(calls.map(([, options]) => options)).toEqual(
      expectedWorkloadsInCallOrder.map((workload) =>
        snapshotOptions(expectedTimeoutByWorkload[workload])
      )
    );
  });

  // The regression the #7314 review found: a server-mode list wired to the
  // bounded budget. The case above would also catch it, but only as one entry in
  // a five-element array diff; this one names the incident path on its own so the
  // failure says what broke.
  it("opens the server-mode list — the incident path — on the full-corpus budget", async () => {
    mockDb.$queryRaw.mockResolvedValue([]);
    mockDb.artifact.findMany.mockResolvedValue([]);

    await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
      pageMode: BranchListPageMode.Server,
    });

    expect(getMockWithDb().tx).toHaveBeenCalledWith(
      expect.any(Function),
      snapshotOptions(BRANCH_PRODUCT_READ_SNAPSHOT_FULL_CORPUS_TIMEOUT_MS)
    );
  });

  // ISS-7140 — this case must reach the Product gate, which takes two things it
  // used to lack. It drove the LOCAL `organizationId` against a `makeBranchRow`
  // stamped with the fixture's own org, so findBranchArtifact rejected it on org
  // scope after a single read; and it revoked eligibility with a bare
  // `$queryRaw.mockResolvedValueOnce`, which supersedes the implementation on
  // the FIRST call rather than the gate's. Queued as the third candidate slot,
  // against the fixture's org, the empty page is the gate's own read.
  it("fails a detail read closed when the Product gate finds the admitted branch ineligible", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockBranchCandidatePage(mockDb, [branchId]);
    mockBranchCandidateIds(mockDb, []);
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());

    await expect(
      branchReadService.getBranchDetail(branchFixtureOrganizationId, branchId)
    ).resolves.toBeNull();
    // `toBeNull()` alone does not say the gate ran: every earlier bail in
    // `getBranchDetail` returns null too — an invalid id, a missing or
    // unconfirmed candidate, a null `artifact.findFirst`, an org-scope
    // rejection, a null on-read refresh, an unresolvable associated PR. That is
    // how this case originally shipped green without reaching the gate at all.
    // The identity/usage read is issued alongside the gate and nowhere earlier,
    // so it is what separates the gate's denial from an earlier bail. Its
    // sibling in `branch-read-service.product-gate-order.test.ts` uses the same
    // guard.
    expect(mockDb.artifactLink.findMany).toHaveBeenCalled();
  });

  // ISS-11767: the detail identity read's stored PR comments and lane proof
  // must come from one bounded snapshot. A distinct snapshot client is what
  // tells "ran on the snapshot" apart from "a snapshot was opened somewhere".
  it("reads detail identity on one bounded snapshot, not the plain client", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    const snapshotDb = createMockDb();
    mockWithDbTx(snapshotDb);

    await branchReadService.getBranchDetail(
      branchFixtureOrganizationId,
      branchId
    );

    expect(getMockWithDb().tx.mock.calls.map(([, options]) => options)).toEqual(
      [snapshotOptions(BRANCH_PRODUCT_READ_SNAPSHOT_BOUNDED_TIMEOUT_MS)]
    );
    expect(snapshotDb.artifactLink.findMany).toHaveBeenCalled();
    expect(snapshotDb.gitHubCommentProjection.findMany).toHaveBeenCalled();
    expect(mockDb.artifactLink.findMany).not.toHaveBeenCalled();
    expect(mockDb.gitHubCommentProjection.findMany).not.toHaveBeenCalled();
  });

  it("uses candidate ids directly for the full usage corpus", async () => {
    const branchIds = Array.from(
      { length: 501 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
    );
    mockBranchCandidateIds(mockDb, branchIds);

    const response = await branchReadService.getBranchUsage(organizationId, {
      limit: 50,
      offset: 0,
    });

    expect(mockDb.artifact.findMany).not.toHaveBeenCalled();
    expect(mockDb.artifactLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          targetId: { in: branchIds },
        }),
      })
    );
    expect(response.totalBranches).toBe(501);
  });
});
