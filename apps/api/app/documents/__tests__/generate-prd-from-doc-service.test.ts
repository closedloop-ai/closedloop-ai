/**
 * Unit tests for generatePrdFromDocumentService.generatePrdFromDocument.
 *
 * External dependencies (database, createDocumentRecord, version lookup, room
 * creation) are mocked. Focus is the behavioral contract:
 *  - only an evergreen Document (DocumentType.Doc) can seed a PRD;
 *  - the new PRD is DRAFT and seeded with the source Document's latest content;
 *  - a RelatesTo provenance link is written source Document → new PRD;
 *  - every read/write is org-scoped (two-org isolation).
 */
import { LinkType } from "@repo/api/src/types/artifact";
import type {
  CreateDocumentInput,
  Document,
} from "@repo/api/src/types/document";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => {
  const tx = vi.fn();
  const withDbFn = Object.assign(vi.fn(), { tx });
  return {
    withDb: withDbFn,
    ArtifactType: { DOCUMENT: "DOCUMENT", BRANCH: "BRANCH" },
  };
});

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../document-service", () => ({
  createDocumentRecord: vi.fn(),
  indexDocumentProjection: vi.fn(),
}));

vi.mock("../document-version-service", () => ({
  documentVersionService: { getLatest: vi.fn() },
}));

vi.mock("../room-utils", () => ({
  createDocumentRoom: vi.fn(),
}));

import { withDb } from "@repo/database";
import {
  createDocumentRecord,
  indexDocumentProjection,
} from "../document-service";
import { documentVersionService } from "../document-version-service";
import { generatePrdFromDocumentService } from "../generate-prd-from-doc-service";

const mockWithDb = withDb as unknown as Mock;
const mockWithDbTx = (withDb as unknown as { tx: Mock }).tx;
const mockCreateDocumentRecord = createDocumentRecord as unknown as Mock;
const mockIndexDocumentProjection = indexDocumentProjection as unknown as Mock;
const mockGetLatest = documentVersionService.getLatest as unknown as Mock;

const ORG_ID = "org-1";
const OTHER_ORG_ID = "org-2";
const USER_ID = "user-1";
const DOC_ID = "doc-1";
const PROJECT_ID = "project-1";
const PRD_ID = "prd-new";
const DOC_CONTENT = "# Strategy\n\nEvergreen context that should seed the PRD.";

function buildPrd(overrides: Partial<Document> = {}): Document {
  return {
    id: PRD_ID,
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    type: DocumentType.Prd,
    title: "Seeded PRD",
    slug: "prd-new",
    fileName: null,
    status: DocumentStatus.Draft,
    priority: "MEDIUM",
    latestVersion: 1,
    createdById: USER_ID,
    assigneeId: null,
    assignee: null,
    approverId: null,
    approver: null,
    repositorySnapshot: { source: "none", repositories: [] },
    templateForType: null,
    sortOrder: null,
    ...overrides,
  } as Document;
}

/**
 * Wire the sequence of `withDb(...)` reads: source artifact lookup, then
 * project lookup. Each call receives a callback that we invoke with a db stub
 * whose `findUnique` returns the queued value and records the `where` clause.
 */
function stubReads(opts: {
  sourceArtifact: unknown;
  project: unknown;
  captureWhere?: { source?: unknown; project?: unknown };
}) {
  const artifactFindUnique = vi.fn(({ where }: { where: unknown }) => {
    if (opts.captureWhere) {
      opts.captureWhere.source = where;
    }
    return Promise.resolve(opts.sourceArtifact);
  });
  const projectFindUnique = vi.fn(({ where }: { where: unknown }) => {
    if (opts.captureWhere) {
      opts.captureWhere.project = where;
    }
    return Promise.resolve(opts.project);
  });
  mockWithDb.mockImplementation((fn: (db: unknown) => Promise<unknown>) =>
    fn({
      artifact: { findUnique: artifactFindUnique },
      project: { findUnique: projectFindUnique },
    })
  );
  return { artifactFindUnique, projectFindUnique };
}

