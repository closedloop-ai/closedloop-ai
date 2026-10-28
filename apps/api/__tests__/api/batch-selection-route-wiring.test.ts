import { BATCH_MUTATION_ENTITY_LIMIT } from "@repo/api/src/types/batch-mutation-limits";
import { BatchQuerySelectionErrorCode } from "@repo/api/src/types/batch-query-selection";
import { DocumentStatus } from "@repo/api/src/types/document";
import { Result } from "@repo/api/src/types/result";
import { ArtifactType } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { documentStatusMutationService } from "@/app/documents/document-status-mutation-service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

/**
 * ISS-9579 — the production wiring: a batch route driven by a query selection
 * hands its service the ids the SERVER resolved.
 *
 * Without this the resolver could be correct and unreachable. The corpus is
 * seeded so the resolved set is one the request could not have named: the body
 * carries no artifact ids at all.
 */

const ORGANIZATION_ID = "test-org-id";
const ASSIGNEE_ID = "11111111-1111-4111-8111-111111111111";

type SeededArtifact = {
  id: string;
  organizationId: string;
  type: string;
  assigneeId: string | null;
};

let seeded: SeededArtifact[];

function matchesWhere(
  artifact: SeededArtifact,
  where: Record<string, unknown>
): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "AND") {
      return (condition as Record<string, unknown>[]).every((clause) =>
        matchesWhere(artifact, clause)
      );
    }
    if (key === "id") {
      const clause = condition as { notIn?: string[] };
      return !clause.notIn?.includes(artifact.id);
    }
    return artifact[key as keyof SeededArtifact] === condition;
  });
}

const mockWithDb = vi.hoisted(() => vi.fn());
const mockWithDbTx = vi.hoisted(() => vi.fn());
const mockQueryRaw = vi.hoisted(() => vi.fn());

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withDb: Object.assign(mockWithDb, { tx: mockWithDbTx }),
  };
});

/**
 * Which rows the selection lock still finds.
 *
 * `null` means every seeded row survived to the lock, which is the ordinary
 * case. A shorter list models a concurrent DELETE committing between the
 * predicate read and the lock — the window ISS-9579's reviewers named.
 */
let lockedIds: string[] | null = null;

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params),
}));
// PARTIAL, not a bare automock: the module also exports
// `validateUndoTransactionReference`, which both routes call before writing
// (ISS-10458). Automocking it to `undefined` 500s every case here. Kept REAL —
// no request in this suite names an `undoOfTransactionId`, so it short-circuits
// without a query, which is also the proof that the field is optional.
vi.mock(
  "@/app/documents/document-status-mutation-service",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    documentStatusMutationService: {
      batchUpdateStatus: vi.fn(),
    },
  })
);
vi.mock("@/app/documents/batch-status-side-effects", () => ({
  captureBatchStatusActivity: vi.fn(),
  emitBatchStatusSideEffects: vi.fn(),
}));

import { POST } from "@/app/documents/batch-update-status/route";

/** Deterministic UUIDs, because `excludedIds` is `z.array(z.uuid())`. */
function resolvedId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function seedArtifacts(count: number): SeededArtifact[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: resolvedId(index),
    organizationId: ORGANIZATION_ID,
    type: ArtifactType.DOCUMENT,
    assigneeId: ASSIGNEE_ID,
  }));
}

