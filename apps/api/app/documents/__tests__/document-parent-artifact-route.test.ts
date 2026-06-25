import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  documentService: {
    findById: vi.fn(),
  },
  getValuesForEntity: vi.fn(),
  resolveDocumentId: vi.fn(),
  getByVersion: vi.fn(),
  getLatest: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context = { params: Promise.resolve({}) }) =>
      handler({ user: mocks.user }, request, context.params),
}));

vi.mock("@/app/documents/document-service", () => ({
  documentService: mocks.documentService,
}));

vi.mock("@/app/custom-fields/values-service", () => ({
  customFieldValuesService: {
    getValuesForEntity: mocks.getValuesForEntity,
  },
}));

vi.mock("@/lib/identifier-utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/identifier-utils")>();
  return {
    ...actual,
    resolveArtifactIdentifier: vi.fn(),
    resolveDocumentId: mocks.resolveDocumentId,
  };
});

vi.mock("../document-version-service", () => ({
  documentVersionService: {
    getByVersion: mocks.getByVersion,
    getLatest: mocks.getLatest,
  },
}));

import { GET as getDocument } from "../[id]/route";

function request(path: string) {
  return new NextRequest(`https://api.example.test${path}`, { method: "GET" });
}

describe("GET /documents/:id artifact type boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getValuesForEntity.mockResolvedValue([]);
  });

  it("keeps pull-request artifact ids 404-safe for GET /documents/:id", async () => {
    mocks.resolveDocumentId.mockResolvedValue(null);

    const response = await getDocument(request("/documents/parent-pr-1"), {
      params: Promise.resolve({ id: "parent-pr-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("Artifact not found");
    expect(mocks.documentService.findById).not.toHaveBeenCalled();
  });

  it("returns saved latest content alongside selected historical content", async () => {
    mocks.resolveDocumentId.mockResolvedValue("document-1");
    mocks.documentService.findById.mockResolvedValue(createDocument());
    mocks.getByVersion.mockResolvedValue(
      createVersion({ content: "Historical content", version: 1 })
    );
    mocks.getLatest.mockResolvedValue(
      createVersion({
        content: "Latest content with ![diagram](attachment://latest-image)",
        version: 3,
      })
    );

    const response = await getDocument(
      request("/documents/document-1?version=1"),
      {
        params: Promise.resolve({ id: "document-1" }),
      }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.version.content).toBe("Historical content");
    expect(body.data.latestVersionContent).toBe(
      "Latest content with ![diagram](attachment://latest-image)"
    );
    expect(mocks.getByVersion).toHaveBeenCalledWith("document-1", 1);
    expect(mocks.getLatest).toHaveBeenCalledWith("document-1");
  });
});

function createDocument() {
  const now = new Date("2026-06-12T00:00:00.000Z");

  return {
    id: "document-1",
    organizationId: "org-1",
    projectId: "project-1",
    type: "FEATURE",
    title: "Feature",
    slug: "FEA-1762",
    fileName: null,
    status: "DRAFT",
    priority: "MEDIUM",
    latestVersion: 3,
    createdById: "user-1",
    createdBy: null,
    assigneeId: null,
    assignee: null,
    approverId: null,
    approver: null,
    tokenUsage: null,
    repositorySnapshot: {
      createdAt: now.toISOString(),
      repositories: [],
      source: "none",
    },
    templateForType: null,
    sortOrder: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createVersion({
  content,
  version,
}: {
  content: string;
  version: number;
}) {
  return {
    id: `version-${version}`,
    documentId: "document-1",
    version,
    content,
    createdById: "user-1",
    createdAt: new Date("2026-06-12T00:00:00.000Z"),
  };
}