describe("generatePrdFromDocumentService.generatePrdFromDocument", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("seeds a DRAFT PRD with the Document content and writes a RelatesTo provenance link", async () => {
    stubReads({
      sourceArtifact: {
        id: DOC_ID,
        type: "DOCUMENT",
        subtype: DocumentType.Doc,
        name: "Strategy Doc",
      },
      project: { id: PROJECT_ID },
    });
    mockGetLatest.mockResolvedValue({ content: DOC_CONTENT });

    const linkCreate = vi.fn().mockResolvedValue({ id: "link-1" });
    mockCreateDocumentRecord.mockResolvedValue(buildPrd());
    mockWithDbTx.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ artifactLink: { create: linkCreate } })
    );

    const result = await generatePrdFromDocumentService.generatePrdFromDocument(
      ORG_ID,
      USER_ID,
      { documentId: DOC_ID, projectId: PROJECT_ID }
    );

    expect(result.ok).toBe(true);

    // The PRD is created DRAFT, in the chosen project, seeded with the Doc content.
    const createInput = mockCreateDocumentRecord.mock
      .calls[0][3] as CreateDocumentInput;
    expect(createInput.type).toBe(DocumentType.Prd);
    expect(createInput.status).toBe(DocumentStatus.Draft);
    expect(createInput.projectId).toBe(PROJECT_ID);
    expect(createInput.content).toBe(DOC_CONTENT);

    // Provenance: source Document → new PRD via RelatesTo, org-scoped.
    expect(linkCreate).toHaveBeenCalledWith({
      data: {
        organizationId: ORG_ID,
        sourceId: DOC_ID,
        targetId: PRD_ID,
        linkType: LinkType.RelatesTo,
      },
      select: { id: true },
    });

    // The seeded PRD is projected into unified search with its seed content so
    // it is findable immediately, matching the normal document create path.
    expect(mockIndexDocumentProjection).toHaveBeenCalledWith(
      expect.objectContaining({ id: PRD_ID }),
      DOC_CONTENT
    );
  });

  it("falls back to the Document title when no title override is given", async () => {
    stubReads({
      sourceArtifact: {
        id: DOC_ID,
        type: "DOCUMENT",
        subtype: DocumentType.Doc,
        name: "Strategy Doc",
      },
      project: { id: PROJECT_ID },
    });
    mockGetLatest.mockResolvedValue({ content: DOC_CONTENT });
    mockCreateDocumentRecord.mockResolvedValue(buildPrd());
    mockWithDbTx.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ artifactLink: { create: vi.fn().mockResolvedValue({}) } })
    );

    await generatePrdFromDocumentService.generatePrdFromDocument(
      ORG_ID,
      USER_ID,
      { documentId: DOC_ID, projectId: PROJECT_ID }
    );

    const createInput = mockCreateDocumentRecord.mock
      .calls[0][3] as CreateDocumentInput;
    expect(createInput.title).toBe("Strategy Doc");
  });

  it("rejects a non-Doc source artifact (a PRD cannot seed via this path)", async () => {
    stubReads({
      sourceArtifact: {
        id: DOC_ID,
        type: "DOCUMENT",
        subtype: DocumentType.Prd,
        name: "A PRD",
      },
      project: { id: PROJECT_ID },
    });

    const result = await generatePrdFromDocumentService.generatePrdFromDocument(
      ORG_ID,
      USER_ID,
      { documentId: DOC_ID, projectId: PROJECT_ID }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(Status.NotFound);
    }
    expect(mockCreateDocumentRecord).not.toHaveBeenCalled();
  });

  it("is org-scoped: a source Document from another org is not found and no PRD is created", async () => {
    const captureWhere: { source?: unknown; project?: unknown } = {};
    // Simulate the DB: the org-scoped `where` (id + organizationId) finds
    // nothing because the Doc belongs to OTHER_ORG_ID.
    stubReads({
      sourceArtifact: null,
      project: { id: PROJECT_ID },
      captureWhere,
    });

    const result = await generatePrdFromDocumentService.generatePrdFromDocument(
      ORG_ID,
      USER_ID,
      { documentId: DOC_ID, projectId: PROJECT_ID }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(Status.NotFound);
    }
    // The source lookup was constrained to the caller's org, not the doc's org.
    expect(captureWhere.source).toEqual({
      id: DOC_ID,
      organizationId: ORG_ID,
    });
    expect(captureWhere.source).not.toMatchObject({
      organizationId: OTHER_ORG_ID,
    });
    expect(mockCreateDocumentRecord).not.toHaveBeenCalled();
  });

  it("rejects when the target project is not in the org", async () => {
    stubReads({
      sourceArtifact: {
        id: DOC_ID,
        type: "DOCUMENT",
        subtype: DocumentType.Doc,
        name: "Strategy Doc",
      },
      project: null,
    });

    const result = await generatePrdFromDocumentService.generatePrdFromDocument(
      ORG_ID,
      USER_ID,
      { documentId: DOC_ID, projectId: PROJECT_ID }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(Status.BadRequest);
    }
    expect(mockCreateDocumentRecord).not.toHaveBeenCalled();
  });
});
