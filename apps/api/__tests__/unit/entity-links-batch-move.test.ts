import {
  type EntityLink,
  EntityType,
  LinkType,
} from "@repo/api/src/types/entity-link";
import { vi } from "vitest";
import { mockWithDbCall, mockWithDbTx } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { DbNull: "DbNull" },
}));

vi.mock("@/lib/entity-validation", () => ({
  assertEntityInOrganization: vi.fn(),
  EntityOrganizationMismatchError: class extends Error {
    constructor(entityType: string, id: string) {
      super(`${entityType} ${id} not found in the authenticated organization`);
      this.name = "EntityOrganizationMismatchError";
    }
  },
}));

import { entityLinksService } from "@/app/entity-links/service";
import { assertEntityInOrganization } from "@/lib/entity-validation";

const mockedAssert = vi.mocked(assertEntityInOrganization);

const ORG_ID = "org-1";
const TARGET_PROJECT_ID = "project-target";

function makeLink(
  id: string,
  sourceId: string,
  sourceType: EntityType,
  targetId: string,
  targetType: EntityType,
  linkType: LinkType = LinkType.Produces
): EntityLink {
  return {
    id,
    organizationId: ORG_ID,
    sourceId,
    sourceType,
    targetId,
    targetType,
    sourceVersion: null,
    targetVersion: null,
    linkType,
    metadata: null,
    createdAt: new Date(),
  };
}

describe("entityLinksService.findDownstreamEntityIds", () => {
  let findLinkTreeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    findLinkTreeSpy = vi.spyOn(entityLinksService, "findLinkTree");
  });

  afterEach(() => {
    findLinkTreeSpy.mockRestore();
  });

  it("returns downstream entities from a chain, excluding the root", async () => {
    const linkAB = makeLink(
      "l1",
      "a",
      EntityType.Artifact,
      "b",
      EntityType.Artifact
    );
    const linkBC = makeLink(
      "l2",
      "b",
      EntityType.Artifact,
      "c",
      EntityType.Feature
    );

    findLinkTreeSpy.mockResolvedValueOnce([
      { link: linkAB, fromEntityId: "a" },
      { link: linkBC, fromEntityId: "b" },
    ]);

    const result = await entityLinksService.findDownstreamEntityIds(
      ORG_ID,
      "a",
      EntityType.Artifact
    );

    expect(result).toEqual([
      { id: "b", type: EntityType.Artifact },
      { id: "c", type: EntityType.Feature },
    ]);
  });

  it("returns empty array when no downstream entities exist", async () => {
    findLinkTreeSpy.mockResolvedValueOnce([]);

    const result = await entityLinksService.findDownstreamEntityIds(
      ORG_ID,
      "a",
      EntityType.Artifact
    );

    expect(result).toEqual([]);
  });
});

