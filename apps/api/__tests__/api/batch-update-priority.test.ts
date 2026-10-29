import { randomUUID } from "node:crypto";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { ArtifactPriorityMutationErrorCode } from "@repo/api/src/types/artifact-priority-mutation";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { AuditActorType } from "@repo/api/src/types/audit";
import { Priority } from "@repo/api/src/types/common";
import { Result } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { artifactBulkPriorityService } from "@/app/documents/artifact-bulk-priority-service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

const mockCaptureBatchPriorityChange = vi.fn();
const mockCaptureArtifactFieldEditAnalytics = vi.fn();
const mockDispatchAuditEvents = vi.fn();
const mockEmitBatchFieldEditRefusalAnalytics = vi.fn();

// ISS-10993: the route opens ONE transaction for the mutation and its activity
// receipt. Every store this suite reaches is mocked, so the real `withDb` would
// only add a Postgres the unit lane does not have.
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: (await import("@/__tests__/utils/mock-with-db")).mockWithDb(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params),
}));
vi.mock("@/app/documents/artifact-bulk-priority-service");
// ISS-10749: the emitter this route drives also dispatches an audit receipt
// (ISS-9465), whose real `waitUntil(...)` outlives the test body and logs a pg
// failure against the unit lane's placeholder DATABASE_URL. Its wiring is
// covered by `__tests__/unit/bulk-mutation-side-effect-emitters.test.ts`, and
// the sibling `batch-update-status.test.ts` mocks the same seam.
vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvents: (...args: unknown[]) => mockDispatchAuditEvents(...args),
  userAuditActor: (userId: string) => ({
    actorType: AuditActorType.User,
    actorId: userId,
  }),
}));
vi.mock("@/lib/artifact-activity-capture", () => ({
  captureBatchPriorityChange: (...args: unknown[]) =>
    mockCaptureBatchPriorityChange(...args),
}));
vi.mock("@/lib/artifact-field-edit-analytics", () => ({
  captureArtifactFieldEditAnalytics: (...args: unknown[]) =>
    mockCaptureArtifactFieldEditAnalytics(...args),
}));
vi.mock("@/app/documents/batch-field-edit-refusal-analytics", () => ({
  emitBatchFieldEditRefusalAnalytics: (...args: unknown[]) =>
    mockEmitBatchFieldEditRefusalAnalytics(...args),
}));

import { POST } from "@/app/documents/batch-update-priority/route";

const URL = "http://localhost:3002/api/documents/batch-update-priority";
const ID_A = randomUUID();
const ID_B = randomUUID();

function post(body: unknown) {
  return POST(
    createMockRequest({ url: URL, method: "POST", body }),
    createMockRouteContext({})
  );
}

