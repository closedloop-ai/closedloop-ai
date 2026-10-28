import { AgentSessionFieldMutationErrorCode } from "@repo/api/src/types/agent-session-field-mutation";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbTx } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: {
    DbNull: "DbNull",
    join: (items: unknown[]) => ({ joined: items }),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      sql: strings.join("?"),
      values,
    }),
  },
}));

import { artifactLinksService } from "@/app/artifact-links/service";

const ORG_ID = "org-1";
const TARGET_PROJECT_ID = "project-target";

// findDownstreamArtifactIds is covered in artifact-links-service.test.ts.
// Here we only exercise batchMoveArtifacts and stub the downstream call.

describe("artifactLinksService.batchMoveArtifacts", () => {
  let findDownstreamSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    findDownstreamSpy = vi.spyOn(
      artifactLinksService,
      "findDownstreamArtifactIds"
    );
  });

  afterEach(() => {
    findDownstreamSpy.mockRestore();
  });

  /**
   * Compose a single tx mock covering both the validation reads (artifact +
   * project findFirst/findUnique) and the move writes (findMany/updateMany).
   * The service now runs all of these inside a single withDb.tx so the
   * snapshot stays consistent across validation and mutation.
   */
  function setupTx(options: {
    sourceFound: boolean;
    sourceType?: ArtifactType;
    projectFound: boolean;
    rows?: { id: string; type: ArtifactType; projectId: string | null }[];
  }) {
    const rows = options.rows ?? [];
    const mockTx = {
      artifact: {
        findFirst: vi.fn().mockResolvedValue(
          options.sourceFound
            ? {
                id: "root-artifact",
                type: options.sourceType ?? ArtifactType.Document,
              }
            : null
        ),
        updateMany: vi.fn().mockResolvedValue({ count: rows.length }),
      },
      // ISS-9158: the rows are read with a locking `$queryRaw`, not findMany.
      $queryRaw: vi.fn().mockResolvedValue(rows),
      project: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            options.projectFound ? { id: TARGET_PROJECT_ID } : null
          ),
      },
    };
    mockWithDbTx(mockTx);
    return mockTx;
  }

  it("moves a single artifact without downstream", async () => {
    setupTx({
      sourceFound: true,
      projectFound: true,
      rows: [
        { id: "root-artifact", type: ArtifactType.Document, projectId: "p0" },
      ],
    });

    const result = await artifactLinksService.batchMoveArtifacts(ORG_ID, {
      artifactId: "root-artifact",
      targetProjectId: TARGET_PROJECT_ID,
      includeDownstream: false,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        movedArtifacts: [{ id: "root-artifact", type: ArtifactType.Document }],
        // ISS-9158: the before-projectId read in the same tx as the write.
        projectChanges: [
          {
            artifactId: "root-artifact",
            before: "p0",
            after: TARGET_PROJECT_ID,
          },
        ],
      },
    });
    expect(findDownstreamSpy).not.toHaveBeenCalled();
  });

  it("moves downstream when includeDownstream is true", async () => {
    setupTx({
      sourceFound: true,
      projectFound: true,
      rows: [
        { id: "root-artifact", type: ArtifactType.Document, projectId: "p0" },
        { id: "child-1", type: ArtifactType.Document, projectId: null },
        {
          id: "child-2",
          type: ArtifactType.Branch,
          projectId: TARGET_PROJECT_ID,
        },
      ],
    });
    findDownstreamSpy.mockResolvedValueOnce(["child-1", "child-2"]);

    const result = await artifactLinksService.batchMoveArtifacts(ORG_ID, {
      artifactId: "root-artifact",
      targetProjectId: TARGET_PROJECT_ID,
      includeDownstream: true,
    });

    expect(findDownstreamSpy).toHaveBeenCalledWith(ORG_ID, "root-artifact");
    expect(result).toEqual({
      ok: true,
      value: {
        movedArtifacts: [
          { id: "root-artifact", type: ArtifactType.Document },
          { id: "child-1", type: ArtifactType.Document },
          { id: "child-2", type: ArtifactType.Branch },
        ],
        // Unfiltered here: the capture helper owns the before !== after drop.
        projectChanges: [
          {
            artifactId: "root-artifact",
            before: "p0",
            after: TARGET_PROJECT_ID,
          },
          { artifactId: "child-1", before: null, after: TARGET_PROJECT_ID },
          {
            artifactId: "child-2",
            before: TARGET_PROJECT_ID,
            after: TARGET_PROJECT_ID,
          },
        ],
      },
    });
  });

  it("returns NotFound when source artifact does not exist in org", async () => {
    setupTx({ sourceFound: false, projectFound: true });

    const result = await artifactLinksService.batchMoveArtifacts(ORG_ID, {
      artifactId: "missing-artifact",
      targetProjectId: TARGET_PROJECT_ID,
      includeDownstream: false,
    });

    expect(result).toEqual({ ok: false, error: 404 });
  });

  it("returns BadRequest when target project does not exist", async () => {
    setupTx({ sourceFound: true, projectFound: false });

    const result = await artifactLinksService.batchMoveArtifacts(ORG_ID, {
      artifactId: "root-artifact",
      targetProjectId: "nonexistent-project",
      includeDownstream: false,
    });

    expect(result).toEqual({ ok: false, error: 400 });
  });

  // ISS-12858: a `null` target clears the project; no project is looked up.
  it("clears the source's project when targetProjectId is null", async () => {
    const mockTx = setupTx({
      sourceFound: true,
      projectFound: false,
      rows: [
        { id: "root-artifact", type: ArtifactType.Document, projectId: "p0" },
      ],
    });

    const result = await artifactLinksService.batchMoveArtifacts(ORG_ID, {
      artifactId: "root-artifact",
      targetProjectId: null,
      includeDownstream: false,
    });

    expect(mockTx.project.findUnique).not.toHaveBeenCalled();
    expect(mockTx.artifact.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["root-artifact"] }, organizationId: ORG_ID },
      data: { projectId: null },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        movedArtifacts: [{ id: "root-artifact", type: ArtifactType.Document }],
        projectChanges: [
          { artifactId: "root-artifact", before: "p0", after: null },
        ],
      },
    });
    expect(findDownstreamSpy).not.toHaveBeenCalled();
  });

  it("clears the downstream set too when targetProjectId is null and includeDownstream is true", async () => {
    const mockTx = setupTx({
      sourceFound: true,
      projectFound: false,
      rows: [
        { id: "root-artifact", type: ArtifactType.Document, projectId: "p0" },
        { id: "child-1", type: ArtifactType.Document, projectId: "p0" },
      ],
    });
    findDownstreamSpy.mockResolvedValueOnce(["child-1"]);

    const result = await artifactLinksService.batchMoveArtifacts(ORG_ID, {
      artifactId: "root-artifact",
      targetProjectId: null,
      includeDownstream: true,
    });

    expect(mockTx.project.findUnique).not.toHaveBeenCalled();
    expect(mockTx.artifact.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["root-artifact", "child-1"] },
        organizationId: ORG_ID,
      },
      data: { projectId: null },
    });
    expect(result.ok && result.value.projectChanges).toEqual([
      { artifactId: "root-artifact", before: "p0", after: null },
      { artifactId: "child-1", before: "p0", after: null },
    ]);
  });

  it("returns NotFound when zero rows are actually updated", async () => {
    setupTx({ sourceFound: true, projectFound: true, rows: [] });
    findDownstreamSpy.mockResolvedValueOnce([]);

    const result = await artifactLinksService.batchMoveArtifacts(ORG_ID, {
      artifactId: "root-artifact",
      targetProjectId: TARGET_PROJECT_ID,
      includeDownstream: false,
    });

    expect(result).toEqual({ ok: false, error: 404 });
  });

  it("issues a single updateMany covering all artifact ids", async () => {
    const mockTx = setupTx({
      sourceFound: true,
      projectFound: true,
      rows: [
        { id: "root-artifact", type: ArtifactType.Document, projectId: "p0" },
        { id: "child-1", type: ArtifactType.Document, projectId: null },
        {
          id: "child-2",
          type: ArtifactType.Branch,
          projectId: TARGET_PROJECT_ID,
        },
      ],
    });
    findDownstreamSpy.mockResolvedValueOnce(["child-1", "child-2"]);

    await artifactLinksService.batchMoveArtifacts(ORG_ID, {
      artifactId: "root-artifact",
      targetProjectId: TARGET_PROJECT_ID,
      includeDownstream: true,
    });

    // The before-projectId read locks every target row in canonical id order
    // (FOR NO KEY UPDATE, ORDER BY "id" ASC — the same lock the status and
    // priority batches take), so a concurrent move cannot make the recorded
    // transition untrue.
    expect(mockTx.$queryRaw).toHaveBeenCalledTimes(1);
    const lockSql = String(mockTx.$queryRaw.mock.calls[0][0].sql);
    expect(lockSql).toContain('ORDER BY "id" ASC');
    expect(lockSql).toContain("FOR NO KEY UPDATE");
    expect(mockTx.$queryRaw.mock.calls[0][0].values).toEqual([
      { joined: expect.any(Array) },
      ORG_ID,
    ]);

    // All artifacts move in a single updateMany call on the unified table.
    expect(mockTx.artifact.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["root-artifact", "child-1", "child-2"] },
        organizationId: ORG_ID,
      },
      data: { projectId: TARGET_PROJECT_ID },
    });
  });
});

