import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import { afterEach, test, vi } from "vitest";
import { AuthReason } from "../src/server/gateway-auth-reasons.js";
import { SymphonyDirNotConfiguredError } from "../src/server/operations/symphony-utils.js";
import {
  type GatewayActivityEvent,
  GatewayRouter,
} from "../src/server/router.js";
import { DesktopGatewayServer } from "../src/server/server.js";
import {
  _setKnownBinaryLocationsForResolverTest,
  resetShellPathCache,
  setShellPathForTest,
} from "../src/server/shell-path.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";
import { dispatchMockRequest } from "./gateway-server-test-doubles.js";
import {
  assertUnauthorized,
  startAuthRejectionServer,
} from "./helpers/gateway-auth-fixtures.js";

const GENERIC_JSON_LIMIT_BYTES = 256 * 1024;

const serversToClose: DesktopGatewayServer[] = [];
const blockersToClose: net.Server[] = [];
const tempPathsToClean: string[] = [];
const originalSymphonyWorktreeParentDir =
  process.env.SYMPHONY_WORKTREE_PARENT_DIR;
const originalHome = process.env.HOME;
const originalPath = process.env.PATH;
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;

  if (originalSymphonyWorktreeParentDir === undefined) {
    delete process.env.SYMPHONY_WORKTREE_PARENT_DIR;
  } else {
    process.env.SYMPHONY_WORKTREE_PARENT_DIR =
      originalSymphonyWorktreeParentDir;
  }

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  resetShellPathCache();
  // Ensure no test leaks a known-location resolver override into the next one.
  _setKnownBinaryLocationsForResolverTest(null);

  for (const server of serversToClose.splice(0)) {
    await server.stop();
  }

  for (const blocker of blockersToClose.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      blocker.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  for (const tempPath of tempPathsToClean.splice(0)) {
    await fs.rm(tempPath, { recursive: true, force: true });
  }

  vi.restoreAllMocks();
});

function createGatewayRouter(
  overrides: Partial<ConstructorParameters<typeof GatewayRouter>[0]> = {}
): GatewayRouter {
  return new GatewayRouter({
    webAppOrigin: "https://app.closedloop.ai",
    getAllowedDirectories: () => [os.tmpdir()],
    machineName: "router-test-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    getActivePort: () => 0,
    getGatewayId: () => "test-gateway-id",
    ...overrides,
  });
}

/**
 * Create a temp dir that is ALREADY tracked for cleanup. Allocating and
 * registering in one call is what makes an untracked temp path unrepresentable —
 * the pair used to be written out at every site, and one site forgot the push.
 */
async function makeTrackedTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempPathsToClean.push(dir);
  return dir;
}

test("uses closedloop-ai discovery file path by default", () => {
  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [os.homedir()],
    machineName: "discovery-default-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
  });

  assert.equal(
    server.getAddress().discoveryFilePath,
    path.join(os.homedir(), ".closedloop-ai", "electron-port")
  );
});

// PLN-1535 M5 deletion 2. The legacy local-`gh` PR data lane is retired: every
// one of these routes had lost its client (the live-overlay lane went in M5
// deletion 3, `/pr/comments` with FEA-2608, and `apps/mobile` — the last caller
// that bypassed the `allowLiveOverlays` gate — in ISS-5284).
//
// They answer 410 ON PURPOSE, and are registered unconditionally: the gateway is
// a cross-process contract served by an installed Desktop build that is never
// upgraded in lockstep with the web app, so a version-skewed caller has to be
// able to tell "this endpoint is gone for good" from "not built yet". Dropping
// the routes instead would surface as this gateway's generic 501 `operation not
// implemented` (router.ts) — which per root AGENTS.md means the opposite. The
// previous `enableGithubDataRoutes` flag defaulted to serving the real handlers,
// so nothing exercised this path in production.
//
// This server is built without `evaluateApproval`, so the request reaches the
// dispatcher directly. In the app the auth/onboarding/approval gates run first
// and can answer before the route does — the 410 is this lane's answer once a
// request gets to it, not a guarantee about every caller.
//
// The route table is asserted EXPLICITLY here rather than imported from the
// source module: importing the same array the implementation registers from
// would pass even if that array were emptied by mistake.
const RETIRED_GITHUB_DATA_REQUESTS = [
  { method: "GET", path: "/api/gateway/git/pr/list?repo=/tmp/x" },
  {
    method: "GET",
    path: "/api/gateway/git/pr/comments?owner=o&repo=r&number=1",
  },
  {
    method: "GET",
    path: "/api/gateway/git/pr/reviews?owner=o&repo=r&number=1",
  },
  { method: "POST", path: "/api/gateway/git/pr/reply" },
  { method: "GET", path: "/api/gateway/git/pr/files?owner=o&repo=r&number=1" },
  {
    method: "GET",
    path: "/api/gateway/git/pr/file-diff?owner=o&repo=r&number=1",
  },
  { method: "GET", path: "/api/gateway/git/pr/head-sha?repo=/tmp/x&pr=1" },
  { method: "POST", path: "/api/gateway/git/pr/inline-comment" },
] as const;

