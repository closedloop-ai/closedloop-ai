/**
 * Branch coverage for `document-service.ts`'s creation-time surface:
 * `createDocumentRecord` (including the internal
 * `resolveRepositorySnapshot`), and the `find*` read helpers on
 * `documentService`. `withDb` is mocked (its own tests cover the wrapper);
 * `createDocumentRecord` is driven directly with a hand-rolled `tx` since it
 * already accepts one as a parameter, matching the pattern in the sibling
 * `document-service-issue-alias.test.ts`.
 */

import {
  type CreateDocumentInput,
  DocumentType,
} from "@repo/api/src/types/document";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerateArtifactSlug = vi.hoisted(() => vi.fn());
const mockWithDb = vi.hoisted(() => vi.fn());
const mockWithDbTx = vi.hoisted(() => vi.fn());
const mockParseStoredSnapshot = vi.hoisted(() => vi.fn());
const mockBuildSnapshotFromRepositorySelection = vi.hoisted(() => vi.fn());
const mockBuildSnapshotFromProjectDefaults = vi.hoisted(() => vi.fn());
const mockInheritSnapshotFromParent = vi.hoisted(() => vi.fn());

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withDb: Object.assign(mockWithDb, { tx: mockWithDbTx }),
  };
});

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/slug-generator", () => ({
  generateArtifactSlug: mockGenerateArtifactSlug,
}));

vi.mock("@/app/search/search-index-service", () => ({
  documentProjection: vi.fn(),
  searchIndexService: { indexAfterCommit: vi.fn(), removeAfterCommit: vi.fn() },
}));

vi.mock("../repository-snapshot-helpers", () => ({
  buildSnapshotFromRepositorySelection:
    mockBuildSnapshotFromRepositorySelection,
  buildSnapshotFromProjectDefaults: mockBuildSnapshotFromProjectDefaults,
  inheritSnapshotFromParent: mockInheritSnapshotFromParent,
  parseStoredSnapshot: mockParseStoredSnapshot,
}));

import { createDocumentRecord, documentService } from "../document-service";

const ORGANIZATION_ID = "org-1";
const USER_ID = "user-1";
const PROJECT_ID = "project-1";

type ArtifactCreateArgs = {
  data: { subtype?: string; projectId?: string; sortOrder?: number };
};

function makeCreatedArtifact(overrides?: Partial<{ subtype: string }>) {
  return {
    id: "doc-created-1",
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    subtype: overrides?.subtype ?? DocumentType.Doc,
    type: "DOCUMENT",
    name: "Some doc",
    slug: "DOC-1",
    status: "DRAFT",
    priority: null,
    createdById: USER_ID,
    assigneeId: USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    document: { fileName: null, approverId: null, templateForType: null },
  };
}

function makeCreateInput(
  overrides: Partial<CreateDocumentInput> = {}
): CreateDocumentInput {
  return {
    title: "Some doc",
    type: DocumentType.Doc,
    content: "body",
    ...overrides,
  } as CreateDocumentInput;
}

function makeTx(overrides?: {
  projectFindFirst?: unknown;
  documentDetailFindFirst?: unknown;
  aggregateMax?: number | null;
}) {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    project: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          overrides && "projectFindFirst" in overrides
            ? overrides.projectFindFirst
            : { settings: null }
        ),
    },
    documentDetail: {
      findFirst: vi
        .fn()
        .mockResolvedValue(overrides?.documentDetailFindFirst ?? null),
    },
    artifact: {
      findFirst: vi.fn().mockResolvedValue({ projectId: PROJECT_ID }),
      create: vi
        .fn()
        .mockImplementation((args: ArtifactCreateArgs) =>
          Promise.resolve(makeCreatedArtifact({ subtype: args.data.subtype }))
        ),
      aggregate: vi.fn().mockResolvedValue({
        _max: { sortOrder: overrides?.aggregateMax ?? null },
      }),
    },
    documentVersion: { create: vi.fn().mockResolvedValue(undefined) },
    artifactLink: {
      aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: null } }),
      create: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("createDocumentRecord assignee validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateArtifactSlug.mockResolvedValue("DOC-1");
  });

  it("throws when the resolved assignee does not exist in the organization", async () => {
    const tx = makeTx();
    mockWithDb.mockImplementation(
      async (callback: (db: unknown) => unknown) =>
        await callback({ user: { findFirst: () => Promise.resolve(null) } })
    );

    await expect(
      createDocumentRecord(
        tx as never,
        ORGANIZATION_ID,
        USER_ID,
        makeCreateInput()
      )
    ).rejects.toThrow("Invalid user ID: user not found in this organization");
    expect(tx.artifact.create).not.toHaveBeenCalled();
  });
});

