/**
 * Route tests for POST /documents/batch-move (ISS-9158).
 *
 * The service is covered by `__tests__/documents/batch-move.integration.test.ts`.
 * This file pins the route's own contract: the wire response stays `string[]`,
 * a service `Result.err` maps to its 4xx (never a 500), and every moved
 * document leaves the same `projectId` activity event a single
 * `PUT /documents/:id` leaves — deleting the capture call must go red here.
 */
import { Result, Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { documentBatchMoveService } from "@/app/documents/document-batch-move-service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

const mockCaptureBatchProjectChange = vi.hoisted(() => vi.fn());
const mockDispatchAuditEvents = vi.hoisted(() => vi.fn());

const DESKTOP_TOKEN = "desktop-session-token";

// ISS-9466: `withAnyAuth` is NOT stubbed, so its real bearer dispatch runs.
// The Clerk mock refuses a desktop bearer the way Clerk does, so moving the
// route back to `withAuth` turns the desktop case below into a 401.
// ISS-10993: the route opens ONE transaction for the mutation and its activity
// receipt. Every store this suite reaches is mocked, so the real `withDb` would
// only add a Postgres the unit lane does not have.
import { MOCK_TRANSACTION_CLIENT } from "@/__tests__/utils/mock-with-db";

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: (await import("@/__tests__/utils/mock-with-db")).mockWithDb(),
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: Request, context?: { params: Promise<unknown> }) =>
      request.headers.get("authorization") === `Bearer ${DESKTOP_TOKEN}`
        ? Response.json({ error: "Unauthorized" }, { status: 401 })
        : handler(mockAuthContext, request, context?.params),
}));
vi.mock("@/lib/auth/with-desktop-session-auth", () => ({
  withDesktopSessionAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(
        { ...mockAuthContext, authMethod: "desktop_session" },
        request,
        context?.params
      ),
}));
vi.mock("@/lib/auth/with-api-key-auth", () => ({
  withApiKeyAuth: vi.fn(),
}));
vi.mock("@repo/auth/desktop-session-jwt", () => ({
  isDesktopSessionToken: (token: string) => token === DESKTOP_TOKEN,
}));
vi.mock("@/app/documents/document-batch-move-service");
vi.mock("@/lib/artifact-activity-capture", () => ({
  captureBatchProjectChange: (...args: unknown[]) =>
    mockCaptureBatchProjectChange(...args),
}));

vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvents: (...args: unknown[]) => mockDispatchAuditEvents(...args),
  userAuditActor: (userId: string) => ({
    actorType: "user",
    actorId: userId,
  }),
}));

import { POST } from "@/app/documents/batch-move/route";

const DOC_A = "11111111-1111-4111-8111-111111111111";
const DOC_B = "22222222-2222-4222-8222-222222222222";
const SOURCE_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_PROJECT_ID = "44444444-4444-4444-8444-444444444444";

function makeRequest(body: unknown) {
  return createMockRequest({
    url: "http://localhost:3002/documents/batch-move",
    method: "POST",
    body,
  });
}

