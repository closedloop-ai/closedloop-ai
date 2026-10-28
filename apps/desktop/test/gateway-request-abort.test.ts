import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, test } from "vitest";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  CLIENT_ABORTED_CODE,
  GatewayRouter,
  UNHANDLED_REQUEST_ERROR_CODE,
} from "../src/server/router.js";
import { DesktopGatewayServer } from "../src/server/server.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";
import { TestResponse } from "./gateway-server-test-doubles.js";

/**
 * ISS-8566 — a client that aborts an upload mid-body must not take the app down.
 *
 * `server.ts` dispatches the router with a bare `void this.router.handle(...)`,
 * so anything `handle` rejects with becomes an UNHANDLED rejection, and
 * `handleUnhandledRejection` calls `exit(1)` for every `Error` that is not a
 * spawn ENOENT. `ECONNRESET` out of `readBody` is such an `Error`.
 *
 * The mutation these cases must kill is removing the top-level catch in
 * `GatewayRouter.handle`. They kill it two ways that do not depend on each
 * other: the process-level rejection the crash chain actually starts from, and a
 * second request that only a still-serving gateway can answer. Neither asserts
 * on a timer.
 *
 * The server is built with NO gateway auth token, which is the DEFAULT state and
 * the reason this needs no credential: `isAuthorizedGatewayRequest` authorizes
 * every request when none is configured.
 */

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

