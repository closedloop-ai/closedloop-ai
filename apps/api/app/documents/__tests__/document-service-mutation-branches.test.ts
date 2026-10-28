/**
 * Branch coverage for `documentService.create`, `.createWithInlineImages`,
 * `.update`, and `.delete`. `withDb`/`withDb.tx` are mocked; the post-commit
 * search-indexing and Liveblocks room side effects are mocked so these tests
 * stay focused on the write-path branch decisions.
 */

import {
  AuditAction,
  AuditActorType,
  AuditObjectType,
} from "@repo/api/src/types/audit";
import {
  type CreateDocumentInput,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { Result } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const mockWithDb = vi.hoisted(() => vi.fn());
const mockWithDbTx = vi.hoisted(() => vi.fn());
const mockCreateDocumentRoom = vi.hoisted(() => vi.fn());
const mockDeleteDocumentRoom = vi.hoisted(() => vi.fn());
const mockIndexAfterCommit = vi.hoisted(() => vi.fn());
const mockRemoveAfterCommit = vi.hoisted(() => vi.fn());
const mockDocumentProjection = vi.hoisted(() => vi.fn());
const mockGenerateArtifactSlug = vi.hoisted(() => vi.fn());

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

vi.mock("../room-utils", () => ({
  createDocumentRoom: mockCreateDocumentRoom,
  deleteDocumentRoom: mockDeleteDocumentRoom,
}));

vi.mock("@/app/search/search-index-service", () => ({
  documentProjection: mockDocumentProjection,
  searchIndexService: {
    indexAfterCommit: mockIndexAfterCommit,
    removeAfterCommit: mockRemoveAfterCommit,
  },
}));

import { systemAuditActor } from "@/app/audit/audit-emit-service";
import { documentService } from "../document-service";

const ORGANIZATION_ID = "org-1";
const USER_ID = "user-1";
const PROJECT_ID = "project-1";
const DOCUMENT_ID = "doc-1";
const OTHER_ORGANIZATION_ID = "org-2";
const OTHER_ORG_PROJECT_ID = "project-2";

function makeCreatedArtifact(overrides?: {
  subtype?: string;
  slug?: string | null;
}) {
  return {
    id: DOCUMENT_ID,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    subtype: overrides?.subtype ?? DocumentType.Doc,
    type: "DOCUMENT",
    name: "Some doc",
    slug: overrides?.slug ?? "DOC-1",
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

function makeCreateTx(overrides?: { slug?: string | null }) {
  return {
    project: { findFirst: vi.fn().mockResolvedValue({ settings: null }) },
    documentDetail: { findFirst: vi.fn().mockResolvedValue(null) },
    artifact: {
      create: vi
        .fn()
        .mockImplementation((args: { data: { subtype?: string } }) =>
          Promise.resolve(
            makeCreatedArtifact({
              subtype: args.data.subtype,
              slug: overrides?.slug,
            })
          )
        ),
      aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: null } }),
    },
    documentVersion: { create: vi.fn().mockResolvedValue(undefined) },
    artifactLink: { create: vi.fn().mockResolvedValue(undefined) },
  };
}

describe("documentService.create", () => {
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

  it("throws when a Template create also supplies a projectId", async () => {
    mockWithDbTx.mockImplementation(
      async (callback: (tx: unknown) => unknown) =>
        await callback(makeCreateTx())
    );

    await expect(
      documentService.create(
        ORGANIZATION_ID,
        USER_ID,
        makeCreateInput({ type: DocumentType.Template, projectId: PROJECT_ID })
      )
    ).rejects.toThrow(
      "Templates are organization-level artifacts and cannot be associated with a project"
    );
    expect(mockCreateDocumentRoom).not.toHaveBeenCalled();
  });

  it("creates the room and indexes the raw content when the document is created", async () => {
    const tx = makeCreateTx();
    mockWithDbTx.mockImplementation(
      async (callback: (tx: unknown) => unknown) => await callback(tx)
    );

    const result = await documentService.create(
      ORGANIZATION_ID,
      USER_ID,
      makeCreateInput({ content: "raw seeded body" })
    );

    expect(result?.id).toBe(DOCUMENT_ID);
    expect(mockCreateDocumentRoom).toHaveBeenCalledWith(result);
    expect(mockDocumentProjection).toHaveBeenCalledWith(
      expect.objectContaining({ body: "raw seeded body" })
    );
  });

  it("defaults the indexed body to null when content is not supplied by a loosely-typed in-code caller", async () => {
    const tx = makeCreateTx();
    mockWithDbTx.mockImplementation(
      async (callback: (tx: unknown) => unknown) => await callback(tx)
    );
    // pins current behavior: `content` is typed required on CreateDocumentInput,
    // but `create()` defensively falls back with `input.content ?? null` for
    // callers that build this input in code (see document-service.ts's own
    // comment on this same fallback in `createDocumentRecord`).
    const input = makeCreateInput();
    (input as Record<string, unknown>).content = undefined;

    await documentService.create(ORGANIZATION_ID, USER_ID, input);

    expect(mockDocumentProjection).toHaveBeenCalledWith(
      expect.objectContaining({ body: null })
    );
  });

  it("skips the room creation and search indexing when createDocumentRecord returns null", async () => {
    mockWithDbTx.mockImplementation(
      async (callback: (tx: unknown) => unknown) =>
        await callback(makeCreateTx())
    );

    const result = await documentService.create(
      ORGANIZATION_ID,
      USER_ID,
      // Project-bound type with no projectId -> createDocumentRecord's own
      // guard returns null before ever calling tx.artifact.create.
      makeCreateInput({ type: DocumentType.Prd, projectId: undefined })
    );

    expect(result).toBeNull();
    expect(mockCreateDocumentRoom).not.toHaveBeenCalled();
    expect(mockDocumentProjection).not.toHaveBeenCalled();
  });
});