describe("POST /documents/batch-move", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("returns the moved ids and captures one project change per document", async () => {
    const projectChanges = [
      {
        artifactId: DOC_A,
        before: SOURCE_PROJECT_ID,
        after: TARGET_PROJECT_ID,
      },
      // Already in the target: the row was locked and rewritten but did not
      // MOVE, so neither the receipt nor the ledger entry may name it
      // (ISS-9465). The side-effect helper drops it before either.
      {
        artifactId: DOC_B,
        before: TARGET_PROJECT_ID,
        after: TARGET_PROJECT_ID,
      },
    ];
    vi.mocked(documentBatchMoveService.batchMove).mockResolvedValue(
      Result.ok({ movedIds: [DOC_A, DOC_B], projectChanges })
    );

    const response = await POST(
      makeRequest({
        documentIds: [DOC_A, DOC_B],
        targetProjectId: TARGET_PROJECT_ID,
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data).toEqual([DOC_A, DOC_B]);
    expect(documentBatchMoveService.batchMove).toHaveBeenCalledWith(
      [DOC_A, DOC_B],
      TARGET_PROJECT_ID,
      mockAuthContext.user.organizationId
    );
    expect(mockCaptureBatchProjectChange).toHaveBeenCalledTimes(1);
    expect(mockCaptureBatchProjectChange).toHaveBeenCalledWith({
      tx: MOCK_TRANSACTION_CLIENT,
      organizationId: mockAuthContext.user.organizationId,
      actor: {
        userId: mockAuthContext.user.id,
        authMethod: mockAuthContext.authMethod,
      },
      changes: [projectChanges[0]],
      transactionId: expect.any(String),
      provenance: undefined,
      preserveProvenanceOmission: true,
    });

    // ISS-9465 ruling 6. Literals, not the const they guard: a ledger value is
    // hashed into an append-only chain and cannot be renamed later.
    const [auditEvents] = mockDispatchAuditEvents.mock.calls[0];
    expect(auditEvents).toEqual([
      expect.objectContaining({
        action: "artifact.project_changed",
        objectType: "artifact",
        objectId: projectChanges[0].artifactId,
      }),
    ]);
    expect(auditEvents[0].detail.transactionId).toBe(
      mockCaptureBatchProjectChange.mock.calls[0][0].transactionId
    );
  });

  it("attributes an API-key caller through authMethod", async () => {
    mockAuthContext = createTestAuthContext({ authMethod: "api_key" });
    vi.mocked(documentBatchMoveService.batchMove).mockResolvedValue(
      Result.ok({
        movedIds: [DOC_A],
        projectChanges: [
          { artifactId: DOC_A, before: null, after: TARGET_PROJECT_ID },
        ],
      })
    );

    await POST(
      makeRequest({ documentIds: [DOC_A], targetProjectId: TARGET_PROJECT_ID }),
      createMockRouteContext({})
    );

    expect(mockCaptureBatchProjectChange).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { userId: mockAuthContext.user.id, authMethod: "api_key" },
      })
    );
  });

  it("accepts a desktop-session bearer token and attributes it", async () => {
    vi.mocked(documentBatchMoveService.batchMove).mockResolvedValue(
      Result.ok({
        movedIds: [DOC_A],
        projectChanges: [
          { artifactId: DOC_A, before: null, after: TARGET_PROJECT_ID },
        ],
      })
    );

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/documents/batch-move",
        method: "POST",
        body: { documentIds: [DOC_A], targetProjectId: TARGET_PROJECT_ID },
        headers: { Authorization: `Bearer ${DESKTOP_TOKEN}` },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(documentBatchMoveService.batchMove).toHaveBeenCalledWith(
      [DOC_A],
      TARGET_PROJECT_ID,
      mockAuthContext.user.organizationId
    );
    expect(mockCaptureBatchProjectChange).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: {
          userId: mockAuthContext.user.id,
          authMethod: "desktop_session",
        },
      })
    );
  });

  it("maps a missing target project to 400 and captures nothing", async () => {
    vi.mocked(documentBatchMoveService.batchMove).mockResolvedValue(
      Result.err(Status.BadRequest)
    );

    const response = await POST(
      makeRequest({ documentIds: [DOC_A], targetProjectId: TARGET_PROJECT_ID }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(mockCaptureBatchProjectChange).not.toHaveBeenCalled();
  });

  it("maps a missing document to 404 and captures nothing", async () => {
    vi.mocked(documentBatchMoveService.batchMove).mockResolvedValue(
      Result.err(Status.NotFound)
    );

    const response = await POST(
      makeRequest({ documentIds: [DOC_A], targetProjectId: TARGET_PROJECT_ID }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(404);
    expect(mockCaptureBatchProjectChange).not.toHaveBeenCalled();
  });

  it("returns 500 and captures nothing when the service rejects", async () => {
    vi.mocked(documentBatchMoveService.batchMove).mockRejectedValue(
      new Error("connection reset")
    );

    const response = await POST(
      makeRequest({ documentIds: [DOC_A], targetProjectId: TARGET_PROJECT_ID }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(500);
    expect(mockCaptureBatchProjectChange).not.toHaveBeenCalled();
  });

  /**
   * ISS-10993, operator ruling (Cosimo Corrigan, 2026-09-23). This case asserted
   * 200 until that ruling: the capture was swallowed and the move still
   * answered success. Restore a `catch {}` around the capture and it returns
   * 200 again and this fails.
   */
  it("refuses the move when the capture cannot record its receipt", async () => {
    mockCaptureBatchProjectChange.mockRejectedValue(
      new Error("activity store down")
    );
    vi.mocked(documentBatchMoveService.batchMove).mockResolvedValue(
      Result.ok({
        movedIds: [DOC_A],
        projectChanges: [
          {
            artifactId: DOC_A,
            before: SOURCE_PROJECT_ID,
            after: TARGET_PROJECT_ID,
          },
        ],
      })
    );

    const response = await POST(
      makeRequest({ documentIds: [DOC_A], targetProjectId: TARGET_PROJECT_ID }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(500);
  });

  it("returns 400 and never reaches the service on an invalid body", async () => {
    const response = await POST(
      makeRequest({ documentIds: [], targetProjectId: TARGET_PROJECT_ID }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(documentBatchMoveService.batchMove).not.toHaveBeenCalled();
    expect(mockCaptureBatchProjectChange).not.toHaveBeenCalled();
  });
});
