import {
  GRID_PREFERENCE_CONTRACT_VERSION,
  GRID_PREFERENCE_VALUE_MAX_BYTES,
  type GridPreference,
  GridPreferenceErrorCode,
  GridPreferenceGridKey,
  GridPreferenceKind,
  GridPreferenceReadStatus,
  GridPreferenceResetStatus,
  type GridPreferenceRevisionConflict,
  GridPreferenceScopeKey,
  GridPreferenceWriteStatus,
} from "@repo/api/src/types/grid-preferences";
import { NUL_CHARACTER } from "@repo/api/src/types/postgres-text";
import { Result, Status } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authContext: {
    user: { id: "user-1", organizationId: "org-1" },
  },
  service: {
    listPreferences: vi.fn(),
    getPreference: vi.fn(),
    upsertPreference: vi.fn(),
    resetPreference: vi.fn(),
  },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(mocks.authContext, request, context?.params),
}));

vi.mock("../grid-preference-service", () => ({
  gridPreferenceService: mocks.service,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

import { DELETE, GET, POST } from "../route";
import {
  GRID_PREFERENCE_VALUE_KEY_COLLISION_MESSAGE,
  GRID_PREFERENCE_VALUE_TOO_DEEP_TO_SANITIZE_MESSAGE,
} from "../validators";

const ROUTE_PARAMS = { params: Promise.resolve({}) };

const SELECTOR = {
  gridKey: GridPreferenceGridKey.Sessions,
  preferenceKind: GridPreferenceKind.ViewState,
  scopeKey: GridPreferenceScopeKey.Default,
};

const PREFERENCE: GridPreference = {
  ...SELECTOR,
  value: { columns: ["name"], viewStateVersions: { columns: 1 } },
  revision: 3,
  createdAt: "2026-09-11T00:00:00.000Z",
  updatedAt: "2026-09-11T00:01:00.000Z",
  contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
};

function request(
  url: string,
  init?: ConstructorParameters<typeof NextRequest>[1]
): NextRequest {
  return new NextRequest(url, init);
}

function postRequest(body: unknown): NextRequest {
  return request("http://localhost/settings/grid-preferences", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function rawPostRequest(body: string): NextRequest {
  return request("http://localhost/settings/grid-preferences", {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

function resetUrl(query: string): string {
  return `http://localhost/settings/grid-preferences${query}`;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /settings/grid-preferences", () => {
  it("lists the caller's preferences without accepting request-supplied authority", async () => {
    mocks.service.listPreferences.mockResolvedValue([PREFERENCE]);

    const response = await GET(
      request("http://localhost/settings/grid-preferences"),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(200);
    expect(mocks.service.listPreferences).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
    });
    const json = await response.json();
    expect(json.data).toEqual({
      status: GridPreferenceReadStatus.List,
      preferences: [PREFERENCE],
      contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
    });
  });

  it("returns found or missing for a complete selector", async () => {
    mocks.service.getPreference.mockResolvedValueOnce(PREFERENCE);
    const found = await GET(
      request(
        resetUrl("?gridKey=sessions&preferenceKind=view-state&scopeKey=default")
      ),
      ROUTE_PARAMS
    );

    expect(found.status).toBe(200);
    expect(mocks.service.getPreference).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      ...SELECTOR,
    });
    expect((await found.json()).data.status).toBe(
      GridPreferenceReadStatus.Found
    );

    mocks.service.getPreference.mockResolvedValueOnce(null);
    const missing = await GET(
      request(
        resetUrl("?gridKey=sessions&preferenceKind=view-state&scopeKey=default")
      ),
      ROUTE_PARAMS
    );

    expect((await missing.json()).data).toEqual({
      status: GridPreferenceReadStatus.Missing,
      selector: SELECTOR,
      contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
    });
  });

  it("rejects partial selectors before service access", async () => {
    const response = await GET(
      request(resetUrl("?gridKey=sessions")),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(400);
    expect(mocks.service.listPreferences).not.toHaveBeenCalled();
    expect(mocks.service.getPreference).not.toHaveBeenCalled();
  });
});

describe("POST /settings/grid-preferences", () => {
  it("upserts a JSON object value for the authenticated caller", async () => {
    mocks.service.upsertPreference.mockResolvedValue(Result.ok(PREFERENCE));

    const response = await POST(
      postRequest({
        ...SELECTOR,
        value: { columns: ["name"], futureAxis: { kept: true } },
        expectedRevision: 2,
      }),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(200);
    expect(mocks.service.upsertPreference).toHaveBeenCalledWith(
      {
        organizationId: "org-1",
        userId: "user-1",
        ...SELECTOR,
        value: { columns: ["name"], futureAxis: { kept: true } },
        expectedRevision: 2,
      },
      undefined
    );
    expect((await response.json()).data).toEqual({
      status: GridPreferenceWriteStatus.Stored,
      preference: PREFERENCE,
      contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
    });
  });

  it("rejects authority fields and over-cap values without writing", async () => {
    const spoofed = await POST(
      postRequest({
        ...SELECTOR,
        organizationId: "org-spoofed",
        userId: "user-spoofed",
        value: {},
      }),
      ROUTE_PARAMS
    );
    expect(spoofed.status).toBe(400);

    const overCap = await POST(
      postRequest({
        ...SELECTOR,
        value: { oversized: "x".repeat(GRID_PREFERENCE_VALUE_MAX_BYTES) },
      }),
      ROUTE_PARAMS
    );
    expect(overCap.status).toBe(400);
    expect(mocks.service.upsertPreference).not.toHaveBeenCalled();
  });

  it("lets escaped JSON reach the canonical value-size validator", async () => {
    mocks.service.upsertPreference.mockResolvedValue(Result.ok(PREFERENCE));
    const escapedName = "\\u0061".repeat(12_000);

    const response = await POST(
      rawPostRequest(
        `{"gridKey":"${GridPreferenceGridKey.Sessions}","preferenceKind":"${GridPreferenceKind.ViewState}","scopeKey":"${GridPreferenceScopeKey.Default}","value":{"name":"${escapedName}"}}`
      ),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(200);
    expect(mocks.service.upsertPreference).toHaveBeenCalledWith(
      {
        organizationId: "org-1",
        userId: "user-1",
        ...SELECTOR,
        value: { name: "a".repeat(12_000) },
      },
      undefined
    );
  });

  // ISS-10436: `JSON.stringify` spells a NUL as `\u0000`, which `jsonb`
  // refuses (22P05), so the write used to answer 500. Strings are sanitized the
  // way the agent-session lanes sanitize theirs; the route echoes the service's
  // stored row, never the request body.
  it("stores a value with the NUL stripped from a nested string", async () => {
    mocks.service.upsertPreference.mockResolvedValue(Result.ok(PREFERENCE));

    const response = await POST(
      postRequest({
        ...SELECTOR,
        value: {
          columns: [`na${NUL_CHARACTER}me`],
          nested: { note: `x${NUL_CHARACTER}` },
        },
      }),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(200);
    expect(mocks.service.upsertPreference).toHaveBeenCalledWith(
      {
        organizationId: "org-1",
        userId: "user-1",
        ...SELECTOR,
        value: { columns: ["name"], nested: { note: "x" } },
      },
      undefined
    );
  });

  it("stores a value with a lone surrogate replaced", async () => {
    mocks.service.upsertPreference.mockResolvedValue(Result.ok(PREFERENCE));

    const response = await POST(
      rawPostRequest(
        `{"gridKey":"${GridPreferenceGridKey.Sessions}","preferenceKind":"${GridPreferenceKind.ViewState}","scopeKey":"${GridPreferenceScopeKey.Default}","value":{"name":"a\\ud800b"}}`
      ),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(200);
    expect(mocks.service.upsertPreference).toHaveBeenCalledWith(
      {
        organizationId: "org-1",
        userId: "user-1",
        ...SELECTOR,
        value: { name: "a\uFFFDb" },
      },
      undefined
    );
  });

  it("rejects two keys that collapse into one after sanitizing, without writing", async () => {
    const response = await POST(
      postRequest({
        ...SELECTOR,
        value: { ab: 1, [`a${NUL_CHARACTER}b`]: 2 },
      }),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: `value: ${GRID_PREFERENCE_VALUE_KEY_COLLISION_MESSAGE}`,
    });
    expect(mocks.service.upsertPreference).not.toHaveBeenCalled();
  });

  it("passes a clean value deeper than the sanitizer's cap through unchanged", async () => {
    mocks.service.upsertPreference.mockResolvedValue(Result.ok(PREFERENCE));
    // Every JSON leaf kind, so the pass-through walk is exercised on each.
    let deep: Record<string, unknown> = {
      leaf: true,
      none: null,
      count: 1,
      name: "ok",
      tags: ["a", { b: "c" }],
    };
    for (let depth = 0; depth < 260; depth += 1) {
      deep = { next: deep };
    }

    const sent = structuredClone(deep);

    const response = await POST(
      postRequest({ ...SELECTOR, value: deep }),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(200);
    expect(mocks.service.upsertPreference).toHaveBeenCalledWith(
      {
        organizationId: "org-1",
        userId: "user-1",
        ...SELECTOR,
        value: sent,
      },
      undefined
    );
  });

  it("rejects a value deeper than the sanitizer's cap when it also carries a NUL, without writing", async () => {
    let deep: Record<string, unknown> = { leaf: `x${NUL_CHARACTER}` };
    for (let depth = 0; depth < 260; depth += 1) {
      deep = { next: deep };
    }

    const response = await POST(
      postRequest({ ...SELECTOR, value: deep }),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: `value: ${GRID_PREFERENCE_VALUE_TOO_DEEP_TO_SANITIZE_MESSAGE}`,
    });
    expect(mocks.service.upsertPreference).not.toHaveBeenCalled();
  });

  it("rejects a value deeper than the sanitizer's cap when a key carries a lone surrogate, without writing", async () => {
    let deep: Record<string, unknown> = { "k\uD800": true };
    for (let depth = 0; depth < 260; depth += 1) {
      deep = { next: deep };
    }

    const response = await POST(
      postRequest({ ...SELECTOR, value: deep }),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(400);
    expect(mocks.service.upsertPreference).not.toHaveBeenCalled();
  });

  it("maps stale revision refusals to a typed 409 conflict", async () => {
    const conflict: GridPreferenceRevisionConflict = {
      code: GridPreferenceErrorCode.StaleRevision,
      selector: SELECTOR,
      expectedRevision: 2,
      currentRevision: 3,
      current: PREFERENCE,
      contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
    };
    mocks.service.upsertPreference.mockResolvedValue(
      Result.err({ status: Status.Conflict, conflict })
    );

    const response = await POST(
      postRequest({ ...SELECTOR, value: {}, expectedRevision: 2 }),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.data).toEqual(conflict);
  });
});

describe("DELETE /settings/grid-preferences", () => {
  it("resets one selected preference using a bodyless query contract", async () => {
    mocks.service.resetPreference.mockResolvedValue(
      Result.ok({
        status: GridPreferenceResetStatus.Deleted,
        selector: SELECTOR,
        previousRevision: 3,
        contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
      })
    );

    const response = await DELETE(
      request(
        resetUrl(
          "?gridKey=sessions&preferenceKind=view-state&scopeKey=default&expectedRevision=3"
        ),
        { method: "DELETE" }
      ),
      ROUTE_PARAMS
    );

    expect(response.status).toBe(200);
    expect(mocks.service.resetPreference).toHaveBeenCalledWith(
      {
        organizationId: "org-1",
        userId: "user-1",
        ...SELECTOR,
        expectedRevision: 3,
      },
      undefined
    );
    expect((await response.json()).data.status).toBe(
      GridPreferenceResetStatus.Deleted
    );
  });

  it("rejects bodies and unsupported selector scopes before resetting", async () => {
    const bodyResponse = await DELETE(
      request("http://localhost/settings/grid-preferences", {
        method: "DELETE",
        body: "{}",
      }),
      ROUTE_PARAMS
    );
    expect(bodyResponse.status).toBe(400);

    const scopeResponse = await DELETE(
      request(
        resetUrl("?gridKey=agents&preferenceKind=view-state&scopeKey=approved"),
        { method: "DELETE" }
      ),
      ROUTE_PARAMS
    );
    expect(scopeResponse.status).toBe(400);
    expect(mocks.service.resetPreference).not.toHaveBeenCalled();
  });
});
