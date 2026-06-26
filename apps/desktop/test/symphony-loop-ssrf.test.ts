/**
 * Tests that all outbound loop HTTP requests target the configured
 * getApiOrigin, regardless of body.apiBaseUrl.
 *
 * The trust boundary is server-owned: the gateway derives the callback
 * URL from its own settings, not from the relay command payload.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { LoopSchedulerContext } from "../src/main/loop-scheduler-context.js";

// ---------------------------------------------------------------------------
// Minimal gateway server that records requests
// ---------------------------------------------------------------------------

type RecordedRequest = {
  method: string;
  url: string;
  body: string;
};

let gatewayServer: http.Server | null = null;
let gatewayPort = 0;
const recordedRequests: RecordedRequest[] = [];

/** Per-test isolated allowlist root — avoids matching /tmp/repo or other local checkouts. */
let ssrfAllowDir: string;
const ssrfTempDirsToClean: string[] = [];

async function startGateway(): Promise<void> {
  gatewayServer = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      recordedRequests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf-8"),
      });
      // Respond 200 to everything so the handler proceeds
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: true }));
    })();
  });
  await new Promise<void>((resolve, reject) => {
    gatewayServer?.listen(0, "127.0.0.1", () => resolve());
    gatewayServer?.once("error", reject);
  });
  const address = gatewayServer.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test server");
  }
  gatewayPort = address.port;
}

async function stopGateway(): Promise<void> {
  if (!gatewayServer) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    gatewayServer?.close((err) => (err ? reject(err) : resolve()));
  });
  gatewayServer = null;
  gatewayPort = 0;
}

// ---------------------------------------------------------------------------
// Import the handler under test
// ---------------------------------------------------------------------------

// We import the route registration function and drive it through a fake
// OperationDispatcher so we can call the handler directly.

import { PassThrough } from "node:stream";
import type {
  OperationHandler,
  OperationRequestContext,
} from "../src/server/operation-dispatcher.js";

type CapturedRoute = {
  method: string;
  path: string;
  handler: OperationHandler;
};
const capturedRoutes: CapturedRoute[] = [];

const fakeDispatcher = {
  register(method: string, path: string, handler: OperationHandler) {
    capturedRoutes.push({ method, path, handler });
  },
};

function findHandler(method: string, pathSubstring: string): OperationHandler {
  const route = capturedRoutes.find(
    (r) => r.method === method && r.path.includes(pathSubstring)
  );
  if (!route) {
    throw new Error(`No handler for ${method} ${pathSubstring}`);
  }
  return route.handler;
}

function buildContext(body: Record<string, unknown>): OperationRequestContext {
  const bodyStr = JSON.stringify(body);
  const req = new PassThrough() as unknown as http.IncomingMessage;
  const res = new PassThrough() as unknown as http.ServerResponse;
  let responseStatus = 0;
  let responseBody = "";
  // Minimal mock for the response
  (res as unknown as Record<string, unknown>).statusCode = 0;
  Object.defineProperty(res, "statusCode", {
    get: () => responseStatus,
    set: (v: number) => {
      responseStatus = v;
    },
  });
  (res as unknown as { setHeader: (k: string, v: string) => void }).setHeader =
    () => {};
  (res as unknown as { end: (data?: string) => void }).end = (
    data?: string
  ) => {
    responseBody = data ?? "";
  };

  return {
    method: "POST",
    pathname: "/api/gateway/symphony/loop",
    params: {},
    query: new URLSearchParams(),
    rawBody: Buffer.from(bodyStr),
    body: bodyStr,
    request: req,
    response: res,
    // Expose for assertions
    get _responseStatus() {
      return responseStatus;
    },
    get _responseBody() {
      return responseBody;
    },
  } as OperationRequestContext & {
    _responseStatus: number;
    _responseBody: string;
  };
}

/** Repo fullName whose basename does not exist under ssrfAllowDir — PLAN exits before run-loop spawn. */
const SSRF_PLAN_REPO = {
  fullName: "ssrf-test-org/ssrf-nonexistent-repo-7f3a1b2c",
  branch: "main",
} as const;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  recordedRequests.length = 0;
  capturedRoutes.length = 0;
  await startGateway();

  ssrfAllowDir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ssrf-"));
  ssrfTempDirsToClean.push(ssrfAllowDir);

  // Register routes with a trusted origin pointing at our test server
  const { registerSymphonyLoopRoutes } = await import(
    "../src/server/operations/symphony-loop.js"
  );
  registerSymphonyLoopRoutes(
    fakeDispatcher as never,
    () => [ssrfAllowDir],
    new LoopSchedulerContext(),
    () => `http://127.0.0.1:${gatewayPort}`,
    undefined // no jobStore
  );
});