describe("createDocumentRecord project-required guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateArtifactSlug.mockResolvedValue("PRD-1");
    mockWithDb.mockImplementation(
      async (callback: (db: unknown) => unknown) =>
        await callback({
          user: { findFirst: () => Promise.resolve({ id: USER_ID }) },
        })
    );
  });

  it("returns null instead of creating when a project-bound type omits projectId", async () => {
    const tx = makeTx();

    const result = await createDocumentRecord(
      tx as never,
      ORGANIZATION_ID,
      USER_ID,
      makeCreateInput({ type: DocumentType.Prd, projectId: undefined })
    );

    expect(result).toBeNull();
    expect(tx.artifact.create).not.toHaveBeenCalled();
  });
});

describe("createDocumentRecord field resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateArtifactSlug.mockResolvedValue("DOC-1");
    mockWithDb.mockImplementation(
      async (callback: (db: unknown) => unknown) =>
        await callback({
          user: { findFirst: () => Promise.resolve({ id: USER_ID }) },
        })
    );
    mockBuildSnapshotFromRepositorySelection.mockReturnValue({
      repositories: [],
      source: "loop_selection",
    });
    mockBuildSnapshotFromProjectDefaults.mockResolvedValue({
      repositories: [],
      source: "project_defaults",
    });
  });

  it("also validates the approverId when one is supplied", async () => {
    const tx = makeTx();
    const findFirstCalls: unknown[] = [];
    mockWithDb.mockImplementation(
      async (callback: (db: unknown) => unknown) =>
        await callback({
          user: {
            findFirst: (args: { where: { id: string } }) => {
              findFirstCalls.push(args.where.id);
              return Promise.resolve({ id: args.where.id });
            },
          },
        })
    );

    await createDocumentRecord(
      tx as never,
      ORGANIZATION_ID,
      USER_ID,
      makeCreateInput({ approverId: "approver-1" })
    );

    expect(findFirstCalls).toContain("approver-1");
  });

  it("forces a Template's project to undefined even when a projectId is supplied, and skips sort-order computation", async () => {
    const tx = makeTx();

    await createDocumentRecord(
      tx as never,
      ORGANIZATION_ID,
      USER_ID,
      makeCreateInput({ type: DocumentType.Template, projectId: PROJECT_ID })
    );

    const createArgs = tx.artifact.create.mock
      .calls[0][0] as ArtifactCreateArgs;
    expect(createArgs.data.projectId).toBeUndefined();
    expect(tx.artifact.aggregate).not.toHaveBeenCalled();
  });

  it("sanitizes a null body when content is not supplied by a loosely-typed in-code caller", async () => {
    const tx = makeTx();
    // pins current behavior: `CreateDocumentInput.content` is typed required,
    // but `createDocumentRecord` defensively coalesces it with `?? null`
    // because in-code callers (plan-from-local, context-attachment) build this
    // input by hand per the docstring above `createDocumentRecord`.
    const input = {
      ...makeCreateInput(),
      content: undefined,
    } as unknown as CreateDocumentInput;

    await createDocumentRecord(tx as never, ORGANIZATION_ID, USER_ID, input);

    expect(tx.documentVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ content: null }),
      })
    );
  });

  it("links the source artifact when sourceId is supplied, using the client-picked repository selection", async () => {
    const tx = makeTx();

    await createDocumentRecord(
      tx as never,
      ORGANIZATION_ID,
      USER_ID,
      makeCreateInput({
        sourceId: "source-doc-1",
        repositorySelection: {
          primary: { fullName: "closedloop-ai/closedloop-ai" },
        },
      })
    );

    expect(mockBuildSnapshotFromRepositorySelection).toHaveBeenCalledWith({
      primary: { fullName: "closedloop-ai/closedloop-ai" },
    });
    expect(tx.artifactLink.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceId: "source-doc-1",
          targetId: "doc-created-1",
          sortOrder: 0,
        }),
      })
    );
  });
});

