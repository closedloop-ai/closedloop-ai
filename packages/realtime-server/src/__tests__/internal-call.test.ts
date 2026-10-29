import assert from "node:assert/strict";
import { log } from "@repo/observability/log";
import { getVercelOidcToken } from "@vercel/oidc";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import {
  createInternalServiceCaller,
  InternalCallFailure,
  type InternalServiceConfig,
} from "../internal-call";

vi.mock("@vercel/oidc", () => ({ getVercelOidcToken: vi.fn() }));

const CONFIG: InternalServiceConfig = {
  url: "http://service.internal:3050",
  oidcAudience: "internal-call-fixture",
};
const EVENTS = {
  failed: { event: "fixture.call_failed", message: "fixture call failed" },
  notConfigured: {
    event: "fixture.not_configured",
    message: "fixture not configured",
  },
};
const PATH = "/internal/fixture";

function answering(response: Response) {
  return vi.fn((_url: URL | RequestInfo, _init?: RequestInit) =>
    Promise.resolve(response)
  );
}

function call(response: Response) {
  return createInternalServiceCaller({
    config: CONFIG,
    fetch: answering(response),
    events: EVENTS,
  }).call({ method: "GET", path: PATH, timeoutMs: 1000 });
}

beforeEach(() => {
  vi.spyOn(log, "error").mockImplementation(() => undefined);
  vi.mocked(getVercelOidcToken).mockReset().mockResolvedValue("token");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the response body", () => {
  it("is the parsed JSON when the response says it is JSON", async () => {
    const result = await call(
      new Response('{"names":[]}', {
        status: 201,
        headers: { "content-type": "application/json; charset=utf-8" },
      })
    );

    assert.deepEqual(result, { ok: true, status: 201, body: { names: [] } });
  });

  it("is undefined for a body that is not JSON", async () => {
    const result = await call(
      new Response('{"names":[]}', {
        status: 200,
        headers: { "content-type": "text/plain" },
      })
    );

    assert.deepEqual(result, { ok: true, status: 200, body: undefined });
  });

  it("is undefined for malformed JSON", async () => {
    const result = await call(
      new Response("{not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    assert.deepEqual(result, { ok: true, status: 200, body: undefined });
  });

  it("rides along on a refusal, which is any non-2xx by default", async () => {
    const result = await call(
      new Response('{"code":"not_found"}', {
        status: 404,
        headers: { "content-type": "application/json" },
      })
    );

    assert.deepEqual(result, {
      ok: false,
      failure: InternalCallFailure.Rejected,
      status: 404,
      body: { code: "not_found" },
    });
  });
});
