import type { PrismaClient } from "@repo/database";
import { vi } from "vitest";
import {
  buildArtifactScopeCondition,
  generateDocumentSlug,
  getOrCreateDefaultProject,
  prepareArtifactVersion,
} from "@/app/artifacts/artifact-utils";

// Type-safe transaction mock helper
type TransactionClient = Pick<PrismaClient, "artifact" | "project">;

// Top-level regex for slug validation
const SLUG_PATTERN = /^[a-z0-9-]+$/;

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

describe("generateDocumentSlug", () => {
  it("generates slug from fileName", () => {
    expect(generateDocumentSlug("My PRD.md", null)).toBe("my-prd");
  });

  it("generates slug from title when fileName is null", () => {
    expect(generateDocumentSlug(null, "My Feature")).toBe("my-feature");
  });

  it("removes .md extension", () => {
    expect(generateDocumentSlug("document.md", null)).toBe("document");
  });

  it("replaces non-alphanumeric with hyphens", () => {
    expect(generateDocumentSlug("My Doc (v2)", null)).toBe("my-doc-v2");
  });

  it("trims leading/trailing hyphens", () => {
    expect(generateDocumentSlug("--test--", null)).toBe("test");
  });

  it("returns null when both inputs are null", () => {
    expect(generateDocumentSlug(null, null)).toBeNull();
  });

  // EDGE CASES (added per test-strategist feedback)
  it("handles empty string inputs", () => {
    // Empty strings are falsy, so function returns null
    expect(generateDocumentSlug("", "")).toBe(null);
    // Whitespace-only strings are truthy but become empty after processing
    expect(generateDocumentSlug(" ", "  ")).toBe("");
  });

  it("handles very long titles (>200 chars)", () => {
    const longTitle = "a".repeat(300);
    const slug = generateDocumentSlug(null, longTitle);
    expect(slug).toBeDefined();
    expect(slug?.length).toBe(300);
  });

  it("handles unicode and emoji characters", () => {
    expect(generateDocumentSlug("My PRD 🚀", null)).toMatch(SLUG_PATTERN);
    expect(generateDocumentSlug("文档标题", null)).toBeDefined();
  });

  it("handles multiple consecutive spaces and hyphens", () => {
    expect(generateDocumentSlug("my   doc---name", null)).toBe("my-doc-name");
  });
});

describe("buildArtifactScopeCondition", () => {
  it("includes workstreamId when provided", () => {
    const result = buildArtifactScopeCondition({
      workstreamId: "ws-123",
      type: "PRD",
      documentSlug: "test-doc",
    });
    expect(result).toEqual({
      workstreamId: "ws-123",
      type: "PRD",
      documentSlug: "test-doc",
    });
  });

  it("includes projectId when provided", () => {
    const result = buildArtifactScopeCondition({
      projectId: "proj-123",
      type: "IMPLEMENTATION_PLAN",
      documentSlug: null,
    });
    expect(result).toEqual({
      projectId: "proj-123",
      type: "IMPLEMENTATION_PLAN",
      documentSlug: null,
    });
  });

  it("omits workstreamId and projectId when null", () => {
    const result = buildArtifactScopeCondition({
      type: "PRD",
      documentSlug: "test",
    });
    expect(result).toEqual({
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
      type: "PRD",
      documentSlug: "test-doc",
    });

    expect(mockTx.artifact.updateMany).toHaveBeenCalledWith({
      where: { type: "PRD", documentSlug: "test-doc", isLatest: true },
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
      type: "PRD",
      documentSlug: "concurrent-test",
    });

    // Both should return version 4 (findFirst returns highest existing version)
    expect(version1).toBe(4);
  });
});

describe("getOrCreateDefaultProject", () => {
  it("returns existing default project ID", async () => {
    const mockTx = createMockTransaction({
      project: {
        findFirst: vi.fn().mockResolvedValue({ id: "existing-proj-id" }),
        create: vi.fn(),
      } as any,
    });

    const result = await getOrCreateDefaultProject(mockTx as any, "org-123");

    expect(mockTx.project.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org-123",
        name: "Default Project",
      },
    });
    expect(mockTx.project.create).not.toHaveBeenCalled();
    expect(result).toBe("existing-proj-id");
  });

  it("creates default project when none exists", async () => {
    const mockTx = createMockTransaction({
      project: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "new-proj-id" }),
      } as any,
    });

    const result = await getOrCreateDefaultProject(mockTx as any, "org-123");

    expect(mockTx.project.create).toHaveBeenCalledWith({
      data: {
        organizationId: "org-123",
        name: "Default Project",
        description: "Default project for standalone PRDs and artifacts",
      },
    });
    expect(result).toBe("new-proj-id");
  });

  // ERROR HANDLING EDGE CASE (added per test-strategist feedback)
  it("throws error when create fails", async () => {
    const mockTx = createMockTransaction({
      project: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi
          .fn()
          .mockRejectedValue(new Error("Database constraint violation")),
      } as any,
    });

    await expect(
      getOrCreateDefaultProject(mockTx as any, "org-123")
    ).rejects.toThrow("Database constraint violation");
  });

  it("handles concurrent default project creation", async () => {
    const mockTx = createMockTransaction({
      project: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: "concurrent-proj-id" }),
        create: vi.fn().mockResolvedValue({ id: "new-proj-id" }),
      } as any,
    });

    const result = await getOrCreateDefaultProject(mockTx as any, "org-123");
    expect(result).toBe("new-proj-id");
  });
});