function createTestServer(): DesktopGatewayServer {
  const tmpDir = path.join(
    os.tmpdir(),
    `gateway-abort-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
  });
  serversToClose.push(srv);
  return srv;
}

function internalServerOf(srv: DesktopGatewayServer): http.Server {
  const internal = (srv as unknown as { server: http.Server | null }).server;
  if (!internal) {
    // Not an assertion: `noMisplacedAssertion` forbids one outside a test body,
    // and a helper that cannot produce its value has nothing to hand back.
    throw new Error("internal http.Server handle missing after start()");
  }
  return internal;
}

/**
 * Declare 100 body bytes, send 11, then RST.
 *
 * The reset waits for the server's own `request` event rather than a delay, so
 * the router is provably inside `handle` when the socket dies — a timer here
 * would make the case pass without ever reaching the branch it exists to pin.
 */
function abortMidBody(server: http.Server, port: number): Promise<void> {
  const handlerEntered = new Promise<void>((resolve) => {
    server.once("request", () => resolve());
  });
  return new Promise<void>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let reset = false;
    socket.on("error", (err) => {
      if (!reset) {
        reject(err);
      }
    });
    socket.on("connect", () => {
      socket.write(
        [
          "POST /api/gateway/repos HTTP/1.1",
          "Host: localhost",
          "Content-Type: application/json",
          "Content-Length: 100",
          "",
          "partialbody",
        ].join("\r\n")
      );
      handlerEntered.then(() => {
        reset = true;
        socket.resetAndDestroy();
        resolve();
      }, reject);
    });
  });
}

test("an aborted mid-body upload raises no unhandled rejection and leaves the gateway serving", async () => {
  const srv = createTestServer();
  await srv.start();
  const port = srv.getActivePort();
  const server = internalServerOf(srv);

  const rejections: unknown[] = [];
  const record = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", record);
  // Sliced rather than cleared, so this case cannot depend on which other cases
  // in this process ran first, and cannot delete their entries either.
  const logMark = gatewayLog.getEntries().length;

  try {
    await abortMidBody(server, port);

    // Only a live, still-listening gateway can answer this, and awaiting it is
    // also the bounded wait that lets any rejection from the aborted request
    // surface before the assertion below.
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200, "gateway should still serve /health");
    await health.arrayBuffer();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(
      rejections,
      [],
      `aborted upload must not reject out of handle(); got ${rejections.map(String).join(", ")}`
    );

    // Which BRANCH of the catch ran, not just that the app survived (review,
    // marisolashgrove). Both branches keep the process up, so the assertions above
    // stay green if `isClientAbort` loses the ECONNRESET/ECONNABORTED half and
    // `socket.destroyed` has not flipped yet — and the cost of that regression
    // is a `status=500` error written into the durable gateway log and the
    // diagnostics Logs panel on every laptop-lid disconnect. That distinction is
    // the whole reason the branch exists, so it is pinned here.
    const routerEntries = gatewayLog
      .getEntries()
      .slice(logMark)
      .filter((entry) => entry.tag === "gateway-router");
    assert.equal(
      routerEntries.filter((entry) =>
        entry.message.startsWith(CLIENT_ABORTED_CODE)
      ).length,
      1,
      `an aborted upload must log exactly one ${CLIENT_ABORTED_CODE}; got ${routerEntries.map((entry) => entry.message).join(" | ")}`
    );
    assert.equal(
      routerEntries.filter((entry) =>
        entry.message.startsWith(UNHANDLED_REQUEST_ERROR_CODE)
      ).length,
      0,
      `a client that went away is not a server error; got ${routerEntries.map((entry) => entry.message).join(" | ")}`
    );
  } finally {
    process.off("unhandledRejection", record);
  }
});

test("a valid request is unaffected by the top-level catch", async () => {
  const srv = createTestServer();
  await srv.start();
  const port = srv.getActivePort();

  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status?: string };
  assert.equal(body.status, "ok");
});

test("a server-side handler failure answers 500 while the caller is still connected", async () => {
  // The other arm of the catch. Here the request is alive, so the failure is
  // ours to report rather than a caller that vanished — it must become a
  // generic 500 that leaks no internals, not a torn-down socket and not a
  // rejection.
  const router = new GatewayRouter({
    webAppOrigin: "https://app.closedloop.ai",
    getAllowedDirectories: () => [os.tmpdir()],
    machineName: "abort-test-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    getActivePort: () => 0,
    getGatewayId: () => "test-gateway-id",
    evaluateApproval: () => {
      throw new Error("synthetic approval failure");
    },
  });

  const request = Readable.from([Buffer.from("{}")]) as Readable & {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    socket: { remoteAddress: string };
  };
  request.method = "POST";
  request.url = "/api/gateway/iss8566-noop";
  request.headers = { "content-type": "application/json" };
  request.socket = { remoteAddress: "127.0.0.1" };

  const response = new TestResponse();
  await assert.doesNotReject(
    router.handle(
      request as unknown as http.IncomingMessage,
      response as unknown as http.ServerResponse
    ),
    "handle() must not reject"
  );

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { error: "internal error" });
  assert.equal(
    response.text().includes("synthetic approval failure"),
    false,
    "the 500 body must not leak the internal error"
  );
});

test("a failure after the answer was already delivered leaves the response alone", async () => {
  // The third arm (review, marisolashgrove). `headersSent` is true for a
  // half-written answer AND for one that already completed, so it alone cannot
  // tell them apart, and `destroy()` on a COMPLETED response resets a
  // keep-alive socket that carried a good reply.
  //
  // The production shape that lands here is a streaming handler whose
  // post-answer step fails: `codex-routes-review.ts` ends the response as the
  // last statement of its `try`, and its `catch` writes again — a throw from
  // there escapes `dispatch` with the answer already on the wire. That is what
  // this case stands in for: a response that has already ended, and a route
  // body that then throws.
  const router = new GatewayRouter({
    webAppOrigin: "https://app.closedloop.ai",
    getAllowedDirectories: () => [os.tmpdir()],
    machineName: "abort-test-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    getActivePort: () => 0,
    getGatewayId: () => "test-gateway-id",
    evaluateApproval: () => {
      throw new Error("synthetic post-answer failure");
    },
  });

  const request = Readable.from([Buffer.from("{}")]) as Readable & {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    socket: { remoteAddress: string };
  };
  request.method = "POST";
  request.url = "/api/gateway/iss8566-noop";
  request.headers = { "content-type": "application/json" };
  request.socket = { remoteAddress: "127.0.0.1" };

  const response = new TestResponse();
  response.statusCode = 200;
  response.end('{"delivered":true}');
  response.headersSent = true;
  const logMark = gatewayLog.getEntries().length;

  await assert.doesNotReject(
    router.handle(
      request as unknown as http.IncomingMessage,
      response as unknown as http.ServerResponse
    ),
    "handle() must not reject"
  );

  assert.equal(
    response.destroyed,
    false,
    "a completed response must not have its socket torn down"
  );
  assert.equal(
    response.text(),
    '{"delivered":true}',
    "the delivered answer must not gain a second body"
  );
  assert.equal(response.statusCode, 200, "the delivered status must stand");
  const logged = gatewayLog
    .getEntries()
    .slice(logMark)
    .filter((entry) => entry.tag === "gateway-router")
    .map((entry) => entry.message);
  assert.equal(
    logged.some(
      (message) =>
        message.startsWith(UNHANDLED_REQUEST_ERROR_CODE) &&
        message.endsWith("status=200")
    ),
    true,
    `the failure is still our bug and still logged, at the status the caller actually got; entries: ${logged.join(" | ")}`
  );
});

test("an ECONNRESET on a socket that has not finished tearing down is still an abort", async () => {
  // The deterministic half of the branch pin above (review, marisolashgrove).
  // Over a real socket, whether `socket.destroyed` has flipped by the time
  // `readBody` rejects is a race, so that case cannot reliably prove the error
  // code is consulted at all. Here the socket is explicitly still alive, which
  // is the state `isClientAbort`'s second signal exists for: without it this is
  // classified as our bug and every laptop-lid disconnect starts writing
  // `unhandled_request_error ... status=500` into the durable gateway log.
  const router = new GatewayRouter({
    webAppOrigin: "https://app.closedloop.ai",
    getAllowedDirectories: () => [os.tmpdir()],
    machineName: "abort-test-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    getActivePort: () => 0,
    getGatewayId: () => "test-gateway-id",
  });

  const reset = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
  const request = new Readable({
    read() {
      this.destroy(reset);
    },
  }) as Readable & {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    socket: { remoteAddress: string; destroyed: boolean };
  };
  request.method = "POST";
  request.url = "/api/gateway/iss8566-noop";
  request.headers = { "content-type": "application/json" };
  request.socket = { remoteAddress: "127.0.0.1", destroyed: false };

  const response = new TestResponse();
  const logMark = gatewayLog.getEntries().length;

  await assert.doesNotReject(
    router.handle(
      request as unknown as http.IncomingMessage,
      response as unknown as http.ServerResponse
    ),
    "handle() must not reject"
  );

  const logged = gatewayLog
    .getEntries()
    .slice(logMark)
    .filter((entry) => entry.tag === "gateway-router")
    .map((entry) => entry.message);
  assert.equal(
    logged.filter((message) => message.startsWith(CLIENT_ABORTED_CODE)).length,
    1,
    `an ECONNRESET is the client going away, not a server error; entries: ${logged.join(" | ")}`
  );
  assert.equal(
    logged.filter((message) => message.startsWith(UNHANDLED_REQUEST_ERROR_CODE))
      .length,
    0,
    `a client that went away must not be logged as our 500; entries: ${logged.join(" | ")}`
  );
  assert.equal(
    response.destroyed,
    true,
    "a response with nobody left to read it is torn down, not answered"
  );
  assert.equal(
    response.text(),
    "",
    "nothing is written to a socket whose peer is gone"
  );
});
