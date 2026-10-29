import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports) ---

let mockAuthContext: import("@/lib/auth/with-auth").AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params),
}));

vi.mock("@/lib/identifier-utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/identifier-utils")>(
    "@/lib/identifier-utils"
  );
  return {
    ...actual,
    resolveProjectId: vi.fn(),
    resolveDocumentId: vi.fn(),
  };
});

vi.mock("@/app/projects/service", async () => {
  const actual = await vi.importActual<typeof import("@/app/projects/service")>(
    "@/app/projects/service"
  );
  return {
    ...actual,
    projectsService: {
      ...actual.projectsService,
      findById: vi.fn(),
    },
  };
});

vi.mock("@/app/documents/document-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/app/documents/document-service")
  >("@/app/documents/document-service");
  return {
    ...actual,
    documentService: {
      ...actual.documentService,
      moveArtifact: vi.fn(),
    },
  };
});

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(async () => undefined),
  },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

// --- Imports (after mocks) ---

import {
  MOVE_ARTIFACT_CONFLICT,
  MOVE_ARTIFACT_EXPECTED_ORDER_LIMIT,
  MovePosition,
} from "@repo/api/src/types/project-artifact-move";
import { Result, Status } from "@repo/api/src/types/result";
import { documentService } from "@/app/documents/document-service";
import { projectsService } from "@/app/projects/service";
import { resolveDocumentId, resolveProjectId } from "@/lib/identifier-utils";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../../../../__tests__/utils/auth-helpers";
import { POST } from "./route";

const PROJECT_ID = "11111111-1111-7111-8111-111111111111";
const PROJECT_SLUG = "PRO-7";
const ARTIFACT_ID = "22222222-2222-7222-8222-222222222222";
const REFERENCE_ID = "33333333-3333-7333-8333-333333333333";

const resolveProjectIdMock = vi.mocked(resolveProjectId);
const resolveDocumentIdMock = vi.mocked(resolveDocumentId);
const findById = projectsService.findById as ReturnType<typeof vi.fn>;
const moveArtifact = documentService.moveArtifact as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  resolveProjectIdMock.mockResolvedValue(PROJECT_ID);
  // Identity by default: UUIDs resolve to themselves, so existing
  // UUID-bodied cases assert against the same id they sent.
  resolveDocumentIdMock.mockImplementation((id) => Promise.resolve(id));
  findById.mockResolvedValue({ id: PROJECT_ID });
});

function moveRequest(body: unknown) {
  return createMockRequest({
    url: `http://localhost:3002/api/projects/${PROJECT_ID}/artifacts/move`,
    method: "POST",
    body,
  });
}