function selectionRequest(excludedIds?: string[]) {
  return createMockRequest({
    url: "http://localhost:3002/api/documents/batch-update-status",
    method: "POST",
    body: {
      selection: {
        query: { assigneeId: ASSIGNEE_ID },
        ...(excludedIds ? { excludedIds } : {}),
      },
      status: DocumentStatus.InReview,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  seeded = [];
  lockedIds = null;
  // The lock answers with the rows that still exist, which is what
  // `FOR NO KEY UPDATE` does after it takes each lock.
  mockQueryRaw.mockImplementation(() =>
    Promise.resolve(
      (lockedIds ?? seeded.map((artifact) => artifact.id)).map((id) => ({ id }))
    )
  );
  mockWithDbTx.mockImplementation(
    async (callback: (tx: { $queryRaw: typeof mockQueryRaw }) => unknown) =>
      await callback({ $queryRaw: mockQueryRaw })
  );
  mockWithDb.mockImplementation(
    async (
      callback: (db: {
        artifact: {
          findMany: (args: {
            where: Record<string, unknown>;
            take?: number;
          }) => Promise<{ id: string }[]>;
          count: (args: { where: Record<string, unknown> }) => Promise<number>;
        };
      }) => Promise<unknown>
    ) =>
      await callback({
        artifact: {
          findMany: ({ where, take }) =>
            Promise.resolve(
              seeded
                .filter((artifact) => matchesWhere(artifact, where))
                .slice(0, take)
                .map((artifact) => ({ id: artifact.id }))
            ),
          count: ({ where }) =>
            Promise.resolve(
              seeded.filter((artifact) => matchesWhere(artifact, where)).length
            ),
        },
      })
  );
  vi.mocked(documentStatusMutationService.batchUpdateStatus).mockResolvedValue(
    Result.ok({ updatedIds: [], changedIds: [], transitions: [] })
  );
});

describe("POST /documents/batch-update-status driven by a query selection", () => {
  it("writes the ids the server resolved, which the request never named", async () => {
    seeded = seedArtifacts(4);

    const response = await POST(
      selectionRequest([resolvedId(3)]),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(
      documentStatusMutationService.batchUpdateStatus
    ).toHaveBeenCalledWith(
      [resolvedId(0), resolvedId(1), resolvedId(2)],
      DocumentStatus.InReview,
      ORGANIZATION_ID,
      undefined
    );
  });

  it("holds the resolved rows on the write's own transaction, before the write", async () => {
    seeded = seedArtifacts(2);

    await POST(selectionRequest(), createMockRouteContext({}));

    // ONE transaction, and the lock ran on the client it handed out — the
    // resolved set cannot change between the lock and the service call.
    expect(mockWithDbTx).toHaveBeenCalledTimes(1);
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expect(mockQueryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(documentStatusMutationService.batchUpdateStatus).mock
        .invocationCallOrder[0]
    );
  });

  it("drops a row a concurrent delete removed rather than refusing the batch over it", async () => {
    seeded = seedArtifacts(3);
    // `resolvedId(1)` matched the predicate and was gone by the time the lock
    // reached it. This route refuses the WHOLE batch over a missing id, so
    // forwarding it would 400 a select-all over a row the caller never named.
    lockedIds = [resolvedId(0), resolvedId(2)];

    const response = await POST(selectionRequest(), createMockRouteContext({}));

    expect(response.status).toBe(200);
    expect(
      documentStatusMutationService.batchUpdateStatus
    ).toHaveBeenCalledWith(
      [resolvedId(0), resolvedId(2)],
      DocumentStatus.InReview,
      ORGANIZATION_ID,
      undefined
    );
  });

  it("refuses when every resolved row is gone by the time the lock runs", async () => {
    seeded = seedArtifacts(2);
    lockedIds = [];

    const response = await POST(selectionRequest(), createMockRouteContext({}));

    expect(response.status).toBe(400);
    expect(
      documentStatusMutationService.batchUpdateStatus
    ).not.toHaveBeenCalled();
    const payload = (await response.json()) as { code?: string };
    expect(payload.code).toBe(BatchQuerySelectionErrorCode.SelectionEmpty);
  });

  it("refuses above the ceiling and never reaches the write", async () => {
    seeded = seedArtifacts(BATCH_MUTATION_ENTITY_LIMIT + 1);

    const response = await POST(selectionRequest(), createMockRouteContext({}));

    expect(response.status).toBe(400);
    expect(
      documentStatusMutationService.batchUpdateStatus
    ).not.toHaveBeenCalled();
    const payload = (await response.json()) as {
      code?: string;
      details?: { limit: number; resolvedTotal: number };
    };
    expect(payload.code).toBe(BatchQuerySelectionErrorCode.SelectionTooLarge);
    expect(payload.details).toEqual({ limit: 500, resolvedTotal: 501 });
  });

  it("still accepts an explicit id list, so an older client is unaffected", async () => {
    const documentIds = [crypto.randomUUID(), crypto.randomUUID()];
    const request = createMockRequest({
      url: "http://localhost:3002/api/documents/batch-update-status",
      method: "POST",
      body: { documentIds, status: DocumentStatus.InReview },
    });

    const response = await POST(request, createMockRouteContext({}));

    expect(response.status).toBe(200);
    expect(
      documentStatusMutationService.batchUpdateStatus
    ).toHaveBeenCalledWith(
      documentIds,
      DocumentStatus.InReview,
      ORGANIZATION_ID,
      undefined
    );
    expect(mockWithDb).not.toHaveBeenCalled();
    // And it takes NO selection lock: a missing id the CALLER enumerated is a
    // diagnostic the services owe that caller, so this arm must not narrow it
    // away (ISS-9579 review).
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });
});