test("retired local-gh PR data routes answer 410 with a stable reason", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-retired-");

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "retired-routes-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  for (const request of RETIRED_GITHUB_DATA_REQUESTS) {
    const response = await fetch(
      `http://127.0.0.1:${server.getActivePort()}${request.path}`,
      { method: request.method }
    );
    assert.equal(
      response.status,
      410,
      `${request.method} ${request.path} should be gone, not ${response.status}`
    );
    const body = (await response.json()) as {
      error?: string;
      message?: string;
    };
    // The machine-readable reason is the part a skewed client branches on.
    assert.equal(body.error, "github_data_route_retired");
    assert.ok(
      body.message && body.message.length > 0,
      `${request.path} should explain itself to a human reader`
    );
  }
});

// The write route that SURVIVES. Without this, emptying `registerGitPrRoutes`
// entirely would leave the suite green.
test("the PR create route is still registered after the data-lane retirement", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-pr-create-");

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "pr-create-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  // The create route is registered at `/api/gateway/git/pr` — no `/create`
  // suffix — and the dispatcher matches exactly (`^pattern$`), so a wrong path
  // here would fall through to the gateway's generic 501 and quietly satisfy
  // any not-404/not-410 assertion.
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git/pr`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }
  );
  // Assert the POSITIVE: the handler ran and rejected the empty body on its own
  // terms. A pair of not-equals would pass for an unregistered path too, which
  // is exactly the vacuity this test exists to avoid.
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error?: string };
  assert.match(String(body.error), /required/i);
});

test("returns health contract with active port and CORS headers", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-test-");
  const discoveryFile = path.join(tmpDir, "electron-port");

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "test-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    getGatewayId: () => "019dd8f5-5a1a-4bce-ae72-a3c973850f81",
    getOnboardingCompleted: () => true,
    discoveryFilePath: discoveryFile,
  });
  serversToClose.push(server);
  await server.start();

  const healthResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/health`
  );
  assert.equal(healthResponse.status, 200);
  assert.equal(
    healthResponse.headers.get("access-control-allow-origin"),
    "https://app.symphony.com"
  );

  const healthBody = (await healthResponse.json()) as {
    status: string;
    port: number;
    machineName: string;
    gatewayId?: string;
    onboardingCompleted?: boolean;
  };
  assert.equal(healthBody.status, "ok");
  assert.equal(healthBody.machineName, "test-machine");
  assert.equal(healthBody.gatewayId, "019dd8f5-5a1a-4bce-ae72-a3c973850f81");
  assert.equal(healthBody.onboardingCompleted, true);
  assert.equal(healthBody.port, server.getActivePort());

  const discoveryPort = await fs.readFile(discoveryFile, "utf-8");
  assert.equal(Number(discoveryPort), server.getActivePort());
});

test("returns 204 for CORS preflight requests", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-preflight-");

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://staging.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "preflight-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const preflight = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/repos`,
    {
      method: "OPTIONS",
    }
  );

  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "https://staging.symphony.com"
  );
  assert.equal(
    preflight.headers.get("access-control-allow-headers"),
    "Content-Type,Authorization,X-Desktop-Gateway-Token,X-Desktop-Session-Token,X-Desktop-Source,X-Desktop-Force-Approval,X-Desktop-Approval-Reason"
  );
});

test("returns private-network CORS allow header for repos preflight", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-pna-preflight-");

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.closedloop.ai",
    getAllowedDirectories: () => [tmpDir],
    machineName: "pna-preflight-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const preflight = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/repos`,
    {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.closedloop.ai",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
        "Access-Control-Request-Private-Network": "true",
      },
    }
  );

  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "https://app.closedloop.ai"
  );
  assert.equal(
    preflight.headers.get("access-control-allow-methods"),
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  );
  assert.equal(
    preflight.headers.get("access-control-allow-private-network"),
    "true"
  );
});

test("allows loopback origin variants for CORS preflight", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-loopback-origin-");

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "http://localhost:3000",
    getAllowedDirectories: () => [tmpDir],
    machineName: "loopback-origin-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const preflight = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/repos`,
    {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:3001",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    }
  );

  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "http://127.0.0.1:3001"
  );
});

test("normal mode: 127.0.0.2 loopback variant echoed back in CORS preflight", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-127-2-");

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.closedloop.ai",
    getAllowedDirectories: () => [tmpDir],
    machineName: "loopback-127-2-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const preflight = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/repos`,
    {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.2:8080",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    }
  );

  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "http://127.0.0.2:8080"
  );
});

test("normal mode: DNS name like 127.evil.com is NOT treated as loopback", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-127-evil-");

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.closedloop.ai",
    getAllowedDirectories: () => [tmpDir],
    machineName: "loopback-evil-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const preflight = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/repos`,
    {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.evil.com:8080",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    }
  );

  assert.equal(preflight.status, 204);
  // Should NOT echo back the spoofed origin -- falls back to configured origin
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "https://app.closedloop.ai"
  );
});

