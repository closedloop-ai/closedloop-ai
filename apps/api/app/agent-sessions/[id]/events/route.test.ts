import { encodeSessionEventCursor } from "@repo/api/src/types/agent-session-event-cursor";
import type { AgentSessionEventsPage } from "@repo/api/src/types/agent-session-events-page";
import { PG_TIMESTAMP_MIN_MS } from "@repo/api/src/types/pg-timestamp-floor";
import { NUL_CHARACTER } from "@repo/api/src/types/postgres-text";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context.params),
}));

vi.mock("../../service", () => ({
  agentSessionsService: {
    findSessionEventsPage: vi.fn(),
  },
}));

import { agentSessionsService } from "../../service";
import { SESSION_EVENTS_CURSOR_REJECTION } from "../../validators";
import { GET } from "./route";

const SESSION_ID = "01997d8e-3b2e-7c6a-8f1a-1b2c3d4e5f60";
const NOT_A_UUID = "not-a-uuid";

const CURSOR_POSITION = {
  createdAt: "2026-06-10T10:00:00.000Z",
  externalEventId: "evt-1000",
};

function pageOf(
  events: AgentSessionEventsPage["events"]
): AgentSessionEventsPage {
  return { events };
}

function get(query = "") {
  return getAs(SESSION_ID, query);
}

function getAs(id: string, query = "") {
  return GET(
    createMockRequest({
      url: `http://localhost:3002/agent-sessions/${id}/events${query}`,
    }),
    createMockRouteContext({ id })
  );
}

describe("GET /agent-sessions/[id]/events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(agentSessionsService.findSessionEventsPage).mockResolvedValue(
      pageOf([])
    );
  });

  it("passes the org, the decoded cursor, and the raw limit to the service", async () => {
    const cursor = encodeSessionEventCursor(CURSOR_POSITION);
    const response = await get(`?cursor=${cursor}&limit=50`);

    expect(response.status).toBe(200);
    expect(agentSessionsService.findSessionEventsPage).toHaveBeenCalledWith({
      id: SESSION_ID,
      organizationId: "test-org-id",
      cursor: CURSOR_POSITION,
      limit: 50,
    });
  });

  it("omits cursor and limit when the caller sends neither", async () => {
    await get();

    const [input] =
      vi.mocked(agentSessionsService.findSessionEventsPage).mock.calls[0] ?? [];
    expect(input).toEqual({ id: SESSION_ID, organizationId: "test-org-id" });
    expect(Object.hasOwn(input ?? {}, "cursor")).toBe(false);
    expect(Object.hasOwn(input ?? {}, "limit")).toBe(false);
  });

  it("answers 400 for a cursor this endpoint could not have minted", async () => {
    const response = await get("?cursor=not-a-cursor");

    expect(response.status).toBe(400);
    expect(agentSessionsService.findSessionEventsPage).not.toHaveBeenCalled();
  });

  it("answers 400 for a well-formed cursor whose timestamp does not parse", async () => {
    const cursor = encodeSessionEventCursor({
      createdAt: "garbage",
      externalEventId: "e1",
    });
    const response = await get(`?cursor=${cursor}`);

    expect(response.status).toBe(400);
    expect(agentSessionsService.findSessionEventsPage).not.toHaveBeenCalled();
  });

  it("answers 400 for a well-formed cursor whose timestamp is below the Postgres floor", async () => {
    // `new Date` accepts it; the `timestamp(3)` predicate would not, and the
    // documented 400 path would have answered 500 from inside Prisma.
    const cursor = encodeSessionEventCursor({
      createdAt: new Date(PG_TIMESTAMP_MIN_MS - 1).toISOString(),
      externalEventId: "e1",
    });
    const response = await get(`?cursor=${cursor}`);

    expect(response.status).toBe(400);
    expect(agentSessionsService.findSessionEventsPage).not.toHaveBeenCalled();
  });

  it("accepts a cursor sitting exactly on the Postgres floor", async () => {
    const position = {
      createdAt: new Date(PG_TIMESTAMP_MIN_MS).toISOString(),
      externalEventId: "e1",
    };
    await get(`?cursor=${encodeSessionEventCursor(position)}`);

    expect(agentSessionsService.findSessionEventsPage).toHaveBeenCalledWith({
      id: SESSION_ID,
      organizationId: "test-org-id",
      cursor: position,
    });
  });

  it("answers 400 for a query parameter it does not know, rather than a default page", async () => {
    const response = await get("?limti=500");

    expect(response.status).toBe(400);
    expect(agentSessionsService.findSessionEventsPage).not.toHaveBeenCalled();
  });

  it("answers 400 for a present-but-blank limit", async () => {
    const response = await get("?limit=");

    expect(response.status).toBe(400);
    expect(agentSessionsService.findSessionEventsPage).not.toHaveBeenCalled();
  });

  it("hands an out-of-range limit to the service raw, where it is clamped", async () => {
    await get("?limit=999999");

    expect(agentSessionsService.findSessionEventsPage).toHaveBeenCalledWith({
      id: SESSION_ID,
      organizationId: "test-org-id",
      limit: 999_999,
    });
  });

  it("answers 404 when the service cannot see the session", async () => {
    vi.mocked(agentSessionsService.findSessionEventsPage).mockResolvedValue(
      null
    );

    const response = await get();

    expect(response.status).toBe(404);
  });

  it("serves the page as the success envelope's data", async () => {
    const page: AgentSessionEventsPage = {
      events: [
        {
          externalEventId: "evt-1",
          agentExternalId: null,
          eventType: "tool",
          toolName: "Read",
          createdAt: "2026-06-10T10:00:00.000Z",
        },
      ],
      nextCursor: "opaque",
    };
    vi.mocked(agentSessionsService.findSessionEventsPage).mockResolvedValue(
      page
    );

    const response = await get();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: page,
    });
  });

  // ISS-10436: `SessionDetail.artifactId` is `@db.Uuid`, so a non-UUID id used
  // to reach Prisma, raise P2023, and fall out of `withAuth` as a 500. The id
  // is checked before the query so the coarser resource check wins.
  it("answers 404 for an id that is not a UUID, before the service is asked", async () => {
    const response = await getAs(NOT_A_UUID);

    expect(response.status).toBe(404);
    expect(agentSessionsService.findSessionEventsPage).not.toHaveBeenCalled();
  });

  it("answers 404, not 400, when both the id and the query are malformed", async () => {
    const response = await getAs(NOT_A_UUID, "?limti=500");

    expect(response.status).toBe(404);
    expect(agentSessionsService.findSessionEventsPage).not.toHaveBeenCalled();
  });

  it("answers 400 for a cursor whose externalEventId carries a NUL", async () => {
    const cursor = encodeSessionEventCursor({
      createdAt: CURSOR_POSITION.createdAt,
      externalEventId: `a${NUL_CHARACTER}b`,
    });
    const response = await get(`?cursor=${cursor}`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining(SESSION_EVENTS_CURSOR_REJECTION),
    });
    expect(agentSessionsService.findSessionEventsPage).not.toHaveBeenCalled();
  });

  it("still accepts a NUL in createdAt, which the service converts with new Date before Postgres sees it", async () => {
    const position = {
      createdAt: `${CURSOR_POSITION.createdAt}${NUL_CHARACTER}`,
      externalEventId: "e1",
    };
    const response = await get(`?cursor=${encodeSessionEventCursor(position)}`);

    expect(response.status).toBe(200);
    expect(agentSessionsService.findSessionEventsPage).toHaveBeenCalledWith({
      id: SESSION_ID,
      organizationId: "test-org-id",
      cursor: position,
    });
  });
});
