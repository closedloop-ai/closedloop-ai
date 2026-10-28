/**
 * Route dispatch tests for POST /artifact-links/batch-move.
 *
 * Why this file exists
 * --------------------
 * The service returns a `Result<value, StatusCode>` that the route must
 * translate into HTTP status codes:
 *   - ok                        → 200
 *   - err(Status.NotFound)      → 404 (source artifact missing)
 *   - err(Status.BadRequest)    → 400 (target project missing)
 *   - any other err             → 400 (generic fallback)
 *
 * Before PR #920 addressed the finding, every error collapsed into 400,
 * which silently hid "artifact not found" behind a "bad request" response.
 * This test pins the mapping at the route layer so a regression is caught
 * without needing an integration test.
 */

import {
  AgentSessionFieldMutationErrorCode,
  staleSessionFieldsConflict,
} from "@repo/api/src/types/agent-session-field-mutation";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ISS-10993: the route opens ONE transaction for the mutation and its activity
// receipt, so `withDb.tx` has to RUN its callback here rather than stub it away.
vi.mock("@repo/database", () => ({
  withDb: Object.assign(<T>(fn: (client: unknown) => T) => fn(MOCK_TX), {
    tx: <T>(fn: (client: unknown) => T) => fn(MOCK_TX),
  }),
  Prisma: { JsonNull: "DbNull" },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: unknown, context: { params: Promise<unknown> }) =>
      handler(
        {
          user: { id: "user-1", organizationId: "org-1" },
          authMethod: "session",
        },
        request,
        context.params
      ),
}));

/** Stands in for the route's transaction client; nothing calls a method on it. */
const MOCK_TX = vi.hoisted(() => ({ __brand: "mock-tx" }));

const mockCaptureBatchProjectChange = vi.hoisted(() => vi.fn());
vi.mock("@/lib/artifact-activity-capture", () => ({
  captureBatchProjectChange: (...args: unknown[]) =>
    mockCaptureBatchProjectChange(...args),
}));

const mockDispatchAuditEvents = vi.hoisted(() => vi.fn());
vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvents: (...args: unknown[]) => mockDispatchAuditEvents(...args),
  userAuditActor: (userId: string) => ({
    actorType: "user",
    actorId: userId,
  }),
}));

vi.mock("@/app/artifact-links/service", () => ({
  artifactLinksService: {
    batchMoveArtifacts: vi.fn(),
  },
}));

import { POST } from "@/app/artifact-links/batch-move/route";
import { artifactLinksService } from "@/app/artifact-links/service";
import {
  createMockRequest,
  createMockRouteContext,
} from "../utils/auth-helpers";

// Valid v4 UUIDs (z.uuid() enforces RFC 4122 version/variant bits).
const ARTIFACT_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_PROJECT_ID = "22222222-2222-4222-8222-222222222222";

function makeRequest(body: unknown) {
  return createMockRequest({
    url: "http://localhost:3002/artifact-links/batch-move",
    method: "POST",
    body,
  });
}

const VALID_BODY = {
  artifactId: ARTIFACT_ID,
  targetProjectId: TARGET_PROJECT_ID,
  includeDownstream: false,
};