test("prodOriginsOnly: preflight from loopback returns configured origin, no PNA header", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-prod-loopback-");

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.closedloop.ai",
    getAllowedDirectories: () => [tmpDir],
    machineName: "prod-loopback-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    prodOriginsOnly: true,
  });
  serversToClose.push(server);
  await server.start();

  const preflight = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/repos`,
    {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
        "Access-Control-Request-Private-Network": "true",
      },
    }
  );

  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "https://app.closedloop.ai"
  );
  assert.equal(
    preflight.headers.get("access-control-allow-private-network"),
    null
  );
});

test("prodOriginsOnly: preflight from configured origin returns correct CORS + PNA header", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-prod-configured-");

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.closedloop.ai",
    getAllowedDirectories: () => [tmpDir],
    machineName: "prod-configured-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    prodOriginsOnly: true,
  });
  serversToClose.push(server);
  await server.start();

  const preflight = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/repos`,
    {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.closedloop.ai",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
        "Access-Control-Request-Private-Network": "true",
      },
    }
  );

  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "https://app.closedloop.ai"
  );
  assert.equal(
    preflight.headers.get("access-control-allow-private-network"),
    "true"
  );
});

test("prodOriginsOnly: preflight from random origin returns configured origin", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-prod-random-");

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.closedloop.ai",
    getAllowedDirectories: () => [tmpDir],
    machineName: "prod-random-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    prodOriginsOnly: true,
  });
  serversToClose.push(server);
  await server.start();

  const preflight = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/repos`,
    {
      method: "OPTIONS",
      headers: {
        Origin: "https://random.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    }
  );

  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "https://app.closedloop.ai"
  );
});

test("prodOriginsOnly: loopback webAppOrigin preflight from that origin echoes it back", async () => {
  const tmpDir = await makeTrackedTempDir(
    "desktop-gateway-prod-loopback-webapp-"
  );

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "http://localhost:3000",
    getAllowedDirectories: () => [tmpDir],
    machineName: "prod-loopback-webapp-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    prodOriginsOnly: true,
  });
  serversToClose.push(server);
  await server.start();

  const preflight = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/repos`,
    {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    }
  );

  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "http://localhost:3000"
  );
});

test("requires gateway token when configured", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-auth-token-");
  const activityEvents: GatewayActivityEvent[] = [];

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getGatewayAuthToken: () => "test-gateway-token",
    getAllowedDirectories: () => [tmpDir],
    machineName: "auth-token-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    onActivityEvent: (event) => {
      activityEvents.push(event);
    },
  });
  serversToClose.push(server);
  await server.start();

  const unauthorized = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/unimplemented-route`
  );
  assert.equal(unauthorized.status, 401);
  const body = (await unauthorized.json()) as {
    error: string;
    reason?: string;
  };
  assert.equal(body.error, "unauthorized");

  const authorized = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/unimplemented-route`,
    {
      headers: {
        "x-desktop-gateway-token": "test-gateway-token",
      },
    }
  );
  assert.equal(authorized.status, 501);

  assert.equal(activityEvents.length, 2);
  assert.equal(activityEvents[0].type, "security");
  assert.equal(activityEvents[0].statusCode, 401);
  assert.equal(activityEvents[0].path, "/api/gateway/unimplemented-route");
  assert.equal(Object.hasOwn(activityEvents[0], "requestBody"), false);
  assert.equal(Object.hasOwn(activityEvents[0], "responseBody"), false);
  assert.equal(activityEvents[1].type, "request");
  assert.equal(activityEvents[1].statusCode, 501);
  assert.equal(activityEvents[1].path, "/api/gateway/unimplemented-route");
  assert.equal(Object.hasOwn(activityEvents[1], "requestBody"), false);
  assert.equal(Object.hasOwn(activityEvents[1], "responseBody"), false);
});

test("records gateway activity byte counts without raw request or response bodies", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-safe-activity-");
  const activityEvents: GatewayActivityEvent[] = [];
  const requestBody = JSON.stringify({
    secret: "do-not-store",
    value: "hello",
  });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "safe-activity-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    onActivityEvent: (event) => activityEvents.push(event),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/unimplemented-route`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    }
  );
  const responseText = await response.text();

  assert.equal(response.status, 501);
  assert.equal(activityEvents.length, 1);
  const [event] = activityEvents;
  assert.equal(event.requestSizeBytes, Buffer.byteLength(requestBody));
  assert.equal(event.responseSizeBytes, Buffer.byteLength(responseText));
  assert.equal(Object.hasOwn(event, "requestBody"), false);
  assert.equal(Object.hasOwn(event, "responseBody"), false);
});