describe("resolveRepositorySnapshot (via createDocumentRecord)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateArtifactSlug.mockResolvedValue("DOC-1");
    mockWithDb.mockImplementation(
      async (callback: (db: unknown) => unknown) =>
        await callback({
          user: { findFirst: () => Promise.resolve({ id: USER_ID }) },
        })
    );
  });

  it("inherits the parent's snapshot when sourceId resolves to a non-empty repository list", async () => {
    const tx = makeTx({
      documentDetailFindFirst: { repositorySnapshot: { some: "stored" } },
    });
    mockParseStoredSnapshot.mockReturnValue({
      repositories: [{ fullName: "acme/web" }],
      source: "loop_selection",
    });
    mockInheritSnapshotFromParent.mockReturnValue({
      repositories: [{ fullName: "acme/web" }],
      source: "inherited",
    });

    await createDocumentRecord(
      tx as never,
      ORGANIZATION_ID,
      USER_ID,
      makeCreateInput({ sourceId: "source-doc-1" })
    );

    expect(tx.documentDetail.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          artifactId: "source-doc-1",
          artifact: { organizationId: ORGANIZATION_ID },
        },
      })
    );
    expect(mockInheritSnapshotFromParent).toHaveBeenCalledWith({
      repositories: [{ fullName: "acme/web" }],
      source: "loop_selection",
    });
    const createArgs = tx.artifact.create.mock.calls[0][0] as {
      data: { document: { create: { repositorySnapshot: unknown } } };
    };
    expect(createArgs.data.document.create.repositorySnapshot).toEqual({
      repositories: [{ fullName: "acme/web" }],
      source: "inherited",
    });
  });

  it("falls through to an empty snapshot when sourceId resolves to no project and no template", async () => {
    const tx = makeTx({ documentDetailFindFirst: null });
    mockParseStoredSnapshot.mockReturnValue(null);

    await createDocumentRecord(
      tx as never,
      ORGANIZATION_ID,
      USER_ID,
      makeCreateInput({ sourceId: "source-doc-missing", projectId: undefined })
    );

    expect(mockInheritSnapshotFromParent).not.toHaveBeenCalled();
    const createArgs = tx.artifact.create.mock.calls[0][0] as {
      data: {
        document: {
          create: {
            repositorySnapshot: { repositories: unknown[]; source: string };
          };
        };
      };
    };
    expect(
      createArgs.data.document.create.repositorySnapshot.repositories
    ).toEqual([]);
    expect(createArgs.data.document.create.repositorySnapshot.source).toBe(
      "none"
    );
  });

  it("returns an empty snapshot when the resolved project cannot be found in the organization", async () => {
    const tx = makeTx({ projectFindFirst: null });

    await createDocumentRecord(
      tx as never,
      ORGANIZATION_ID,
      USER_ID,
      makeCreateInput({ type: DocumentType.Prd, projectId: PROJECT_ID })
    );

    expect(tx.project.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PROJECT_ID, organizationId: ORGANIZATION_ID },
      })
    );
    expect(mockBuildSnapshotFromProjectDefaults).not.toHaveBeenCalled();
    const createArgs = tx.artifact.create.mock.calls[0][0] as {
      data: {
        document: {
          create: { repositorySnapshot: { repositories: unknown[] } };
        };
      };
    };
    expect(
      createArgs.data.document.create.repositorySnapshot.repositories
    ).toEqual([]);
  });
});

