import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { LocalSessionStore } from "../src/main/auth/local-session-store.js";
import { AuthReason } from "../src/server/gateway-auth-reasons.js";
import { DesktopGatewayServer } from "../src/server/server.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";
import { assertUnauthorized } from "./helpers/gateway-auth-fixtures.js";

const serversToClose: DesktopGatewayServer[] = [];
const tempPathsToClean: string[] = [];

afterEach(async () => {
  for (const server of serversToClose.splice(0)) {
    await server.stop();
  }

  for (const tmpPath of tempPathsToClean.splice(0)) {
    await fs.rm(tmpPath, { recursive: true, force: true });
  }
});

async function makeTempDir(suffix: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `gateway-auth-test-${suffix}-`)
  );
  tempPathsToClean.push(tmpDir);
  return tmpDir;
}

function makeServer(
  tmpDir: string,
  store: LocalSessionStore,
  overrides: Partial<ConstructorParameters<typeof DesktopGatewayServer>[0]> = {}
): DesktopGatewayServer {
  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.test.com",
    getAllowedDirectories: () => [tmpDir],
    getGatewayAuthToken: () => "test-gateway-token-hex",
    machineName: "test-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    sessionStore: store,
    ...overrides,
  });
  serversToClose.push(server);
  return server;
}

test("gateway route rejects spoofed origin without session token (401)", async () => {
  const tmpDir = await makeTempDir("no-session");
  const store = new LocalSessionStore();
  const server = makeServer(tmpDir, store);
  await server.start();

  // No session token was created for this origin — browser-style request with Origin only
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/directories?path=${tmpDir}`,
    { headers: { Origin: "http://localhost" } }
  );

  await assertUnauthorized(response, AuthReason.BrowserSessionRequired);
});

test("gateway route rejects missing origin even with browser-like headers (401)", async () => {
  const tmpDir = await makeTempDir("no-origin");
  const store = new LocalSessionStore();
  const server = makeServer(tmpDir, store);
  await server.start();

  // Browser-like headers but no Origin and no session token
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/directories?path=${tmpDir}`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        "Sec-Fetch-Mode": "cors",
      },
    }
  );

  await assertUnauthorized(response, AuthReason.NoCredential);
});

test("gateway route accepts valid session token with matching origin (200)", async () => {
  const tmpDir = await makeTempDir("valid-session");
  const store = new LocalSessionStore();
  const { sessionToken } = store.create("http://localhost:3000");
  const server = makeServer(tmpDir, store);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/directories?path=${tmpDir}`,
    {
      headers: {
        Origin: "http://localhost:3000",
        "X-Desktop-Session-Token": sessionToken,
      },
    }
  );

  assert.equal(response.status, 200);
});

test("gateway route rejects expired session token (401)", async () => {
  const tmpDir = await makeTempDir("expired-session");
  // A zero TTL expires the token at the instant it is created, so the request
  // below carries an expired token without waiting on the wall clock.
  const store = new LocalSessionStore(0);
  const { sessionToken } = store.create("http://localhost:3000");
  const server = makeServer(tmpDir, store);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/directories?path=${tmpDir}`,
    {
      headers: {
        Origin: "http://localhost:3000",
        "X-Desktop-Session-Token": sessionToken,
      },
    }
  );

  await assertUnauthorized(response, AuthReason.SessionTokenInvalid);
});

test("gateway route rejects session token with mismatched origin (401)", async () => {
  const tmpDir = await makeTempDir("origin-mismatch");
  const store = new LocalSessionStore();
  const { sessionToken } = store.create("http://localhost:3000");
  const server = makeServer(tmpDir, store);
  await server.start();

  // Send the valid token but with a different origin
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/directories?path=${tmpDir}`,
    {
      headers: {
        Origin: "http://localhost:4000",
        "X-Desktop-Session-Token": sessionToken,
      },
    }
  );

  await assertUnauthorized(response, AuthReason.SessionTokenInvalid);
});

test("internal cloud token path still works (200)", async () => {
  const tmpDir = await makeTempDir("cloud-token");
  const store = new LocalSessionStore();
  const server = makeServer(tmpDir, store);
  await server.start();

  // Cloud executor uses the internal gateway token directly — no session needed
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/directories?path=${tmpDir}`,
    {
      headers: {
        "X-Desktop-Gateway-Token": "test-gateway-token-hex",
      },
    }
  );

  // 200 because the directories route returns the listing
  assert.equal(response.status, 200);
});

test("CORS preflight includes X-Desktop-Session-Token in Access-Control-Allow-Headers", async () => {
  const tmpDir = await makeTempDir("cors-preflight");
  const store = new LocalSessionStore();
  const server = makeServer(tmpDir, store);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/directories`,
    {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "X-Desktop-Session-Token",
      },
    }
  );

  assert.equal(response.status, 204);

  const allowedHeaders = response.headers.get("access-control-allow-headers");
  assert.ok(
    allowedHeaders?.includes("X-Desktop-Session-Token"),
    `Expected Access-Control-Allow-Headers to include X-Desktop-Session-Token, got: ${allowedHeaders}`
  );
});

// --- Production Origins Only Mode ---

test("prodOriginsOnly: no-auth mode + loopback origin engineer request returns 401", async () => {
  const tmpDir = await makeTempDir("prod-noauth-loopback");
  const store = new LocalSessionStore();
  const server = makeServer(tmpDir, store, {
    prodOriginsOnly: true,
    getGatewayAuthToken: () => undefined,
  });
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/directories?path=${tmpDir}`,
    {
      headers: { Origin: "http://localhost:3000" },
    }
  );

  await assertUnauthorized(response, AuthReason.OriginNotAllowed);
});

test("prodOriginsOnly: gateway token request (no Origin) succeeds", async () => {
  const tmpDir = await makeTempDir("prod-gateway-token");
  const store = new LocalSessionStore();
  const server = makeServer(tmpDir, store, { prodOriginsOnly: true });
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/directories?path=${tmpDir}`,
    {
      headers: {
        "X-Desktop-Gateway-Token": "test-gateway-token-hex",
      },
    }
  );

  assert.equal(response.status, 200);
});

test("prodOriginsOnly: gateway token + blocked Origin header still succeeds", async () => {
  const tmpDir = await makeTempDir("prod-gateway-token-with-origin");
  const store = new LocalSessionStore();
  const server = makeServer(tmpDir, store, { prodOriginsOnly: true });
  await server.start();

  // Relayed cloud commands may carry an Origin header forwarded from the browser.
  // The gateway token must take precedence over the origin gate.
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/directories?path=${tmpDir}`,
    {
      headers: {
        "X-Desktop-Gateway-Token": "test-gateway-token-hex",
        Origin: "http://localhost:3000",
      },
    }
  );

  assert.equal(response.status, 200);
});