test("keeps approval and dispatch body available while activity capture stays payload-free", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-body-preserved-");
  const activityEvents: GatewayActivityEvent[] = [];
  const requestBody = JSON.stringify({ approval: "body survives" });
  let approvalBody: string | null = null;

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "body-preserved-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    onActivityEvent: (event) => activityEvents.push(event),
    evaluateApproval: (request) => {
      approvalBody = request.body;
      return {
        allow: false,
        statusCode: 202,
        payload: { error: "approval required" },
      };
    },
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/unimplemented-route`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    }
  );

  assert.equal(response.status, 202);
  assert.equal(approvalBody, requestBody);
  assert.equal(activityEvents.length, 1);
  assert.equal(activityEvents[0].detail, "approval required");
  assert.equal(Object.hasOwn(activityEvents[0], "requestBody"), false);
  assert.equal(Object.hasOwn(activityEvents[0], "responseBody"), false);
});

test("rejects oversized numeric Content-Length before dispatch with safe 413 activity", async () => {
  const activityEvents: GatewayActivityEvent[] = [];
  const router = createGatewayRouter({
    onActivityEvent: (event) => activityEvents.push(event),
    evaluateApproval: () => {
      throw new Error("approval should not run for oversized requests");
    },
  });

  const response = await dispatchMockRequest({
    router,
    method: "POST",
    path: "/api/gateway/unimplemented-route",
    headers: { "content-length": String(GENERIC_JSON_LIMIT_BYTES + 1) },
  });

  assert.equal(response.statusCode, 413);
  assert.deepEqual(response.json(), {
    error: "request body too large",
    code: "request_body_too_large",
    maxBytes: GENERIC_JSON_LIMIT_BYTES,
  });
  assert.equal(activityEvents.length, 1);
  assert.equal(activityEvents[0].type, "security");
  assert.equal(activityEvents[0].detail, "request_body_too_large");
  assert.equal(
    activityEvents[0].requestSizeBytes,
    GENERIC_JSON_LIMIT_BYTES + 1
  );
  assert.equal(Object.hasOwn(activityEvents[0], "requestBody"), false);
  assert.equal(Object.hasOwn(activityEvents[0], "responseBody"), false);
});

test("treats malformed or absent Content-Length as absent and enforces streamed byte count", async () => {
  const acceptedBodies: string[] = [];
  const router = createGatewayRouter({
    evaluateApproval: (request) => {
      acceptedBodies.push(request.body);
      return {
        allow: false,
        statusCode: 202,
        payload: { error: "accepted under limit" },
      };
    },
  });
  const body = JSON.stringify({ ok: true });

  const malformed = await dispatchMockRequest({
    router,
    method: "POST",
    path: "/api/gateway/unimplemented-route",
    headers: { "content-length": "not-a-number" },
    chunks: [body],
  });
  const absent = await dispatchMockRequest({
    router,
    method: "POST",
    path: "/api/gateway/unimplemented-route",
    chunks: [body],
  });

  assert.equal(malformed.statusCode, 202);
  assert.equal(absent.statusCode, 202);
  assert.deepEqual(acceptedBodies, [body, body]);
});

test("rejects chunked gateway bodies once streamed bytes exceed the route limit", async () => {
  const activityEvents: GatewayActivityEvent[] = [];
  const router = createGatewayRouter({
    onActivityEvent: (event) => activityEvents.push(event),
    evaluateApproval: () => {
      throw new Error("approval should not run after streamed overflow");
    },
  });

  const response = await dispatchMockRequest({
    router,
    method: "POST",
    path: "/api/gateway/unimplemented-route",
    chunks: [Buffer.alloc(GENERIC_JSON_LIMIT_BYTES, "a"), Buffer.from("b")],
  });

  assert.equal(response.statusCode, 413);
  assert.equal(response.json().code, "request_body_too_large");
  assert.equal(
    activityEvents[0].requestSizeBytes,
    GENERIC_JSON_LIMIT_BYTES + 1
  );
});

test("counts streaming fallback responses without capturing response bodies", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-stream-activity-");
  const activityEvents: GatewayActivityEvent[] = [];
  const chunks = Array.from(
    { length: 25 },
    (_, index) =>
      `${JSON.stringify({ type: "text", index, content: "x".repeat(512) })}\n`
  );
  const upstream = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/x-ndjson");
    for (const chunk of chunks) {
      response.write(chunk);
    }
    response.end();
  });
  blockersToClose.push(upstream);
  await new Promise<void>((resolve, reject) => {
    upstream.listen(0, "127.0.0.1", () => resolve());
    upstream.once("error", reject);
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "stream-activity-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    fallbackGatewayOrigin: `http://127.0.0.1:${address.port}`,
    onActivityEvent: (event) => activityEvents.push(event),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/fallback-stream`
  );
  const responseText = await response.text();

  assert.equal(response.status, 200);
  assert.equal(responseText, chunks.join(""));
  assert.equal(activityEvents.length, 1);
  assert.equal(
    activityEvents[0].responseSizeBytes,
    Buffer.byteLength(responseText)
  );
  assert.equal(Object.hasOwn(activityEvents[0], "responseBody"), false);
});

test("Desktop 413 body preserves gateway returned 413 parsing shape", async () => {
  const router = createGatewayRouter();
  const response = await dispatchMockRequest({
    router,
    method: "POST",
    path: "/api/gateway/unimplemented-route",
    headers: { "content-length": String(GENERIC_JSON_LIMIT_BYTES + 1) },
  });

  const terminalError = `gateway returned ${response.statusCode}: ${response.text()}`;
  const statusMatch = /^gateway returned (\d{3})/.exec(terminalError);
  const body = JSON.parse(
    terminalError.slice(terminalError.indexOf(": ") + 2)
  ) as {
    code?: string;
    maxBytes?: number;
  };

  assert.equal(statusMatch?.[1], "413");
  assert.equal(body.code, "request_body_too_large");
  assert.equal(body.maxBytes, GENERIC_JSON_LIMIT_BYTES);
});

test("rejects trusted browser origin without session token (origin-only bypass removed)", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-origin-auth-");

  const server = await startAuthRejectionServer({
    tmpDir,
    webAppOrigin: "https://app.closedloop.ai",
    machineName: "origin-auth-machine",
    serversToClose,
  });

  // Trusted origin alone is no longer sufficient — session token required
  const trusted = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/unimplemented-route`,
    {
      headers: {
        Origin: "https://app.closedloop.ai",
      },
    }
  );
  await assertUnauthorized(trusted, AuthReason.BrowserSessionRequired);

  const untrusted = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/unimplemented-route`,
    {
      headers: {
        Origin: "https://evil.example",
      },
    }
  );
  await assertUnauthorized(untrusted, AuthReason.BrowserSessionRequired);
});

test("rejects localhost browser origin without session token", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-localhost-origin-");

  const server = await startAuthRejectionServer({
    tmpDir,
    webAppOrigin: "https://app.closedloop.ai",
    machineName: "localhost-origin-machine",
    serversToClose,
  });

  const localhostOrigin = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/unimplemented-route`,
    {
      headers: {
        Origin: "http://localhost:3000",
      },
    }
  );
  await assertUnauthorized(localhostOrigin, AuthReason.BrowserSessionRequired);
});

