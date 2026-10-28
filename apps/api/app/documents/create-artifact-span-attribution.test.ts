/**
 * ISS-7224: `POST /documents` must stamp the span with the CREATED row's
 * subtype and status, so the create-vs-edit mix is sliceable by type.
 *
 * A sibling file rather than an addition to `route.test.ts`, which is already
 * well past the 500-line smell; this concern is cohesive on its own and its
 * harness is a fraction of that file's.
 *
 * Its two halves live elsewhere: `[id]/artifact-span-attribution.test.ts` covers
 * the read/edit routes, and `__tests__/unit/request-span-attribution.test.ts`
 * proves what the recorder is handed actually reaches the emitted span.
 */
import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import { Priority } from "@repo/api/src/types/common";
import {
  type Document,
  DocumentType,
  IssueStatus,
  SnapshotSource,
} from "@repo/api/src/types/document";
import { Result } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createTestAuthContext,
} from "../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext;
const mockCreate = vi.hoisted(() => vi.fn());
const mockCreateWithInlineImages = vi.hoisted(() => vi.fn());
const mockRecordRequestArtifact = vi.hoisted(() => vi.fn());

// ISS-8643: the route's activity-feed capture is fire-and-forget
// (`waitUntil(recordChanges(...))`), so left unmocked it opens a pg pool
// against the unit lane's placeholder DATABASE_URL and logs its failure AFTER
// this file's tests have resolved — a console write with no live test task,
// which fails the whole run on `Closing rpc while "onUserConsoleLog" was
// pending` when it lands during worker teardown. The seam's own wiring is
// pinned by `create-artifact-activity-capture.test.ts`; here it is replaced
// purely for isolation.
vi.mock("@/lib/artifact-activity-capture", () => ({
  captureArtifactCreation: vi.fn(),
}));

vi.mock("@/app/documents/attachment-upload-feature", () => ({
  isMcpAttachmentUploadEnabled: vi.fn(async () => true),
}));

vi.mock("@/app/documents/document-service", () => ({
  documentService: {
    create: mockCreate,
    createWithInlineImages: mockCreateWithInlineImages,
    findAllWithCustomFields: vi.fn(),
  },
}));

vi.mock("@/app/documents/document-list-service", () => ({
  documentListService: { findPageWithCustomFields: vi.fn() },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: never, _options?: { requiredScopes?: ApiKeyScope[] }) =>
    (request: Request) =>
      (handler as never as (...args: unknown[]) => unknown)(
        mockAuthContext,
        request
      ),
}));

vi.mock("@/lib/identifier-utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveArtifactIdentifier: vi.fn(async (id: string) => id),
  resolveProjectId: vi.fn(async (id: string) => id),
}));

// Spread the real module: `route-utils` also imports the error-cause recorder
// and the emitter's reader from here, so a wholesale replacement would leave
// those undefined on any path that returns an `errorResponse`.
vi.mock(
  "@/lib/observability/request-span-attribution",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    recordRequestArtifact: mockRecordRequestArtifact,
  })
);

import { POST } from "./route";

const CREATED: Document = {
  approver: null,
  approverId: null,
  assignee: null,
  assigneeId: null,
  createdAt: new Date("2026-07-20T12:00:00.000Z"),
  createdBy: null,
  createdById: "test-user-id",
  fileName: null,
  id: "doc-1",
  latestVersion: 1,
  organizationId: "test-org-id",
  priority: Priority.Medium,
  projectId: "PRO-44",
  repositorySnapshot: {
    createdAt: "2026-07-20T12:00:00.000Z",
    repositories: [],
    source: SnapshotSource.None,
  },
  slug: "FEA-3539",
  sortOrder: null,
  status: IssueStatus.Backlog,
  templateForType: null,
  title: "Created document",
  type: DocumentType.Feature,
  updatedAt: new Date("2026-07-20T12:00:00.000Z"),
};

function createRequestBody(overrides: Record<string, unknown> = {}) {
  return {
    content: "Plain content",
    projectId: "PRO-44",
    title: "Created document",
    type: DocumentType.Feature,
    ...overrides,
  };
}

function postDocuments(body: Record<string, unknown>) {
  return POST(
    createMockRequest({
      body,
      method: "POST",
      url: "http://localhost:3002/documents",
    }) as never,
    { params: Promise.resolve({}) } as never
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  mockCreate.mockResolvedValue(CREATED);
  mockCreateWithInlineImages.mockResolvedValue(
    Result.ok({
      document: CREATED,
      inlineImages: [],
      versionContent: "Content",
    })
  );
});

describe("POST /documents artifact span attribution", () => {
  /**
   * Both create paths, because instrumenting only the plain one would
   * under-count exactly the subtypes that carry inline images.
   */
  it("stamps the created artifact's subtype and status on the content-only path", async () => {
    const response = await postDocuments(createRequestBody());

    expect(response.status).toBe(200);
    expect(mockCreateWithInlineImages).not.toHaveBeenCalled();
    expect(mockRecordRequestArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        type: DocumentType.Feature,
        status: IssueStatus.Backlog,
      })
    );
  });

  it("stamps the created artifact's subtype and status on the inline-image path", async () => {
    const response = await postDocuments(
      createRequestBody({
        content: "Content [[diagram]]",
        inlineImages: [
          {
            altText: "Diagram",
            dataBase64: "aW1hZ2U=",
            filename: "diagram.png",
            mimeType: "image/png",
            placeholder: "[[diagram]]",
          },
        ],
      })
    );

    expect(response.status).toBe(200);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockRecordRequestArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        type: DocumentType.Feature,
        status: IssueStatus.Backlog,
      })
    );
  });

  it("stamps nothing when no artifact was created", async () => {
    mockCreate.mockResolvedValue(null);

    const response = await postDocuments(createRequestBody());

    expect(response.status).toBe(400);
    // No row exists, so there is nothing to attribute the request to.
    expect(mockRecordRequestArtifact).not.toHaveBeenCalled();
  });
});
