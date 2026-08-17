import {
  type CreateDocumentInput,
  DOCUMENT_LIST_DEFAULT_LIMIT,
  DOCUMENT_LIST_MAX_LIMIT,
  DocumentType,
  DocumentTypeAlias,
} from "@repo/api/src/types/document";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ISS-4397: `createDocumentRecord` and `documentService.findAll` accept the
// request-side `ISSUE` alias in addition to the persisted `DocumentType`. The
// HTTP path normalizes at the create validator, but these entry points are also
// called in-code (generation / plan-from-local / context-attachment services)
// and by direct filters, so each normalizes the alias to the persisted
// `FEATURE` subtype itself. These tests drive the real service against a mocked
// DB boundary and assert the persisted subtype / query predicate, so removing
// the in-service normalization fails here even though the validator suite (which
// normalizes upstream) would stay green.

const ORGANIZATION_ID = "org-1";
const USER_ID = "user-1";
const PROJECT_ID = "project-1";

const mockGenerateArtifactSlug = vi.hoisted(() => vi.fn());
const mockWithDb = vi.hoisted(() => vi.fn());
const mockWithDbTx = vi.hoisted(() => vi.fn());
const mockLoadProjectRepoDefaults = vi.hoisted(() => vi.fn());

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

vi.mock("@/app/projects/repository-resolver", () => ({
  loadProjectRepoDefaults: mockLoadProjectRepoDefaults,
}));

// Keep the post-write side effects inert so the test focuses on the persisted
// shape rather than search/loop-status fan-out.
vi.mock("@/app/search/search-index-service", () => ({
  documentProjection: vi.fn(),
  searchIndexService: { indexAfterCommit: vi.fn() },
}));
vi.mock("../generation-status-helpers", () => ({
  mergeLoopStatuses: vi.fn().mockResolvedValue(undefined),
  suppressDismissedFailuresForDocumentMap: vi.fn().mockResolvedValue(undefined),
}));

import { createDocumentRecord, documentService } from "../document-service";

type ArtifactCreateArgs = { data: { subtype?: string } };

function makeCreatedArtifact(subtype: string) {
  return {
    id: "doc-created-1",
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    subtype,
    type: "DOCUMENT",
    name: "Broken login",
    slug: "ISS-1",
    status: "BACKLOG",
    priority: null,
    createdById: USER_ID,
    assigneeId: USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    document: { fileName: null, approverId: null, templateForType: null },
  };
}

function makeIssueInput(): CreateDocumentInput {
  return {
    title: "Broken login",
    // Request-side alias — must normalize to persisted FEATURE.
    type: DocumentTypeAlias.Issue,
    projectId: PROJECT_ID,
    content: "steps to repro",
  } as CreateDocumentInput;
}

describe("createDocumentRecord normalizes the ISSUE alias (ISS-4397)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateArtifactSlug.mockResolvedValue("ISS-1");
    mockLoadProjectRepoDefaults.mockResolvedValue(null);
    // validateUserInOrg reads a user row via withDb; return a match.
    mockWithDb.mockImplementation(
      async (
        callback: (db: {
          user: { findFirst: () => Promise<unknown> };
        }) => Promise<unknown>
      ) =>
        await callback({
          user: { findFirst: () => Promise.resolve({ id: USER_ID }) },
        })
    );
  });

  it("persists subtype FEATURE and mints the FEATURE slug for a type=ISSUE create", async () => {
    let capturedCreateArgs: ArtifactCreateArgs | undefined;
    const tx = {
      project: {
        findFirst: vi.fn().mockResolvedValue({ settings: null }),
      },
      artifact: {
        create: vi.fn((args: ArtifactCreateArgs) => {
          capturedCreateArgs = args;
          return Promise.resolve(makeCreatedArtifact(DocumentType.Feature));
        }),
        aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: null } }),
      },
      documentVersion: { create: vi.fn().mockResolvedValue(undefined) },
      artifactLink: { create: vi.fn().mockResolvedValue(undefined) },
    };

    const result = await createDocumentRecord(
      tx as never,
      ORGANIZATION_ID,
      USER_ID,
      makeIssueInput()
    );

    // The persisted subtype must be the canonical FEATURE, never the ISSUE alias.
    expect(capturedCreateArgs?.data.subtype).toBe(DocumentType.Feature);
    // Slug generation keys off the normalized type, not the raw alias.
    expect(mockGenerateArtifactSlug).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      DocumentType.Feature
    );
    expect(result?.type).toBe(DocumentType.Feature);
  });
});