test("rejects loopback browser request without origin or session token", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-no-origin-browser-");

  const server = await startAuthRejectionServer({
    tmpDir,
    webAppOrigin: "http://localhost:3000",
    machineName: "no-origin-browser-machine",
    serversToClose,
  });

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/unimplemented-route`,
    {
      headers: {
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "cross-site",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      },
    }
  );

  await assertUnauthorized(response, AuthReason.NoCredential);
});

test("keeps non-browser loopback request unauthorized without token", async () => {
  const tmpDir = await makeTrackedTempDir(
    "desktop-gateway-no-origin-non-browser-"
  );

  const server = await startAuthRejectionServer({
    tmpDir,
    webAppOrigin: "http://localhost:3000",
    machineName: "no-origin-non-browser-machine",
    serversToClose,
  });

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/unimplemented-route`
  );
  await assertUnauthorized(response, AuthReason.NoCredential);
});

test("returns approval-required response when approval evaluator blocks gateway route", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-approval-gate-");

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "approval-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    evaluateApproval: () => ({
      allow: false,
      statusCode: 202,
      payload: {
        approvalRequired: true,
        approvalId: "approval-1",
        operationId: "repos_config",
        message: "Manual approval required for repos_config (high)",
      },
    }),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/repos`
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    approvalRequired: true,
    approvalId: "approval-1",
    operationId: "repos_config",
    message: "Manual approval required for repos_config (high)",
  });
});

test("passes cloud approval headers into approval evaluator context", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-approval-headers-");
  let capturedRequest: {
    source: string | null;
    forceApproval: boolean;
    approvalReason: string | null;
  } | null = null;

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "approval-header-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => path.join(tmpDir, "symphony-home"),
    evaluateApproval: (request) => {
      capturedRequest = {
        source: request.source,
        forceApproval: request.forceApproval,
        approvalReason: request.approvalReason,
      };
      return { allow: true };
    },
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/repos`,
    {
      headers: {
        "x-desktop-source": "cloud-socket",
        "x-desktop-force-approval": "1",
        "x-desktop-approval-reason":
          "Manual approval requested by relay policy",
      },
    }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(capturedRequest, {
    source: "cloud-socket",
    forceApproval: true,
    approvalReason: "Manual approval requested by relay policy",
  });
});

test("falls back to the next configured port when preferred port is in use", async () => {
  const blocker = net.createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  blockersToClose.push(blocker);
  const blockerAddress = blocker.address();
  assert.ok(blockerAddress && typeof blockerAddress !== "string");
  const preferredPort = blockerAddress.port;

  const tmpDir = await makeTrackedTempDir("desktop-gateway-fallback-");
  const discoveryFile = path.join(tmpDir, "electron-port");

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "fallback-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: discoveryFile,
  });
  serversToClose.push(server);

  await server.start();

  const activePort = server.getActivePort();
  assert.notEqual(activePort, preferredPort);
  const discoveryPort = await fs.readFile(discoveryFile, "utf-8");
  assert.equal(Number(discoveryPort), activePort);
});

