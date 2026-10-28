import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbAll, mockWithDbCall } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: {
    TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" },
  },
}));

const labelReconciliation = vi.hoisted(() => ({
  reconcileLinkedPullRequestLabelsForArtifact: vi.fn(),
  reconcileLinkedPullRequestLabelsForArtifacts: vi.fn(),
}));

vi.mock(
  "@/lib/github/artifact-tag-label-reconciliation",
  () => labelReconciliation
);

import type { TagEntityType as TagEntityTypeValue } from "@repo/api/src/types/tag";
import { TAG_LIST_DEFAULT_LIMIT, TagEntityType } from "@repo/api/src/types/tag";
import {
  DuplicateNameError,
  EntityNotFoundError,
  tagService,
} from "@/app/tags/service";

const ORG_ID = "org-123";
const TAG_ID = "tag-789";
const ACTOR = { userId: "test-actor", authMethod: "session" } as const;

function prismaError(code: string) {
  return Object.assign(new Error(`prisma ${code}`), { code });
}

function makeTag(overrides?: Record<string, unknown>) {
  return {
    id: TAG_ID,
    organizationId: ORG_ID,
    name: "Bug",
    color: "red",
    createdById: "user-1",
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    ...overrides,
  };
}

describe("tagService.create catch-block Prisma error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps a P2002 unique-constraint error from the write itself to DuplicateNameError", async () => {
    const mockDb = {
      tag: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockRejectedValue(prismaError("P2002")),
      },
    };
    mockWithDbAll(mockDb);

    await expect(
      tagService.create(ORG_ID, "user-1", { name: "Bug", color: "red" })
    ).rejects.toThrow(DuplicateNameError);
  });

  it("rethrows an unrelated database error unchanged", async () => {
    const dbError = prismaError("P2099");
    const mockDb = {
      tag: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockRejectedValue(dbError),
      },
    };
    mockWithDbAll(mockDb);

    await expect(
      tagService.create(ORG_ID, "user-1", { name: "Bug", color: "red" })
    ).rejects.toBe(dbError);
  });
});

describe("tagService.update catch-block Prisma error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps P2025 (row vanished before the write) to EntityNotFoundError", async () => {
    const mockDb = {
      tag: {
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockRejectedValue(prismaError("P2025")),
      },
    };
    mockWithDbAll(mockDb);

    await expect(
      tagService.update(TAG_ID, ORG_ID, { color: "blue" })
    ).rejects.toThrow(EntityNotFoundError);
  });

  it("maps a P2002 unique-constraint error from the write itself to DuplicateNameError, keyed by the requested name", async () => {
    const mockDb = {
      tag: {
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockRejectedValue(prismaError("P2002")),
      },
    };
    mockWithDbAll(mockDb);

    await expect(
      tagService.update(TAG_ID, ORG_ID, { name: "Taken" })
    ).rejects.toThrow(
      'A tag named "Taken" already exists in this organization.'
    );
  });

  // Pins current behavior: a name-less update (e.g. color-only) still reaches
  // the write, and if THAT rejects P2002 the error message falls back to an
  // empty name because `input.name` was never provided.
  it("falls back to an empty name in DuplicateNameError when a P2002 hits a name-less update", async () => {
    const mockDb = {
      tag: {
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockRejectedValue(prismaError("P2002")),
      },
    };
    mockWithDbAll(mockDb);

    await expect(
      tagService.update(TAG_ID, ORG_ID, { color: "blue" })
    ).rejects.toThrow('A tag named "" already exists in this organization.');
  });

  it("rethrows an unrelated database error unchanged", async () => {
    const dbError = prismaError("P2099");
    const mockDb = {
      tag: {
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockRejectedValue(dbError),
      },
    };
    mockWithDbAll(mockDb);

    await expect(
      tagService.update(TAG_ID, ORG_ID, { color: "blue" })
    ).rejects.toBe(dbError);
  });
});

describe("tagService.delete catch-block Prisma error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps P2025 (already gone) to EntityNotFoundError", async () => {
    const mockDb = {
      tag: { delete: vi.fn().mockRejectedValue(prismaError("P2025")) },
    };
    mockWithDbAll(mockDb);

    await expect(tagService.delete(TAG_ID, ORG_ID)).rejects.toThrow(
      EntityNotFoundError
    );
  });

  it("rethrows an unrelated database error unchanged", async () => {
    const dbError = prismaError("P2099");
    const mockDb = {
      tag: { delete: vi.fn().mockRejectedValue(dbError) },
    };
    mockWithDbAll(mockDb);

    await expect(tagService.delete(TAG_ID, ORG_ID)).rejects.toBe(dbError);
  });
});

describe("tagService.applyTag rejects an entity type validateEntityExists does not recognize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws before any write when entityType matches none of the known switch cases", async () => {
    mockWithDbAll({
      tag: { findFirst: vi.fn().mockResolvedValue({ id: TAG_ID }) },
    });

    await expect(
      tagService.applyTag(
        TAG_ID,
        "WORKSTREAM" as TagEntityTypeValue,
        "entity-1",
        ORG_ID,
        ACTOR
      )
    ).rejects.toThrow("Unknown entity type: WORKSTREAM");
  });
});