/**
 * ISS-10995 — the org boundary on the validation reads, EXECUTED.
 *
 * `setupTx` above answers both reads from booleans and never inspects `where`,
 * so deleting `organizationId` from either one leaves every case above green,
 * the two named for the boundary included. This matters now that `batch-move`
 * is the writer behind a one-click Project picker on every Session and Branch
 * Details tab rather than only the bulk Move dialog. The SOURCE check has a
 * second line of defence in the org-scoped lock and `updateMany`; the
 * DESTINATION check has none, so an unscoped one would let `updateMany` commit
 * the caller's own artifact stamped with a foreign org's project.
 */
describe("artifactLinksService.batchMoveArtifacts org scoping", () => {
  const OTHER_ORG_ID = "org-2";
  const FOREIGN_PROJECT_ID = "project-other-org";
  const SESSION_ID = "session-artifact";

  type StoredArtifact = {
    id: string;
    organizationId: string;
    type: ArtifactType;
    projectId: string | null;
  };
  type StoredProject = { id: string; organizationId: string };
  /**
   * `organizationId` is OPTIONAL here on purpose, and an absent one matches
   * every org, exactly as Prisma reads a `where` that omits the key. A required
   * one would make the harness refuse a query missing the scope, so dropping
   * the scope would fail the control case instead of the boundary case — the
   * refusal would then be the harness's, not the service's.
   */
  type ArtifactWhere = { id: string; organizationId?: string };
  type UpdateManyArgs = {
    where: { id: { in: string[] }; organizationId?: string };
    data: { projectId: string };
  };
  /** What the `Prisma.sql`/`Prisma.join` doubles at the top of this file build. */
  type LockStatement = {
    values: [{ joined: { values: string[] }[] }, string];
  };

  /** A tx whose reads and writes answer from `where`, against a tiny store. */
  function setupOrgScopedTx(
    artifacts: StoredArtifact[],
    projects: StoredProject[]
  ) {
    const store = artifacts.map((artifact) => ({ ...artifact }));
    const inScope = (organizationId: string, scope?: string) =>
      scope === undefined || scope === organizationId;
    const findInOrg = (where: ArtifactWhere) =>
      store.find(
        (artifact) =>
          artifact.id === where.id &&
          inScope(artifact.organizationId, where.organizationId)
      ) ?? null;
    const mockTx = {
      artifact: {
        findFirst: vi.fn(({ where }: { where: ArtifactWhere }) =>
          Promise.resolve(findInOrg(where))
        ),
        updateMany: vi.fn(({ where, data }: UpdateManyArgs) => {
          const matched = store.filter(
            (artifact) =>
              where.id.in.includes(artifact.id) &&
              inScope(artifact.organizationId, where.organizationId)
          );
          for (const artifact of matched) {
            artifact.projectId = data.projectId;
          }
          return Promise.resolve({ count: matched.length });
        }),
      },
      $queryRaw: vi.fn((statement: LockStatement) => {
        const [idList, organizationId] = statement.values;
        const ids = idList.joined.map((part) => part.values[0]);
        return Promise.resolve(
          store
            .filter(
              (artifact) =>
                ids.includes(artifact.id) &&
                inScope(artifact.organizationId, organizationId)
            )
            .map(({ id, type, projectId }) => ({ id, type, projectId }))
        );
      }),
      project: {
        findUnique: vi.fn(({ where }: { where: ArtifactWhere }) =>
          Promise.resolve(
            projects.find(
              (project) =>
                project.id === where.id &&
                inScope(project.organizationId, where.organizationId)
            ) ?? null
          )
        ),
      },
    };
    mockWithDbTx(mockTx);
    return { mockTx, store };
  }

  function session(organizationId: string): StoredArtifact {
    return {
      id: SESSION_ID,
      organizationId,
      type: ArtifactType.Session,
      projectId: "project-before",
    };
  }

  function move(targetProjectId: string) {
    return artifactLinksService.batchMoveArtifacts(ORG_ID, {
      artifactId: SESSION_ID,
      targetProjectId,
      includeDownstream: false,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("files the caller's own session into its own project", async () => {
    // The positive control: without it a harness that refuses everything would
    // satisfy both refusals below.
    const { mockTx, store } = setupOrgScopedTx(
      [session(ORG_ID)],
      [{ id: TARGET_PROJECT_ID, organizationId: ORG_ID }]
    );

    await expect(move(TARGET_PROJECT_ID)).resolves.toMatchObject({ ok: true });
    expect(store[0]?.projectId).toBe(TARGET_PROJECT_ID);
    // Both reads carry the scope. The SOURCE one is asserted rather than
    // behaviourally exercised because the org-scoped lock and `updateMany`
    // already refuse a foreign artifact, so dropping it changes no outcome
    // this harness can observe — the destination one has no such backstop and
    // is covered by the refusal below.
    for (const read of [mockTx.artifact.findFirst, mockTx.project.findUnique]) {
      expect(read).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organizationId: ORG_ID }),
        })
      );
    }
  });

  it("refuses a session that exists only in another org, and moves nothing", async () => {
    const { store } = setupOrgScopedTx(
      [session(OTHER_ORG_ID)],
      [{ id: TARGET_PROJECT_ID, organizationId: ORG_ID }]
    );

    await expect(move(TARGET_PROJECT_ID)).resolves.toEqual({
      ok: false,
      error: 404,
    });
    expect(store[0]?.projectId).toBe("project-before");
  });

  /**
   * ISS-10995 (Cosimo Corrigan, 2026-10-12: "I think we want a stale-write
   * guard"): the Details Project row sends the project it RENDERED, and a write
   * made against a stale read is refused. Decided against the LOCKED row, so
   * the guard is not itself a read-then-write.
   */
  it("refuses a move whose expected project is not the one stored", async () => {
    const { mockTx, store } = setupOrgScopedTx(
      [session(ORG_ID)],
      [{ id: TARGET_PROJECT_ID, organizationId: ORG_ID }]
    );

    const refused = await artifactLinksService.batchMoveArtifacts(ORG_ID, {
      artifactId: SESSION_ID,
      targetProjectId: TARGET_PROJECT_ID,
      includeDownstream: false,
      expectedProjectId: "project-the-reader-saw",
    });

    expect(refused).toEqual({
      ok: false,
      error: {
        status: 409,
        code: AgentSessionFieldMutationErrorCode.StaleProjectId,
        message: expect.any(String),
        details: {
          staleProjectIds: [
            {
              documentId: SESSION_ID,
              currentProjectId: "project-before",
              expectedProjectId: "project-the-reader-saw",
            },
          ],
        },
      },
    });
    expect(store[0]?.projectId).toBe("project-before");
    // The lock was taken and the write was not: the decision sits between
    // `lockArtifactRowsForMove` and `updateMany`, in the same transaction, so
    // it cannot be a second read-then-write. The only `projectId` in scope at
    // that point is the LOCKED row's — the pre-lock `findFirst` selects
    // `{ id, type }` alone.
    expect(mockTx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockTx.artifact.updateMany).not.toHaveBeenCalled();
  });

  it("writes unguarded when the caller sends no expected project", async () => {
    // The bulk Move dialog and the documents batch path send none. An absent
    // expectation is last-write-wins, never a refusal.
    const { store } = setupOrgScopedTx(
      [session(ORG_ID)],
      [{ id: TARGET_PROJECT_ID, organizationId: ORG_ID }]
    );

    await expect(
      artifactLinksService.batchMoveArtifacts(ORG_ID, {
        artifactId: SESSION_ID,
        targetProjectId: TARGET_PROJECT_ID,
        includeDownstream: false,
      })
    ).resolves.toMatchObject({ ok: true });
    expect(store[0]?.projectId).toBe(TARGET_PROJECT_ID);
  });

  it("accepts a retry whose expectation its own earlier success moved off", async () => {
    // ISS-9486 ruling 2: a write already at the requested value is not stale,
    // or a retried commit would 409 against itself.
    const { store } = setupOrgScopedTx(
      [{ ...session(ORG_ID), projectId: TARGET_PROJECT_ID }],
      [{ id: TARGET_PROJECT_ID, organizationId: ORG_ID }]
    );

    await expect(
      artifactLinksService.batchMoveArtifacts(ORG_ID, {
        artifactId: SESSION_ID,
        targetProjectId: TARGET_PROJECT_ID,
        includeDownstream: false,
        expectedProjectId: "project-before",
      })
    ).resolves.toMatchObject({ ok: true });
    expect(store[0]?.projectId).toBe(TARGET_PROJECT_ID);
  });

  it("refuses another org's project as the destination, and moves nothing", async () => {
    const { store } = setupOrgScopedTx(
      [session(ORG_ID)],
      [{ id: FOREIGN_PROJECT_ID, organizationId: OTHER_ORG_ID }]
    );

    await expect(move(FOREIGN_PROJECT_ID)).resolves.toEqual({
      ok: false,
      error: 400,
    });
    expect(store[0]?.projectId).toBe("project-before");
  });
});