test("repos-config returns 503 when getSymphonyDir throws (not 500)", async () => {
  const tmpDir = await makeTrackedTempDir(
    "desktop-gateway-repos-unconfigured-"
  );

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "repos-unconfigured-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => {
      throw new SymphonyDirNotConfiguredError();
    },
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/repos`
  );
  assert.equal(
    response.status,
    503,
    "repos should return 503 when symphony dir not configured"
  );
  const body = (await response.json()) as { error: string };
  assert.ok(
    body.error.includes("not configured"),
    "error message should mention configuration"
  );
});

test("supports repos config CRUD and settings patch", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-repos-");

  const repoPath = path.join(tmpDir, "repo-configured");
  await fs.mkdir(repoPath, { recursive: true });
  await fs.writeFile(
    path.join(repoPath, "package.json"),
    JSON.stringify({
      name: "repo-configured",
      dependencies: { next: "15.0.0" },
    }),
    "utf-8"
  );

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "repos-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getSymphonyDir: () => path.join(tmpDir, "symphony-home"),
  });
  serversToClose.push(server);
  await server.start();

  const postResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/repos`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: repoPath, description: "test repo" }),
    }
  );
  assert.equal(postResponse.status, 200);
  const postBody = (await postResponse.json()) as {
    success: boolean;
    repo?: { path: string };
  };
  assert.equal(postBody.success, true);
  assert.equal(postBody.repo?.path.endsWith("repo-configured"), true);

  const patchResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/repos`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        worktreeParentDir: "~/tmp",
        worktreeParentDirConfirmed: true,
      }),
    }
  );
  assert.equal(patchResponse.status, 200);
  assert.deepEqual(await patchResponse.json(), { success: true });

  const getResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/repos`
  );
  assert.equal(getResponse.status, 200);
  const getBody = (await getResponse.json()) as {
    repos: Array<{ path: string }>;
    settings: { worktreeParentDir?: string };
  };
  assert.equal(getBody.repos.length, 1);
  assert.equal(getBody.settings.worktreeParentDir, "~/tmp");

  const deleteResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/repos?path=${encodeURIComponent(repoPath)}`,
    { method: "DELETE" }
  );
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { success: true });
});

test("lists directories and supports file search endpoint", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-filesystem-");

  const repoPath = path.join(tmpDir, "repo-search");
  const worktreeParent = path.join(tmpDir, "worktrees");
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  await fs.mkdir(path.join(repoPath, ".git"), { recursive: true });
  await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
  await fs.writeFile(
    path.join(repoPath, "src", "Widget.tsx"),
    "export const Widget = () => null;",
    "utf-8"
  );

  const worktreeDir = path.join(worktreeParent, "repo-search-AI-121");
  await fs.mkdir(path.join(worktreeDir, "src"), { recursive: true });
  await fs.writeFile(
    path.join(worktreeDir, "src", "WidgetPanel.tsx"),
    "export const WidgetPanel = () => null;",
    "utf-8"
  );

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "filesystem-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const directoriesResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/directories?path=${encodeURIComponent(tmpDir)}`
  );
  assert.equal(directoriesResponse.status, 200);
  const directoriesBody = (await directoriesResponse.json()) as {
    directories: Array<{ name: string; isDirectory: boolean }>;
  };
  assert.equal(
    directoriesBody.directories.some((entry) => entry.name === "repo-search"),
    true
  );

  const searchResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/files/search?repo=${encodeURIComponent(
      repoPath
    )}&ticket=AI-121&query=Widget`
  );
  assert.equal(searchResponse.status, 200);
  const searchBody = (await searchResponse.json()) as {
    files: string[];
    truncated: boolean;
  };
  assert.equal(
    searchBody.files.some((file) => file.includes("WidgetPanel.tsx")),
    true
  );
  assert.equal(typeof searchBody.truncated, "boolean");
});

test("proxies unimplemented gateway routes to fallback origin when configured", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-fallback-proxy-");

  const upstream = http.createServer((_req, res) => {
    const payload = JSON.stringify({ proxied: true, source: "upstream" });
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(payload);
  });
  await new Promise<void>((resolve, reject) => {
    upstream.listen(0, "127.0.0.1", () => resolve());
    upstream.once("error", reject);
  });
  blockersToClose.push(upstream);

  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string") {
    throw new Error("failed to resolve upstream address");
  }

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    fallbackGatewayOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
    machineName: "fallback-proxy-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/unimplemented-route`
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    proxied: true,
    source: "upstream",
  });
});

