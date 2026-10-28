import { IssueStatus } from "@repo/api/src/types/document";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import { createTestAuthContext } from "../../../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext;

const mockFindBySlug = vi.hoisted(() => vi.fn());
const mockGetByVersion = vi.hoisted(() => vi.fn());
const mockGetLatestVersion = vi.hoisted(() => vi.fn());
const mockMergeCustomFieldsIntoResponse = vi.hoisted(() => vi.fn());
const mockWithDocumentStatusMutation = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth: (handler: (...args: unknown[]) => Promise<Response>) => {
    return (request: NextRequest, ctx: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, ctx.params);
  },
}));

vi.mock("@/app/documents/document-service", () => ({
  documentService: { findBySlug: mockFindBySlug },
}));

vi.mock("@/app/documents/document-status-mutation-capability", () => ({
  documentStatusMutationPermissionsForAuth: () => ({
    single: true,
    bulk: true,
  }),
  withDocumentStatusMutation: (...args: unknown[]) =>
    mockWithDocumentStatusMutation(...args),
}));

vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: {
    getByVersion: mockGetByVersion,
    getLatest: mockGetLatestVersion,
  },
}));

vi.mock("../../../custom-fields/route-helpers", () => ({
  mergeCustomFieldsIntoResponse: (...args: unknown[]) =>
    mockMergeCustomFieldsIntoResponse(...args),
}));

import { GET } from "./route";

const STATUS_MUTATION_CAPABILITY = {
  allowedStatuses: [IssueStatus.Todo, IssueStatus.InReview],
  expectedStatusField: "expectedStatus",
  expectedStatusByIdField: "expectedStatusById",
};

const ARTIFACT = {
  id: "a1",
  status: IssueStatus.Todo,
  assigneeId: null,
  approverId: null,
  priority: "MEDIUM",
  title: "Issue",
  dueDate: null,
  projectId: "p1",
  slug: "ISS-9433",
  latestVersion: 1,
  type: "FEATURE",
};

const VERSION = {
  id: "version-1",
  documentId: "a1",
  version: 1,
  content: "version content",
  createdById: null,
  createdAt: new Date("2026-09-10T12:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  mockFindBySlug.mockResolvedValue(ARTIFACT);
  mockGetLatestVersion.mockResolvedValue(VERSION);
  mockGetByVersion.mockResolvedValue(VERSION);
  mockMergeCustomFieldsIntoResponse.mockImplementation(async (doc) => doc);
  mockWithDocumentStatusMutation.mockImplementation((document: object) => ({
    ...document,
    statusMutation: STATUS_MUTATION_CAPABILITY,
  }));
});

describe("GET /documents/by-slug/[slug] status mutation metadata", () => {
  it("returns statusMutation metadata after custom-field merging", async () => {
    const response = await GET(
      new NextRequest("http://localhost/documents/by-slug/ISS-9433"),
      { params: Promise.resolve({ slug: "ISS-9433" }) }
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.statusMutation).toEqual(STATUS_MUTATION_CAPABILITY);
    expect(mockMergeCustomFieldsIntoResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        latestVersionContent: VERSION.content,
        statusMutation: STATUS_MUTATION_CAPABILITY,
        version: VERSION,
      }),
      expect.any(String),
      mockAuthContext.user.organizationId
    );
  });
});
