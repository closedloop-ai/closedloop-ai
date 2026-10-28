/**
 * ISS-10737 — the HTTP layer of `GET /agent-sessions/[id]/invocation-tree`.
 *
 * The service suite (`service/session-invocation-tree-read.test.ts`) owns the
 * predicate, the org scope and the page bound. What is covered HERE is what only
 * the route decides: the id shape, the org the service is handed, the 404 a
 * cross-org or unknown session gets, and the STATUS a malformed cursor gets.
 *
 * That last one is why this file exists. The cursor used to be decoded inside
 * the service, which threw a plain `Error`; the route's catch answered the
 * default 500, so `?cursor=garbage` was recorded as a server failure and reached
 * the error monitors. It is refused at the request boundary now, exactly as the
 * `events` sibling refuses its own.
 */

import { encodeAgentComponentInvocationSessionTreeCursor } from "@repo/api/src/types/agent-component-invocation-session-tree";
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

const DB_SENTINEL = { db: true };

vi.mock("@repo/database", () => ({
  withDb: (run: (db: unknown) => unknown) => run(DB_SENTINEL),
}));

vi.mock("../../service/session-invocation-tree-read", () => ({
  loadAgentSessionInvocationTree: vi.fn(),
}));

import { loadAgentSessionInvocationTree } from "../../service/session-invocation-tree-read";
import { GET } from "./route";

const SESSION_ID = "01997d8e-3b2e-7c6a-8f1a-1b2c3d4e5f60";
const NOT_A_UUID = "not-a-uuid";

// `id` is a uuid because the column is `@db.Uuid`: a producer cannot mint any
// other shape, and the route now refuses one (ISS-11195).
const CURSOR_POSITION = {
  sequence: 12,
  externalInvocationId: "inv-12",
  id: "0190a000-0000-7000-8000-000000000012",
};

// ISS-11195: the three tokens from the ticket, each shape-valid for the codec
// and each outside one column's domain. Literals, not re-encoded, because they
// are the exact inputs that answered 500.
const OUT_OF_DOMAIN_CURSORS = [
  { column: "id (uuid)", token: "NR9leHQfbm90LWEtdXVpZA" },
  {
    column: "sequence (int4)",
    token:
      "MTA5OTUxMTYyNzc3Nh9leHQfMDE5MGEwMDAtMDAwMC03MDAwLTgwMDAtMDAwMDAwMDAwMDAw",
  },
  {
    column: "external_invocation_id (text, NUL)",
    token: "NR9hAGIfMDE5MGEwMDAtMDAwMC03MDAwLTgwMDAtMDAwMDAwMDAwMDAw",
  },
] as const;

function getAs(id: string, query = "") {
  return GET(
    createMockRequest({
      url: `http://localhost:3002/agent-sessions/${id}/invocation-tree${query}`,
    }),
    createMockRouteContext({ id })
  );
}

function get(query = "") {
  return getAs(SESSION_ID, query);
}

describe("GET /agent-sessions/[id]/invocation-tree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(loadAgentSessionInvocationTree).mockResolvedValue({
      items: [],
      total: 0,
    });
  });

  it("scopes the read to the caller's organization and omits an absent cursor", async () => {
    const response = await get();

    expect(response.status).toBe(200);
    const [, input] =
      vi.mocked(loadAgentSessionInvocationTree).mock.calls[0] ?? [];
    expect(input).toEqual({
      sessionId: SESSION_ID,
      organizationId: "test-org-id",
    });
    // OMITTED, never a blank string: `?cursor=` is itself a malformed token.
    expect(Object.hasOwn(input ?? {}, "cursor")).toBe(false);
  });

  it("passes a producer-minted cursor through", async () => {
    const cursor =
      encodeAgentComponentInvocationSessionTreeCursor(CURSOR_POSITION);

    const response = await get(`?cursor=${cursor}`);

    expect(response.status).toBe(200);
    const [, input] =
      vi.mocked(loadAgentSessionInvocationTree).mock.calls[0] ?? [];
    expect(input?.cursor).toBe(cursor);
  });

  it("answers 400 for a cursor this endpoint could not have minted", async () => {
    const response = await get("?cursor=not-a-cursor");

    expect(response.status).toBe(400);
    // Refused before the read, so a client mistake never reaches the database
    // and never lands on the error monitors as a 500.
    expect(loadAgentSessionInvocationTree).not.toHaveBeenCalled();
  });

  it.each(OUT_OF_DOMAIN_CURSORS)(
    "answers 400 for a decodable cursor outside the $column domain",
    async ({ token }) => {
      const response = await get(`?cursor=${token}`);

      expect(response.status).toBe(400);
      expect(loadAgentSessionInvocationTree).not.toHaveBeenCalled();
    }
  );

  it("passes a minted cursor at the int4 ceiling through", async () => {
    const cursor = encodeAgentComponentInvocationSessionTreeCursor({
      ...CURSOR_POSITION,
      sequence: 2_147_483_647,
    });

    const response = await get(`?cursor=${cursor}`);

    expect(response.status).toBe(200);
    const [, input] =
      vi.mocked(loadAgentSessionInvocationTree).mock.calls[0] ?? [];
    expect(input?.cursor).toBe(cursor);
  });

  it("answers 400 for a present-but-blank cursor", async () => {
    const response = await get("?cursor=");

    expect(response.status).toBe(400);
    expect(loadAgentSessionInvocationTree).not.toHaveBeenCalled();
  });

  it("answers 400 for an unknown query parameter", async () => {
    const response = await get("?limti=10");

    expect(response.status).toBe(400);
    expect(loadAgentSessionInvocationTree).not.toHaveBeenCalled();
  });

  it("answers 404 for an id that is not a uuid, before any read", async () => {
    const response = await getAs(NOT_A_UUID);

    expect(response.status).toBe(404);
    expect(loadAgentSessionInvocationTree).not.toHaveBeenCalled();
  });

  it("answers 404 when the service reports no session in this organization", async () => {
    vi.mocked(loadAgentSessionInvocationTree).mockResolvedValue(undefined);

    const response = await get();

    // A cross-org session is indistinguishable from an unknown one, and neither
    // gets an empty tree — an empty tree is a claim about the session.
    expect(response.status).toBe(404);
  });

  it("answers 200 with a real, empty page for a known session that ran nothing", async () => {
    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toStrictEqual({ items: [], total: 0 });
  });
});