test("supports core git action routes", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-git-action-");
  const repoPath = path.join(tmpDir, "repo-git");
  await fs.mkdir(repoPath, { recursive: true });

  // Fake git binary: handles the subcommands the route exercises without
  // requiring a real git repository.
  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const fakeGitScript = [
    "#!/bin/sh",
    'case "$1" in',
    '  rev-parse) echo "main" ;;',
    "  status) exit 0 ;;",
    "  branch)",
    '    case "$2" in',
    "      --list) exit 0 ;;",
    '      --show-current) echo "main" ;;',
    '      -a) printf "main|\\nfeature/AI-501|\\n" ;;',
    "      *) exit 0 ;;",
    "    esac",
    "    ;;",
    "  checkout) exit 0 ;;",
    "  symbolic-ref) exit 1 ;;",
    "  worktree) exit 0 ;;",
    "  *) exit 0 ;;",
    "esac",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "git-action-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const statusResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "status", repoPath }),
    }
  );
  assert.equal(statusResponse.status, 200);
  const statusBody = (await statusResponse.json()) as {
    hasChanges: boolean;
    currentBranch: string;
  };
  assert.equal(statusBody.hasChanges, false);
  assert.equal(typeof statusBody.currentBranch, "string");

  const branchResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "branch",
        branchName: "feature/AI-501",
        repoPath,
      }),
    }
  );
  assert.equal(branchResponse.status, 200);
  const branchBody = (await branchResponse.json()) as {
    success: boolean;
    branchName: string;
  };
  assert.equal(branchBody.success, true);
  assert.equal(branchBody.branchName, "feature/AI-501");

  const branchesResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git/branches?repo=${encodeURIComponent(repoPath)}`
  );
  assert.equal(branchesResponse.status, 200);
  const branchesBody = (await branchesResponse.json()) as {
    branches: Array<{ name: string }>;
  };
  assert.equal(
    branchesBody.branches.some((branch) => branch.name === "feature/AI-501"),
    true
  );
});

test("classifies git action failures with additive structured error fields", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-git-action-errors-");
  const repoPath = path.join(tmpDir, "repo-git-errors");
  await fs.mkdir(repoPath, { recursive: true });

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const fakeGitScript = [
    "#!/bin/sh",
    'case "$1" in',
    '  rev-parse) echo "main" ;;',
    "  add) exit 0 ;;",
    '  commit) echo "pre-commit hook: eslint failed" >&2; exit 1 ;;',
    '  push) echo "Permission denied (publickey)." >&2; exit 128 ;;',
    '  status) echo "fatal: not a git repository" >&2; exit 128 ;;',
    "  *) exit 0 ;;",
    "esac",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "git-action-errors-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const commitResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "commit", message: "test", repoPath }),
    }
  );
  assert.equal(commitResponse.status, 500);
  const commitBody = (await commitResponse.json()) as {
    error: string;
    code: string;
    details: {
      action: string;
      category: string;
      hookType: string;
      stderrExcerpt: string;
    };
  };
  assert.equal(commitBody.error, "Pre-commit hook failed");
  assert.equal(commitBody.code, LoopErrorCode.ProcessFailed);
  assert.equal(commitBody.details.category, "pre_commit_hook");
  assert.equal(commitBody.details.action, "commit");
  assert.equal(commitBody.details.hookType, "lint");
  assert.match(commitBody.details.stderrExcerpt, /eslint failed/);

  const pushResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "push", repoPath }),
    }
  );
  assert.equal(pushResponse.status, 500);
  const pushBody = (await pushResponse.json()) as {
    error: string;
    code: string;
    details: { action: string; category: string; stderrExcerpt: string };
  };
  assert.equal(pushBody.error, "Git push authentication failed");
  assert.equal(pushBody.code, LoopErrorCode.ProcessFailed);
  assert.equal(pushBody.details.category, "git_push_auth");
  assert.equal(pushBody.details.action, "push");
  assert.match(pushBody.details.stderrExcerpt, /Permission denied/);

  const statusResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "status", repoPath }),
    }
  );
  assert.equal(statusResponse.status, 500);
  const statusBody = (await statusResponse.json()) as {
    error: string;
    code: string;
    details: {
      action: string;
      category: string;
      exitCode: number;
      stderrExcerpt: string;
    };
  };
  assert.equal(statusBody.code, LoopErrorCode.ProcessFailed);
  assert.equal(statusBody.details.category, "git_command_failed");
  assert.equal(statusBody.details.action, "status");
  assert.equal(statusBody.details.exitCode, 128);
  assert.match(statusBody.details.stderrExcerpt, /not a git repository/);
});

test("classifies pre-commit hook failures written to stdout", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-git-hook-stdout-");
  const repoPath = path.join(tmpDir, "repo-git-hook-stdout");
  await fs.mkdir(repoPath, { recursive: true });

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const fakeGitScript = [
    "#!/bin/sh",
    'case "$1" in',
    '  rev-parse) echo "main" ;;',
    "  add) exit 0 ;;",
    '  commit) echo "pre-commit hook: tsc type error"; exit 1 ;;',
    "  *) exit 0 ;;",
    "esac",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "git-hook-stdout-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const commitResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "commit", message: "test", repoPath }),
    }
  );
  assert.equal(commitResponse.status, 500);
  const commitBody = (await commitResponse.json()) as {
    error: string;
    code: string;
    details: {
      action: string;
      category: string;
      hookType: string;
      stderrExcerpt: string;
    };
  };
  assert.equal(commitBody.error, "Pre-commit hook failed");
  assert.equal(commitBody.code, LoopErrorCode.ProcessFailed);
  assert.equal(commitBody.details.category, "pre_commit_hook");
  assert.equal(commitBody.details.hookType, "typecheck");
  assert.match(commitBody.details.stderrExcerpt, /type error/);
});

test("classifies git repo policy, missing repo, and spawn failures", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-git-repo-errors-");
  const allowedRepoPath = path.join(tmpDir, "repo");
  await fs.mkdir(allowedRepoPath, { recursive: true });
  const missingRepoPath = path.join(tmpDir, "missing-repo");

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  process.env.PATH = fakeBin;
  // Hide the resolver's known-location tier for git so that, with the empty
  // fake PATH, getResolvedGitPath() falls through to the bare "git" name and
  // the spawn genuinely fails with ENOENT — exercising the SPAWN_FAILED branch.
  // Without this the host's real /usr/bin/git would resolve and the spawn would
  // succeed against a non-repo, yielding PROCESS_FAILED instead. FEA-3742.
  _setKnownBinaryLocationsForResolverTest({ git: [] });
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [allowedRepoPath, tmpDir],
    machineName: "git-repo-errors-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const missingResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "status", repoPath: missingRepoPath }),
    }
  );
  assert.equal(missingResponse.status, 404);
  const missingBody = (await missingResponse.json()) as {
    error: string;
    code: string;
    details: { category: string };
  };
  assert.equal(missingBody.error, "repository not found");
  assert.equal(missingBody.code, LoopErrorCode.RepoNotFound);
  assert.equal(missingBody.details.category, "repo_not_found");

  const disallowedResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "status",
        repoPath: path.join(os.homedir(), ".ssh"),
      }),
    }
  );
  assert.equal(disallowedResponse.status, 403);
  const disallowedBody = (await disallowedResponse.json()) as {
    error: string;
    code: string;
    details: { category: string };
  };
  assert.equal(disallowedBody.error, "directory not allowed");
  assert.equal(disallowedBody.code, LoopErrorCode.RepoNotAllowed);
  assert.equal(disallowedBody.details.category, "repo_not_allowed");

  const spawnResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "status", repoPath: allowedRepoPath }),
    }
  );
  assert.equal(spawnResponse.status, 500);
  const spawnBody = (await spawnResponse.json()) as {
    error: string;
    code: string;
    details: { category: string; action: string };
  };
  assert.equal(spawnBody.code, LoopErrorCode.SpawnFailed);
  assert.equal(spawnBody.details.category, "spawn_failed");
  assert.equal(spawnBody.details.action, "status");
});

test("supports git diff route for working tree changes", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-git-diff-");
  const repoPath = path.join(tmpDir, "repo-git-diff");
  await fs.mkdir(repoPath, { recursive: true });

  // Write the "current" file on disk (new content read directly by the route handler).
  await fs.writeFile(
    path.join(repoPath, "app.ts"),
    "export const value = 2;\n",
    "utf-8"
  );

  // Fake git binary: status reports the file as modified; show returns the old content.
  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const fakeGitScript = [
    "#!/bin/sh",
    'case "$1" in',
    '  status) printf " M app.ts\\n" ;;',
    '  show) printf "export const value = 1;\\n" ;;',
    "  *) exit 0 ;;",
    "esac",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "git-diff-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const diffResponse = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git/diff`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoPath,
        filePath: "app.ts",
      }),
    }
  );
  assert.equal(diffResponse.status, 200);
  const diffBody = (await diffResponse.json()) as {
    oldContent: string;
    newContent: string;
    isDeleted: boolean;
  };
  assert.equal(diffBody.oldContent.includes("value = 1"), true);
  assert.equal(diffBody.newContent.includes("value = 2"), true);
  assert.equal(diffBody.isDeleted, false);
});

test("validates git PR create request payload", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-git-pr-validate-");

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "git-pr-validate-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/git/pr`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Missing repo" }),
    }
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "repoPath is required" });
});

test("getWebAppOrigin getter takes effect on next CORS response without restart", async () => {
  const tmpDir = await makeTrackedTempDir("desktop-gateway-live-origin-");

  let currentWebAppOrigin = "https://initial.example.com";

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://initial.example.com",
    getWebAppOrigin: () => currentWebAppOrigin,
    getAllowedDirectories: () => [tmpDir],
    machineName: "live-origin-test",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(server);
  await server.start();

  // First request: should reflect initial origin
  const res1 = await fetch(`http://127.0.0.1:${server.getActivePort()}/health`);
  assert.equal(
    res1.headers.get("access-control-allow-origin"),
    "https://initial.example.com"
  );

  // Change origin via getter — no restart
  currentWebAppOrigin = "https://updated.example.com";

  // Second request: should reflect the updated origin immediately
  const res2 = await fetch(`http://127.0.0.1:${server.getActivePort()}/health`);
  assert.equal(
    res2.headers.get("access-control-allow-origin"),
    "https://updated.example.com"
  );
});