describe("POST /documents/batch-update-priority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(
      artifactBulkPriorityService.batchUpdatePriority
    ).mockResolvedValue(
      Result.ok({
        updatedIds: [],
        changedIds: [],
        beforePriorities: new Map(),
      })
    );
  });

  // URGENT is the value the old three-member vocabularies dropped, so it gets
  // the positive assertion and a rejected value gets the negative one.
  it("accepts URGENT and rejects a value outside the vocabulary", async () => {
    vi.mocked(
      artifactBulkPriorityService.batchUpdatePriority
    ).mockResolvedValue(
      Result.ok({
        updatedIds: [ID_A],
        changedIds: [ID_A],
        beforePriorities: new Map([[ID_A, Priority.Low]]),
      })
    );

    const accepted = await post({
      documentIds: [ID_A],
      priority: Priority.Urgent,
    });
    expect(accepted.status).toBe(200);
    expect(
      artifactBulkPriorityService.batchUpdatePriority
    ).toHaveBeenCalledWith(
      [ID_A],
      Priority.Urgent,
      mockAuthContext.user.organizationId,
      // ISS-9440: OMITTED, never `null`. An older client sends no guard at all
      // and the service must see the absence, because `null` is a real
      // expectation meaning "this artifact holds no priority".
      undefined
    );

    const rejected = await post({ documentIds: [ID_A], priority: "CRITICAL" });
    expect(rejected.status).toBe(400);
  });

  it("records the previous and new value for a row that moved", async () => {
    vi.mocked(
      artifactBulkPriorityService.batchUpdatePriority
    ).mockResolvedValue(
      Result.ok({
        updatedIds: [ID_A],
        changedIds: [ID_A],
        beforePriorities: new Map([[ID_A, Priority.Low]]),
      })
    );

    await post({ documentIds: [ID_A], priority: Priority.Urgent });

    expect(mockCaptureBatchPriorityChange).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: [
          { artifactId: ID_A, before: Priority.Low, after: Priority.Urgent },
        ],
      })
    );
  });

  // A re-apply must not enter the feed as a change; the sibling above proves
  // the same locator does report a real move.
  it("records nothing for a re-apply that moved no row", async () => {
    vi.mocked(
      artifactBulkPriorityService.batchUpdatePriority
    ).mockResolvedValue(
      Result.ok({
        updatedIds: [ID_B],
        changedIds: [],
        beforePriorities: new Map(),
      })
    );

    const response = await post({
      documentIds: [ID_B],
      priority: Priority.Urgent,
    });

    expect(response.status).toBe(200);
    expect(mockCaptureBatchPriorityChange).toHaveBeenCalledWith(
      expect.objectContaining({ changes: [] })
    );
  });

  // A caller-correctable id must not be reported as a server fault; the
  // sibling above proves the same locator returns 200 for a good request.
  it("answers an unknown id with 400, not 500", async () => {
    vi.mocked(
      artifactBulkPriorityService.batchUpdatePriority
    ).mockResolvedValue(
      Result.err({
        status: 400,
        code: ArtifactPriorityMutationErrorCode.ArtifactsNotFound,
        message: `Invalid artifact IDs: ${ID_B}`,
        details: { missingDocuments: [{ documentId: ID_B }] },
      })
    );

    const response = await post({
      documentIds: [ID_B],
      priority: Priority.High,
    });

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  // ISS-9094 review (whitlockk): a race is retryable, not malformed. The sibling
  // above proves the same locator still renders 400 for a genuinely bad id, so
  // this asserts the two are not collapsed.
  it("answers a conflict with 409, not 400", async () => {
    vi.mocked(
      artifactBulkPriorityService.batchUpdatePriority
    ).mockResolvedValue(
      Result.err({
        status: 409,
        code: ArtifactPriorityMutationErrorCode.StalePriority,
        message: "One or more documents changed before the priority update",
      })
    );

    const response = await post({
      documentIds: [ID_A],
      priority: Priority.High,
    });

    expect(response.status).toBe(409);
    expect(mockCaptureBatchPriorityChange).not.toHaveBeenCalled();
    expect(mockEmitBatchFieldEditRefusalAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: ArtifactPriorityMutationErrorCode.StalePriority,
        }),
      })
    );
  });

  // A first-time set is a real transition: the single-artifact path records
  // null -> value, so the bulk path must too.
  it("records a first-time priority set, whose previous value was unset", async () => {
    vi.mocked(
      artifactBulkPriorityService.batchUpdatePriority
    ).mockResolvedValue(
      Result.ok({
        updatedIds: [ID_A],
        changedIds: [ID_A],
        beforePriorities: new Map([[ID_A, null]]),
      })
    );

    await post({ documentIds: [ID_A], priority: Priority.Urgent });

    expect(mockCaptureBatchPriorityChange).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: [{ artifactId: ID_A, before: null, after: Priority.Urgent }],
      })
    );
  });
  // ISS-9440. The guard reaches the service, or it guards nothing: the route
  // is the only thing between the validated body and the write.
  it("forwards the optimistic guard to the service", async () => {
    await post({
      documentIds: [ID_A, ID_B],
      priority: Priority.High,
      expectedPriorityById: { [ID_A]: Priority.Low, [ID_B]: null },
    });

    expect(
      artifactBulkPriorityService.batchUpdatePriority
    ).toHaveBeenCalledWith(
      [ID_A, ID_B],
      Priority.High,
      mockAuthContext.user.organizationId,
      { [ID_A]: Priority.Low, [ID_B]: null }
    );
  });

  // The 409 must carry WHICH rows moved and to what, or a client can only
  // retry blindly. Asserting the envelope, not just the status.
  it("renders a stale-priority conflict with its code and the rows that moved", async () => {
    vi.mocked(
      artifactBulkPriorityService.batchUpdatePriority
    ).mockResolvedValue(
      Result.err({
        status: 409,
        code: ArtifactPriorityMutationErrorCode.StalePriority,
        message: "One or more documents changed before the priority update",
        details: {
          stalePriorities: [
            {
              documentId: ID_A,
              currentPriority: Priority.Urgent,
              expectedPriority: Priority.Low,
            },
          ],
        },
      })
    );

    const response = await post({
      documentIds: [ID_A],
      priority: Priority.High,
      expectedPriorityById: { [ID_A]: Priority.Low },
    });

    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.code).toBe(ArtifactPriorityMutationErrorCode.StalePriority);
    expect(json.details.stalePriorities).toEqual([
      {
        documentId: ID_A,
        currentPriority: Priority.Urgent,
        expectedPriority: Priority.Low,
      },
    ]);
    expect(mockCaptureBatchPriorityChange).not.toHaveBeenCalled();
  });

  // Each half is a separate way to send a guard nothing will read, and the
  // service must never be reached with one.
  it("rejects a guard whose key is not a selected id, and an invalid guard value", async () => {
    const unselected = await post({
      documentIds: [ID_A],
      priority: Priority.High,
      expectedPriorityById: { [ID_B]: Priority.Low },
    });
    expect(unselected.status).toBe(400);

    const badValue = await post({
      documentIds: [ID_A],
      priority: Priority.High,
      expectedPriorityById: { [ID_A]: "CRITICAL" },
    });
    expect(badValue.status).toBe(400);

    expect(
      artifactBulkPriorityService.batchUpdatePriority
    ).not.toHaveBeenCalled();
  });

  // ISS-9440: the status batch has always been `.strict()`; this one was not,
  // so a misspelled guard key was accepted and silently dropped and the caller
  // got a 200 for a write nothing guarded. The sibling above proves the
  // correctly spelled key is accepted.
  it("rejects an unknown body key instead of silently dropping it", async () => {
    const response = await post({
      documentIds: [ID_A],
      priority: Priority.High,
      expectedPriorityByIds: { [ID_A]: Priority.Low },
    });

    expect(response.status).toBe(400);
    expect(
      artifactBulkPriorityService.batchUpdatePriority
    ).not.toHaveBeenCalled();
  });
});