describe("POST /projects/[id]/artifacts/move", () => {
  it("moves to top via service and returns the new sortOrder", async () => {
    moveArtifact.mockResolvedValue(Result.ok({ newSortOrder: 0 }));

    const response = await POST(
      moveRequest({ artifactId: ARTIFACT_ID, position: MovePosition.Top }),
      createMockRouteContext({ id: PROJECT_ID })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data).toEqual({ moved: true, newSortOrder: 0 });

    expect(moveArtifact).toHaveBeenCalledWith(
      PROJECT_ID,
      mockAuthContext.user.organizationId,
      { artifactId: ARTIFACT_ID, position: MovePosition.Top },
      undefined
    );
  });

  it("resolves a project slug to its id before moving", async () => {
    resolveProjectIdMock.mockResolvedValue(PROJECT_ID);
    moveArtifact.mockResolvedValue(Result.ok({ newSortOrder: 0 }));

    const response = await POST(
      moveRequest({ artifactId: ARTIFACT_ID, position: MovePosition.Top }),
      createMockRouteContext({ id: PROJECT_SLUG })
    );

    expect(response.status).toBe(200);
    expect(resolveProjectIdMock).toHaveBeenCalledWith(
      PROJECT_SLUG,
      mockAuthContext.user.organizationId
    );
    // findById receives the resolved UUID, never the raw slug.
    expect(findById).toHaveBeenCalledWith(
      PROJECT_ID,
      mockAuthContext.user.organizationId
    );
    expect(moveArtifact).toHaveBeenCalledWith(
      PROJECT_ID,
      mockAuthContext.user.organizationId,
      { artifactId: ARTIFACT_ID, position: MovePosition.Top },
      undefined
    );
  });

  it("returns 404 when the project identifier does not resolve", async () => {
    resolveProjectIdMock.mockResolvedValue(null);

    const response = await POST(
      moveRequest({ artifactId: ARTIFACT_ID, position: MovePosition.Top }),
      createMockRouteContext({ id: "PRO-nope" })
    );

    expect(response.status).toBe(404);
    expect(findById).not.toHaveBeenCalled();
    expect(moveArtifact).not.toHaveBeenCalled();
  });

  it("moves before a reference", async () => {
    moveArtifact.mockResolvedValue(Result.ok({ newSortOrder: 1500 }));

    const response = await POST(
      moveRequest({
        artifactId: ARTIFACT_ID,
        position: MovePosition.Before,
        referenceArtifactId: REFERENCE_ID,
      }),
      createMockRouteContext({ id: PROJECT_ID })
    );

    expect(response.status).toBe(200);
    expect(moveArtifact).toHaveBeenCalledWith(
      PROJECT_ID,
      mockAuthContext.user.organizationId,
      {
        artifactId: ARTIFACT_ID,
        position: MovePosition.Before,
        referenceArtifactId: REFERENCE_ID,
      },
      undefined
    );
  });

  it("resolves artifact and reference slugs to UUIDs before moving", async () => {
    const slugToId: Record<string, string> = {
      "PLN-12": ARTIFACT_ID,
      "FEA-42": REFERENCE_ID,
    };
    resolveDocumentIdMock.mockImplementation((id) =>
      Promise.resolve(slugToId[id] ?? null)
    );
    moveArtifact.mockResolvedValue(Result.ok({ newSortOrder: 1500 }));

    const response = await POST(
      moveRequest({
        artifactId: "PLN-12",
        position: MovePosition.Before,
        referenceArtifactId: "FEA-42",
      }),
      createMockRouteContext({ id: PROJECT_ID })
    );

    expect(response.status).toBe(200);
    expect(resolveDocumentIdMock).toHaveBeenCalledWith(
      "PLN-12",
      mockAuthContext.user.organizationId
    );
    expect(resolveDocumentIdMock).toHaveBeenCalledWith(
      "FEA-42",
      mockAuthContext.user.organizationId
    );
    // The service receives resolved UUIDs, never the raw slugs.
    expect(moveArtifact).toHaveBeenCalledWith(
      PROJECT_ID,
      mockAuthContext.user.organizationId,
      {
        artifactId: ARTIFACT_ID,
        position: MovePosition.Before,
        referenceArtifactId: REFERENCE_ID,
      },
      undefined
    );
  });

  it("returns 404 when the artifact identifier does not resolve", async () => {
    // Valid slug format (passes the validator) but no such document.
    resolveDocumentIdMock.mockResolvedValue(null);

    const response = await POST(
      moveRequest({ artifactId: "PLN-999", position: MovePosition.Top }),
      createMockRouteContext({ id: PROJECT_ID })
    );

    expect(response.status).toBe(404);
    expect(moveArtifact).not.toHaveBeenCalled();
  });

  it("returns 404 when the reference artifact does not resolve", async () => {
    resolveDocumentIdMock.mockImplementation((id) =>
      Promise.resolve(id === ARTIFACT_ID ? ARTIFACT_ID : null)
    );

    const response = await POST(
      moveRequest({
        artifactId: ARTIFACT_ID,
        position: MovePosition.After,
        referenceArtifactId: "FEA-999",
      }),
      createMockRouteContext({ id: PROJECT_ID })
    );

    expect(response.status).toBe(404);
    expect(moveArtifact).not.toHaveBeenCalled();
  });

  it("returns 404 when the project is not in the caller's org", async () => {
    findById.mockResolvedValue(null);

    const response = await POST(
      moveRequest({ artifactId: ARTIFACT_ID, position: MovePosition.Bottom }),
      createMockRouteContext({ id: PROJECT_ID })
    );

    expect(response.status).toBe(404);
    expect(moveArtifact).not.toHaveBeenCalled();
  });

  it("rejects before/after bodies without referenceArtifactId", async () => {
    const response = await POST(
      moveRequest({ artifactId: ARTIFACT_ID, position: MovePosition.Before }),
      createMockRouteContext({ id: PROJECT_ID })
    );

    expect(response.status).toBe(400);
    expect(moveArtifact).not.toHaveBeenCalled();
  });

  it("rejects an unknown position value", async () => {
    // Intentionally invalid: "sideways" is not in the MovePosition union.
    const response = await POST(
      moveRequest({ artifactId: ARTIFACT_ID, position: "sideways" }),
      createMockRouteContext({ id: PROJECT_ID })
    );

    expect(response.status).toBe(400);
    expect(moveArtifact).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID artifactId", async () => {
    const response = await POST(
      moveRequest({ artifactId: "not-a-uuid", position: MovePosition.Top }),
      createMockRouteContext({ id: PROJECT_ID })
    );

    expect(response.status).toBe(400);
    expect(moveArtifact).not.toHaveBeenCalled();
  });

  it("returns 404 when the service reports the artifact is not in the project", async () => {
    moveArtifact.mockResolvedValue(
      Result.err({
        status: Status.NotFound,
        message: `Artifact ${ARTIFACT_ID} not found in project ${PROJECT_ID}`,
      })
    );

    const response = await POST(
      moveRequest({ artifactId: ARTIFACT_ID, position: MovePosition.Top }),
      createMockRouteContext({ id: PROJECT_ID })
    );

    expect(response.status).toBe(404);
  });

  it("returns 400 when the service reports referenceArtifactId equals artifactId", async () => {
    moveArtifact.mockResolvedValue(
      Result.err({
        status: Status.BadRequest,
        message: `referenceArtifactId must differ from artifactId (${ARTIFACT_ID})`,
      })
    );

    const response = await POST(
      moveRequest({
        artifactId: ARTIFACT_ID,
        position: MovePosition.After,
        referenceArtifactId: ARTIFACT_ID,
      }),
      createMockRouteContext({ id: PROJECT_ID })
    );

    expect(response.status).toBe(400);
  });

  it("returns 500 when the service throws", async () => {
    moveArtifact.mockRejectedValue(new Error("boom"));

    const response = await POST(
      moveRequest({ artifactId: ARTIFACT_ID, position: MovePosition.Top }),
      createMockRouteContext({ id: PROJECT_ID })
    );

    expect(response.status).toBe(500);
  });

  // ISS-8728 — the optional expected-order precondition.
  it("forwards an expectedOrder precondition to the service unchanged", async () => {
    moveArtifact.mockResolvedValue(Result.ok({ newSortOrder: 0 }));
    const expectedOrder = [ARTIFACT_ID, REFERENCE_ID];

    const response = await POST(
      moveRequest({
        artifactId: ARTIFACT_ID,
        position: MovePosition.Top,
        expectedOrder,
      }),
      createMockRouteContext({ id: PROJECT_ID })
    );

    expect(response.status).toBe(200);
    // The service decides the precondition inside its transaction, so the
    // route's whole job is to carry it there intact — a dropped field would
    // silently restore last-write-wins while the caller believed it was
    // protected, and the 200 above would look identical.
    expect(moveArtifact).toHaveBeenCalledWith(
      PROJECT_ID,
      mockAuthContext.user.organizationId,
      {
        artifactId: ARTIFACT_ID,
        position: MovePosition.Top,
        expectedOrder,
      },
      undefined
    );
  });

  it("carries the precondition on a before/after move too", async () => {
    moveArtifact.mockResolvedValue(Result.ok({ newSortOrder: 1500 }));
    const expectedOrder = [ARTIFACT_ID, REFERENCE_ID];

    const response = await POST(
      moveRequest({
        artifactId: ARTIFACT_ID,
        position: MovePosition.Before,
        referenceArtifactId: REFERENCE_ID,
        expectedOrder,
      }),
      createMockRouteContext({ id: PROJECT_ID })
    );

    expect(response.status).toBe(200);
    // The reference branch rebuilds the body rather than mutating it, so it is
    // the one that can drop the field while the Top branch keeps it.
    expect(moveArtifact).toHaveBeenCalledWith(
      PROJECT_ID,
      mockAuthContext.user.organizationId,
      {
        artifactId: ARTIFACT_ID,
        position: MovePosition.Before,
        referenceArtifactId: REFERENCE_ID,
        expectedOrder,
      },
      undefined
    );
  });

  it("omits expectedOrder entirely when the caller sent none", async () => {
    moveArtifact.mockResolvedValue(Result.ok({ newSortOrder: 0 }));

    await POST(
      moveRequest({ artifactId: ARTIFACT_ID, position: MovePosition.Top }),
      createMockRouteContext({ id: PROJECT_ID })
    );

    // OMITTED, not `undefined`: the service reads `input.expectedOrder ===
    // undefined` as "no precondition", and both spellings satisfy that today —
    // but this is a cross-process payload shape, and the repo's compatibility
    // rule is that an absent optional field stays absent rather than being
    // serialized as a null-ish placeholder.
    const [, , body] = moveArtifact.mock.calls.at(-1) as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect("expectedOrder" in body).toBe(false);
  });

  it("maps a stale-precondition conflict to 409", async () => {
    moveArtifact.mockResolvedValue(
      Result.err({
        status: Status.Conflict,
        message: `${MOVE_ARTIFACT_CONFLICT}: re-read the project and retry.`,
      })
    );

    const response = await POST(
      moveRequest({
        artifactId: ARTIFACT_ID,
        position: MovePosition.Top,
        expectedOrder: [ARTIFACT_ID],
      }),
      createMockRouteContext({ id: PROJECT_ID })
    );
    const json = await response.json();

    // 409, not the 400 every non-404 service error used to collapse into: a
    // caller retrying a conflict is doing something different from a caller
    // fixing a malformed request, and only the status tells them apart.
    expect(response.status).toBe(409);
    expect(json.error).toContain(MOVE_ARTIFACT_CONFLICT);
  });

  it("rejects a non-UUID expectedOrder entry with 400 before reaching the service", async () => {
    const response = await POST(
      moveRequest({
        artifactId: ARTIFACT_ID,
        position: MovePosition.Top,
        expectedOrder: ["PLN-12"],
      }),
      createMockRouteContext({ id: PROJECT_ID })
    );

    // Slugs are deliberately not accepted here — see the validator's docstring.
    expect(response.status).toBe(400);
    expect(moveArtifact).not.toHaveBeenCalled();
  });

  it("rejects an expectedOrder past the shared cap with 400", async () => {
    const response = await POST(
      moveRequest({
        artifactId: ARTIFACT_ID,
        position: MovePosition.Top,
        expectedOrder: Array.from(
          { length: MOVE_ARTIFACT_EXPECTED_ORDER_LIMIT + 1 },
          () => ARTIFACT_ID
        ),
      }),
      createMockRouteContext({ id: PROJECT_ID })
    );

    expect(response.status).toBe(400);
    expect(moveArtifact).not.toHaveBeenCalled();
  });
});