afterEach(async () => {
  await stopGateway();
  for (const dir of ssrfTempDirsToClean.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("returns 503 when getApiOrigin is absent", async () => {
  const allowDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "symphony-ssrf-no-origin-")
  );
  try {
    // Register with no getApiOrigin
    const freshRoutes: CapturedRoute[] = [];
    const { registerSymphonyLoopRoutes } = await import(
      "../src/server/operations/symphony-loop.js"
    );
    registerSymphonyLoopRoutes(
      {
        register: (m: string, p: string, h: OperationHandler) =>
          freshRoutes.push({ method: m, path: p, handler: h }),
      } as never,
      () => [allowDir],
      new LoopSchedulerContext(),
      undefined, // no getApiOrigin
      undefined
    );
    const handler = freshRoutes.find(
      (r) => r.path.includes("/loop") && !r.path.includes("kill")
    )!.handler;
    const ctx = buildContext({
      loopId: "test",
      command: LoopCommand.Plan,
      closedLoopAuthToken: "tok",
    }) as OperationRequestContext & {
      _responseStatus: number;
      _responseBody: string;
    };
    await handler(ctx);
    assert.equal(ctx._responseStatus, 503);
    assert.ok(ctx._responseBody.includes("API origin not configured"));
  } finally {
    await fs.rm(allowDir, { recursive: true, force: true });
  }
});

test("works with no apiBaseUrl field in body when getApiOrigin is configured", async () => {
  const handler = findHandler("POST", "/loop");
  const ctx = buildContext({
    loopId: "00000000-0000-0000-0000-000000000001",
    command: LoopCommand.Plan,
    closedLoopAuthToken: "tok",
    // No apiBaseUrl at all
    artifacts: [],
    repo: { ...SSRF_PLAN_REPO },
  }) as OperationRequestContext & {
    _responseStatus: number;
    _responseBody: string;
  };

  await handler(ctx);
  // Should not fail with "Missing required fields" for apiBaseUrl
  // It will fail later (repo not found, etc.) but NOT because of apiBaseUrl
  assert.notEqual(
    ctx._responseStatus,
    400,
    "should not reject for missing apiBaseUrl"
  );
  const parsed = JSON.parse(ctx._responseBody);
  assert.ok(
    !parsed.error?.includes("apiBaseUrl"),
    `unexpected apiBaseUrl error: ${parsed.error}`
  );
});

test("ignores caller-supplied apiBaseUrl -- events go to configured origin", async () => {
  const handler = findHandler("POST", "/loop");
  const ctx = buildContext({
    loopId: "00000000-0000-0000-0000-000000000002",
    command: LoopCommand.Plan,
    closedLoopAuthToken: "tok",
    apiBaseUrl: "http://169.254.169.254", // attacker-controlled
    artifacts: [],
    repo: { ...SSRF_PLAN_REPO },
  }) as OperationRequestContext & { _responseStatus: number };

  await handler(ctx);
  // Any outbound requests must have gone to our test server, not 169.254.169.254
  for (const req of recordedRequests) {
    assert.ok(
      !req.url.includes("169.254"),
      `outbound request leaked to attacker URL: ${req.url}`
    );
  }
});

test("ignores caller-supplied localhost apiBaseUrl", async () => {
  const handler = findHandler("POST", "/loop");
  const ctx = buildContext({
    loopId: "00000000-0000-0000-0000-000000000003",
    command: LoopCommand.Plan,
    closedLoopAuthToken: "tok",
    apiBaseUrl: "http://localhost:9999", // different port than configured
    artifacts: [],
    repo: { ...SSRF_PLAN_REPO },
  });

  await handler(ctx);
  // No requests should have gone to port 9999
  for (const req of recordedRequests) {
    assert.ok(
      !req.url.includes("9999"),
      `request leaked to caller port: ${req.url}`
    );
  }
});

test("ignores caller-supplied private IP apiBaseUrl", async () => {
  const handler = findHandler("POST", "/loop");
  const ctx = buildContext({
    loopId: "00000000-0000-0000-0000-000000000004",
    command: LoopCommand.Plan,
    closedLoopAuthToken: "tok",
    apiBaseUrl: "http://10.0.0.1:3002",
    artifacts: [],
    repo: { ...SSRF_PLAN_REPO },
  });

  await handler(ctx);
  for (const req of recordedRequests) {
    assert.ok(
      !req.url.includes("10.0.0.1"),
      `request leaked to private IP: ${req.url}`
    );
  }
});