describe("POST /documents/batch-update-priority telemetry (ISS-9443)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("emits ONE event for the whole commit, carrying the row count", async () => {
    vi.mocked(
      artifactBulkPriorityService.batchUpdatePriority
    ).mockResolvedValue(
      Result.ok({
        updatedIds: [ID_A, ID_B],
        changedIds: [ID_A, ID_B],
        beforePriorities: new Map([
          [ID_A, Priority.Low],
          [ID_B, null],
        ]),
      })
    );

    const response = await post({
      documentIds: [ID_A, ID_B],
      priority: Priority.High,
      surface: ArtifactStatusEditSurface.Bulk,
    });

    expect(response.status).toBe(200);
    // Exactly one call, not one per artifact: a per-row emit off a single
    // request is an unbounded fan-out and drowns the surface signal in rows.
    expect(mockCaptureArtifactFieldEditAnalytics).toHaveBeenCalledTimes(1);
    expect(mockCaptureArtifactFieldEditAnalytics).toHaveBeenCalledWith({
      organizationId: mockAuthContext.user.organizationId,
      userId: mockAuthContext.user.id,
      field: ArtifactFieldEditField.Priority,
      result: ArtifactFieldEditOutcome.Committed,
      provenance: {
        surface: ArtifactStatusEditSurface.Bulk,
        commitGroupId: expect.any(String),
      },
      commitGroupId: expect.any(String),
      after: Priority.High,
      artifactCount: 2,
    });
  });

  it("discards a surface an API key named — an agent write is unattributed", async () => {
    mockAuthContext = createTestAuthContext({ authMethod: "api_key" });
    vi.mocked(
      artifactBulkPriorityService.batchUpdatePriority
    ).mockResolvedValue(
      Result.ok({
        updatedIds: [ID_A],
        changedIds: [ID_A],
        beforePriorities: new Map([[ID_A, Priority.Low]]),
      })
    );

    const response = await post({
      documentIds: [ID_A],
      priority: Priority.High,
      surface: ArtifactStatusEditSurface.Bulk,
    });

    // The write still commits — only the attribution is refused.
    expect(response.status).toBe(200);
    expect(
      artifactBulkPriorityService.batchUpdatePriority
    ).toHaveBeenCalledTimes(1);
    expect(mockCaptureBatchPriorityChange).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: undefined,
        preserveProvenanceOmission: true,
      })
    );
    const [capturedAnalytics] =
      mockCaptureArtifactFieldEditAnalytics.mock.calls[0];
    expect(capturedAnalytics).not.toHaveProperty("provenance");
  });

  it("commits the write when a newer client names a surface this build cannot place", async () => {
    vi.mocked(
      artifactBulkPriorityService.batchUpdatePriority
    ).mockResolvedValue(
      Result.ok({
        updatedIds: [ID_A],
        changedIds: [ID_A],
        beforePriorities: new Map([[ID_A, Priority.Low]]),
      })
    );

    const response = await post({
      documentIds: [ID_A],
      priority: Priority.High,
      surface: "command_palette",
    });

    // Version skew must cost the EVENT, never the user's write.
    expect(response.status).toBe(200);
    expect(
      artifactBulkPriorityService.batchUpdatePriority
    ).toHaveBeenCalledTimes(1);
    expect(mockCaptureBatchPriorityChange).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: undefined,
        preserveProvenanceOmission: true,
      })
    );
    const [capturedAnalytics] =
      mockCaptureArtifactFieldEditAnalytics.mock.calls[0];
    expect(capturedAnalytics).not.toHaveProperty("provenance");
  });

  it("counts the rows that MOVED, not the rows that were asked for", async () => {
    vi.mocked(
      artifactBulkPriorityService.batchUpdatePriority
    ).mockResolvedValue(
      Result.ok({
        updatedIds: [ID_A, ID_B],
        changedIds: [ID_A],
        beforePriorities: new Map([[ID_A, Priority.Low]]),
      })
    );

    await post({
      documentIds: [ID_A, ID_B],
      priority: Priority.High,
      surface: ArtifactStatusEditSurface.Bulk,
    });

    expect(mockCaptureArtifactFieldEditAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({ artifactCount: 1 })
    );
  });

  it("emits nothing when a re-apply moved no row", async () => {
    vi.mocked(
      artifactBulkPriorityService.batchUpdatePriority
    ).mockResolvedValue(
      Result.ok({
        updatedIds: [ID_A],
        changedIds: [],
        beforePriorities: new Map(),
      })
    );

    const response = await post({
      documentIds: [ID_A],
      priority: Priority.High,
      surface: ArtifactStatusEditSurface.Bulk,
    });

    expect(response.status).toBe(200);
    expect(mockCaptureArtifactFieldEditAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({ result: ArtifactFieldEditOutcome.NoChange })
    );
  });

  it("emits nothing when the caller named no surface, and still writes", async () => {
    vi.mocked(
      artifactBulkPriorityService.batchUpdatePriority
    ).mockResolvedValue(
      Result.ok({
        updatedIds: [ID_A],
        changedIds: [ID_A],
        beforePriorities: new Map([[ID_A, Priority.Low]]),
      })
    );

    const response = await post({
      documentIds: [ID_A],
      priority: Priority.High,
    });

    expect(response.status).toBe(200);
    expect(
      artifactBulkPriorityService.batchUpdatePriority
    ).toHaveBeenCalledTimes(1);
    const [capturedAnalytics] =
      mockCaptureArtifactFieldEditAnalytics.mock.calls[0];
    expect(capturedAnalytics).not.toHaveProperty("provenance");
  });

  it("rejects a surface a priority cannot come from, rather than writing it uncounted", async () => {
    const response = await post({
      documentIds: [ID_A],
      priority: Priority.High,
      surface: ArtifactStatusEditSurface.Board,
    });

    expect(response.status).toBe(400);
    expect(
      artifactBulkPriorityService.batchUpdatePriority
    ).not.toHaveBeenCalled();
  });
});
