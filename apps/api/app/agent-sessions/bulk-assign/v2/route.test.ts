import {
  BATCH_ITEM_APPLIED_STATUS,
  BatchItemFailureCode,
  BatchItemFailureStatus,
  type BatchItemResult,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { Status } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_SESSION_BULK_ASSIGN_MAX_IDS,
  AgentSessionBulkAssignField,
} from "../../write-contract";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "33333333-3333-4333-8333-333333333331";
// Lock (id) order is A before B; the order cases send B first.
const SESSION_A = "55555555-5555-4555-8555-555555555551";
const SESSION_B = "55555555-5555-4555-8555-555555555552";

const mocks = vi.hoisted(() => ({
  user: {
    id: "22222222-2222-4222-8222-222222222221",
    organizationId: "11111111-1111-4111-8111-111111111111",
  },
  requiredScopes: [] as unknown[],
  bulkAssign: vi.fn(),
}));

// ISS-10993: the route opens ONE transaction for the mutation and its activity
// receipt. Every store this suite reaches is mocked, so the real `withDb` would
// only add a Postgres the unit lane does not have.
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: (await import("@/__tests__/utils/mock-with-db")).mockWithDb(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (
    handler: (...args: unknown[]) => Promise<Response>,
    options?: { requiredScopes?: unknown }
  ) => {
    mocks.requiredScopes.push(options?.requiredScopes);
    return (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler({ user: mocks.user }, request, context.params);
  },
}));

vi.mock("../../session-bulk-assign-item-service", () => ({
  sessionBulkAssignItemService: { bulkAssign: mocks.bulkAssign },
}));

import { POST } from "./route";

const routeContext = { params: Promise.resolve({}) };

function request(body: unknown) {
  return new NextRequest(
    "https://api.example.test/agent-sessions/bulk-assign/v2",
    { method: "POST", body: JSON.stringify(body) }
  );
}

function assignProject(sessionIds: string[]) {
  return request({
    sessionIds,
    field: AgentSessionBulkAssignField.Project,
    value: PROJECT_ID,
  });
}

function serviceReturns(...results: BatchItemResult[]) {
  mocks.bulkAssign.mockResolvedValue({
    ok: true,
    value: {
      results: new Map(results.map((result) => [result.id, result] as const)),
      changes: [],
    },
  });
}

function uuidAt(index: number) {
  return `66666666-6666-4666-8666-${index.toString().padStart(12, "0")}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceReturns(batchItemApplied(SESSION_A), batchItemApplied(SESSION_B));
});

describe("POST /agent-sessions/bulk-assign/v2 (ISS-9464)", () => {
  it("is registered demanding the write scope, like v1", () => {
    expect(mocks.requiredScopes).toHaveLength(1);
    expect(mocks.requiredScopes).toEqual([["write"]]);
  });

  it("rejects an empty, over-cap or malformed set with a 400 envelope before the service", async () => {
    const overCap = Array.from(
      { length: AGENT_SESSION_BULK_ASSIGN_MAX_IDS + 1 },
      (_unused, index) => uuidAt(index)
    );

    for (const sessionIds of [[], overCap, [SESSION_A, "not-a-uuid"]]) {
      const response = await POST(assignProject(sessionIds), routeContext);
      expect(response.status).toBe(400);
    }
    expect(mocks.bulkAssign).not.toHaveBeenCalled();
  });

  it("maps an unknown target project or owner to a 400 envelope", async () => {
    mocks.bulkAssign.mockResolvedValue({
      ok: false,
      error: Status.BadRequest,
    });

    const response = await POST(assignProject([SESSION_A]), routeContext);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ success: false });
  });

  it("answers 200 with one applied result per id, handing the service the caller's set", async () => {
    const response = await POST(
      assignProject([SESSION_A, SESSION_B]),
      routeContext
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        results: [
          { id: SESSION_A, status: BATCH_ITEM_APPLIED_STATUS },
          { id: SESSION_B, status: BATCH_ITEM_APPLIED_STATUS },
        ],
        // ISS-9465 ruling 4: the id grouping this commit's receipts, additive
        // and read-through — a client that does not know it ignores it.
        transactionId: expect.any(String),
      },
    });
    expect(mocks.bulkAssign).toHaveBeenCalledWith(
      {
        organizationId: ORG_ID,
        sessionIds: [SESSION_A, SESSION_B],
        field: AgentSessionBulkAssignField.Project,
        value: PROJECT_ID,
      },
      // ISS-10993: the receipt writer the route hands the WRITE, so the write
      // owns the transaction both commit on. Its behaviour is pinned DB-backed
      // in `__tests__/integration/bulk-assign-refusal-rollback.integration.test.ts`.
      expect.any(Function)
    );
  });

  it("reports a refused set in the caller's first-appearance order, not id order, once per id", async () => {
    serviceReturns(
      batchItemFailed(SESSION_A, BatchItemFailureCode.ArtifactsNotFound),
      batchItemFailed(SESSION_B, BatchItemFailureCode.BatchRefused)
    );

    const response = await POST(
      assignProject([SESSION_B, SESSION_A, SESSION_B]),
      routeContext
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.data.results.map((result: BatchItemResult) => [
        result.id,
        result.status,
      ])
    ).toEqual([
      [SESSION_B, BatchItemFailureStatus.FailedDependency],
      [SESSION_A, BatchItemFailureStatus.NotFound],
    ]);
  });

  it("reports an id the service returned no result for as outcome_unknown, keeping the ids that have one", async () => {
    serviceReturns(batchItemApplied(SESSION_A));

    const response = await POST(
      assignProject([SESSION_A, SESSION_B]),
      routeContext
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.results).toEqual([
      batchItemApplied(SESSION_A),
      batchItemFailed(SESSION_B, BatchItemFailureCode.OutcomeUnknown),
    ]);
  });
});