describe("tagService.applyTag retains non-Artifact duplicate behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      entityType: TagEntityType.Project,
      entity: "project",
      relation: "tagProject",
    },
  ])(
    "treats a targetless P2002 as a retry for $entityType",
    async ({ entityType, entity, relation }) => {
      const mockDb = {
        tag: { findFirst: vi.fn().mockResolvedValue({ id: TAG_ID }) },
        [entity]: { findFirst: vi.fn().mockResolvedValue({ id: "entity-1" }) },
        [relation]: { create: vi.fn().mockRejectedValue(prismaError("P2002")) },
      };
      mockWithDbAll(mockDb);

      await expect(
        tagService.applyTag(TAG_ID, entityType, "entity-1", ORG_ID, ACTOR)
      ).resolves.toBe(false);
    }
  );
});

describe("tagService.removeTag rejects an entity type its own switch does not recognize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws for an entityType outside Project/Artifact", async () => {
    mockWithDbCall({
      tag: { findFirst: vi.fn().mockResolvedValue({ id: TAG_ID }) },
    });

    await expect(
      tagService.removeTag(
        TAG_ID,
        "WORKSTREAM" as TagEntityTypeValue,
        "entity-1",
        ORG_ID,
        ACTOR
      )
    ).rejects.toThrow("Unknown entity type: WORKSTREAM");
  });
});

describe("tagService.batchApplyTag missing-artifact validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws EntityNotFoundError naming the ids that were not found in the org", async () => {
    const mockDb = {
      tag: { findFirst: vi.fn().mockResolvedValue({ id: TAG_ID }) },
      artifact: {
        // Only art-1 exists; art-2 does not resolve in this org.
        findMany: vi.fn().mockResolvedValue([{ id: "art-1" }]),
      },
    };
    mockWithDbCall(mockDb);

    await expect(
      tagService.batchApplyTag(
        TAG_ID,
        TagEntityType.Artifact,
        ["art-1", "art-2"],
        ORG_ID
      )
    ).rejects.toThrow("Artifact art-2 not found in this organization");
  });

  it("reconciles every requested artifact while reporting only inserted tag relations", async () => {
    const createManyAndReturn = vi
      .fn()
      .mockResolvedValue([{ artifactId: "art-2" }]);
    mockWithDbAll({
      tag: { findFirst: vi.fn().mockResolvedValue({ id: TAG_ID }) },
      artifact: {
        findMany: vi.fn().mockResolvedValue([{ id: "art-1" }, { id: "art-2" }]),
      },
      tagArtifact: { createManyAndReturn },
    });

    await expect(
      tagService.batchApplyTag(
        TAG_ID,
        TagEntityType.Artifact,
        ["art-1", "art-2"],
        ORG_ID
      )
    ).resolves.toEqual({ appliedCount: 1, newlyTaggedIds: ["art-2"] });
    expect(
      labelReconciliation.reconcileLinkedPullRequestLabelsForArtifacts
    ).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      artifactIds: ["art-1", "art-2"],
    });
  });

  it("reconciles GitHub labels when a retried batch inserts nothing", async () => {
    const recordReceipt = vi.fn();
    mockWithDbAll({
      tag: { findFirst: vi.fn().mockResolvedValue({ id: TAG_ID }) },
      artifact: { findMany: vi.fn().mockResolvedValue([{ id: "art-1" }]) },
      tagArtifact: { createManyAndReturn: vi.fn().mockResolvedValue([]) },
    });

    await expect(
      tagService.batchApplyTag(
        TAG_ID,
        TagEntityType.Artifact,
        ["art-1"],
        ORG_ID,
        recordReceipt
      )
    ).resolves.toEqual({ appliedCount: 0, newlyTaggedIds: [] });
    expect(recordReceipt).toHaveBeenCalledWith(
      expect.anything(),
      [],
      ["art-1"]
    );
    expect(
      labelReconciliation.reconcileLinkedPullRequestLabelsForArtifacts
    ).toHaveBeenCalledWith({ organizationId: ORG_ID, artifactIds: ["art-1"] });
  });
});

describe("tagService validateTagOwnership not-found path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws EntityNotFoundError for the tag itself when it does not resolve in the org", async () => {
    mockWithDbCall({
      tag: { findFirst: vi.fn().mockResolvedValue(null) },
    });

    await expect(
      tagService.removeTag(
        TAG_ID,
        TagEntityType.Project,
        "entity-1",
        ORG_ID,
        ACTOR
      )
    ).rejects.toThrow("Tag tag-789 not found in this organization");
  });
});

describe("tagService.findPageByOrg limit fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("floors the page size at TAG_LIST_DEFAULT_LIMIT when no limit is given", async () => {
    const findMany = vi.fn().mockResolvedValue([makeTag()]);
    const count = vi.fn().mockResolvedValue(1);
    mockWithDbAll({ tag: { findMany, count } });

    await tagService.findPageByOrg(ORG_ID, {});

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: TAG_LIST_DEFAULT_LIMIT })
    );
  });
});
