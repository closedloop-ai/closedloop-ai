import {
  ArtifactSubtype,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall } from "../../../__tests__/utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { DbNull: "DbNull" },
}));

import { artifactLinksService } from "../service";

const ORG_ID = "org-1";

function artifact(overrides: Record<string, unknown>) {
  return {
    id: "parent-doc-1",
    organizationId: ORG_ID,
    projectId: "project-1",
    workstreamId: null,
    type: ArtifactType.Document,
    subtype: ArtifactSubtype.Prd,
    name: "Parent PRD",
    slug: "PRD-1",
    status: "APPROVED",
    priority: null,
    assigneeId: null,
    dueDate: null,
    externalUrl: null,
    sortOrder: null,
    createdAt: new Date("2026-05-13T00:00:00.000Z"),
    createdById: "user-1",
    updatedAt: new Date("2026-05-13T00:00:00.000Z"),
    ...overrides,
  };
}

function link(overrides: Record<string, unknown>) {
  const source = artifact({});
  const target = artifact({ id: "doc-1", subtype: ArtifactSubtype.Feature });
  const row = {
    id: "link-1",
    organizationId: ORG_ID,
    sourceId: source.id,
    targetId: target.id,
    linkType: LinkType.Produces,
    metadata: null,
    createdAt: new Date("2026-05-13T00:00:00.000Z"),
    source,
    target,
    ...overrides,
  };
  return {
    ...row,
    sourceId: (row.source as { id: string }).id,
    targetId:
      overrides.target === undefined && typeof overrides.targetId === "string"
        ? overrides.targetId
        : (row.target as { id: string }).id,
  };
}

describe("artifactLinksService.findSelectedParentProjections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty list without querying for no target ids", async () => {
    const mockDb = { artifactLink: { findMany: vi.fn() } };
    mockWithDbCall(mockDb);

    await expect(
      artifactLinksService.findSelectedParentProjections(ORG_ID, [])
    ).resolves.toEqual([]);
    expect(mockDb.artifactLink.findMany).not.toHaveBeenCalled();
  });

  it("returns explicit null projections when no parent links qualify", async () => {
    const mockDb = {
      artifactLink: { findMany: vi.fn().mockResolvedValue([]) },
    };
    mockWithDbCall(mockDb);

    const result = await artifactLinksService.findSelectedParentProjections(
      ORG_ID,
      ["doc-1"]
    );

    expect(mockDb.artifactLink.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG_ID,
        targetId: { in: ["doc-1"] },
        linkType: LinkType.Produces,
      },
      include: {
        source: {
          include: {
            branch: { include: { currentPullRequestDetail: true } },
          },
        },
        target: {
          include: {
            branch: { include: { currentPullRequestDetail: true } },
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    expect(result).toEqual([
      {
        targetId: "doc-1",
        linkId: null,
        linkType: null,
        linkCreatedAt: null,
        parentArtifact: null,
      },
    ]);
  });

  it("projects a document parent with subtype", async () => {
    const row = link({});
    const mockDb = {
      artifactLink: { findMany: vi.fn().mockResolvedValue([row]) },
    };
    mockWithDbCall(mockDb);

    const [projection] =
      await artifactLinksService.findSelectedParentProjections(ORG_ID, [
        "doc-1",
      ]);

    expect(projection).toMatchObject({
      targetId: "doc-1",
      linkId: "link-1",
      linkType: LinkType.Produces,
      parentArtifact: {
        id: "parent-doc-1",
        type: ArtifactType.Document,
        subtype: ArtifactSubtype.Prd,
        name: "Parent PRD",
        slug: "PRD-1",
      },
    });
    expect(projection?.linkCreatedAt).toEqual(row.createdAt);
  });

  it("projects pull-request and deployment parents", async () => {
    const rows = [
      link({
        id: "link-pr",
        targetId: "doc-pr",
        source: artifact({
          id: "parent-pr-1",
          type: ArtifactType.Branch,
          subtype: null,
          name: "PR #1170",
          slug: null,
          externalUrl:
            "https://github.com/closedloop-ai/symphony-alpha/pull/1170",
        }),
      }),
      link({
        id: "link-deploy",
        targetId: "doc-deploy",
        source: artifact({
          id: "parent-deploy-1",
          type: ArtifactType.Deployment,
          subtype: null,
          name: "Preview",
          slug: null,
          externalUrl: "https://vercel.example/deploy",
        }),
      }),
    ];
    const mockDb = {
      artifactLink: { findMany: vi.fn().mockResolvedValue(rows) },
    };
    mockWithDbCall(mockDb);

    const result = await artifactLinksService.findSelectedParentProjections(
      ORG_ID,
      ["doc-pr", "doc-deploy"]
    );

    expect(result[0]?.parentArtifact).toMatchObject({
      id: "parent-pr-1",
      type: ArtifactType.Branch,
      subtype: null,
    });
    expect(result[1]?.parentArtifact).toMatchObject({
      id: "parent-deploy-1",
      type: ArtifactType.Deployment,
      subtype: null,
    });
  });

  it("uses PRODUCES by default and accepts an explicit non-default link type", async () => {
    const mockDb = {
      artifactLink: { findMany: vi.fn().mockResolvedValue([]) },
    };
    mockWithDbCall(mockDb);

    await artifactLinksService.findSelectedParentProjections(ORG_ID, ["doc-1"]);
    await artifactLinksService.findSelectedParentProjections(
      ORG_ID,
      ["doc-1"],
      { linkType: LinkType.RelatesTo }
    );

    expect(mockDb.artifactLink.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ linkType: LinkType.Produces }),
      })
    );
    expect(mockDb.artifactLink.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ linkType: LinkType.RelatesTo }),
      })
    );
  });

  it("keeps the first ordered parent per target and never overwrites it", async () => {
    const rows = [
      link({
        id: "link-newest-highest",
        source: artifact({
          id: "selected-parent",
          subtype: ArtifactSubtype.Feature,
        }),
      }),
      link({
        id: "link-older",
        source: artifact({ id: "older-parent", subtype: ArtifactSubtype.Prd }),
      }),
    ];
    const mockDb = {
      artifactLink: { findMany: vi.fn().mockResolvedValue(rows) },
    };
    mockWithDbCall(mockDb);

    const [projection] =
      await artifactLinksService.findSelectedParentProjections(ORG_ID, [
        "doc-1",
      ]);

    expect(projection?.parentArtifact).toMatchObject({
      id: "selected-parent",
      subtype: ArtifactSubtype.Feature,
    });
  });
});