describe("documentService.findAll normalizes the ISSUE alias (ISS-4397)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries subtype FEATURE when filtering type=ISSUE", async () => {
    let capturedWhere: { subtype?: string } | undefined;
    mockWithDb.mockImplementation(
      async (
        callback: (db: {
          artifact: {
            findMany: (args: {
              where: { subtype?: string };
            }) => Promise<unknown[]>;
          };
        }) => Promise<unknown[]>
      ) =>
        await callback({
          artifact: {
            findMany: (args) => {
              capturedWhere = args.where;
              return Promise.resolve([]);
            },
          },
        })
    );

    await documentService.findAll({
      organizationId: ORGANIZATION_ID,
      type: DocumentTypeAlias.Issue,
    });

    expect(capturedWhere?.subtype).toBe(DocumentType.Feature);
  });

  it("passes a canonical FEATURE filter through unchanged (compat)", async () => {
    let capturedWhere: { subtype?: string } | undefined;
    mockWithDb.mockImplementation(
      async (
        callback: (db: {
          artifact: {
            findMany: (args: {
              where: { subtype?: string };
            }) => Promise<unknown[]>;
          };
        }) => Promise<unknown[]>
      ) =>
        await callback({
          artifact: {
            findMany: (args) => {
              capturedWhere = args.where;
              return Promise.resolve([]);
            },
          },
        })
    );

    await documentService.findAll({
      organizationId: ORGANIZATION_ID,
      type: DocumentType.Feature,
    });

    expect(capturedWhere?.subtype).toBe(DocumentType.Feature);
  });
});

// FEA-4373: the bound on `findAll` is opt-in. Omitting `limit` keeps the query
// unbounded (`take` undefined) so the endpoint's long-standing default contract
// — the Documents index, pickers, and API clients all read the full set — is
// preserved. Only a caller that passes `limit` (the My Tasks board, whose
// one-row-per-artifact render can crash on a large set) gets it clamped to
// [1, DOCUMENT_LIST_MAX_LIMIT]; `offset` applies only alongside a limit.
describe("documentService.findAll bounds the result page only when asked (FEA-4373)", () => {
  type FindManyArgs = { take?: number; skip?: number };

  function captureFindManyArgs(sink: { args?: FindManyArgs }) {
    mockWithDb.mockImplementation(
      async (
        callback: (db: {
          artifact: {
            findMany: (args: FindManyArgs) => Promise<unknown[]>;
          };
        }) => Promise<unknown[]>
      ) =>
        await callback({
          artifact: {
            findMany: (args) => {
              sink.args = args;
              return Promise.resolve([]);
            },
          },
        })
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stays unbounded (take/skip undefined) when no limit is supplied, preserving the default contract other consumers rely on", () => {
    const sink: { args?: FindManyArgs } = {};
    captureFindManyArgs(sink);

    return documentService
      .findAll({ organizationId: ORGANIZATION_ID })
      .then(() => {
        expect(sink.args?.take).toBeUndefined();
        expect(sink.args?.skip).toBeUndefined();
      });
  });

  it("clamps a limit above the ceiling down to DOCUMENT_LIST_MAX_LIMIT", async () => {
    const sink: { args?: FindManyArgs } = {};
    captureFindManyArgs(sink);

    await documentService.findAll({
      organizationId: ORGANIZATION_ID,
      limit: 10_000,
    });

    expect(sink.args?.take).toBe(DOCUMENT_LIST_MAX_LIMIT);
  });

  it("floors a non-positive limit to 1", async () => {
    const sink: { args?: FindManyArgs } = {};
    captureFindManyArgs(sink);

    await documentService.findAll({
      organizationId: ORGANIZATION_ID,
      limit: 0,
    });

    expect(sink.args?.take).toBe(1);
  });

  it("passes a valid limit/offset straight through as take/skip", async () => {
    const sink: { args?: FindManyArgs } = {};
    captureFindManyArgs(sink);

    await documentService.findAll({
      organizationId: ORGANIZATION_ID,
      limit: 50,
      offset: 100,
    });

    expect(sink.args?.take).toBe(50);
    expect(sink.args?.skip).toBe(100);
  });

  it("ignores an offset when no limit is supplied (offset into an unbounded read is meaningless)", async () => {
    const sink: { args?: FindManyArgs } = {};
    captureFindManyArgs(sink);

    await documentService.findAll({
      organizationId: ORGANIZATION_ID,
      offset: 100,
    });

    expect(sink.args?.take).toBeUndefined();
    expect(sink.args?.skip).toBeUndefined();
  });

  it("applies the My Tasks page size when it is passed as an explicit limit", async () => {
    const sink: { args?: FindManyArgs } = {};
    captureFindManyArgs(sink);

    await documentService.findAll({
      organizationId: ORGANIZATION_ID,
      limit: DOCUMENT_LIST_DEFAULT_LIMIT,
    });

    expect(sink.args?.take).toBe(DOCUMENT_LIST_DEFAULT_LIMIT);
  });
});
