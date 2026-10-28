/**
 * ISS-12552 (PRD-800 "Rollout"): `POST /documents` builds its receipt
 * recorder inside the request's attribution gate scope, like every other
 * receipting route, so a writer running inside the create's transaction reads
 * the answer the recorder already read instead of finding it unread.
 *
 * The flag's organization gate and PostHog are stubbed; the request scope,
 * the memo and the in-transaction reader are the real ones.
 */
import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  OperationKind,
  type OperationReceipt,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import { Priority } from "@repo/api/src/types/common";
import {
  type Document,
  DocumentType,
  IssueStatus,
  SnapshotSource,
} from "@repo/api/src/types/document";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockRequest,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";

let mockAuthContext: AuthContext;
const mockCreate = vi.hoisted(() => vi.fn());
const mockRecordOperationReceipt = vi.hoisted(() => vi.fn());

vi.mock("@/lib/memoized-feature-flag-gate", () => ({
  createMemoizedOrganizationFeatureFlagGate: () => ({
    resolve: () => Promise.resolve(true),
    clear: () => undefined,
  }),
}));

vi.mock(
  "@/lib/feature-flags/server-feature-flag-evaluation",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveUnmemoizedFeatureFlagValue: () => Promise.resolve(undefined),
  })
);

vi.mock("@/lib/operation-receipts/operation-receipt-writer", () => ({
  recordOperationReceipt: mockRecordOperationReceipt,
  recordRejectedOperationReceipt: () => Promise.resolve(),
}));

vi.mock("@/lib/artifact-activity-capture", () => ({
  captureArtifactCreation: () => Promise.resolve(),
}));

vi.mock("@/app/documents/attachment-upload-feature", () => ({
  isMcpAttachmentUploadEnabled: () => Promise.resolve(true),
}));

vi.mock("@/app/documents/document-service", () => ({
  documentService: {
    create: mockCreate,
    createWithInlineImages: vi.fn(),
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
  resolveArtifactIdentifier: (id: string) => Promise.resolve(id),
  resolveProjectId: (id: string) => Promise.resolve(id),
}));

import { isAttributionEvidenceReadOnForOrganization } from "@/lib/attribution-evidence-policy-feature";
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

const RECEIPT: OperationReceipt = {
  operationId: "op_create_document",
  outcome: OperationReceiptOutcome.Committed,
};

/** Stands in for the create's transaction client. */
const CREATE_TX = { __brand: "create-tx" };

describe("POST /documents attribution gate scope (ISS-12552)", () => {
  let readOnInTransaction: boolean | undefined;

  beforeEach(() => {
    readOnInTransaction = undefined;
    mockAuthContext = createTestAuthContext({
      apiKeyScopes: ["write"],
      authMethod: "api_key",
    });
    mockRecordOperationReceipt.mockResolvedValue(RECEIPT);
    mockCreate.mockImplementation(async (...args: unknown[]) => {
      readOnInTransaction = isAttributionEvidenceReadOnForOrganization(
        mockAuthContext.user.organizationId
      );
      await (args[3] as (tx: unknown, created: Document) => Promise<void>)(
        CREATE_TX,
        CREATED
      );
      return CREATED;
    });
  });

  it("lets a writer inside the create's transaction read the recorder's on answer, and records the receipt", async () => {
    const response = await POST(
      createMockRequest({
        body: {
          content: "Plain content",
          projectId: "PRO-44",
          title: "Created document",
          type: DocumentType.Feature,
        },
        method: "POST",
        url: "http://localhost:3002/documents",
      }) as never,
      { params: Promise.resolve({}) } as never
    );

    expect(response.status).toBe(200);
    expect(readOnInTransaction).toBe(true);
    expect(mockRecordOperationReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: CREATE_TX,
        request: expect.objectContaining({
          organizationId: mockAuthContext.user.organizationId,
        }),
        write: expect.objectContaining({
          operationKind: OperationKind.Create,
          outcome: OperationReceiptOutcome.Committed,
          targetArtifactId: CREATED.id,
        }),
      })
    );
    expect(await response.json()).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ operationReceipt: RECEIPT }),
      })
    );
  });
});