describe("documentService.createWithInlineImages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns DocumentCreateFailed when the underlying create returns null", async () => {
    const createSpy = vi
      .spyOn(documentService, "create")
      .mockResolvedValue(null);

    const result = await documentService.createWithInlineImages(
      ORGANIZATION_ID,
      USER_ID,
      makeCreateInput(),
      []
    );

    expect(result).toEqual(Result.err({ code: "document_create_failed" }));
    createSpy.mockRestore();
  });
});

describe("documentService.update", () => {
  // Two orgs, so the project lookup's org predicate is decidable here rather
  // than at a mocked route (ISS-6748).
  const PROJECT_ROWS = [
    { id: PROJECT_ID, organizationId: ORGANIZATION_ID },
    { id: OTHER_ORG_PROJECT_ID, organizationId: OTHER_ORGANIZATION_ID },
  ];

  /**
   * Resolves against Prisma's own `where` semantics: a key the service did NOT
   * put in the `where` constrains nothing. Filtering on the caller's
   * `organizationId` argument instead would reintroduce the false green.
   */
  function makeProjectFindUnique() {
    return vi.fn((args: { where: { id: string; organizationId?: string } }) =>
      Promise.resolve(
        PROJECT_ROWS.find(
          (row) =>
            row.id === args.where.id &&
            (args.where.organizationId === undefined ||
              row.organizationId === args.where.organizationId)
        ) ?? null
      )
    );
  }

  function makeUpdateTx(overrides?: { existingArtifact?: unknown }) {
    return {
      project: { findUnique: makeProjectFindUnique() },
      artifact: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            overrides && "existingArtifact" in overrides
              ? overrides.existingArtifact
              : { subtype: DocumentType.Doc }
          ),
        update: vi
          .fn()
          .mockImplementation((_args: { data: Record<string, unknown> }) =>
            Promise.resolve(makeCreatedArtifact({}))
          ),
      },
      // Defensive stub for indexDocumentProjection's best-effort background
      // read (`waitUntil`), which update() always triggers with a null body.
      documentVersion: { findFirst: vi.fn().mockResolvedValue(null) },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("validates both assigneeId and approverId when both are supplied", async () => {
    const validated: string[] = [];
    mockWithDb.mockImplementation(
      async (callback: (db: unknown) => unknown) =>
        await callback({
          user: {
            findFirst: (args: { where: { id: string } }) => {
              validated.push(args.where.id);
              return Promise.resolve({ id: args.where.id });
            },
          },
          project: makeUpdateTx().project,
          artifact: makeUpdateTx().artifact,
        })
    );

    await documentService.update(DOCUMENT_ID, ORGANIZATION_ID, {
      assigneeId: "assignee-9",
      approverId: "approver-9",
    });

    expect(validated).toEqual(["assignee-9", "approver-9"]);
  });

  it("throws when the supplied projectId names a real project owned by another organization", async () => {
    const tx = makeUpdateTx();
    mockWithDb.mockImplementation(
      async (callback: (db: unknown) => unknown) => await callback(tx)
    );

    await expect(
      documentService.update(DOCUMENT_ID, ORGANIZATION_ID, {
        projectId: OTHER_ORG_PROJECT_ID,
      })
    ).rejects.toThrow(
      "Invalid project ID: project not found in this organization"
    );
    expect(tx.project.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: OTHER_ORG_PROJECT_ID, organizationId: ORGANIZATION_ID },
      })
    );
    expect(tx.artifact.update).not.toHaveBeenCalled();
  });

  it("proceeds with the update when the supplied projectId does belong to the organization", async () => {
    const tx = makeUpdateTx();
    mockWithDb.mockImplementation(
      async (callback: (db: unknown) => unknown) => await callback(tx)
    );

    await expect(
      documentService.update(DOCUMENT_ID, ORGANIZATION_ID, {
        projectId: PROJECT_ID,
      })
    ).resolves.toMatchObject({ id: DOCUMENT_ID });
    expect(tx.project.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PROJECT_ID, organizationId: ORGANIZATION_ID },
      })
    );
  });

  it("skips the status-vocabulary check entirely when status is not part of the update", async () => {
    const tx = makeUpdateTx();
    mockWithDb.mockImplementation(
      async (callback: (db: unknown) => unknown) => await callback(tx)
    );

    await documentService.update(DOCUMENT_ID, ORGANIZATION_ID, {
      title: "Renamed",
    });

    expect(tx.artifact.findUnique).not.toHaveBeenCalled();
  });

  it("falls back to the word 'document' in the invalid-status message when the target has no subtype", async () => {
    mockWithDb.mockImplementation(
      async (callback: (db: unknown) => unknown) =>
        await callback(makeUpdateTx({ existingArtifact: { subtype: null } }))
    );

    await expect(
      documentService.update(DOCUMENT_ID, ORGANIZATION_ID, {
        // Reachable at runtime: the update payload arrives as parsed JSON, so
        // the service's own status guard is what rejects it, not the type.
        status: "not-a-real-status" as never,
      })
    ).rejects.toThrow(
      'Status "not-a-real-status" is not valid for this document'
    );
  });

  it("includes a nested document update only when the payload has detail fields", async () => {
    const tx = makeUpdateTx();
    mockWithDb.mockImplementation(
      async (callback: (db: unknown) => unknown) => await callback(tx)
    );

    await documentService.update(DOCUMENT_ID, ORGANIZATION_ID, {
      fileName: "renamed.md",
    });

    expect(tx.artifact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          document: { update: { fileName: "renamed.md" } },
        }),
      })
    );
  });
});

