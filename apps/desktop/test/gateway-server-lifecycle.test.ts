/**
 * Gateway server lifecycle edge-case tests (ISS-5299).
 *
 * Lives beside gateway-server.test.ts and gateway-liveness.test.ts because
 * gateway-server.test.ts is on the shrink-only grandfather list in biome.jsonc;
 * AGENTS.md's file-size rule forbids growing a grandfathered file by a single
 * line. This file covers the uncovered branches in
 * apps/desktop/src/server/server.ts that the existing suites do not reach.
 *
 * Lines verified by these tests:
 *   317 — start() called twice: second call returns early (this.server guard)
 *   338 — activePort falls back to candidate when address() does not return an object
 *   360 — non-EADDRINUSE listen error is rethrown immediately without wrapping
 *   364 — all candidate ports are exhausted → throws the "failed to bind" message
 *   385 — close() callback reports a non-ERR_SERVER_NOT_RUNNING error → stop() rejects
 *   416 — writeDiscoveryFile() early-return when discoveryFilePath is falsy ("")
 *
 * Genuinely unreachable branches (documented, not tested):
 *
 *   172 — the second `getGatewayId ?? (() => "")` inside the GatewayRouter
 *          constructor call. The constructor already coalesces
 *          options.getGatewayId at line 132 (`this.options.getGatewayId =
 *          options.getGatewayId ?? (() => "")`), so this.options.getGatewayId
 *          is always a function by the time line 172 is reached. The `?? (() =>
 *          "")` fallback is dead code.
 *
 *   364 (lastError === null arm) — `lastError?.message ?? "unknown error"` at
 *          line 364 can only use "unknown error" when lastError is null. But
 *          lastError is null only if zero EADDRINUSE errors were caught. If zero
 *          EADDRINUSE errors were caught and all candidates still failed, each
 *          would have thrown at line 360 before the loop completed. The null arm
 *          is therefore dead code through the existing API surface.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { vi } from "vitest";
import { LoopSchedulerContext } from "../src/main/loop/loop-scheduler-context.js";
import { DesktopGatewayServer } from "../src/server/server.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";

// ---------------------------------------------------------------------------
// Shared cleanup registries — drained in afterEach with .splice(0)
// ---------------------------------------------------------------------------

const serversToClose: DesktopGatewayServer[] = [];
const blockersToClose: net.Server[] = [];
const tempPathsToClean: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const srv of serversToClose.splice(0)) {
    try {
      await srv.stop();
    } catch {
      /* already stopped, never started, or stop() was intentionally tested */
    }
  }
  for (const blocker of blockersToClose.splice(0)) {
    // net.Server does not have closeAllConnections; close() is sufficient for
    // TCP-only blockers. http.Server instances pushed here have no active
    // connections in these tests, so close() alone drains cleanly.
    await new Promise<void>((resolve) => {
      blocker.close(() => resolve());
    });
  }
  for (const p of tempPathsToClean.splice(0)) {
    try {
      await fs.rm(p, { recursive: true });
    } catch {
      /* best effort */
    }
  }
});

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeTempDiscoveryPath(): string {
  const dir = path.join(
    os.tmpdir(),
    `gw-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  tempPathsToClean.push(dir);
  return path.join(dir, "electron-port");
}

function createTestServer(
  overrides: Partial<ConstructorParameters<typeof DesktopGatewayServer>[0]> = {}
): DesktopGatewayServer {
  const srv = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "http://localhost:3000",
    machineName: "test-machine",
    version: "0.0.1",
    capabilities: EMPTY_CAPABILITIES,
    getAllowedDirectories: () => [],
    discoveryFilePath: makeTempDiscoveryPath(),
    ...overrides,
  });
  serversToClose.push(srv);
  return srv;
}

/**
 * Reserves a free TCP port by probing with a temporary server, then
 * immediately closing it. Retries if the probed port is in the excluded set.
 */
function findFreePort(excluded: number[] = []): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (!addr || typeof addr === "string") {
        probe.close(() =>
          reject(new Error("could not resolve a free port from probe"))
        );
        return;
      }
      const { port } = addr;
      probe.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (excluded.includes(port)) {
          resolve(findFreePort(excluded));
          return;
        }
        resolve(port);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Line 317 — second start() call returns without rebinding
// ---------------------------------------------------------------------------

test("start() called twice is a no-op: second call returns early (line 317)", async () => {
  const srv = createTestServer();
  await srv.start();
  const portAfterFirst = srv.getActivePort();
  assert.ok(
    portAfterFirst > 0,
    "should have a real port after the first start()"
  );

  // The `if (this.server) { return; }` guard on line 317 fires here.
  await srv.start();

  assert.ok(
    srv.isAlive(),
    "server must still be alive after the second start()"
  );
  assert.equal(
    srv.getActivePort(),
    portAfterFirst,
    "port must be unchanged after the no-op second start()"
  );
});

// ---------------------------------------------------------------------------
// Line 338 — activePort falls back to candidate when address() is falsy
// ---------------------------------------------------------------------------

test("activePort uses the candidate port when server.address() returns null (line 338)", async () => {
  // The ternary on line 338 is:
  //   typeof addr === "object" && addr ? addr.port : candidate
  // typeof null === "object" is true in JS, but null is falsy, so the overall
  // condition is false and execution falls to `candidate`.
  // Stub net.Server.prototype.address (inherited by http.Server) to return null.
  vi.spyOn(net.Server.prototype, "address").mockImplementation(
    (): net.AddressInfo | string | null => null
  );

  // preferredPort: 0 means the first candidate is 0; with address() returning
  // null, activePort is set to that candidate value (0) instead of addr.port.
  const srv = createTestServer({ preferredPort: 0, fallbackPorts: [0] });
  await srv.start();

  assert.equal(
    srv.getActivePort(),
    0,
    "when address() returns null the non-object arm must fall back to the candidate port (0)"
  );
});

// ---------------------------------------------------------------------------
// Line 360 — non-EADDRINUSE listen error is rethrown immediately
// ---------------------------------------------------------------------------

test("non-EADDRINUSE listen error is rethrown, not wrapped in the exhausted-candidates message (line 360)", async () => {
  // Binding to 240.0.0.1 (Class E / reserved range, never a local interface)
  // yields EADDRNOTAVAIL. Because EADDRNOTAVAIL !== EADDRINUSE, start() must
  // rethrow the raw error at line 360 rather than continuing to the next
  // candidate or reaching the "failed to bind" wrapper at line 364.
  const srv = new DesktopGatewayServer({
    host: "240.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "http://localhost:3000",
    machineName: "test",
    version: "0.0.1",
    capabilities: EMPTY_CAPABILITIES,
    getAllowedDirectories: () => [],
    discoveryFilePath: "",
  });
  // Still push so afterEach disposes the LoopSchedulerContext cleanly.
  serversToClose.push(srv);

  await assert.rejects(
    () => srv.start(),
    (err: NodeJS.ErrnoException) => {
      assert.notEqual(
        err.code,
        "EADDRINUSE",
        `expected a non-EADDRINUSE error; got code=${err.code ?? "(none)"}`
      );
      assert.ok(
        !err.message.includes(
          "failed to bind gateway server to any candidate port"
        ),
        "the raw bind error must propagate directly, not wrapped in the exhausted-candidates message"
      );
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Line 364 — all candidate ports exhausted → wrapped "failed to bind" error
// ---------------------------------------------------------------------------

test("start() throws the exhausted-candidates error with lastError.message when all ports are in use (line 364)", async () => {
  const preferredPort = await findFreePort();
  const fallbackPort = await findFreePort([preferredPort]);

  // Block both candidate ports so every listen() attempt gets EADDRINUSE.
  // start() records each EADDRINUSE as lastError and continues; when the loop
  // exhausts all candidates it throws the wrapper at line 364.
  for (const port of [preferredPort, fallbackPort]) {
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(port, "127.0.0.1", () => resolve());
    });
    blockersToClose.push(blocker);
  }

  const srv = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort,
    fallbackPorts: [fallbackPort],
    webAppOrigin: "http://localhost:3000",
    machineName: "test",
    version: "0.0.1",
    capabilities: EMPTY_CAPABILITIES,
    getAllowedDirectories: () => [],
    discoveryFilePath: "",
  });
  serversToClose.push(srv);

  await assert.rejects(
    () => srv.start(),
    (err: Error) => {
      assert.ok(
        err.message.includes(
          "failed to bind gateway server to any candidate port"
        ),
        `expected the exhausted-candidates wrapper message; got: ${err.message}`
      );
      // lastError.message from the EADDRINUSE is embedded in the wrapper.
      assert.ok(
        err.message.includes("EADDRINUSE"),
        `wrapper message must contain lastError.message (EADDRINUSE); got: ${err.message}`
      );
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Line 385 — close() callback error that is not ERR_SERVER_NOT_RUNNING
// ---------------------------------------------------------------------------

test("stop() rejects when the close callback reports a non-ERR_SERVER_NOT_RUNNING error (line 385)", async () => {
  const srv = createTestServer();
  await srv.start();

  // Access the internal http.Server. The cast mirrors the pattern used in
  // gateway-liveness.test.ts to reach private state for stale-server testing.
  const internalRef = (srv as unknown as { server: http.Server | null }).server;
  if (!internalRef) {
    throw new Error("internal server handle must be set after start()");
  }

  // Stub close() on this specific instance to call back with a non-ERR_SERVER_NOT_RUNNING
  // error, exercising the reject(error) path at line 385.
  const closeErr = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  vi.spyOn(internalRef, "close").mockImplementation(function (
    this: http.Server,
    cb?: (err?: Error) => void
  ): http.Server {
    cb?.(closeErr);
    return this;
  });

  // The mock close does not actually shut the server down. Track the real
  // http.Server so afterEach can close it once the real close is restored.
  blockersToClose.push(internalRef);

  await assert.rejects(
    () => srv.stop(),
    (err: Error) => {
      assert.equal(
        err.message,
        "write EPIPE",
        "stop() must reject with the error from the close callback"
      );
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Line 416 — writeDiscoveryFile() early-return for empty discoveryFilePath
// ---------------------------------------------------------------------------

test("start() succeeds without writing a discovery file when discoveryFilePath is empty (line 416)", async () => {
  // Passing discoveryFilePath: "" is falsy → the `if (!this.options.discoveryFilePath)`
  // guard at line 416 returns early. Without the guard, path.dirname("") is "."
  // and fs.writeFile("", …) would fail. A successful start() with no error proves
  // the early-return path was taken.
  const srv = createTestServer({ discoveryFilePath: "" });
  await srv.start();

  assert.ok(
    srv.isAlive(),
    "server must be alive after start() with an empty discoveryFilePath"
  );
  assert.ok(
    srv.getActivePort() > 0,
    "server must have bound to a real port even without writing a discovery file"
  );
});

// ---------------------------------------------------------------------------
// Bonus — ownsSchedulers: false does not dispose externally-supplied schedulers
// ---------------------------------------------------------------------------

test("stop() does not dispose schedulers when an external LoopSchedulerContext is injected", async () => {
  const schedulers = new LoopSchedulerContext();
  let disposeCallCount = 0;

  // Mock the prototype method rather than the instance: [Symbol.dispose] is
  // defined on the prototype, not as an own property of each instance. Mocking
  // the instance's own property would fail the mock-restore mechanism because
  // node:test's mock.method saves the original as `instance[key]` and then
  // restores it — which is undefined for prototype-only methods.
  vi.spyOn(LoopSchedulerContext.prototype, Symbol.dispose).mockImplementation(
    () => {
      disposeCallCount++;
    }
  );

  const srv = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "http://localhost:3000",
    machineName: "test",
    version: "0.0.1",
    capabilities: EMPTY_CAPABILITIES,
    getAllowedDirectories: () => [],
    discoveryFilePath: "",
    schedulers,
  });
  serversToClose.push(srv);

  await srv.start();
  await srv.stop();

  assert.equal(
    disposeCallCount,
    0,
    "stop() must not call [Symbol.dispose] on an externally-supplied LoopSchedulerContext"
  );
  // afterEach calls mock.restoreAll() which restores LoopSchedulerContext.prototype
  // [Symbol.dispose]. No registered timers exist (no loops were started), so
  // explicit disposal is not required for test isolation.
});