describe("POST /artifact-links/batch-move — status code mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with ONLY the declared wire shape on ok result", async () => {
    const movedArtifacts = [{ id: ARTIFACT_ID, type: "DOCUMENT" as const }];
    vi.mocked(artifactLinksService.batchMoveArtifacts).mockResolvedValue({
      ok: true,
      value: {
        movedArtifacts,
        projectChanges: [
          { artifactId: ARTIFACT_ID, before: null, after: TARGET_PROJECT_ID },
        ],
      },
    });

    const response = await POST(
      makeRequest(VALID_BODY),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    // ISS-9158: `projectChanges` is an internal service return and must not
    // leak into `BatchMoveArtifactsResult`.
    expect(json.data).toEqual({ movedArtifacts });
  });

  it("returns 404 when the service reports Status.NotFound (source artifact missing)", async () => {
    vi.mocked(artifactLinksService.batchMoveArtifacts).mockResolvedValue({
      ok: false,
      error: Status.NotFound,
    });

    const response = await POST(
      makeRequest(VALID_BODY),
      createMockRouteContext({})
    );

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns 400 when the service reports Status.BadRequest (target project missing)", async () => {
    vi.mocked(artifactLinksService.batchMoveArtifacts).mockResolvedValue({
      ok: false,
      error: Status.BadRequest,
    });

    const response = await POST(
      makeRequest(VALID_BODY),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns 400 on any other failure status (generic fallback)", async () => {
    vi.mocked(artifactLinksService.batchMoveArtifacts).mockResolvedValue({
      ok: false,
      error: Status.Error,
    });

    const response = await POST(
      makeRequest(VALID_BODY),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
  });

  /**
   * ISS-10995: a refused optimistic guard is a 409 carrying the envelope
   * `PATCH /agent-sessions/{id}` already answers with, not the generic 400 the
   * fallback above gives every other non-404 error.
   */
  it("returns 409 with the stale-project envelope when the guard is refused", async () => {
    const staleProjectId = {
      documentId: ARTIFACT_ID,
      currentProjectId: "33333333-3333-4333-8333-333333333333",
      expectedProjectId: null,
    };
    const conflict = staleSessionFieldsConflict({ projectId: staleProjectId });
    if (!conflict) {
      throw new Error("staleSessionFieldsConflict reported no conflict");
    }
    vi.mocked(artifactLinksService.batchMoveArtifacts).mockResolvedValue({
      ok: false,
      error: conflict,
    });

    const response = await POST(
      makeRequest({ ...VALID_BODY, expectedProjectId: null }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.code).toBe(AgentSessionFieldMutationErrorCode.StaleProjectId);
    expect(json.details).toEqual({ staleProjectIds: [staleProjectId] });
  });

  it("carries an expected project through to the service, and omits an absent one", async () => {
    vi.mocked(artifactLinksService.batchMoveArtifacts).mockResolvedValue({
      ok: true,
      value: { movedArtifacts: [], projectChanges: [] },
    });

    await POST(
      makeRequest({ ...VALID_BODY, expectedProjectId: null }),
      createMockRouteContext({})
    );
    await POST(makeRequest(VALID_BODY), createMockRouteContext({}));

    const calls = vi.mocked(artifactLinksService.batchMoveArtifacts).mock.calls;
    expect(calls[0]?.[1]).toMatchObject({ expectedProjectId: null });
    // Absent, not `null`: `null` is the real assertion "filed into no project",
    // so the two cannot collapse at the parse boundary.
    expect(calls[1]?.[1]).not.toHaveProperty("expectedProjectId");
  });

  it("returns 400 when the request body fails validation", async () => {
    const response = await POST(
      makeRequest({ artifactId: "not-a-uuid" }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(artifactLinksService.batchMoveArtifacts).not.toHaveBeenCalled();
  });

  it("forwards a null targetProjectId to the service as a clear", async () => {
    vi.mocked(artifactLinksService.batchMoveArtifacts).mockResolvedValue({
      ok: true,
      value: { movedArtifacts: [], projectChanges: [] },
    });

    const response = await POST(
      makeRequest({ ...VALID_BODY, targetProjectId: null }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(
      vi.mocked(artifactLinksService.batchMoveArtifacts).mock.calls[0]?.[1]
    ).toMatchObject({ artifactId: ARTIFACT_ID, targetProjectId: null });
  });

  it("rejects a body without targetProjectId with 400 and never calls the service", async () => {
    const response = await POST(
      makeRequest({ artifactId: ARTIFACT_ID, includeDownstream: false }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(artifactLinksService.batchMoveArtifacts).not.toHaveBeenCalled();
  });
});

/**
 * ISS-9158: a bulk move must leave the same per-artifact `projectId` activity
 * event a single move leaves. The capture is fed straight from the service's
 * in-transaction read, unchanged rows included — the helper owns the
 * `before !== after` filter (pinned in artifact-activity-capture.test.ts).
 */
describe("POST /artifact-links/batch-move — activity capture", () => {
  const SOURCE_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
  const DOWNSTREAM_ID = "44444444-4444-4444-8444-444444444444";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures one project change per moved row with the actor from auth", async () => {
    const projectChanges = [
      {
        artifactId: ARTIFACT_ID,
        before: SOURCE_PROJECT_ID,
        after: TARGET_PROJECT_ID,
      },
      // Already in the target project: the row was locked and rewritten but
      // did not MOVE, so neither the receipt nor the ledger entry may name it
      // (ISS-9465). The side-effect helper drops it before either.
      {
        artifactId: DOWNSTREAM_ID,
        before: TARGET_PROJECT_ID,
        after: TARGET_PROJECT_ID,
      },
    ];
    vi.mocked(artifactLinksService.batchMoveArtifacts).mockResolvedValue({
      ok: true,
      value: {
        movedArtifacts: [
          { id: ARTIFACT_ID, type: "DOCUMENT" as const },
          { id: DOWNSTREAM_ID, type: "BRANCH" as const },
        ],
        projectChanges,
      },
    });

    const response = await POST(
      makeRequest({ ...VALID_BODY, includeDownstream: true }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(mockCaptureBatchProjectChange).toHaveBeenCalledTimes(1);
    const transactionId =
      mockCaptureBatchProjectChange.mock.calls[0][0].transactionId;
    expect(transactionId).toEqual(expect.any(String));
    expect(mockCaptureBatchProjectChange).toHaveBeenCalledWith({
      tx: MOCK_TX,
      organizationId: "org-1",
      actor: { userId: "user-1", authMethod: "session" },
      changes: [projectChanges[0]],
      transactionId,
      provenance: {
        surface: ArtifactStatusEditSurface.Bulk,
        commitGroupId: transactionId,
      },
    });

    // ISS-9465 ruling 6: this route wrote nothing to the ledger before. The
    // action and object type are LITERALS — reading them from the const they
    // guard would let a fixture agree with a typo that is hashed into an
    // append-only chain and can never be renamed.
    const [auditEvents] = mockDispatchAuditEvents.mock.calls[0];
    expect(auditEvents).toEqual([
      expect.objectContaining({
        action: "artifact.project_changed",
        objectType: "artifact",
        objectId: projectChanges[0].artifactId,
      }),
    ]);
    // The ledger entry and the receipt name the SAME commit; two ids would be
    // two answers to "which action was this".
    expect(auditEvents[0].detail.transactionId).toBe(
      mockCaptureBatchProjectChange.mock.calls[0][0].transactionId
    );
  });

  it("does not capture when the move failed", async () => {
    vi.mocked(artifactLinksService.batchMoveArtifacts).mockResolvedValue({
      ok: false,
      error: Status.NotFound,
    });

    const response = await POST(
      makeRequest(VALID_BODY),
      createMockRouteContext({})
    );

    expect(response.status).toBe(404);
    expect(mockCaptureBatchProjectChange).not.toHaveBeenCalled();
  });

  /**
   * ISS-10993, operator ruling (Cosimo Corrigan, 2026-09-23). This case asserted
   * 200 until that ruling: the capture was swallowed and the move still
   * answered success, which is how a lost receipt left a permanent hole in a
   * published feed with nobody able to see it. Restore a `catch {}` around the
   * capture and this returns 200 again and fails.
   */
  it("refuses the move when the capture cannot record its receipt", async () => {
    mockCaptureBatchProjectChange.mockRejectedValue(
      new Error("activity store down")
    );
    vi.mocked(artifactLinksService.batchMoveArtifacts).mockResolvedValue({
      ok: true,
      value: {
        movedArtifacts: [{ id: ARTIFACT_ID, type: "DOCUMENT" as const }],
        projectChanges: [
          {
            artifactId: ARTIFACT_ID,
            before: SOURCE_PROJECT_ID,
            after: TARGET_PROJECT_ID,
          },
        ],
      },
    });

    const response = await POST(
      makeRequest(VALID_BODY),
      createMockRouteContext({})
    );

    expect(response.status).toBe(500);
    // The ledger emission is post-commit, so a refused move must not have
    // written one: an entry for a move that rolled back is a forged row.
    expect(mockDispatchAuditEvents).not.toHaveBeenCalled();
  });
});
