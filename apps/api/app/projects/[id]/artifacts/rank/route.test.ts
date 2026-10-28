/**
 * Route tests for `GET`/`POST /projects/[id]/artifacts/rank` (ISS-8999).
 *
 * The service is mocked; what is under test here is the boundary — auth and
 * org-scoped project resolution, Zod rejection of a malformed body, and the
 * mapping from a service `Result` to a status code and wire shape (notably the
 * typed 409 body that carries the added / removed / reparented breakdown).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let mockAuthContext: import("@/lib/auth/with-auth").AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => unknown) =>
    (request: unknown, context: { params?: unknown }) =>
      handler(mockAuthContext, request, context?.params),
}));

vi.mock("@/lib/identifier-utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/identifier-utils")>(
    "@/lib/identifier-utils"
  );
  return { ...actual, resolveProjectId: vi.fn() };
});

vi.mock("@/app/projects/service", async () => {
  const actual = await vi.importActual<typeof import("@/app/projects/service")>(
    "@/app/projects/service"
  );
  return {
    ...actual,
    projectsService: { ...actual.projectsService, findById: vi.fn() },
  };
});

vi.mock("@/app/documents/artifact-bulk-rank-service", () => ({
  artifactBulkRankService: {
    getRankState: vi.fn(),
    bulkRankArtifacts: vi.fn(),
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

import { NUL_CHARACTER } from "@repo/api/src/types/postgres-text";
import type { BulkRankConflictDetail } from "@repo/api/src/types/project-artifact-bulk-rank";
import {
  BulkRankConflictReason,
  BulkRankMutationSource,
} from "@repo/api/src/types/project-artifact-bulk-rank";
import { Result, Status } from "@repo/api/src/types/result";
import { artifactBulkRankService } from "@/app/documents/artifact-bulk-rank-service";
import { projectsService } from "@/app/projects/service";
import { resolveProjectId } from "@/lib/identifier-utils";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../../../../__tests__/utils/auth-helpers";
import { GET, POST } from "./route";

const PROJECT_ID = "11111111-1111-7111-8111-111111111111";
const PROJECT_SLUG = "PRO-7";
const ROOT_A = "22222222-2222-7222-8222-222222222222";
const ROOT_B = "33333333-3333-7333-8333-333333333333";
const EPOCH = "a".repeat(32);

const mockGetRankState = vi.mocked(artifactBulkRankService.getRankState);
const mockBulkRank = vi.mocked(artifactBulkRankService.bulkRankArtifacts);
const mockResolveProjectId = vi.mocked(resolveProjectId);
const mockFindProject = vi.mocked(projectsService.findById);

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    orderedArtifactIds: [ROOT_A, ROOT_B],
    expectedRankEpoch: EPOCH,
    source: BulkRankMutationSource.DependencyRank,
    idempotencyKey: "rank-run-1",
    ...overrides,
  };
}

function postRequest(body: unknown) {
  return POST(
    createMockRequest({ method: "POST", body }),
    createMockRouteContext({ id: PROJECT_SLUG })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  mockResolveProjectId.mockResolvedValue(PROJECT_ID);
  mockFindProject.mockResolvedValue({ id: PROJECT_ID } as never);
});

describe("GET /projects/[id]/artifacts/rank", () => {
  it("returns the ordered roots and the epoch they were read at", async () => {
    mockGetRankState.mockResolvedValue({
      rankEpoch: EPOCH,
      orderedRootIds: [ROOT_A, ROOT_B],
    });

    const response = await GET(
      createMockRequest({ method: "GET" }),
      createMockRouteContext({ id: PROJECT_SLUG })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { rankEpoch: EPOCH, orderedArtifactIds: [ROOT_A, ROOT_B] },
    });
    expect(mockGetRankState).toHaveBeenCalledWith(
      PROJECT_ID,
      mockAuthContext.user.organizationId
    );
  });

  it("404s a project outside the caller's organization", async () => {
    mockFindProject.mockResolvedValue(null);

    const response = await GET(
      createMockRequest({ method: "GET" }),
      createMockRouteContext({ id: PROJECT_SLUG })
    );

    expect(response.status).toBe(404);
    expect(mockGetRankState).not.toHaveBeenCalled();
  });
});

describe("POST /projects/[id]/artifacts/rank", () => {
  it("commits an order and returns the committed epoch", async () => {
    mockBulkRank.mockResolvedValue(
      Result.ok({
        rankEpoch: "b".repeat(32),
        orderedArtifactIds: [ROOT_B, ROOT_A],
        replayed: false,
      })
    );

    const response = await postRequest(
      validBody({ orderedArtifactIds: [ROOT_B, ROOT_A] })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        ranked: true,
        rankEpoch: "b".repeat(32),
        orderedArtifactIds: [ROOT_B, ROOT_A],
        replayed: false,
      },
    });
    expect(mockBulkRank).toHaveBeenCalledWith(
      PROJECT_ID,
      mockAuthContext.user.organizationId,
      validBody({ orderedArtifactIds: [ROOT_B, ROOT_A] }),
      mockAuthContext.user.id,
      undefined
    );
  });

  it("returns 409 with the added, removed, and reparented breakdown", async () => {
    const conflict: BulkRankConflictDetail = {
      reason: BulkRankConflictReason.PopulationMismatch,
      expectedRankEpoch: EPOCH,
      actualRankEpoch: "c".repeat(32),
      addedArtifactIds: [ROOT_A],
      removedArtifactIds: [ROOT_B],
      reparentedArtifactIds: [],
    };
    mockBulkRank.mockResolvedValue(
      Result.err({
        status: Status.Conflict,
        message: "rank state changed",
        conflict,
      })
    );

    const response = await postRequest(validBody());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      success: false,
      error: "rank state changed",
      data: conflict,
    });
  });

  it("400s a body with duplicate artifact ids without calling the service", async () => {
    const response = await postRequest(
      validBody({ orderedArtifactIds: [ROOT_A, ROOT_A] })
    );

    expect(response.status).toBe(400);
    expect(mockBulkRank).not.toHaveBeenCalled();
  });

  // ISS-10436: the key is looked up in a `text` column, which Postgres refuses
  // a NUL in (22021); before the boundary refused it the route answered 500.
  it("400s an idempotency key carrying a NUL without calling the service", async () => {
    const response = await postRequest(
      validBody({ idempotencyKey: `rank-run${NUL_CHARACTER}1` })
    );

    expect(response.status).toBe(400);
    expect(mockBulkRank).not.toHaveBeenCalled();
  });

  it("400s an unknown key rather than silently dropping it", async () => {
    const response = await postRequest(validBody({ position: "top" }));

    expect(response.status).toBe(400);
    expect(mockBulkRank).not.toHaveBeenCalled();
  });

  it("400s an out-of-vocabulary mutation source", async () => {
    const response = await postRequest(validBody({ source: "drag" }));

    expect(response.status).toBe(400);
    expect(mockBulkRank).not.toHaveBeenCalled();
  });

  it("404s a project outside the caller's organization without ranking anything", async () => {
    mockFindProject.mockResolvedValue(null);

    const response = await postRequest(validBody());

    expect(response.status).toBe(404);
    expect(mockBulkRank).not.toHaveBeenCalled();
  });
});
