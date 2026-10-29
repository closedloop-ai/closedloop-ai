import { ArtifactType } from "@repo/api/src/types/artifact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWithDb = vi.hoisted(() => vi.fn());

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, withDb: mockWithDb };
});

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { documentService } from "../document-service";

const ORG = "org-1";
const OTHER_ORG = "org-2";

type ArtifactRow = {
  id: string;
  organizationId: string;
  slug: string;
  type: string;
};
type FindFirstArgs = {
  where: { organizationId?: string; slug?: { in: string[] } };
  select?: Record<string, boolean>;
  include?: unknown;
};

// Prisma semantics: an absent `where` key constrains nothing.
function matches(row: ArtifactRow, where: FindFirstArgs["where"]): boolean {
  if (
    where.organizationId !== undefined &&
    row.organizationId !== where.organizationId
  ) {
    return false;
  }
  return where.slug === undefined || where.slug.in.includes(row.slug);
}

function seed(rows: ArtifactRow[]): FindFirstArgs[] {
  const calls: FindFirstArgs[] = [];
  mockWithDb.mockImplementation(
    (
      callback: (db: {
        artifact: { findFirst: (args: FindFirstArgs) => Promise<unknown> };
      }) => Promise<unknown>
    ) =>
      callback({
        artifact: {
          findFirst: (args) => {
            calls.push(args);
            const row = rows.find((candidate) =>
              matches(candidate, args.where)
            );
            return Promise.resolve(
              row === undefined
                ? null
                : { id: row.id, slug: row.slug, type: row.type }
            );
          },
        },
      })
  );
  return calls;
}

describe("documentService.findCanonicalSlugAndId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the id and stored slug of the document an alias slug resolves", async () => {
    seed([
      {
        id: "doc-1",
        organizationId: ORG,
        slug: "FEA-1",
        type: ArtifactType.Document,
      },
    ]);

    await expect(
      documentService.findCanonicalSlugAndId("ISS-1", ORG)
    ).resolves.toEqual({ id: "doc-1", slug: "FEA-1" });
  });

  it("returns null for a slug stored only in another org", async () => {
    seed([
      {
        id: "doc-1",
        organizationId: OTHER_ORG,
        slug: "PLN-1",
        type: ArtifactType.Document,
      },
    ]);

    await expect(
      documentService.findCanonicalSlugAndId("PLN-1", ORG)
    ).resolves.toBeNull();
  });

  it("returns null for an artifact that is not a document", async () => {
    seed([
      {
        id: "branch-1",
        organizationId: ORG,
        slug: "BR-1",
        type: ArtifactType.Branch,
      },
    ]);

    await expect(
      documentService.findCanonicalSlugAndId("BR-1", ORG)
    ).resolves.toBeNull();
  });

  it("selects only the id, slug and type, with no include graph", async () => {
    const calls = seed([
      {
        id: "doc-1",
        organizationId: ORG,
        slug: "PLN-1",
        type: ArtifactType.Document,
      },
    ]);

    await documentService.findCanonicalSlugAndId("PLN-1", ORG);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.select).toEqual({ id: true, slug: true, type: true });
    expect(calls[0]?.include).toBeUndefined();
  });
});
