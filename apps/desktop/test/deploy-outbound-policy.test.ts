import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, test } from "node:test";
import { Observability } from "../src/main/observability.js";
import type {
  OperationHandler,
  OperationRequestContext,
} from "../src/server/operation-dispatcher.js";
import {
  DEPLOY_HEALTH_POLICY_DENIAL_CODE,
  DEPLOY_HEALTH_POLICY_FAILED_COMMAND,
  registerDeployRoutes,
  startHealthPoll,
} from "../src/server/operations/deploy.js";

const originalFetch = globalThis.fetch;
const tempDirsToClean: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Observability.shutdown();
  Observability.reset();
  for (const dir of tempDirsToClean.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("deploy health route returns compatibility-safe denial without fetching", async () => {
  const handler = registerAndFindDeployHealthHandler();
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch should not be called");
  };

  const context = buildContext({
    url: "http://169.254.169.254/latest/meta-data",
  });
  await handler(context);

  assert.equal(fetchCalls, 0);
  assert.equal(context._responseStatus, 200);
  assert.deepEqual(JSON.parse(context._responseBody), {
    alive: false,
    statusCode: null,
    error: "url blocked by desktop outbound policy",
    code: DEPLOY_HEALTH_POLICY_DENIAL_CODE,
  });
});

test("deploy health route allows app.localhost and does not follow redirects", async () => {
  const handler = registerAndFindDeployHealthHandler();
  const calls: RequestInit[] = [];
  globalThis.fetch = async (
    _input: string | URL | Request,
    init?: RequestInit
  ) => {
    calls.push(init ?? {});
    return new Response(null, { status: 204 });
  };

  const context = buildContext({ url: "http://app.localhost:3000/health" });
  await handler(context);

  assert.equal(context._responseStatus, 200);
  assert.deepEqual(JSON.parse(context._responseBody), {
    alive: true,
    statusCode: 204,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, "manual");
});

test("deploy health route treats loopback redirects as alive", async () => {
  const handler = registerAndFindDeployHealthHandler();
  globalThis.fetch = async () =>
    new Response(null, {
      status: 302,
      headers: { location: "http://app.localhost:3000/login" },
    });

  const context = buildContext({ url: "http://app.localhost:3000/" });
  await handler(context);

  assert.equal(context._responseStatus, 200);
  assert.deepEqual(JSON.parse(context._responseBody), {
    alive: true,
    statusCode: 302,
  });
});

test("startHealthPoll fail-closes disallowed stored healthCheckUrl without fetching", async () => {
  const workDir = await makeTempDir();
  const resultJsonPath = path.join(workDir, "deploy-result.json");
  const exitJsonPath = path.join(workDir, "deploy-exit.json");
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch should not be called");
  };

  startHealthPoll(
    "http://192.168.1.25:3000/health",
    resultJsonPath,
    exitJsonPath
  );

  const exitInfo = await readJsonEventually<{
    exitCode: number;
    failedCommand: string;
  }>(exitJsonPath);
  assert.equal(fetchCalls, 0);
  assert.equal(exitInfo.exitCode, -1);
  assert.equal(exitInfo.failedCommand, DEPLOY_HEALTH_POLICY_FAILED_COMMAND);
  await assert.rejects(fs.stat(resultJsonPath));
});

test("startHealthPoll treats loopback redirect responses as healthy", async () => {
  const workDir = await makeTempDir();
  const resultJsonPath = path.join(workDir, "deploy-result.json");
  const exitJsonPath = path.join(workDir, "deploy-exit.json");
  const calls: RequestInit[] = [];
  globalThis.fetch = async (
    _input: string | URL | Request,
    init?: RequestInit
  ) => {
    calls.push(init ?? {});
    return new Response(null, {
      status: 302,
      headers: { location: "http://app.localhost:3000/login" },
    });
  };

  startHealthPoll("http://app.localhost:3000/", resultJsonPath, exitJsonPath);

  const result = await readJsonEventually<{ url: string }>(
    resultJsonPath,
    3000
  );
  assert.equal(result.url, "http://app.localhost:3000/");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, "manual");
  await assert.rejects(fs.stat(exitJsonPath));
});

function registerAndFindDeployHealthHandler(): OperationHandler {
  const routes: Array<{
    method: string;
    path: string;
    handler: OperationHandler;
  }> = [];
  registerDeployRoutes(
    {
      register(method: string, pathPattern: string, handler: OperationHandler) {
        routes.push({ method, path: pathPattern, handler });
      },
    } as never,
    () => [],
    () => os.tmpdir()
  );
  const route = routes.find(
    (candidate) =>
      candidate.method === "POST" &&
      candidate.path === "/api/gateway/deploy/health"
  );
  if (!route) {
    throw new Error("deploy health route not registered");
  }
  return route.handler;
}

function buildContext(
  body: Record<string, unknown>
): OperationRequestContext & {
  _responseBody: string;
  _responseStatus: number;
} {
  const bodyText = JSON.stringify(body);
  const req = new PassThrough() as unknown as http.IncomingMessage;
  const res = new PassThrough() as unknown as http.ServerResponse;
  let responseBody = "";
  let responseStatus = 0;

  Object.defineProperty(res, "statusCode", {
    get: () => responseStatus,
    set: (value: number) => {
      responseStatus = value;
    },
  });
  (
    res as unknown as { setHeader: (key: string, value: string) => void }
  ).setHeader = () => {};
  (res as unknown as { end: (data?: string) => void }).end = (
    data?: string
  ) => {
    responseBody = data ?? "";
  };

  return {
    method: "POST",
    pathname: "/api/gateway/deploy/health",
    params: {},
    query: new URLSearchParams(),
    rawBody: Buffer.from(bodyText),
    body: bodyText,
    request: req,
    response: res,
    get _responseBody() {
      return responseBody;
    },
    get _responseStatus() {
      return responseStatus;
    },
  } as OperationRequestContext & {
    _responseBody: string;
    _responseStatus: number;
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deploy-policy-"));
  tempDirsToClean.push(dir);
  return dir;
}

async function readJsonEventually<T>(
  filePath: string,
  timeoutMs = 1000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}
