/**
 * Route coverage for the reference-target rejection contract (ISS-7208).
 *
 * The guarantee is not merely "the service throws" — it is that a caller naming
 * a disallowed target gets a 4xx back. Before this wiring the write path's throw
 * fell through to the route's generic handler and surfaced as a 500, which
 * reports a client mistake as a server fault.
 *
 * The custom-field route helpers are DELIBERATELY NOT MOCKED here: the mapping
 * under test lives in `customFieldWriteErrorResponse`, so replacing that module
 * would leave the assertion measuring the mock. Only the document service and
 * the peripheral side effects are stubbed.
 */
import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import { DocumentStatus } from "@repo/api/src/types/document";
import { Result } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestAuthContext } from "@/__tests__/utils/auth-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";

let mockAuthContext: AuthContext;

const mockFindById = vi.hoisted(() => vi.fn());
const mockUpdateDocument = vi.hoisted(() => vi.fn());
const mockSetValueForEntity = vi.hoisted(() => vi.fn());
const mockValidateValueForEntity = vi.hoisted(() => vi.fn());
const mockGetValuesForEntity = vi.hoisted(() => vi.fn());
const mockTransactionClient = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  customFieldValue: { findFirst: vi.fn() },
}));

// ISS-10993: the route opens ONE transaction for the mutation and its activity
// receipt. Every store this suite reaches is mocked, so the real `withDb` would
// only add a Postgres the unit lane does not have.
vi.mock("@repo/database", async (importOriginal) => {
  const run = <T>(callback: (client: typeof mockTransactionClient) => T): T =>
    callback(mockTransactionClient);
  return {
    ...(await importOriginal<object>()),
    withDb: Object.assign(run, { tx: run }),
  };
});

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (
    handler: (
      auth: AuthContext,
      request: NextRequest,
      params: Promise<unknown>
    ) => unknown,
    _options?: { requiredScopes?: ApiKeyScope[] }
  ) => {
    return (request: NextRequest, ctx: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, ctx.params);
  },
}));

vi.mock("@/lib/identifier-utils", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveDocumentId: vi.fn((id: string) => Promise.resolve(id)),
    resolveProjectId: vi.fn((id: string) => Promise.resolve(id)),
  };
});

vi.mock("@/app/documents/document-service", () => ({
  documentService: { findById: mockFindById },
  // ISS-10993: the route indexes the search projection itself, once its own
  // transaction has resolved.
  indexDocumentProjection: vi.fn(),
}));

vi.mock("@/app/documents/document-status-mutation-service", () => ({
  documentStatusMutationService: { updateDocument: mockUpdateDocument },
}));

vi.mock("@/app/custom-fields/values-service", () => ({
  customFieldValuesService: {
    setValueForEntity: mockSetValueForEntity,
    setValueForEntityInTransaction: async (...args: unknown[]) =>
      Result.ok(await mockSetValueForEntity(...args.slice(1))),
    validateValueForEntity: mockValidateValueForEntity,
    clearValue: vi.fn(),
    getValuesForEntity: mockGetValuesForEntity,
  },
}));

vi.mock("@/lib/artifact-activity-capture", () => ({
  captureArtifactUpdate: vi.fn(),
}));

vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvent: vi.fn(),
  userAuditActor: (userId: string) => ({ actorType: "user", actorId: userId }),
}));

vi.mock("@/lib/assignment-notifications", () => ({
  dispatchAssignmentNotification: vi.fn(),
}));

import { InvalidReferenceTargetError } from "@/app/custom-fields/reference-targets";
import { PUT } from "../[id]/route";

const DOCUMENT_ID = "11111111-1111-7111-8111-111111111111";
const FIELD_ID = "22222222-2222-7222-8222-222222222222";
const SESSION_TARGET_ID = "33333333-3333-7333-8333-333333333333";

