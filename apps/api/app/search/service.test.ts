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
    DOC: "DOC",
    // FEA-3956: the generated enum now carries the canonical ISSUE value.
    ISSUE: "ISSUE",
  },
}));

import { ArtifactType, withDb } from "@repo/database";
import {
  createHostileNestedOrderedFindMany,
  createHostileOrderedFindMany,
} from "@/__tests__/utils/hostile-order-planner.test-helpers";
import { searchService } from "./service";

const mockWithDb = withDb as unknown as Mock;

const TEST_ORG_ID = "org-123";

function installDb(db: Record<string, unknown>) {
  mockWithDb.mockImplementation(
    (callback: (tx: Record<string, unknown>) => unknown) => callback(db)
  );
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

  // ISS-9780: the nested team read is `take: 1` — it picks WHICH team name the
  // result row displays. `createdAt` alone is tie-prone (teams attached in one
  // transaction share it), so without a terminal key the displayed team could
  // change between two identical searches.
  it("orders the nested team pick on a unique terminal key", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([]);
    installDb({
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      project: { findMany: mockFindMany },
    });

    await searchService.search(TEST_ORG_ID, "PRO-5");

    const call = mockFindMany.mock.calls[0][0];
    expect(call.select.teams.orderBy).toEqual([
      { createdAt: "asc" },
      { id: "asc" },
    ]);
    expect(call.select.teams.take).toBe(1);
  });

  // ISS-9780: the case above proves the read ASKS for a total nested order; it
  // cannot prove the team it DISPLAYS, because its fake returns `[]`. This one
  // hands the nested `take: 1` a set of team rows entirely tied on `createdAt`
  // — teams attached in one transaction share it — through a fake that applies
  // the nested ordering and permutes the tied rows between calls. Strip the
  // terminal key and the same project renders a different team name on two
  // identical searches.
  it("displays the same team name twice when the project's teams are tied", async () => {
    const TIED_AT = new Date("2026-09-01T00:00:00.000Z");
    const projectRow = makeProjectRow({
      teams: [
        {
          id: "pt-c",
          createdAt: TIED_AT,
          team: { id: "team-c", name: "Team C" },
        },
        {
          id: "pt-a",
          createdAt: TIED_AT,
          team: { id: "team-a", name: "Team A" },
        },
        {
          id: "pt-b",
          createdAt: TIED_AT,
          team: { id: "team-b", name: "Team B" },
        },
      ],
    });
    installDb({
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      project: {
        findMany: createHostileNestedOrderedFindMany([projectRow], "teams"),
      },
    });

    const first = await searchService.search(TEST_ORG_ID, "PRO-5");
    const second = await searchService.search(TEST_ORG_ID, "PRO-5");

    // The terminal key is the join row's own `id`, ascending, so the displayed
    // team is not merely stable — it is this one.
    expect(first.projects[0].teamName).toBe("Team A");
    expect(second.projects[0].teamName).toBe(first.projects[0].teamName);
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

  it("maps an 'issue' type-label query to the persisted FEATURE subtype filter (FEA-3956)", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([]);
    installDb({
      artifact: { findMany: mockFindMany },
      project: { findMany: vi.fn().mockResolvedValue([]) },
    });

    // "Issue" is the post-rename display name; rows persist as FEATURE, so the
    // broad-pass subtype filter must target FEATURE (not the canonical ISSUE)
    // for the query to match stored rows.
    await searchService.search(TEST_ORG_ID, "issue");

    const broadOr = mockFindMany.mock.calls[1][0].where.OR;
    const subtypeClause = broadOr.find(
      (c: Record<string, unknown>) => "subtype" in c
    ) as { subtype: { in: string[] } };
    expect(subtypeClause.subtype.in).toContain(DocumentType.Feature);
    expect(subtypeClause.subtype.in).not.toContain("ISSUE");
  });

  it("surfaces a skew-stored ISSUE row with the canonical FEATURE type (FEA-3956)", async () => {
    // A skewed newer client could persist the canonical ISSUE value; on read it
    // must normalize to the canonical DocumentType FEATURE, never leak ISSUE.
    const issueRow = makeArtifactRow({ id: "iss-1", subtype: "ISSUE" });
    installDb({
      artifact: { findMany: vi.fn().mockResolvedValue([issueRow]) },
      project: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await searchService.search(TEST_ORG_ID, "Test");

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].type).toBe(DocumentType.Feature);
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

describe("searchService.searchByTag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty results when the tag is not found", async () => {
    const artifactFindMany = vi.fn().mockResolvedValue([]);
    installDb({
      tag: { findFirst: vi.fn().mockResolvedValue(null) },
      artifact: { findMany: artifactFindMany },
    });

    const result = await searchService.searchByTag(TEST_ORG_ID, "tag-1");

    expect(result).toEqual({
      query: "",
      tagId: "tag-1",
      documents: [],
      projects: [],
    });
    expect(artifactFindMany).not.toHaveBeenCalled();
  });

  it("collapses the tag join into a single artifact query via the relation filter", async () => {
    const artifactFindMany = vi.fn().mockResolvedValue([makeArtifactRow()]);
    const tagArtifactFindMany = vi.fn().mockResolvedValue([]);
    installDb({
      tag: { findFirst: vi.fn().mockResolvedValue({ name: "Roadmap" }) },
      artifact: { findMany: artifactFindMany },
      tagArtifact: { findMany: tagArtifactFindMany },
    });

    const result = await searchService.searchByTag(TEST_ORG_ID, "tag-1");

    // No intermediate materialization of every tagArtifact row + unbounded IN.
    expect(tagArtifactFindMany).not.toHaveBeenCalled();

    const call = artifactFindMany.mock.calls[0][0];
    expect(call.where).toEqual(
      expect.objectContaining({
        organizationId: TEST_ORG_ID,
        type: ArtifactType.DOCUMENT,
        tagArtifacts: { some: { tagId: "tag-1" } },
      })
    );
    // DB does the recency ordering and cap in the same shot.
    // ISS-9780: the recency order now carries a unique terminal key. `updatedAt`
    // alone is tie-prone, and this read is a bounded top-N (`take: 25`), so
    // which of a set of same-instant rows made the cut was planner-dependent.
    expect(call.orderBy).toEqual([{ updatedAt: "desc" }, { id: "desc" }]);
    expect(call.take).toBe(25);

    expect(result.tagName).toBe("Roadmap");
    expect(result.documents).toHaveLength(1);
  });

  it("returns the tag name with no documents when the tag has no artifacts", async () => {
    installDb({
      tag: { findFirst: vi.fn().mockResolvedValue({ name: "Empty" }) },
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await searchService.searchByTag(TEST_ORG_ID, "tag-1");

    expect(result).toEqual({
      query: "",
      tagId: "tag-1",
      tagName: "Empty",
      documents: [],
      projects: [],
    });
  });

  // ISS-9780: the query-shape case above proves `SEARCH_ORDER` ASKS for a total
  // order; it cannot prove which rows make the cut, because its fake returns one
  // row and the cap is 25. This one hands the bounded top-N a population of 30
  // rows entirely tied on `updatedAt` — a bulk import or a batch status change
  // ties them — through a fake that applies the requested ordering and permutes
  // tied rows between calls. Strip the terminal key and two identical reads of
  // an unchanged corpus return DIFFERENT MEMBERS, not just a different order.
  it("admits the same 25 members twice when the tagged corpus is tied on updatedAt", async () => {
    const TIED_AT = new Date("2026-09-01T00:00:00.000Z");
    const taggedRows = Array.from({ length: 30 }, (_, index) => {
      const suffix = String(index).padStart(2, "0");
      return makeArtifactRow({
        id: `art-${suffix}`,
        slug: `FEA-${suffix}`,
        updatedAt: TIED_AT,
      });
    });

    installDb({
      tag: { findFirst: vi.fn().mockResolvedValue({ name: "Roadmap" }) },
      artifact: { findMany: createHostileOrderedFindMany(taggedRows) },
    });

    const first = await searchService.searchByTag(TEST_ORG_ID, "tag-1");
    const second = await searchService.searchByTag(TEST_ORG_ID, "tag-1");

    // The terminal key is `id` DESCENDING, so the admitted set is not merely
    // stable — it is the 25 highest ids, and `art-00`..`art-04` are cut.
    expect(first.documents).toHaveLength(25);
    expect(first.documents.map((document) => document.id)).toEqual(
      second.documents.map((document) => document.id)
    );
    expect(first.documents.map((document) => document.id)).not.toContain(
      "art-00"
    );
    expect(first.documents[0].id).toBe("art-29");
  });
});
