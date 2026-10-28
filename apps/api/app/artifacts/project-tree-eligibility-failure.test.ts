import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

vi.mock("@/app/branches/cloud-branch-eligibility", async () => {
  const { Prisma } = await import("@repo/database");
  return { cloudBranchProductEligibilitySql: () => Prisma.sql`TRUE` };
});

vi.mock("@/app/branches/branch-provider-fallback-service", () => ({
  branchProviderFallbackService: { findByIds: vi.fn(() => new Set()) },
}));

vi.mock("@/app/tags/tag-projection-select", () => ({
  mapTagRelations: vi.fn(() => []),
}));

vi.mock("@/lib/db-utils", () => ({
  basicUserSelect: { select: { id: true, name: true } },
}));

import { ArtifactType } from "@repo/database";
import { log } from "@repo/observability/log";
import { mockWithDbCall } from "../../__tests__/utils/db-helpers";
import { projectTreeService } from "./project-tree-service";

const projectId = "11111111-1111-7111-8111-111111111111";
const organizationId = "22222222-2222-7222-8222-222222222222";
const branchId = "33333333-3333-7333-8333-333333333333";

describe("projectTreeService eligibility failure isolation", () => {
  const queryRaw = vi.fn();
  const findArtifacts = vi.fn();
  const findLinks = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    queryRaw.mockRejectedValue(new Error("classifier timeout"));
    findArtifacts.mockResolvedValue([
      {
        id: branchId,
        organizationId,
        projectId,
        type: ArtifactType.BRANCH,
        subtype: null,
        name: "feature/fail-open",
        slug: null,
        assigneeId: null,
        status: "OPEN",
        priority: null,
        dueDate: null,
        externalUrl: null,
        sortOrder: 100,
        createdAt: new Date("2026-08-18T12:00:00.000Z"),
        createdById: null,
        updatedAt: new Date("2026-08-18T12:00:00.000Z"),
        templateForType: null,
        assignee: null,
      },
    ]);
    findLinks.mockResolvedValue([]);
    mockWithDbCall({
      $queryRaw: queryRaw,
      artifact: { findMany: findArtifacts },
      artifactLink: { findMany: findLinks },
    });
  });

  it("returns the authoritative base tree with omitted fail-closed eligibility", async () => {
    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId
    );

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.root).toMatchObject({
      id: branchId,
      name: "feature/fail-open",
    });
    expect(result.nodes[0]?.root).not.toHaveProperty("productEligibility");
    expect(log.warn).toHaveBeenCalledWith("telemetry.enrichment_failed", {
      enrichmentKind: "branch_product_eligibility",
      errorClass: "Error",
      requestedBranchCount: 1,
    });
  });
});
