/**
 * ISS-8880 §1 — a malformed `[id]` path segment on the distribution detail
 * routes must be answered at the boundary, not handed to a `@db.Uuid` lookup.
 *
 * Only `distributions/[id]/route.ts` is in scope here. `distributions/service.ts`
 * belongs to ISS-8810 and is deliberately untouched.
 *
 * Each case asserts BOTH the 404 and that the service was never reached — the
 * services below are wired to SUCCEED, so a missing guard produces a 200 and
 * these assertions cannot pass vacuously.
 */
import { DistributionMode } from "@repo/api/src/types/distribution";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authContext: {
    clerkOrgId: "clerk-org-1",
    clerkUserId: "clerk-user-1",
    user: { id: "user-1", organizationId: "org-1" },
  },
  getDetailForOrg: vi.fn(),
  update: vi.fn(),
  withdraw: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(mocks.authContext, request, context?.params),
}));

vi.mock("@/app/distributions/service", () => ({
  distributionsService: {
    getDetailForOrg: mocks.getDetailForOrg,
    update: mocks.update,
    withdraw: mocks.withdraw,
  },
}));

import { DELETE, GET, PATCH } from "../[id]/route";

const MALFORMED_IDS = [
  "not-a-uuid",
  "PRD-42",
  "12345",
  "0199a000-0000-7000-8000",
  "0199a000-0000-7000-8000-0000000000zz",
];

/** `Distribution.id` is `@default(uuid(7))`. */
const VALID_UUID_V7 = "0199a000-0000-7000-8000-00000000000b";

const DISTRIBUTION = { id: VALID_UUID_V7 };

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function request(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/distributions/x", {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
  });
}

function call(handler: unknown, id: string, body?: unknown): Promise<Response> {
  return (handler as (req: NextRequest, ctx: unknown) => Promise<Response>)(
    request(body),
    routeContext(id)
  );
}

/** Every call any of the three handlers made, flattened for one assertion. */
function serviceCalls(): unknown[] {
  return [mocks.getDetailForOrg, mocks.update, mocks.withdraw].flatMap(
    (serviceCall) => serviceCall.mock.calls
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDetailForOrg.mockResolvedValue(DISTRIBUTION);
  mocks.update.mockResolvedValue({ ok: true, value: DISTRIBUTION });
  mocks.withdraw.mockResolvedValue({ ok: true, value: DISTRIBUTION });
});

describe("GET /distributions/[id] — malformed id", () => {
  it.each(MALFORMED_IDS)("answers 404 for %j without a query", async (id) => {
    const response = await call(GET, id);

    expect(response.status).toBe(404);
    expect(serviceCalls()).toHaveLength(0);
  });

  it("still reaches the service for a uuid v7", async () => {
    const response = await call(GET, VALID_UUID_V7);

    expect(response.status).toBe(200);
    expect(mocks.getDetailForOrg).toHaveBeenCalledWith("org-1", VALID_UUID_V7);
  });
});

describe("PATCH /distributions/[id] — malformed id", () => {
  it.each(MALFORMED_IDS)("answers 404 for %j without a query", async (id) => {
    const response = await call(PATCH, id, {
      mode: DistributionMode.AutoInstall,
    });

    expect(response.status).toBe(404);
    expect(serviceCalls()).toHaveLength(0);
  });

  it("still reaches the service for a uuid v7", async () => {
    await call(PATCH, VALID_UUID_V7, { mode: DistributionMode.AutoInstall });

    expect(mocks.update).toHaveBeenCalledWith(
      "org-1",
      VALID_UUID_V7,
      "clerk-org-1",
      "clerk-user-1",
      { mode: DistributionMode.AutoInstall },
      undefined
    );
  });
});

describe("DELETE /distributions/[id] — malformed id", () => {
  it.each(MALFORMED_IDS)("answers 404 for %j without a query", async (id) => {
    const response = await call(DELETE, id);

    expect(response.status).toBe(404);
    expect(serviceCalls()).toHaveLength(0);
  });

  it("still reaches the service for a uuid v7", async () => {
    await call(DELETE, VALID_UUID_V7);

    expect(mocks.withdraw).toHaveBeenCalledWith(
      "org-1",
      VALID_UUID_V7,
      "user-1",
      "clerk-org-1",
      "clerk-user-1",
      undefined
    );
  });
});

// ---------------------------------------------------------------------------
// Authorization ordering — what the guard changes for a NON-admin
// ---------------------------------------------------------------------------

/**
 * These handlers have no `requireOrgAdmin`; the role verdict is resolved INSIDE
 * `distributionsService`, which returns 403 (or 503 when the role cannot be
 * read) before any DB work. The id guard now runs first, so a non-admin sending
 * a MALFORMED id gets 404 where they used to get 403/503.
 *
 * That is correct — a malformed id names no resource, so 404 leaks nothing an
 * unauthenticated caller could not already infer, and it is strictly less
 * informative than the 403 it replaces. It is pinned here because it is a
 * status change on a real request shape, and the plan originally claimed no
 * authorization ordering moved anywhere.
 *
 * A non-admin sending a WELL-FORMED id still gets the service's verdict, which
 * is the case that proves the guard did not swallow authorization generally.
 */
describe("distributions — guard vs the in-service role verdict", () => {
  it("answers 404, not 403, for a non-admin with a malformed id", async () => {
    mocks.withdraw.mockResolvedValue({ ok: false, error: 403 });

    const response = await call(DELETE, "not-a-uuid");

    expect(response.status).toBe(404);
    expect(mocks.withdraw).not.toHaveBeenCalled();
  });

  it("still lets the service answer for a non-admin with a valid id", async () => {
    mocks.withdraw.mockResolvedValue({ ok: false, error: 403 });

    const response = await call(DELETE, VALID_UUID_V7);

    expect(response.status).toBe(403);
    expect(mocks.withdraw).toHaveBeenCalledTimes(1);
  });

  it("still lets the service answer 503 when the role cannot be resolved", async () => {
    mocks.update.mockResolvedValue({ ok: false, error: 503 });

    const response = await call(PATCH, VALID_UUID_V7, {
      mode: DistributionMode.AutoInstall,
    });

    expect(response.status).toBe(503);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });
});
