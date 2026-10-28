import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN" },
  });
});

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/observability/tracing/spans", () => ({
  setAppSpanAttributes: vi.fn(),
  withAppSpan: (_name: string, callback: () => unknown) => callback(),
}));

import {
  createMockDb,
  makeBranchRow,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import {
  BranchListEnrichmentRead,
  createBranchListEnrichmentDomain,
} from "./branch-list-enrichment";
import { projectBranchListRows } from "./branch-list-projection";

const TIMEOUT_ERROR = "canceling statement due to statement timeout";

/**
 * #8602 review (tamsinb): the canonical analytics arm hands its identity
 * evidence to the windowed arm through `onIdentityData`. An unavailable read
 * substitutes empty Maps, and an empty Map is not `undefined`, so offering it
 * would stop the windowed arm from reading identity itself. These cases drive
 * the real projection so deleting the availability gate fails here.
 */
describe("projectBranchListRows identity reuse gate", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
  });

  function project(
    onIdentityData: (data: unknown) => void,
    enrichment = createBranchListEnrichmentDomain()
  ) {
    return projectBranchListRows(
      mockDb as unknown as Parameters<typeof projectBranchListRows>[0],
      organizationId,
      [makeBranchRow({})],
      { evaluationNow: now },
      undefined,
      { includeAttributedCost: false, onIdentityData, enrichment }
    );
  }

  it("does not offer the unavailable fallback when the identity read fails", async () => {
    mockDb.artifactLink.findMany.mockRejectedValue(new Error(TIMEOUT_ERROR));
    const onIdentityData = vi.fn();
    const enrichment = createBranchListEnrichmentDomain();

    await project(onIdentityData, enrichment);

    expect(enrichment.unavailable.has(BranchListEnrichmentRead.Identity)).toBe(
      true
    );
    expect(onIdentityData).not.toHaveBeenCalled();
  });

  it("offers the evidence when the identity read succeeds", async () => {
    mockDb.artifactLink.findMany.mockResolvedValue([]);
    const onIdentityData = vi.fn();

    await project(onIdentityData);

    expect(onIdentityData).toHaveBeenCalledTimes(1);
    expect(onIdentityData.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        windowed: expect.any(Map),
        lifetime: expect.any(Map),
        identityByBranch: expect.any(Map),
      })
    );
  });
});
