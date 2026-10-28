import { LinkType } from "@repo/api/src/types/artifact";
import {
  ProjectTreeCategory,
  ProjectTreeIntegrityDiagnosticKind,
} from "@repo/api/src/types/project-tree";
import {
  ArtifactSubtype,
  ArtifactType,
  type Prisma,
  type TransactionClient,
} from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import { readBoundedProjectHierarchy } from "./project-hierarchy-read";

const organizationId = "11111111-1111-7111-8111-111111111111";
const projectId = "22222222-2222-7222-8222-222222222222";
const branchId = "33333333-3333-7333-8333-333333333333";
const sessionId = "44444444-4444-7444-8444-444444444444";
const mixedChildId = "55555555-5555-7555-8555-555555555555";

describe("bounded project hierarchy storage read", () => {
  it("pages every artifact kind at storage level and keeps mixed children", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ seed: "" }])
      .mockResolvedValueOnce([
        hierarchyRow(branchId, null, "2026-10-20T02:00:00.000Z"),
        hierarchyRow(sessionId, null, "2026-10-20T01:00:00.000Z"),
      ])
      .mockResolvedValueOnce([
        hierarchyRow(mixedChildId, branchId, "2026-10-20T00:00:00.000Z", 3),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 1n, parentId: branchId }])
      .mockResolvedValueOnce([{ sourceId: sessionId, targetId: mixedChildId }]);
    const tx = transactionClient(queryRaw);

    const result = await readBoundedProjectHierarchy(
      tx,
      projectId,
      organizationId,
      { hierarchy: true, limit: 2 }
    );

    expect(result.window.rootIds).toEqual([branchId, sessionId]);
    expect([...result.window.includedArtifactIds]).toEqual([
      branchId,
      sessionId,
      mixedChildId,
    ]);
    expect(result.state.canonicalParents.get(mixedChildId)).toEqual({
      linkType: LinkType.Produces,
      parentId: branchId,
    });
    expect(result.state.artifactsById.get(mixedChildId)?.sortOrder).toBe(3);
    expect(result.childCountsByParent.get(branchId)).toBe(1);
    expect(result.window.diagnosticsComplete).toBe(false);
    expect(result.window.diagnostics).toContainEqual({
      artifactId: mixedChildId,
      kind: ProjectTreeIntegrityDiagnosticKind.DuplicateParent,
      relatedArtifactId: sessionId,
    });

    const pageQuery = sqlText(queryRaw.mock.calls[1]?.[0]);
    expect(pageQuery).toContain(
      "ORDER BY a.hierarchy_rank ASC NULLS LAST, a.created_at DESC, a.id ASC"
    );
    expect(pageQuery).toContain("LIMIT ?");
    expect(pageQuery).not.toContain('a.type = ?::"ArtifactType"');
    expect(sqlValues(queryRaw.mock.calls[1]?.[0])).toContain(3);
    const diagnosticQuery = sqlText(queryRaw.mock.calls[5]?.[0]);
    expect(diagnosticQuery).toContain("JOIN artifacts source");
  });

  it("uses the full shared rank key after a tied-rank page boundary", async () => {
    const firstPageQueryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ seed: "" }])
      .mockResolvedValueOnce([
        hierarchyRow(branchId, null, "2026-10-20T02:00:00.000Z"),
        hierarchyRow(sessionId, null, "2026-10-20T01:00:00.000Z"),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const first = await readBoundedProjectHierarchy(
      transactionClient(firstPageQueryRaw),
      projectId,
      organizationId,
      { hierarchy: true, limit: 1 }
    );
    expect(first.window.rootIds).toEqual([branchId]);
    expect(first.window.rootNextCursor).toEqual(expect.any(String));

    const secondPageQueryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ seed: "" }])
      .mockResolvedValueOnce([
        hierarchyRow(sessionId, null, "2026-10-20T01:00:00.000Z"),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const second = await readBoundedProjectHierarchy(
      transactionClient(secondPageQueryRaw),
      projectId,
      organizationId,
      {
        hierarchy: true,
        limit: 1,
        rootCursor: first.window.rootNextCursor,
      }
    );

    expect(second.window.rootIds).toEqual([sessionId]);
    const pageQuery = sqlText(secondPageQueryRaw.mock.calls[1]?.[0]);
    expect(pageQuery).toContain("a.hierarchy_rank > ?");
    expect(pageQuery).toContain("a.hierarchy_rank IS NULL");
    expect(pageQuery).toContain("a.hierarchy_rank = ?");
    expect(pageQuery).toContain("a.created_at < ?");
    expect(pageQuery).toContain("a.id > ?::uuid");
    expect(sqlValues(secondPageQueryRaw.mock.calls[1]?.[0])).toEqual(
      expect.arrayContaining([
        10,
        new Date("2026-10-20T02:00:00.000Z"),
        branchId,
      ])
    );
  });

  it("continues a null-rank page with only the timestamp and id tiebreak", async () => {
    const firstQueryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ hierarchySeed: "", mutationSeed: "" }])
      .mockResolvedValueOnce([
        hierarchyRow(branchId, null, "2026-10-20T02:00:00.000Z", null),
        hierarchyRow(sessionId, null, "2026-10-20T01:00:00.000Z", null),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const first = await readBoundedProjectHierarchy(
      transactionClient(firstQueryRaw),
      projectId,
      organizationId,
      { hierarchy: true, limit: 1 }
    );
    const secondQueryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ hierarchySeed: "", mutationSeed: "" }])
      .mockResolvedValueOnce([
        hierarchyRow(sessionId, null, "2026-10-20T01:00:00.000Z", null),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await readBoundedProjectHierarchy(
      transactionClient(secondQueryRaw),
      projectId,
      organizationId,
      { hierarchy: true, limit: 1, rootCursor: first.window.rootNextCursor }
    );

    const pageQuery = sqlText(secondQueryRaw.mock.calls[1]?.[0]);
    expect(pageQuery).toContain("a.hierarchy_rank IS NULL AND");
    expect(pageQuery).not.toContain("a.hierarchy_rank > ?");
    expect(sqlValues(secondQueryRaw.mock.calls[1]?.[0])).toEqual(
      expect.arrayContaining([new Date("2026-10-20T02:00:00.000Z"), branchId])
    );
  });

  it("applies a root category before the page bound and preserves flat parent evidence", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([
        { hierarchyVersion: "hierarchy", mutationVersion: "mutation" },
      ])
      .mockResolvedValueOnce([
        hierarchyRow(mixedChildId, branchId, "2026-10-20T00:00:00.000Z"),
      ])
      .mockResolvedValueOnce([]);

    const result = await readBoundedProjectHierarchy(
      transactionClient(queryRaw),
      projectId,
      organizationId,
      { category: ProjectTreeCategory.Prds, hierarchy: true, limit: 1 }
    );

    expect(result.window.rootIds).toEqual([mixedChildId]);
    expect(result.state.childrenByParent.size).toBe(0);
    expect(result.childCountsByParent.size).toBe(0);
    expect(result.state.canonicalParents.get(mixedChildId)).toEqual({
      linkType: LinkType.Produces,
      parentId: branchId,
    });
    const versionQuery = sqlText(queryRaw.mock.calls[0]?.[0]);
    expect(versionQuery).toContain('hierarchy_version AS "hierarchyVersion"');
    expect(versionQuery).toContain(
      'hierarchy_mutation_version AS "mutationVersion"'
    );
    expect(versionQuery).not.toContain("artifact_links");
    expect(result.window.version).toBe("hierarchy");
    expect(result.window.mutationVersion).toBe("mutation");
    const pageQuery = sqlText(queryRaw.mock.calls[1]?.[0]);
    expect(pageQuery).toContain('a.type = ?::"ArtifactType"');
    expect(pageQuery).toContain('a.subtype = ?::"ArtifactSubtype"');
    expect(pageQuery).toContain(
      "ORDER BY a.sort_order ASC NULLS LAST, a.created_at DESC, a.id ASC"
    );
    expect(pageQuery).toContain('a.canonical_parent_id AS "parentId"');
    expect(pageQuery).not.toContain("artifact_links");
    expect(sqlValues(queryRaw.mock.calls[1]?.[0])).toEqual(
      expect.arrayContaining([ArtifactType.DOCUMENT, ArtifactSubtype.PRD, 2])
    );
  });

  it("pages children by canonical link rank, not their root artifact rank", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([
        { hierarchyVersion: "tree", mutationVersion: "place" },
      ])
      .mockResolvedValueOnce([
        hierarchyRow(mixedChildId, branchId, "2026-10-20T02:00:00.000Z", 1),
        hierarchyRow(sessionId, branchId, "2026-10-20T01:00:00.000Z", 5),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 2n }]);
    const tx = transactionClient(queryRaw, branchId);

    const result = await readBoundedProjectHierarchy(
      tx,
      projectId,
      organizationId,
      { childLimit: 1, hierarchy: true, parentArtifactId: branchId }
    );

    expect(result.window.rootIds).toEqual([mixedChildId]);
    expect(result.window.nextCursor).toEqual(expect.any(String));
    expect(result.window.totalChildCount).toBe(2);
    expect(result.state.artifactsById.get(mixedChildId)?.sortOrder).toBe(1);
    const pageQuery = sqlText(queryRaw.mock.calls[1]?.[0]);
    expect(pageQuery).toContain(
      "ORDER BY a.hierarchy_rank ASC NULLS LAST, a.created_at DESC, a.id ASC"
    );
    expect(pageQuery).toContain("a.canonical_parent_id = ?::uuid");
  });
});

function hierarchyRow(
  id: string,
  parentId: string | null,
  createdAt: string,
  sortOrder: number | null = 10
) {
  return {
    createdAt: new Date(createdAt),
    id,
    parentId,
    projectId,
    sortOrder,
  };
}

function transactionClient(
  queryRaw: ReturnType<typeof vi.fn>,
  parentId?: string
) {
  return {
    $queryRaw: queryRaw,
    artifact: {
      findFirst: vi.fn().mockResolvedValue(parentId ? { id: parentId } : null),
    },
  } as unknown as TransactionClient;
}

function sqlText(value: unknown): string {
  if (!(value && typeof value === "object" && "strings" in value)) {
    throw new Error("Expected a Prisma SQL query");
  }
  return (value as Prisma.Sql).strings.join("?");
}

function sqlValues(value: unknown): readonly unknown[] {
  if (!(value && typeof value === "object" && "values" in value)) {
    throw new Error("Expected a Prisma SQL query");
  }
  return (value as Prisma.Sql).values;
}