describe("documentService find* helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeRawArtifact(type: string) {
    return {
      id: "doc-1",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      subtype: DocumentType.Doc,
      type,
      name: "Some doc",
      slug: "DOC-1",
      status: "DRAFT",
      priority: null,
      createdById: USER_ID,
      createdBy: null,
      assigneeId: USER_ID,
      assignee: null,
      dueDate: null,
      sortOrder: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      document: null,
      project: null,
      tagArtifacts: [],
    };
  }

  it("findById returns null when the artifact is not a DOCUMENT", async () => {
    mockWithDb.mockImplementation(
      async (callback: (db: unknown) => unknown) =>
        await callback({
          artifact: {
            findUnique: () => Promise.resolve(makeRawArtifact("BRANCH")),
          },
        })
    );

    await expect(
      documentService.findById("doc-1", ORGANIZATION_ID)
    ).resolves.toBeNull();
  });

  it("findById returns the mapped document when the artifact IS a DOCUMENT", async () => {
    mockWithDb.mockImplementation(
      async (callback: (db: unknown) => unknown) =>
        await callback({
          artifact: {
            findUnique: () => Promise.resolve(makeRawArtifact("DOCUMENT")),
          },
        })
    );

    const result = await documentService.findById("doc-1", ORGANIZATION_ID);
    expect(result?.id).toBe("doc-1");
  });

  it("findBySlug returns null when the matched artifact is not a DOCUMENT", async () => {
    mockWithDb.mockImplementation(
      async (callback: (db: unknown) => unknown) =>
        await callback({
          artifact: {
            findFirst: () => Promise.resolve(makeRawArtifact("DEPLOYMENT")),
          },
        })
    );

    await expect(
      documentService.findBySlug("DOC-1", ORGANIZATION_ID)
    ).resolves.toBeNull();
  });

  it("findBySlug returns the mapped document when the artifact IS a DOCUMENT", async () => {
    mockWithDb.mockImplementation(
      async (callback: (db: unknown) => unknown) =>
        await callback({
          artifact: {
            findFirst: () => Promise.resolve(makeRawArtifact("DOCUMENT")),
          },
        })
    );

    const result = await documentService.findBySlug("DOC-1", ORGANIZATION_ID);
    expect(result?.id).toBe("doc-1");
  });

  it("findByIdSimple returns null when the artifact is not a DOCUMENT", async () => {
    mockWithDb.mockImplementation(
      async (callback: (db: unknown) => unknown) =>
        await callback({
          artifact: {
            findUnique: () => Promise.resolve(makeRawArtifact("BRANCH")),
          },
        })
    );

    await expect(
      documentService.findByIdSimple("doc-1", ORGANIZATION_ID)
    ).resolves.toBeNull();
  });

  it("findByIdSimple returns the mapped document when the artifact IS a DOCUMENT", async () => {
    mockWithDb.mockImplementation(
      async (callback: (db: unknown) => unknown) =>
        await callback({
          artifact: {
            findUnique: () => Promise.resolve(makeRawArtifact("DOCUMENT")),
          },
        })
    );

    const result = await documentService.findByIdSimple(
      "doc-1",
      ORGANIZATION_ID
    );
    expect(result?.id).toBe("doc-1");
  });

  it("findSlugById returns null when no artifact matches", async () => {
    mockWithDb.mockImplementation(
      async (callback: (db: unknown) => unknown) =>
        await callback({
          artifact: { findUnique: () => Promise.resolve(null) },
        })
    );

    await expect(
      documentService.findSlugById("missing", ORGANIZATION_ID)
    ).resolves.toBeNull();
  });

  it("findSlugById returns the slug when an artifact matches", async () => {
    mockWithDb.mockImplementation(
      async (callback: (db: unknown) => unknown) =>
        await callback({
          artifact: { findUnique: () => Promise.resolve({ slug: "DOC-1" }) },
        })
    );

    await expect(
      documentService.findSlugById("doc-1", ORGANIZATION_ID)
    ).resolves.toBe("DOC-1");
  });
});
