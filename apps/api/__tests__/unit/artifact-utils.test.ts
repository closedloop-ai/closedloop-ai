import type { PrismaClient } from "@repo/database";
import { vi } from "vitest";
import {
  buildArtifactScopeCondition,
  prepareArtifactVersion,
} from "@/app/artifacts/artifact-utils";

// Type-safe transaction mock helper
type TransactionClient = Pick<PrismaClient, "artifact" | "project">;

function createMockTransaction(
  overrides?: Partial<TransactionClient>
): TransactionClient {
  return {
    artifact: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      ...overrides?.artifact,
    },
    project: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      ...overrides?.project,
    },
  } as TransactionClient;
}

describe("buildArtifactScopeCondition", () => {
  it("includes workstreamId when provided", () => {
    const result = buildArtifactScopeCondition({
      organizationId: "org-123",
      workstreamId: "ws-123",
      type: "PRD",
      documentSlug: "test-doc",
    });
    expect(result).toEqual({
      organizationId: "org-123",
      workstreamId: "ws-123",
      type: "PRD",
      documentSlug: "test-doc",
    });
  });

  it("includes projectId when provided", () => {
    const result = buildArtifactScopeCondition({
      organizationId: "org-123",
      projectId: "proj-123",
      type: "IMPLEMENTATION_PLAN",
      documentSlug: null,
    });
    expect(result).toEqual({
      organizationId: "org-123",
      projectId: "proj-123",
      type: "IMPLEMENTATION_PLAN",
      documentSlug: null,
    });
  });

  it("omits workstreamId and projectId when null", () => {
    const result = buildArtifactScopeCondition({
      organizationId: "org-123",
      type: "PRD",
      documentSlug: "test",
    });
    expect(result).toEqual({
      organizationId: "org-123",
      type: "PRD",
      documentSlug: "test",
    });
  });
});

describe("prepareArtifactVersion", () => {
  it("marks existing artifacts as not latest", async () => {
    const mockTx = createMockTransaction({
      artifact: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue({ version: 2 }),
      } as any,
    });

    const result = await prepareArtifactVersion(mockTx as any, {
      organizationId: "org-123",
      type: "PRD",
      documentSlug: "test-doc",
    });

    expect(mockTx.artifact.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-123",
        type: "PRD",
        documentSlug: "test-doc",
        isLatest: true,
      },
      data: { isLatest: false },
    });
    expect(result).toBe(3); // version 2 + 1
  });

  it("returns version 1 when no existing artifacts", async () => {
    const mockTx = createMockTransaction({
      artifact: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findFirst: vi.fn().mockResolvedValue(null),
      } as any,
    });

    const result = await prepareArtifactVersion(mockTx as any, {
      organizationId: "org-123",
      type: "PRD",
      documentSlug: "new-doc",
    });

    expect(result).toBe(1);
  });

  // CONCURRENCY EDGE CASE (added per test-strategist feedback)
  it("handles race condition when two versions created simultaneously", async () => {
    const mockTx = createMockTransaction({
      artifact: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue({ version: 3 }),
      } as any,
    });

    const version1 = await prepareArtifactVersion(mockTx as any, {
      organizationId: "org-123",
      type: "PRD",
      documentSlug: "concurrent-test",
    });

    // Both should return version 4 (findFirst returns highest existing version)
    expect(version1).toBe(4);
  });
});
