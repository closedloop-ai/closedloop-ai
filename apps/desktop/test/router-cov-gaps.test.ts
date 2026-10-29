/**
 * ISS-11282: branch coverage for `src/server/router.ts` (gateway auth, SECURITY
 * CRITICAL). Every case pins what the router does today; none loosens a gate.
 * Covered: the prod-origins-only pass-through for an allowed origin, the
 * declared-vs-streamed 413, an empty array header, the unconfigured symphony dir default, and the
 * unhandled-failure writer's fallbacks (missing method/url, non-Error throw,
 * an unrelated error code). Abort classification lives in
 * router-cov-abort-classification.test.ts.
 */
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { json } from "../src/server/operations/response-utils.js";
import {
  type GatewayApprovalRequest,
  GatewayRouter,
  UNHANDLED_REQUEST_ERROR_CODE,
} from "../src/server/router.js";
import { REQUEST_BODY_TOO_LARGE_CODE } from "../src/server/router-body-limits.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";
import { dispatchMockRequest } from "./gateway-server-test-doubles.js";

const WEB_APP_ORIGIN = "https://app.closedloop.ai";
const PROBE_PATH = "/api/gateway/iss11282-router-probe";
const THROW_PATH = "/api/gateway/iss11282-router-throw";
const GENERIC_JSON_LIMIT_BYTES = 256 * 1024;
// Typed unknown so the case exercises the non-Error detail arm.
const NON_ERROR_FAILURE: unknown = "origin settings unreadable";

afterEach(() => {
  vi.unstubAllGlobals();
  gatewayLog.clear();
});

type RouterOptions = ConstructorParameters<typeof GatewayRouter>[0];

function createRouter(
  overrides: Partial<RouterOptions> = {},
  dispatcher = new OperationDispatcher()
): GatewayRouter {
  return new GatewayRouter(
    {
      webAppOrigin: WEB_APP_ORIGIN,
      getAllowedDirectories: () => [os.tmpdir()],
      machineName: "iss11282-router",
      version: "0.1.0-test",
      capabilities: EMPTY_CAPABILITIES,
      getActivePort: () => 0,
      getGatewayId: () => "gw-iss11282",
      ...overrides,
    },
    dispatcher
  );
}

function probeDispatcher(): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  dispatcher.register("GET", PROBE_PATH, (context) => {
    json(context, 200, { reached: true });
  });
  return dispatcher;
}

function throwingDispatcher(thrown: unknown): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  dispatcher.register("GET", THROW_PATH, () => {
    throw thrown;
  });
  return dispatcher;
}

function routerMessages(): string[] {
  return gatewayLog
    .getEntries()
    .filter((entry) => entry.tag === "gateway-router")
    .map((entry) => entry.message);
}

describe("prod-origins-only auth gate", () => {
  it("lets an allowed origin through to the handler when no gateway token is configured", async () => {
    const router = createRouter({ prodOriginsOnly: true }, probeDispatcher());

    const response = await dispatchMockRequest({
      router,
      method: "GET",
      path: PROBE_PATH,
      headers: { origin: WEB_APP_ORIGIN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ reached: true });
  });
});

describe("header normalization", () => {
  it("passes a null source to approval when x-desktop-source is an empty array", async () => {
    const seen: GatewayApprovalRequest[] = [];
    const router = createRouter(
      {
        evaluateApproval: (request) => {
          seen.push(request);
          return { allow: true };
        },
      },
      probeDispatcher()
    );

    const response = await dispatchMockRequest({
      router,
      method: "GET",
      path: PROBE_PATH,
      headers: { "x-desktop-source": [] },
    });

    expect(response.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.source).toBeNull();
  });
});

describe("symphony dir default", () => {
  it("answers 503 on a symphony route when no getSymphonyDir option is wired", async () => {
    const router = createRouter();

    const response = await dispatchMockRequest({
      router,
      method: "GET",
      path: "/api/gateway/repos",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "Server not configured — complete onboarding",
    });
  });
});

describe("request body limit", () => {
  it("returns 413 and logs the declared size when the streamed body outgrows a small Content-Length", async () => {
    const oversized = "x".repeat(GENERIC_JSON_LIMIT_BYTES + 1);

    const response = await dispatchMockRequest({
      router: createRouter({}, probeDispatcher()),
      method: "POST",
      path: PROBE_PATH,
      headers: { "content-length": "10" },
      chunks: [oversized],
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      code: REQUEST_BODY_TOO_LARGE_CODE,
      maxBytes: GENERIC_JSON_LIMIT_BYTES,
    });
    const logged = routerMessages().find((message) =>
      message.startsWith(REQUEST_BODY_TOO_LARGE_CODE)
    );
    expect(logged).toContain("declaredSizeBytes=10");
    expect(logged).toContain(`observedSizeBytes=${oversized.length}`);
  });
});

describe("unhandled request failures", () => {
  it("answers 500 and logs GET with an empty target when method and url are absent and a non-Error is thrown", async () => {
    const router = createRouter({
      getWebAppOrigin: () => {
        throw NON_ERROR_FAILURE;
      },
    });
    const request = new http.IncomingMessage(new net.Socket());
    request.method = undefined;
    request.url = undefined;
    const response = new http.ServerResponse(request);
    const end = vi.spyOn(response, "end");

    await router.handle(request, response);

    expect(response.statusCode).toBe(500);
    expect(end.mock.calls.map((call) => call[0])).toEqual([
      JSON.stringify({ error: "internal error" }),
    ]);
    expect(routerMessages()).toContain(
      `${UNHANDLED_REQUEST_ERROR_CODE} method=GET target= error=origin settings unreadable status=500`
    );
  });

  it("answers 500 for a handler error carrying an unrelated code", async () => {
    const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const router = createRouter({}, throwingDispatcher(failure));

    const response = await dispatchMockRequest({
      router,
      method: "GET",
      path: THROW_PATH,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "internal error" });
    expect(routerMessages()).toContain(
      `${UNHANDLED_REQUEST_ERROR_CODE} method=GET target=${THROW_PATH} error=disk full status=500`
    );
  });
});