describe("documentService.delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * One db double serving both the pre-read (`withDb`) and the delete
   * transaction (`withDb.tx`), which since ISS-10029 also carries the audit
   * outbox insert. `withDb` is mocked here, so the audit enqueue's own
   * `withDb` call lands on this same double rather than on real ALS.
   *
   * The split between the two reads is the contract, not an accident of the
   * double: `findUnique` answers only "is this a DOCUMENT" and `delete`
   * returns the row the entry describes, so the detail can only come from the
   * version that actually disappeared.
   */
  function stubDb(artifact: { slug: string | null; type: string }): {
    deleteFn: Mock;
    createOutbox: Mock;
  } {
    const deleteFn = vi.fn().mockResolvedValue({
      slug: artifact.slug,
      name: "Seeded document",
      subtype: "ISSUE",
      status: IssueStatus.Todo,
      projectId: null,
    });
    const createOutbox = vi.fn().mockResolvedValue({ id: "outbox-row-1" });
    const client = {
      artifact: {
        findUnique: () => Promise.resolve({ type: artifact.type }),
        delete: deleteFn,
      },
      auditOutbox: { create: createOutbox },
    };
    const run = async (callback: (db: unknown) => unknown) =>
      await callback(client);
    mockWithDb.mockImplementation(run);
    mockWithDbTx.mockImplementation(run);
    return { deleteFn, createOutbox };
  }

  it("does nothing when the target artifact is not a DOCUMENT", async () => {
    const { deleteFn, createOutbox } = stubDb({ slug: "BR-1", type: "BRANCH" });

    await documentService.delete(
      DOCUMENT_ID,
      ORGANIZATION_ID,
      systemAuditActor()
    );

    expect(deleteFn).not.toHaveBeenCalled();
    expect(createOutbox).not.toHaveBeenCalled();
    expect(mockRemoveAfterCommit).not.toHaveBeenCalled();
  });

  it("enqueues one document.deleted entry inside the delete transaction", async () => {
    const { deleteFn, createOutbox } = stubDb({
      slug: "DOC-1",
      type: "DOCUMENT",
    });

    await documentService.delete(
      DOCUMENT_ID,
      ORGANIZATION_ID,
      systemAuditActor()
    );

    expect(mockWithDbTx).toHaveBeenCalledTimes(1);
    expect(deleteFn).toHaveBeenCalled();
    expect(createOutbox).toHaveBeenCalledWith({
      data: {
        organizationId: ORGANIZATION_ID,
        action: AuditAction.DocumentDeleted,
        actorType: AuditActorType.System,
        actorId: null,
        objectType: AuditObjectType.Document,
        objectId: DOCUMENT_ID,
        detail: {
          slug: "DOC-1",
          title: "Seeded document",
          subtype: "ISSUE",
          status: IssueStatus.Todo,
          projectId: null,
        },
      },
      select: { id: true },
    });
  });

  it("deletes the room only when the deleted document has a slug", async () => {
    const { deleteFn } = stubDb({ slug: null, type: "DOCUMENT" });

    await documentService.delete(
      DOCUMENT_ID,
      ORGANIZATION_ID,
      systemAuditActor()
    );

    expect(deleteFn).toHaveBeenCalled();
    expect(mockRemoveAfterCommit).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      entityType: "document",
      entityId: DOCUMENT_ID,
    });
    expect(mockDeleteDocumentRoom).not.toHaveBeenCalled();
  });

  it("deletes the room when the deleted document has a slug", async () => {
    stubDb({ slug: "DOC-1", type: "DOCUMENT" });

    await documentService.delete(
      DOCUMENT_ID,
      ORGANIZATION_ID,
      systemAuditActor()
    );

    expect(mockDeleteDocumentRoom).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      "DOC-1"
    );
  });
});
