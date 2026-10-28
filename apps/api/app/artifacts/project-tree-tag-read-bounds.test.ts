/**
 * The detailed project tree's tag read is bound by BIND PARAMETERS, not by the
 * project (whitlockk, PR #6484).
 *
 * ISS-8857 replaced a second project-scoped `SELECT` — two bind parameters
 * whatever the project held — with a read keyed by the ids the first select
 * already returned. That removed a statement, and it put the artifact COUNT
 * into the statement's width: Prisma binds one parameter per `in` element and
 * refuses a built statement at `POSTGRES_MAX_BIND_PARAMETERS`, so past that
 * count the read is not slow, it is rejected outright and takes the request
 * with it.
 *
 * Two properties are under test and only hold together. The statement must stay
 * under the ceiling however large the project is, AND the chunking that keeps
 * it there must partition the ids exactly — a chunker that drops its tail
 * raises no error, it just silently returns a tree whose last artifacts have
 * lost their tags.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

vi.mock("@/app/tags/service", () => ({
  mapTagRelations: vi.fn((relations: { tag: unknown }[]) =>
    relations.map((relation) => relation.tag)
  ),
}));

vi.mock("@/lib/db-utils", () => ({
  basicUserSelect: { select: { id: true, name: true } },
}));

import { ArtifactType } from "@repo/database";
import { POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS } from "@/lib/postgres-bind-parameters";
import { mockWithDbCall } from "../../__tests__/utils/db-helpers";
import { projectTreeService } from "./project-tree-service";
import { TAG_RELATION_ID_CHUNK_SIZE } from "./project-tree-service/tag-relations-read";

const projectId = "11111111-1111-7111-8111-111111111111";
const organizationId = "33333333-3333-7333-8333-333333333333";
const CREATED_AT = new Date("2026-08-05T12:00:00.000Z");

type TagReadArgs = { where: { artifactId: { in: string[] } } };

/**
 * The population every splitting case seeds: one id past the count a built
 * statement is ACCEPTED at, not one past the chunk size. Sizing it off the
 * chunk instead is what makes the width assertion toothless — a project of
 * one-past-the-chunk ids still fits inside a single statement under the
 * ceiling, so an unbounded read passes it. It clears the chunk as well (the
 * reserve between the two is asserted below), so the split fencepost is still
 * exercised.
 */
const ABOVE_CEILING_ID_COUNT = POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS + 1;

function createMockDb() {
  return {
    $queryRaw: vi.fn(),
    artifact: { findMany: vi.fn() },
    artifactLink: { findMany: vi.fn() },
    documentDetail: { findMany: vi.fn().mockResolvedValue([]) },
    tagArtifact: { findMany: vi.fn() },
  };
}

function artifactId(index: number): string {
  return `a${String(index).padStart(11, "0")}-1111-7111-8111-111111111111`;
}

/** `count` unlinked DOCUMENT roots, so the tree is one node per artifact. */
function documents(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    assignee: null,
    createdAt: CREATED_AT,
    id: artifactId(index),
    name: `doc-${index}`,
    organizationId,
    projectId,
    sortOrder: index,
    type: ArtifactType.DOCUMENT,
  }));
}

/** Every `in` list the tag read bound, in call order. */
function boundIdChunks(findMany: ReturnType<typeof vi.fn>): string[][] {
  return findMany.mock.calls.map(
    (call) => (call[0] as TagReadArgs).where.artifactId.in
  );
}

describe("project tree — the tag read is bound by parameters, not by project", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockDb.artifactLink.findMany.mockResolvedValue([]);
    mockDb.tagArtifact.findMany.mockResolvedValue([]);
  });

  it("still reads a project that fits the ceiling in ONE statement", async () => {
    mockDb.artifact.findMany.mockResolvedValue(documents(10));

    await projectTreeService.getProjectTreeWithDetails(
      projectId,
      organizationId
    );

    // ISS-8857's whole result is the statement it removed; a chunk size that
    // split an ordinary project would hand that saving straight back.
    expect(mockDb.tagArtifact.findMany).toHaveBeenCalledTimes(1);
  });

  it("issues no tag statement at all for an empty project", async () => {
    mockDb.artifact.findMany.mockResolvedValue([]);

    await projectTreeService.getProjectTreeWithDetails(
      projectId,
      organizationId
    );

    expect(mockDb.tagArtifact.findMany).not.toHaveBeenCalled();
  });

  it("reserves headroom below the ceiling rather than sitting on it", () => {
    // A chunk sized AT the refusal count emits the first statement the driver
    // rejects (ISS-8185); this is the fencepost that stops it coming back.
    expect(TAG_RELATION_ID_CHUNK_SIZE).toBeLessThan(
      POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS
    );
  });

  it("never binds more ids than a built statement is accepted at", async () => {
    mockDb.artifact.findMany.mockResolvedValue(
      documents(ABOVE_CEILING_ID_COUNT)
    );

    await projectTreeService.getProjectTreeWithDetails(
      projectId,
      organizationId
    );

    const chunks = boundIdChunks(mockDb.tagArtifact.findMany);
    expect(chunks.length).toBeGreaterThan(1);
    const widest = Math.max(...chunks.map((chunk) => chunk.length));
    expect(widest).toBeLessThanOrEqual(POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS);
  });

  it("partitions the id set exactly — no id dropped, none read twice", async () => {
    const rows = documents(ABOVE_CEILING_ID_COUNT);
    mockDb.artifact.findMany.mockResolvedValue(rows);

    await projectTreeService.getProjectTreeWithDetails(
      projectId,
      organizationId
    );

    const bound = boundIdChunks(mockDb.tagArtifact.findMany).flat();
    const unique = new Set(bound);
    // Three assertions, because each alone has a hole: a chunker that repeats
    // one id and drops another keeps the LENGTH, one that re-reads the whole
    // set keeps every id PRESENT, and one that reads ids the project never
    // held keeps the UNIQUE count. Deliberately not a sorted `toEqual` — on a
    // ceiling-sized population that diff takes minutes to render.
    expect(bound).toHaveLength(rows.length);
    expect(unique.size).toBe(rows.length);
    expect(rows.every((row) => unique.has(row.id))).toBe(true);
  });

  it("carries tags off the LAST chunk onto the returned tree", async () => {
    const rows = documents(ABOVE_CEILING_ID_COUNT);
    const tailId = rows.at(-1)?.id;
    const tag = { id: "tag-1", name: "release", color: "#fff" };
    mockDb.artifact.findMany.mockResolvedValue(rows);
    // Answer per chunk, so a dropped final read cannot be papered over by a
    // mock that returns the same rows to every call.
    mockDb.tagArtifact.findMany.mockImplementation((args: TagReadArgs) =>
      Promise.resolve(
        args.where.artifactId.in.includes(tailId as string)
          ? [{ artifactId: tailId, tag }]
          : []
      )
    );

    const result = await projectTreeService.getProjectTreeWithDetails(
      projectId,
      organizationId
    );

    const tail = result.nodes.find((node) => node.root.id === tailId);
    expect(tail?.root.tags).toEqual([tag]);
  });
});
