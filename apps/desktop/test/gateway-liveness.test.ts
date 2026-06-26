import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { DesktopGatewayServer } from "../src/server/server.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";

const serversToClose: DesktopGatewayServer[] = [];
const tempPathsToClean: string[] = [];

afterEach(async () => {
  for (const srv of serversToClose) {
    try {
      await srv.stop();
    } catch {
      /* already stopped */
    }
  }
  serversToClose.length = 0;
  for (const p of tempPathsToClean) {
    try {
      await fs.rm(p, { recursive: true });
    } catch {
      /* best effort */
    }
  }
  tempPathsToClean.length = 0;
});

function createTestServer(opts?: {
  onUnexpectedClose?: () => void;
}): DesktopGatewayServer {
  const tmpDir = path.join(
    os.tmpdir(),
    `gateway-liveness-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  tempPathsToClean.push(tmpDir);
  const srv = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "http://localhost:3000",
    machineName: "test",
    version: "0.0.1",
    capabilities: EMPTY_CAPABILITIES,
    getAllowedDirectories: () => ["/tmp"],
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    onUnexpectedClose: opts?.onUnexpectedClose,
  });
  serversToClose.push(srv);
  return srv;
}

test("isAlive() lifecycle: false before start, true after start, false after stop", async () => {
  const srv = createTestServer();
  assert.equal(srv.isAlive(), false, "should be false before start");

  await srv.start();
  assert.equal(srv.isAlive(), true, "should be true after start");

  await srv.stop();
  assert.equal(srv.isAlive(), false, "should be false after stop");
});

test("restart() recovers the server", async () => {
  const srv = createTestServer();
  await srv.start();

  await srv.restart();
  assert.equal(srv.isAlive(), true, "should be alive after restart");

  const res = await fetch(`http://127.0.0.1:${srv.getActivePort()}/health`);
  assert.equal(res.status, 200);
});

test("stop() resolves with stale (non-listening) server handle", async () => {
  const srv = createTestServer();
  await srv.start();

  // Grab the internal http.Server handle and close it directly to simulate stale state
  const internal = (srv as unknown as { server: http.Server | null }).server;
  assert.ok(internal, "internal server should exist");

  // Close it out-of-band (simulates OS-level close)
  await new Promise<void>((resolve) => {
    internal!.closeAllConnections();
    internal!.close(() => resolve());
  });

  // Re-inject the stale handle (the close handler would have nulled it)
  (srv as unknown as { server: http.Server | null }).server = internal;
  (srv as unknown as { alive: boolean }).alive = true;

  // stop() should resolve without throwing even though the handle is stale
  await assert.doesNotReject(() => srv.stop());
});

test("onUnexpectedClose fires on unexpected close", async () => {
  let callbackFired = false;
  const srv = createTestServer({
    onUnexpectedClose: () => {
      callbackFired = true;
    },
  });
  await srv.start();
  assert.equal(srv.isAlive(), true);

  // Grab internal handle and close it to simulate crash
  const internal = (srv as unknown as { server: http.Server | null }).server;
  assert.ok(internal);

  await new Promise<void>((resolve) => {
    internal!.closeAllConnections();
    internal!.close(() => resolve());
  });

  assert.equal(callbackFired, true, "onUnexpectedClose should have fired");
  assert.equal(
    srv.isAlive(),
    false,
    "should not be alive after unexpected close"
  );
});

test("onUnexpectedClose does NOT fire on intentional stop()", async () => {
  let callbackFired = false;
  const srv = createTestServer({
    onUnexpectedClose: () => {
      callbackFired = true;
    },
  });
  await srv.start();
  await srv.stop();

  assert.equal(
    callbackFired,
    false,
    "onUnexpectedClose should not fire on intentional stop"
  );
});
