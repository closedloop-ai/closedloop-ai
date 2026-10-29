/**
 * Route-handler tests for the reference search + batch resolution endpoints
 * (ISS-7212).
 *
 * The service suite proves the query behaviour; what only a route test can prove
 * is that the zod validators are actually WIRED — a validator that no handler
 * calls type-checks, lints, and ships. Each rejection case therefore also asserts
 * the service was never reached, because a 400 produced downstream of the query
 * would mean the boundary did not hold.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authContext: {
    clerkOrgId: "clerk-org-1",
    clerkUserId: "clerk-user-1",
    user: { id: "user-1", organizationId: "org-1" },
  },
  authOptions: [] as unknown[],
  service: {
    searchTargets: vi.fn(),
    resolveTargets: vi.fn(),
  },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (
    handler: (...args: unknown[]) => Promise<Response>,
    options?: unknown
  ) => {
    mocks.authOptions.push(options);
    return (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(mocks.authContext, request, context?.params);
  },
}));

vi.mock("@/app/custom-fields/reference-search-service", async () => {
  const actual = await import("@/app/custom-fields/reference-search-service");
  return {
    referenceSearchService: mocks.service,
    DisallowedReferenceSourceError: actual.DisallowedReferenceSourceError,
    ReferenceFieldNotFoundError: actual.ReferenceFieldNotFoundError,
  };
});

import {
  REFERENCE_RESOLVE_MAX_IDS,
  REFERENCE_SEARCH_MAX_LIMIT,
  ReferenceTargetSource,
} from "@repo/api/src/types/custom-field";
import { GET } from "../[id]/reference-targets/route";
import {
  DisallowedReferenceSourceError,
  ReferenceFieldNotFoundError,
} from "../reference-search-service";
import { POST } from "../references/resolve/route";
import { MAX_REFERENCE_TARGET_SOURCES } from "../validators";

const FIELD_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "org-1";

const EMPTY_SEARCH = { targets: [], hasMore: false };
const EMPTY_RESOLVE = { targets: [], unresolvable: [] };

function callSearchAs(fieldId: string, query: string): Promise<Response> {
  const request = new NextRequest(
    `https://api.test/custom-fields/${fieldId}/reference-targets${query}`
  );
  return GET(request, {
    params: Promise.resolve({ id: fieldId }),
  }) as unknown as Promise<Response>;
}

function callSearch(query: string): Promise<Response> {
  return callSearchAs(FIELD_ID, query);
}

function callResolve(body: unknown): Promise<Response> {
  const request = new NextRequest(
    "https://api.test/custom-fields/references/resolve",
    { method: "POST", body: JSON.stringify(body) }
  );
  return POST(request, {
    params: Promise.resolve({}),
  }) as unknown as Promise<Response>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.service.searchTargets.mockResolvedValue(EMPTY_SEARCH);
  mocks.service.resolveTargets.mockResolvedValue(EMPTY_RESOLVE);
});

describe("GET /custom-fields/:id/reference-targets input validation", () => {
  it("rejects a limit above the server cap", async () => {
    const response = await callSearch(
      `?limit=${REFERENCE_SEARCH_MAX_LIMIT + 1}`
    );

    expect(response.status).toBe(400);
    expect(mocks.service.searchTargets).not.toHaveBeenCalled();
  });

  it("accepts a limit at the cap", async () => {
    // Sibling of the case above: without it, a validator that rejected EVERY
    // limit would pass the rejection test.
    const response = await callSearch(`?limit=${REFERENCE_SEARCH_MAX_LIMIT}`);

    expect(response.status).toBe(200);
    expect(mocks.service.searchTargets).toHaveBeenCalledTimes(1);
  });

  it("rejects a limit of zero", async () => {
    const response = await callSearch("?limit=0");

    expect(response.status).toBe(400);
    expect(mocks.service.searchTargets).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric limit rather than passing NaN through", async () => {
    const response = await callSearch("?limit=abc");

    expect(response.status).toBe(400);
    expect(mocks.service.searchTargets).not.toHaveBeenCalled();
  });

  it("rejects a source outside the enum", async () => {
    const response = await callSearch("?sources=NOT_A_SOURCE");

    expect(response.status).toBe(400);
    expect(mocks.service.searchTargets).not.toHaveBeenCalled();
  });

  it("rejects more repeated sources than there are legal sources", async () => {
    // `referenceSourceScope` builds one query `OR` branch per entry, so an
    // uncapped repeated param compiles arbitrarily many redundant disjuncts
    // for a set with four members.
    const repeated = Array.from(
      { length: MAX_REFERENCE_TARGET_SOURCES + 1 },
      () => `sources=${ReferenceTargetSource.Issue}`
    ).join("&");
    const response = await callSearch(`?${repeated}`);

    expect(response.status).toBe(400);
    expect(mocks.service.searchTargets).not.toHaveBeenCalled();
  });

  it("accepts every legal source at once", async () => {
    // The sibling that stops the cap from being set too tight: all four are a
    // legitimate request, and a cap below the enum size would reject it while
    // the case above stayed green.
    const all = Object.values(ReferenceTargetSource);
    const response = await callSearch(
      `?${all.map((source) => `sources=${source}`).join("&")}`
    );

    expect(response.status).toBe(200);
    expect(mocks.service.searchTargets.mock.calls[0][0].sources).toEqual(all);
  });

  // Synchronous: this compares two module constants, no request involved.
  it("caps sources at the number of legal values, so OR branches cannot exceed it", () => {
    // The cap and the enum are the same fact. Adding a fifth source without
    // raising the cap would silently make a legitimate five-source narrowing
    // unrequestable; raising the cap past the enum reopens the explosion.
    expect(MAX_REFERENCE_TARGET_SOURCES).toBe(
      Object.values(ReferenceTargetSource).length
    );
  });

  it("rejects a malformed excludeEntityId", async () => {
    const response = await callSearch("?excludeEntityId=not-a-uuid");

    expect(response.status).toBe(400);
    expect(mocks.service.searchTargets).not.toHaveBeenCalled();
  });

  it("rejects a misspelled limit instead of searching under the default", async () => {
    // Without `.strict()` Zod strips `limt`, the handler runs with the DEFAULT
    // page size, and the caller gets a 200 describing a search it never asked
    // for. The `not.toHaveBeenCalled()` is what makes that visible: a
    // non-strict schema turns this case green on the status assertion alone.
    const response = await callSearch("?limt=5");

    expect(response.status).toBe(400);
    expect(mocks.service.searchTargets).not.toHaveBeenCalled();
  });

  it("rejects a misspelled sources filter instead of widening the search", async () => {
    const response = await callSearch(`?source=${ReferenceTargetSource.Issue}`);

    expect(response.status).toBe(400);
    expect(mocks.service.searchTargets).not.toHaveBeenCalled();
  });

  it("rejects a malformed field id with 400 rather than a 500 from the driver", async () => {
    // The mock stands in for Postgres: an invalid uuid literal makes the driver
    // RAISE instead of returning no row, and the route's catch-all maps an
    // unrecognised error to 500 — so without the path parse a caller typo
    // reads as a server fault. `not.toHaveBeenCalled()` is what proves the
    // 400 came from the boundary and not from the rejection below.
    mocks.service.searchTargets.mockRejectedValue(
      new Error('invalid input syntax for type uuid: "not-a-uuid"')
    );

    const response = await callSearchAs("not-a-uuid", "");

    expect(response.status).toBe(400);
    expect(mocks.service.searchTargets).not.toHaveBeenCalled();
  });

  it("accepts the uuid v7 shape the id column actually stores", async () => {
    // `custom_fields.id` is `@default(uuid(7))`. A validator narrowed to v4
    // would 400 every real field while the rejection case above stayed green.
    const response = await callSearchAs(
      "019c435c-9d43-747e-8d26-7b377f2c45c5",
      ""
    );

    expect(response.status).toBe(200);
    expect(mocks.service.searchTargets).toHaveBeenCalledTimes(1);
  });

  it("still accepts every parameter the route implements", async () => {
    // The guard on the guard: a `.strict()` schema taught the wrong field set
    // would reject legitimate callers, and both cases above would stay green.
    const response = await callSearch(
      `?query=grid&sources=${ReferenceTargetSource.Issue}&limit=5&excludeEntityId=${TARGET_ID}`
    );

    expect(response.status).toBe(200);
    expect(mocks.service.searchTargets).toHaveBeenCalledTimes(1);
  });
});

describe("GET /custom-fields/:id/reference-targets wiring", () => {
  it("forwards the parsed query to the service with the authenticated org", async () => {
    await callSearch(
      `?query=grid&sources=${ReferenceTargetSource.Issue}&limit=5&excludeEntityId=${TARGET_ID}`
    );

    expect(mocks.service.searchTargets).toHaveBeenCalledWith({
      fieldId: FIELD_ID,
      organizationId: ORG_ID,
      query: "grid",
      sources: [ReferenceTargetSource.Issue],
      limit: 5,
      excludeEntityId: TARGET_ID,
    });
  });

  it("normalizes a repeated sources param into a list", async () => {
    await callSearch(
      `?sources=${ReferenceTargetSource.Issue}&sources=${ReferenceTargetSource.Branch}`
    );

    expect(mocks.service.searchTargets.mock.calls[0][0].sources).toEqual([
      ReferenceTargetSource.Issue,
      ReferenceTargetSource.Branch,
    ]);
  });

  it("returns the service payload unchanged", async () => {
    const payload = {
      targets: [
        {
          id: TARGET_ID,
          slug: "ISS-1",
          name: "An issue",
          artifactType: "DOCUMENT",
          subtype: "FEATURE",
          status: "TODO",
        },
      ],
      hasMore: true,
    };
    mocks.service.searchTargets.mockResolvedValue(payload);

    const response = await callSearch("?query=iss");

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(payload);
  });

  it("maps an unknown field to 404", async () => {
    mocks.service.searchTargets.mockRejectedValue(
      new ReferenceFieldNotFoundError(FIELD_ID)
    );

    expect((await callSearch("")).status).toBe(404);
  });

  it("maps a disallowed source to 400, not 500", async () => {
    mocks.service.searchTargets.mockRejectedValue(
      new DisallowedReferenceSourceError("nope")
    );

    // The rejection AC is only honoured end to end if this lands as a client
    // error; a 500 would read as a server fault for a caller mistake.
    expect((await callSearch("")).status).toBe(400);
  });
});

describe("POST /custom-fields/references/resolve", () => {
  it("rejects a target id that is not an artifact id", async () => {
    const response = await callResolve({ targetIds: ["not-a-uuid"] });

    expect(response.status).toBe(400);
    expect(mocks.service.resolveTargets).not.toHaveBeenCalled();
  });

  it("rejects a batch larger than the cap", async () => {
    const response = await callResolve({
      targetIds: Array.from(
        { length: REFERENCE_RESOLVE_MAX_IDS + 1 },
        (_, i) => `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`
      ),
    });

    expect(response.status).toBe(400);
    expect(mocks.service.resolveTargets).not.toHaveBeenCalled();
  });

  it("rejects a missing targetIds field", async () => {
    const response = await callResolve({});

    expect(response.status).toBe(400);
    expect(mocks.service.resolveTargets).not.toHaveBeenCalled();
  });

  it("accepts an empty batch as a no-op", async () => {
    const response = await callResolve({ targetIds: [] });

    expect(response.status).toBe(200);
    expect(mocks.service.resolveTargets).toHaveBeenCalledWith([], ORG_ID);
  });

  it("forwards the ids with the authenticated org", async () => {
    await callResolve({ targetIds: [TARGET_ID] });

    expect(mocks.service.resolveTargets).toHaveBeenCalledWith(
      [TARGET_ID],
      ORG_ID
    );
  });

  it("returns both buckets to the caller", async () => {
    const payload = { targets: [], unresolvable: [TARGET_ID] };
    mocks.service.resolveTargets.mockResolvedValue(payload);

    const response = await callResolve({ targetIds: [TARGET_ID] });

    expect((await response.json()).data).toEqual(payload);
  });

  // Synchronous on purpose: `withAnyAuth` is called at module import, so the
  // recorded options are already there before any request is made.
  it("declares the read scope so a read-only API key is not locked out", () => {
    // `withAnyAuth` infers `write` from a POST verb. This endpoint is a read
    // behind a POST only because the id list does not fit a query string, so the
    // explicit scope is the thing keeping read-only keys working.
    expect(mocks.authOptions).toContainEqual({ requiredScopes: ["read"] });
  });
});