describe("entityLinksService.batchMoveEntities", () => {
  let findDownstreamSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedAssert.mockResolvedValue(undefined);
    findDownstreamSpy = vi.spyOn(entityLinksService, "findDownstreamEntityIds");
  });

  afterEach(() => {
    findDownstreamSpy.mockRestore();
  });

  function setupProjectLookup(found: boolean) {
    mockWithDbCall({
      project: {
        findUnique: vi
          .fn()
          .mockResolvedValue(found ? { id: TARGET_PROJECT_ID } : null),
      },
    });
  }

  function setupTransaction(counts: {
    artifact?: number;
    feature?: number;
    externalLink?: number;
  }) {
    mockWithDbTx({
      artifact: {
        updateMany: vi.fn().mockResolvedValue({ count: counts.artifact ?? 0 }),
      },
      feature: {
        updateMany: vi.fn().mockResolvedValue({ count: counts.feature ?? 0 }),
      },
      externalLink: {
        updateMany: vi
          .fn()
          .mockResolvedValue({ count: counts.externalLink ?? 0 }),
      },
    });
  }

  it("moves a single feature without downstream", async () => {
    setupProjectLookup(true);
    setupTransaction({ feature: 1 });

    const result = await entityLinksService.batchMoveEntities(ORG_ID, {
      entityId: "feat-1",
      entityType: EntityType.Feature,
      targetProjectId: TARGET_PROJECT_ID,
      includeDownstream: false,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        movedEntities: [{ id: "feat-1", type: EntityType.Feature }],
      },
    });
    expect(findDownstreamSpy).not.toHaveBeenCalled();
  });

  it("moves downstream when root entity is an artifact and includeDownstream is true", async () => {
    setupProjectLookup(true);
    findDownstreamSpy.mockResolvedValueOnce([
      { id: "art-child-1", type: EntityType.Artifact },
      { id: "feat-child-1", type: EntityType.Feature },
    ]);
    setupTransaction({ artifact: 2, feature: 1 });

    const result = await entityLinksService.batchMoveEntities(ORG_ID, {
      entityId: "art-root-1",
      entityType: EntityType.Artifact,
      targetProjectId: TARGET_PROJECT_ID,
      includeDownstream: true,
    });

    expect(findDownstreamSpy).toHaveBeenCalledWith(
      ORG_ID,
      "art-root-1",
      EntityType.Artifact
    );
    expect(result).toEqual({
      ok: true,
      value: {
        movedEntities: [
          { id: "art-root-1", type: EntityType.Artifact },
          { id: "art-child-1", type: EntityType.Artifact },
          { id: "feat-child-1", type: EntityType.Feature },
        ],
      },
    });
  });

  it("moves feature with downstream artifacts and external links", async () => {
    setupProjectLookup(true);

    findDownstreamSpy.mockResolvedValueOnce([
      { id: "art-1", type: EntityType.Artifact },
      { id: "ext-1", type: EntityType.ExternalLink },
    ]);
    setupTransaction({ feature: 1, artifact: 1, externalLink: 1 });

    const result = await entityLinksService.batchMoveEntities(ORG_ID, {
      entityId: "feat-1",
      entityType: EntityType.Feature,
      targetProjectId: TARGET_PROJECT_ID,
      includeDownstream: true,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        movedEntities: [
          { id: "feat-1", type: EntityType.Feature },
          { id: "art-1", type: EntityType.Artifact },
          { id: "ext-1", type: EntityType.ExternalLink },
        ],
      },
    });
  });

  it("returns NotFound when root entity does not exist in org", async () => {
    mockedAssert.mockRejectedValueOnce(
      new Error("ARTIFACT entity-1 not found in the authenticated organization")
    );
    setupProjectLookup(true);

    const result = await entityLinksService.batchMoveEntities(ORG_ID, {
      entityId: "entity-1",
      entityType: EntityType.Artifact,
      targetProjectId: TARGET_PROJECT_ID,
      includeDownstream: false,
    });

    expect(result).toEqual({ ok: false, error: 404 });
  });

  it("does not move upstream parent when moving a child artifact", async () => {
    setupProjectLookup(true);
    findDownstreamSpy.mockResolvedValueOnce([
      { id: "art-grandchild-1", type: EntityType.Artifact },
    ]);
    setupTransaction({ artifact: 2 });

    const result = await entityLinksService.batchMoveEntities(ORG_ID, {
      entityId: "art-child-1",
      entityType: EntityType.Artifact,
      targetProjectId: TARGET_PROJECT_ID,
      includeDownstream: true,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        movedEntities: [
          { id: "art-child-1", type: EntityType.Artifact },
          { id: "art-grandchild-1", type: EntityType.Artifact },
        ],
      },
    });
  });

  it("returns BadRequest when target project does not exist", async () => {
    setupProjectLookup(false);

    const result = await entityLinksService.batchMoveEntities(ORG_ID, {
      entityId: "feat-1",
      entityType: EntityType.Feature,
      targetProjectId: "nonexistent-project",
      includeDownstream: false,
    });

    expect(result).toEqual({ ok: false, error: 400 });
  });

  it("returns NotFound when zero rows are actually updated", async () => {
    setupProjectLookup(true);
    findDownstreamSpy.mockResolvedValueOnce([]);
    setupTransaction({ artifact: 0 });

    const result = await entityLinksService.batchMoveEntities(ORG_ID, {
      entityId: "art-1",
      entityType: EntityType.Artifact,
      targetProjectId: TARGET_PROJECT_ID,
      includeDownstream: false,
    });

    expect(result).toEqual({ ok: false, error: 404 });
  });

  it("groups entities by type for separate updateMany calls", async () => {
    setupProjectLookup(true);
    findDownstreamSpy.mockResolvedValueOnce([
      { id: "art-1", type: EntityType.Artifact },
      { id: "art-2", type: EntityType.Artifact },
      { id: "ext-1", type: EntityType.ExternalLink },
    ]);

    const mockTx = {
      artifact: {
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      feature: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      externalLink: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockWithDbTx(mockTx);

    await entityLinksService.batchMoveEntities(ORG_ID, {
      entityId: "feat-1",
      entityType: EntityType.Feature,
      targetProjectId: TARGET_PROJECT_ID,
      includeDownstream: true,
    });

    expect(mockTx.artifact.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["art-1", "art-2"] }, organizationId: ORG_ID },
      data: { projectId: TARGET_PROJECT_ID },
    });
    expect(mockTx.feature.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["feat-1"] }, organizationId: ORG_ID },
      data: { projectId: TARGET_PROJECT_ID },
    });
    expect(mockTx.externalLink.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["ext-1"] }, organizationId: ORG_ID },
      data: { projectId: TARGET_PROJECT_ID },
    });
  });
});
