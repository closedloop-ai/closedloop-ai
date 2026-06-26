import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { ProjectStatus } from "@repo/api/src/types/project";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  ArtifactType: { DOCUMENT: "DOCUMENT" },
  ArtifactSubtype: {
    PRD: "PRD",
    IMPLEMENTATION_PLAN: "IMPLEMENTATION_PLAN",
    TEMPLATE: "TEMPLATE",
    FEATURE: "FEATURE",
  },
}));

import { withDb } from "@repo/database";
import { searchService } from "./service";

const mockWithDb = withDb as unknown as Mock;

const TEST_ORG_ID = "org-123";

function installDb(db: Record<string, unknown>) {
  mockWithDb.mockImplementation((callback: any) => callback(db));
}

function makeArtifactRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "art-1",
    name: "Test Document",
    slug: "FEA-414",
    subtype: DocumentType.Feature,
    status: DocumentStatus.Draft,
    priority: Priority.Medium,
    updatedAt: new Date("2024-01-01"),
    assignee: null,
    project: { name: "Project A" },
    ...overrides,
  };
}

function makeProjectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "proj-1",
    name: "Test Project",
    slug: "PRO-5",
    status: ProjectStatus.NotStarted,
    priority: Priority.Medium,
    updatedAt: new Date("2024-01-01"),
    assignee: null,
    teams: [{ team: { id: "team-1", name: "Team A" } }],
    ...overrides,
  };
}

describe("searchService.search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes slug in project OR clause", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([]);
    installDb({
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      project: { findMany: mockFindMany },
    });

    await searchService.search(TEST_ORG_ID, "PRO-5");

    const call = mockFindMany.mock.calls[0][0];
    expect(call.where.OR).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: { contains: "PRO-5", mode: "insensitive" },
        }),
      ])
    );
  });

  it("matches documents by TYPE label and by TAG, not just name/slug", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([]);
    installDb({
      artifact: { findMany: mockFindMany },
      project: { findMany: vi.fn().mockResolvedValue([]) },
    });

    await searchService.search(TEST_ORG_ID, "implementation");

    // Two prioritized passes: [0] = text (name/slug), [1] = broad (subtype + tag).
    const textOr = mockFindMany.mock.calls[0][0].where.OR;
    expect(textOr).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: { contains: "implementation", mode: "insensitive" },
        }),
        expect.objectContaining({
          slug: { contains: "implementation", mode: "insensitive" },
        }),
      ])
    );
    const broadOr = mockFindMany.mock.calls[1][0].where.OR;
    expect(broadOr).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subtype: { in: expect.arrayContaining(["IMPLEMENTATION_PLAN"]) },
        }),
        expect.objectContaining({
          tagArtifacts: {
            some: {
              tag: {
                organizationId: TEST_ORG_ID,
                name: { contains: "implementation", mode: "insensitive" },
              },
            },
          },
        }),
      ])
    );
  });

  it("omits the subtype clause from the broad pass when no type label matches", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([]);
    installDb({
      artifact: { findMany: mockFindMany },
      project: { findMany: vi.fn().mockResolvedValue([]) },
    });

    await searchService.search(TEST_ORG_ID, "FEA-414");

    // Broad pass ([1]) has the tag clause but no subtype clause for a non-type query.
    const broadOr = mockFindMany.mock.calls[1][0].where.OR;
    expect(broadOr.some((c: Record<string, unknown>) => "subtype" in c)).toBe(
      false
    );
    expect(
      broadOr.some((c: Record<string, unknown>) => "tagArtifacts" in c)
    ).toBe(true);
  });

  it("returns projects matching by slug", async () => {
    installDb({
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      project: { findMany: vi.fn().mockResolvedValue([makeProjectRow()]) },
    });

    const result = await searchService.search(TEST_ORG_ID, "PRO-5");

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].slug).toBe("PRO-5");
  });

  it("ranks exact slug match first for documents", async () => {
    const exactMatch = makeArtifactRow({
      id: "exact",
      slug: "FEA-414",
      updatedAt: new Date("2024-01-01"),
    });
    const textMatch = makeArtifactRow({
      id: "text",
      name: "Something about FEA-414",
      slug: "FEA-999",
      updatedAt: new Date("2024-06-01"),
    });

    installDb({
      artifact: {
        findMany: vi.fn().mockResolvedValue([textMatch, exactMatch]),
      },
      project: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await searchService.search(TEST_ORG_ID, "FEA-414");

    expect(result.documents[0].id).toBe("exact");
    expect(result.documents[1].id).toBe("text");
  });

  it("ranks exact slug match first for projects", async () => {
    const exactMatch = makeProjectRow({
      id: "exact",
      slug: "PRO-5",
      updatedAt: new Date("2024-01-01"),
    });
    const textMatch = makeProjectRow({
      id: "text",
      name: "Something PRO-5 related",
      slug: "PRO-99",
      updatedAt: new Date("2024-06-01"),
    });

    installDb({
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      project: {
        findMany: vi.fn().mockResolvedValue([textMatch, exactMatch]),
      },
    });

    const result = await searchService.search(TEST_ORG_ID, "PRO-5");

    expect(result.projects[0].id).toBe("exact");
    expect(result.projects[1].id).toBe("text");
  });

  it("handles case-insensitive slug ranking", async () => {
    const match = makeArtifactRow({ id: "exact", slug: "FEA-414" });

    installDb({
      artifact: { findMany: vi.fn().mockResolvedValue([match]) },
      project: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await searchService.search(TEST_ORG_ID, "fea-414");

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].id).toBe("exact");
  });

  it("partial prefix matches appear in results", async () => {
    const fea40 = makeArtifactRow({ id: "fea-40", slug: "FEA-40" });
    const fea400 = makeArtifactRow({ id: "fea-400", slug: "FEA-400" });

    installDb({
      artifact: { findMany: vi.fn().mockResolvedValue([fea40, fea400]) },
      project: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await searchService.search(TEST_ORG_ID, "FEA-4");

    expect(result.documents).toHaveLength(2);
  });

  it("filters out artifacts with null subtype", async () => {
    const nullSubtype = makeArtifactRow({ subtype: null });

    installDb({
      artifact: { findMany: vi.fn().mockResolvedValue([nullSubtype]) },
      project: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await searchService.search(TEST_ORG_ID, "test");

    expect(result.documents).toHaveLength(0);
  });
});
