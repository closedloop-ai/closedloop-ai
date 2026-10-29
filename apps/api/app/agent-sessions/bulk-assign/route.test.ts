import { Status } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_SESSION_BULK_ASSIGN_MAX_IDS,
  AgentSessionBulkAssignField,
} from "../write-contract";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "33333333-3333-4333-8333-333333333331";
const SESSION_A = "55555555-5555-4555-8555-555555555551";
const SESSION_B = "55555555-5555-4555-8555-555555555552";
const SESSION_C = "55555555-5555-4555-8555-555555555553";

const mocks = vi.hoisted(() => ({
  user: {
    id: "22222222-2222-4222-8222-222222222221",
    organizationId: "11111111-1111-4111-8111-111111111111",
  },
  bulkAssignSessions: vi.fn(),
}));

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
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler({ user: mocks.user }, request, context.params),
}));

vi.mock("../session-write-service", () => ({
  sessionWriteService: { bulkAssignSessions: mocks.bulkAssignSessions },
}));

import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest(
    "https://api.example.test/agent-sessions/bulk-assign",
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  );
}

const routeContext = { params: Promise.resolve({}) };

function uuidAt(index: number) {
  return `66666666-6666-4666-8666-${index.toString().padStart(12, "0")}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bulkAssignSessions.mockResolvedValue({
    ok: true,
    value: {
      response: {
        field: AgentSessionBulkAssignField.Project,
        assignedCount: 2,
        sessions: [],
      },
      changes: [],
    },
  });
});

describe("POST /agent-sessions/bulk-assign (ISS-8649)", () => {
  it("hands the service the ids under test, not a fixed set", async () => {
    await POST(
      request({
        sessionIds: [SESSION_A, SESSION_B],
        field: AgentSessionBulkAssignField.Project,
        value: PROJECT_ID,
      }),
      routeContext
    );
    expect(mocks.bulkAssignSessions).toHaveBeenLastCalledWith(
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

    await POST(
      request({
        sessionIds: [SESSION_C],
        field: AgentSessionBulkAssignField.Owner,
        value: null,
      }),
      routeContext
    );
    expect(mocks.bulkAssignSessions).toHaveBeenLastCalledWith(
      {
        organizationId: ORG_ID,
        sessionIds: [SESSION_C],
        field: AgentSessionBulkAssignField.Owner,
        value: null,
      },
      expect.any(Function)
    );
  });

  it("rejects an EMPTY set and an OVER-CAP set, and accepts one at the cap", async () => {
    const empty = await POST(
      request({
        sessionIds: [],
        field: AgentSessionBulkAssignField.Project,
        value: PROJECT_ID,
      }),
      routeContext
    );
    expect(empty.status).toBe(400);

    const overCap = await POST(
      request({
        sessionIds: Array.from(
          { length: AGENT_SESSION_BULK_ASSIGN_MAX_IDS + 1 },
          (_unused, index) => uuidAt(index)
        ),
        field: AgentSessionBulkAssignField.Project,
        value: PROJECT_ID,
      }),
      routeContext
    );
    expect(overCap.status).toBe(400);
    expect(mocks.bulkAssignSessions).not.toHaveBeenCalled();

    const atCap = await POST(
      request({
        sessionIds: Array.from(
          { length: AGENT_SESSION_BULK_ASSIGN_MAX_IDS },
          (_unused, index) => uuidAt(index)
        ),
        field: AgentSessionBulkAssignField.Project,
        value: PROJECT_ID,
      }),
      routeContext
    );
    expect(atCap.status).toBe(200);
  });

  it("rejects a malformed id or an unknown field before the service is reached", async () => {
    const badId = await POST(
      request({
        sessionIds: [SESSION_A, "not-a-uuid"],
        field: AgentSessionBulkAssignField.Project,
        value: PROJECT_ID,
      }),
      routeContext
    );
    expect(badId.status).toBe(400);

    const badField = await POST(
      request({
        sessionIds: [SESSION_A],
        field: "status",
        value: PROJECT_ID,
      }),
      routeContext
    );
    expect(badField.status).toBe(400);
    expect(mocks.bulkAssignSessions).not.toHaveBeenCalled();
  });

  it("maps the service's whole-set refusal to 404, not a 200 with a partial count", async () => {
    mocks.bulkAssignSessions.mockResolvedValue({
      ok: false,
      error: Status.NotFound,
    });

    const response = await POST(
      request({
        sessionIds: [SESSION_A, SESSION_B],
        field: AgentSessionBulkAssignField.Project,
        value: PROJECT_ID,
      }),
      routeContext
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ success: false });
  });

  it("maps a cross-org assignment target to 400", async () => {
    mocks.bulkAssignSessions.mockResolvedValue({
      ok: false,
      error: Status.BadRequest,
    });

    const response = await POST(
      request({
        sessionIds: [SESSION_A],
        field: AgentSessionBulkAssignField.Project,
        value: PROJECT_ID,
      }),
      routeContext
    );

    expect(response.status).toBe(400);
  });
});
