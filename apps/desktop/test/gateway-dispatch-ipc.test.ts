import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import {
  createGatewayDispatchHandler,
  GATEWAY_DISPATCH_ALLOWED_PATHS,
  GATEWAY_DISPATCH_MAX_BODY_BYTES,
} from "../src/main/gateway-dispatch-ipc.js";

const MAIN_TOKEN = "main-gateway-token-abc123";
const PORT = 19_432;

type Overrides = {
  isTrustedSender?: (sender: unknown) => boolean;
  getActivePort?: () => number;
  getGatewayAuthToken?: () => string;
  fetchImpl?: typeof fetch;
  log?: {
    info: (t: string, m: string) => void;
    warn: (t: string, m: string) => void;
  };
};

function okFetch() {
  return mock.fn(
    async () =>
      new Response(JSON.stringify({ files: ["a.ts"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  );
}

function makeDeps(overrides: Overrides = {}) {
  return {
    isTrustedSender: () => true,
    getActivePort: () => PORT,
    getGatewayAuthToken: () => MAIN_TOKEN,
    fetchImpl: okFetch() as unknown as typeof fetch,
    ...overrides,
  };
}

const trustedEvent = { sender: { id: "trusted" } };

function noneBody() {
  return { kind: "none" } as const;
}

function filesPayload(query = "?owner=o&repo=r&number=1") {
  return {
    method: "GET",
    path: `/api/gateway/git/pr/files${query}`,
    headers: {},
    body: noneBody(),
  };
}

describe("gateway-dispatch-ipc handler", () => {
  test("allowlist contains exactly the two v1 PR overlay routes", () => {
    assert.deepEqual([...GATEWAY_DISPATCH_ALLOWED_PATHS].sort(), [
      "/api/gateway/git/pr/files",
      "/api/gateway/git/pr/reviews",
    ]);
  });

  test("CRITICAL-1: untrusted sender → 403, no network", async () => {
    const deps = makeDeps({ isTrustedSender: () => false });
    const handler = createGatewayDispatchHandler(deps);
    const result = await handler({ sender: { id: "evil" } }, filesPayload());
    assert.equal(result.status, 403);
    assert.equal(
      (deps.fetchImpl as ReturnType<typeof okFetch>).mock.calls.length,
      0
    );
  });

  test("CRITICAL-2: path traversal is rejected (normalized off the allowlist)", async () => {
    const deps = makeDeps();
    const handler = createGatewayDispatchHandler(deps);
    const result = await handler(trustedEvent, {
      method: "GET",
      path: "/api/gateway/../../etc/passwd",
      headers: {},
      body: noneBody(),
    });
    assert.equal(result.status, 403);
    assert.equal(
      (deps.fetchImpl as ReturnType<typeof okFetch>).mock.calls.length,
      0
    );
  });

  test("CRITICAL-2: non-allowlisted path via authority trick is rejected", async () => {
    const deps = makeDeps();
    const handler = createGatewayDispatchHandler(deps);
    const result = await handler(trustedEvent, {
      method: "GET",
      path: "//evil.example/api/gateway/git/exec",
      headers: {},
      body: noneBody(),
    });
    assert.equal(result.status, 403);
    assert.equal(
      (deps.fetchImpl as ReturnType<typeof okFetch>).mock.calls.length,
      0
    );
  });

  test("SSRF: an authority on an allowlisted path still loops back to 127.0.0.1", async () => {
    const deps = makeDeps();
    const handler = createGatewayDispatchHandler(deps);
    const result = await handler(trustedEvent, {
      method: "GET",
      path: "//evil.example/api/gateway/git/pr/files?owner=o&repo=r&number=1",
      headers: {},
      body: noneBody(),
    });
    assert.equal(result.status, 200);
    const call = (deps.fetchImpl as ReturnType<typeof okFetch>).mock.calls[0];
    const target = String(call.arguments[0]);
    assert.ok(
      target.startsWith(`http://127.0.0.1:${PORT}/api/gateway/git/pr/files`),
      `expected loopback target, got ${target}`
    );
    assert.ok(!target.includes("evil.example"));
  });

  test("CRITICAL-2/HIGH-3: renderer auth + force-approval headers are never forwarded; main token is attached", async () => {
    const deps = makeDeps();
    const handler = createGatewayDispatchHandler(deps);
    await handler(trustedEvent, {
      method: "GET",
      path: "/api/gateway/git/pr/files?owner=o&repo=r&number=1",
      headers: {
        authorization: "Bearer sk_live_evil",
        cookie: "session=abc",
        "x-desktop-gateway-token": "renderer-spoofed",
        "x-desktop-force-approval": "1",
      },
      body: noneBody(),
    });
    const call = (deps.fetchImpl as ReturnType<typeof okFetch>).mock.calls[0];
    const headers = (call.arguments[1] as RequestInit).headers as Headers;
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("x-desktop-force-approval"), null);
    assert.equal(headers.get("x-desktop-gateway-token"), MAIN_TOKEN);
  });

  test("HIGH-3: a CRLF-bearing renderer header is dropped, not forwarded", async () => {
    const deps = makeDeps();
    const handler = createGatewayDispatchHandler(deps);
    const result = await handler(trustedEvent, {
      method: "GET",
      path: "/api/gateway/git/pr/files?owner=o&repo=r&number=1",
      headers: { "x-evil": "a\r\nx-injected: 1" },
      body: noneBody(),
    });
    assert.equal(result.status, 200);
    const call = (deps.fetchImpl as ReturnType<typeof okFetch>).mock.calls[0];
    const headers = (call.arguments[1] as RequestInit).headers as Headers;
    assert.equal(headers.get("x-evil"), null);
    assert.equal(headers.get("x-injected"), null);
  });

  test("MEDIUM-1: oversized body → 413 before any network", async () => {
    const deps = makeDeps();
    const handler = createGatewayDispatchHandler(deps);
    const oversized = "A".repeat(GATEWAY_DISPATCH_MAX_BODY_BYTES + 10);
    const result = await handler(trustedEvent, {
      method: "GET",
      path: "/api/gateway/git/pr/files",
      headers: {},
      body: { kind: "text", value: oversized, contentType: null },
    });
    assert.equal(result.status, 413);
    assert.equal(
      (deps.fetchImpl as ReturnType<typeof okFetch>).mock.calls.length,
      0
    );
  });

  test("MEDIUM-2: set-cookie from the gateway is stripped from the envelope", async () => {
    const deps = makeDeps({
      fetchImpl: mock.fn(
        async () =>
          new Response(JSON.stringify({ files: [] }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "set-cookie": "sid=secret; HttpOnly",
              "x-desktop-internal": "leak",
            },
          })
      ) as unknown as typeof fetch,
    });
    const handler = createGatewayDispatchHandler(deps);
    const result = await handler(trustedEvent, filesPayload());
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.headers ?? {}), ["content-type"]);
  });

  test("invalid method on an allowlisted path → 405", async () => {
    const deps = makeDeps();
    const handler = createGatewayDispatchHandler(deps);
    const result = await handler(trustedEvent, {
      method: "POST",
      path: "/api/gateway/git/pr/files",
      headers: {},
      body: noneBody(),
    });
    assert.equal(result.status, 405);
    assert.equal(
      (deps.fetchImpl as ReturnType<typeof okFetch>).mock.calls.length,
      0
    );
  });

  test("malformed payload → 400", async () => {
    const deps = makeDeps();
    const handler = createGatewayDispatchHandler(deps);
    const result = await handler(trustedEvent, { not: "a request" });
    assert.equal(result.status, 400);
    assert.equal(
      (deps.fetchImpl as ReturnType<typeof okFetch>).mock.calls.length,
      0
    );
  });

  test("HIGH-1/LOW-1: logs carry only method + pathname + status — never query or body", async () => {
    const logged: string[] = [];
    const deps = makeDeps({
      log: {
        info: (_tag, message) => logged.push(message),
        warn: (_tag, message) => logged.push(message),
      },
    });
    const handler = createGatewayDispatchHandler(deps);
    await handler(
      trustedEvent,
      filesPayload("?owner=secretOrg&repo=secretRepo&number=42")
    );
    assert.equal(logged.length, 1);
    const line = logged[0];
    assert.ok(line.includes("/api/gateway/git/pr/files"));
    assert.ok(line.includes("200"));
    assert.ok(!line.includes("secretOrg"));
    assert.ok(!line.includes("secretRepo"));
    assert.ok(!line.includes("?"));
  });

  test("happy path: valid /pr/files returns the gateway envelope", async () => {
    const deps = makeDeps();
    const handler = createGatewayDispatchHandler(deps);
    const result = await handler(trustedEvent, filesPayload());
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(String(result.body)), { files: ["a.ts"] });
    const call = (deps.fetchImpl as ReturnType<typeof okFetch>).mock.calls[0];
    assert.equal(
      String(call.arguments[0]),
      `http://127.0.0.1:${PORT}/api/gateway/git/pr/files?owner=o&repo=r&number=1`
    );
  });
});
