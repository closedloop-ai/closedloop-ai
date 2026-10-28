/**
 * FEA-3864: `POST /documents` must hand every created artifact to the activity
 * feed's capture seam, on BOTH create paths and with the caller's own auth
 * method — `resolveActorType` reads that field to decide human vs agent
 * attribution, so a hardcoded or dropped one mis-attributes every agent write.
 *
 * A sibling file rather than an addition to `route.test.ts`, following the
 * precedent its neighbour `create-artifact-span-attribution.test.ts` set for
 * the same route: that file is already well past the 500-line smell, and this
 * concern is cohesive on its own.
 *
 * ISS-8643 is why the seam is mocked in the other two POST suites at all — the
 * real `captureArtifactCreation` opens a pg pool against the unit lane's
 * placeholder DATABASE_URL. This file is where the mock those suites install is
 * held to the production wiring.
 *
 * ISS-10993: the route no longer records the receipt itself. It hands the store
 * a `recordCreated` callback, which the store runs on the create's OWN
 * transaction, so the receipt and the artifact row commit together. The store
 * mocks below therefore INVOKE that callback — without it these assertions
 * would pass on a route that passed no callback at all.
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
import {
  createMockRequest,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";

let mockAuthContext: AuthContext;
const mockCaptureArtifactCreation = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());
const mockCreateWithInlineImages = vi.hoisted(() => vi.fn());

vi.mock("@/lib/artifact-activity-capture", () => ({
  captureArtifactCreation: mockCaptureArtifactCreation,
}));

// ISS-12552: an API-key create also records an operation receipt on the same
// transaction. This suite covers the activity capture, so the receipt store is
// mocked like every other store it reaches.
vi.mock("@/lib/operation-receipts/operation-receipt-writer", () => ({
  recordOperationReceipt: vi.fn(async () => null),
  recordRejectedOperationReceipt: vi.fn(),
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

const INLINE_IMAGE = {
  altText: "Diagram",
  dataBase64: "aW1hZ2U=",
  filename: "diagram.png",
  mimeType: "image/png",
  placeholder: "[[diagram]]",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  mockCreate.mockImplementation(async (..._args: unknown[]) => {
    await runRecordCreated(_args[3]);
    return CREATED;
  });
  mockCreateWithInlineImages.mockImplementation(async (..._args: unknown[]) => {
    await runRecordCreated(_args[4]);
    return Result.ok({
      document: CREATED,
      inlineImages: [],
      versionContent: "Content",
    });
  });
});

describe("POST /documents artifact activity capture", () => {
  it("captures the creation on the content-only path", async () => {
    const response = await postDocuments(createRequestBody());

    expect(response.status).toBe(200);
    expect(mockCreateWithInlineImages).not.toHaveBeenCalled();
    expect(mockCaptureArtifactCreation).toHaveBeenCalledWith(
      expectedCreationCapture()
    );
  });

  it("captures the creation on the inline-image path", async () => {
    // ISS-7224's reasoning applies to the feed too: an inline-image create is a
    // create like any other, so instrumenting only the plain path would leave
    // exactly the subtypes that carry images out of the activity feed.
    const response = await postDocuments(
      createRequestBody({
        content: "Content [[diagram]]",
        inlineImages: [INLINE_IMAGE],
      })
    );

    expect(response.status).toBe(200);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockCaptureArtifactCreation).toHaveBeenCalledWith(
      expectedCreationCapture()
    );
  });

  it("forwards the caller's auth method so an agent write is attributed as one", async () => {
    // `resolveActorType` maps `api_key` to the agent actor type. The route must
    // pass its own auth method through rather than assume a session, or every
    // MCP/API-key create lands in the feed as a human edit.
    mockAuthContext = createTestAuthContext({
      apiKeyScopes: ["write"],
      authMethod: "api_key",
    });

    const response = await postDocuments(createRequestBody());

    expect(response.status).toBe(200);
    expect(mockCaptureArtifactCreation).toHaveBeenCalledWith(
      expectedCreationCapture()
    );
  });

  it("captures nothing when no artifact was created", async () => {
    mockCreate.mockResolvedValue(null);

    const response = await postDocuments(createRequestBody());

    expect(response.status).toBe(400);
    // No row exists, so there is no creation to record.
    expect(mockCaptureArtifactCreation).not.toHaveBeenCalled();
  });
});

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

/**
 * Run the receipt callback the route handed the store, the way the store does:
 * on the create's own transaction client, with the created row.
 */
function runRecordCreated(recordCreated: unknown): Promise<void> | undefined {
  return (
    recordCreated as
      | ((tx: unknown, created: unknown) => Promise<void>)
      | undefined
  )?.(CREATE_TX, CREATED);
}

/** Stands in for the create's transaction client; nothing calls a method on it. */
const CREATE_TX = { __brand: "create-tx" };

function expectedCreationCapture() {
  return {
    tx: CREATE_TX,
    organizationId: mockAuthContext.user.organizationId,
    artifactId: CREATED.id,
    actor: {
      userId: mockAuthContext.user.id,
      authMethod: mockAuthContext.authMethod,
    },
    after: { status: CREATED.status, title: CREATED.title },
  };
}
