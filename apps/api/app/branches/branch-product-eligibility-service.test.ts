import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

vi.mock("./cloud-branch-eligibility", async () => {
  const { Prisma } = await import("@repo/database");
  return { cloudBranchProductEligibilitySql: () => Prisma.sql`TRUE` };
});

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

import { BranchProductEligibility } from "@repo/api/src/types/branch-product-eligibility";
import { log } from "@repo/observability/log";
import { renderSql } from "../../__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall } from "../../__tests__/utils/db-helpers";
import { branchProductEligibilityService } from "./branch-product-eligibility-service";

const organizationId = "11111111-1111-7111-8111-111111111111";

describe("branchProductEligibilityService.findByIds", () => {
  const queryRaw = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    queryRaw.mockResolvedValue([]);
    mockWithDbCall({ $queryRaw: queryRaw });
  });

  it("maps canonical SQL booleans to the additive contract", async () => {
    queryRaw.mockResolvedValue([
      { eligible: true, id: "branch-1" },
      { eligible: false, id: "branch-2" },
    ]);

    const result = await branchProductEligibilityService.findByIds(
      organizationId,
      ["branch-1", "branch-2", "branch-1"]
    );

    expect(result).toEqual(
      new Map([
        ["branch-1", BranchProductEligibility.Eligible],
        ["branch-2", BranchProductEligibility.Ineligible],
      ])
    );
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("does not exclude a deleted Branch from the eligibility read (ISS-11589)", async () => {
    await branchProductEligibilityService.findByIds(organizationId, [
      "branch-1",
    ]);

    expect(renderSql(queryRaw.mock.calls[0]?.[0])).not.toContain("deleted_at");
  });

  it("uses fixed sequential batches instead of per-row reads", async () => {
    const ids = Array.from({ length: 501 }, (_, index) => `branch-${index}`);

    await branchProductEligibilityService.findByIds(organizationId, ids);

    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("does no database work for an empty set", async () => {
    await expect(
      branchProductEligibilityService.findByIds(organizationId, [])
    ).resolves.toEqual(new Map());
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("fails closed without retaining partial eligibility when a batch rejects", async () => {
    queryRaw
      .mockResolvedValueOnce([{ eligible: true, id: "branch-0" }])
      .mockRejectedValueOnce(new Error("eligibility unavailable"));
    const ids = Array.from({ length: 501 }, (_, index) => `branch-${index}`);

    await expect(
      branchProductEligibilityService.findByIds(organizationId, ids)
    ).resolves.toEqual(new Map());
    expect(log.warn).toHaveBeenCalledWith("telemetry.enrichment_failed", {
      enrichmentKind: "branch_product_eligibility",
      errorClass: "Error",
      requestedBranchCount: 501,
    });
  });
});