function putRequest(body: unknown): NextRequest {
  return new NextRequest(`https://api.test/documents/${DOCUMENT_ID}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function routeContext() {
  return { params: Promise.resolve({ id: DOCUMENT_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  const doc = {
    id: DOCUMENT_ID,
    title: "Owning PRD",
    slug: "PRD-900",
    type: "PRD",
    status: DocumentStatus.Draft,
    organizationId: mockAuthContext.user.organizationId,
  };
  mockFindById.mockResolvedValue(doc);
  mockUpdateDocument.mockResolvedValue(
    Result.ok({ document: doc, previous: doc })
  );
  mockGetValuesForEntity.mockResolvedValue([]);
  mockValidateValueForEntity.mockResolvedValue(undefined);
  mockTransactionClient.$queryRaw.mockResolvedValue([{ id: DOCUMENT_ID }]);
  mockTransactionClient.customFieldValue.findFirst.mockResolvedValue(null);
});

describe("PUT /documents/[id] — reference custom field targets", () => {
  it("returns 400 when a reference field is given a target of a disallowed type", async () => {
    mockValidateValueForEntity.mockRejectedValue(
      new InvalidReferenceTargetError(
        'Custom field "Parent artifact" only accepts ISSUE, but 3333 is a SESSION.'
      )
    );

    const response = await PUT(
      putRequest({ customFields: { [FIELD_ID]: SESSION_TARGET_ID } }),
      routeContext()
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("only accepts ISSUE");
  });

  /**
   * The 400 above must not describe a write that already happened. The custom
   * fields are validated ahead of `documentService.update`, so a bad reference
   * leaves the document exactly as the caller found it.
   */
  it("does not update the document when a custom field value is rejected", async () => {
    mockValidateValueForEntity.mockRejectedValue(
      new InvalidReferenceTargetError("only accepts ISSUE")
    );

    const response = await PUT(
      putRequest({
        title: "A title the caller also tried to set",
        customFields: { [FIELD_ID]: SESSION_TARGET_ID },
      }),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mockUpdateDocument).not.toHaveBeenCalled();
    expect(mockSetValueForEntity).not.toHaveBeenCalled();
  });

  it("validates every field in the batch before writing any of them", async () => {
    // Entry two is the bad one. If validation ran per-entry interleaved with
    // the writes, entry one would already be persisted by the time it failed.
    const secondFieldId = "44444444-4444-7444-8444-444444444444";
    mockValidateValueForEntity.mockImplementation((fieldId: string) =>
      fieldId === secondFieldId
        ? Promise.reject(new InvalidReferenceTargetError("only accepts ISSUE"))
        : Promise.resolve(undefined)
    );

    const response = await PUT(
      putRequest({
        customFields: {
          [FIELD_ID]: SESSION_TARGET_ID,
          [secondFieldId]: SESSION_TARGET_ID,
        },
      }),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mockSetValueForEntity).not.toHaveBeenCalled();
    expect(mockUpdateDocument).not.toHaveBeenCalled();
  });

  it("still reports an unexpected write failure as a 500", async () => {
    // The 400 mapping must be scoped to the caller-error class. Widening it to
    // every throw would hide real server faults behind a client-error status.
    mockSetValueForEntity.mockRejectedValue(new Error("connection reset"));

    const response = await PUT(
      putRequest({ customFields: { [FIELD_ID]: SESSION_TARGET_ID } }),
      routeContext()
    );

    expect(response.status).toBe(500);
  });

  it("still reports an unexpected pre-validation failure as a 500", async () => {
    mockValidateValueForEntity.mockRejectedValue(new Error("connection reset"));

    const response = await PUT(
      putRequest({ customFields: { [FIELD_ID]: SESSION_TARGET_ID } }),
      routeContext()
    );

    expect(response.status).toBe(500);
  });

  it("returns 200 when the reference target is accepted", async () => {
    mockSetValueForEntity.mockResolvedValue(undefined);

    const response = await PUT(
      putRequest({ customFields: { [FIELD_ID]: SESSION_TARGET_ID } }),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mockSetValueForEntity).toHaveBeenCalledWith(
      FIELD_ID,
      "DOCUMENT",
      DOCUMENT_ID,
      mockAuthContext.user.organizationId,
      SESSION_TARGET_ID
    );
  });
});
