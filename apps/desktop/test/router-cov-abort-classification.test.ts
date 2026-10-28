/**
 * ISS-11282: pins how `GatewayRouter.handle` (`src/server/router.ts`)
 * classifies a handler failure: client abort (socket destroyed, or an Error
 * whose code is ECONNRESET/ECONNABORTED) versus a server bug answered with a
 * 500, and the 120-char bound on the logged target and error detail. The
 * request is a stream with an explicit socket stub so the socket's `destroyed`
 * flag is the value under test, not an artifact of stream teardown.
 */
import type http from "node:http";
import os from "node:os";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import {
  CLIENT_ABORTED_CODE,
  GatewayRouter,
  UNHANDLED_REQUEST_ERROR_CODE,
} from "../src/server/router.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";
import { TestResponse } from "./gateway-server-test-doubles.js";

const THROW_PATH = "/api/gateway/iss11282-abort-probe";
// Mirrors MAX_LOGGED_REQUEST_TARGET_CHARS in router.ts.
const LOG_BOUND = 120;

afterEach(() => {
  gatewayLog.clear();
});

function routerThrowing(thrown: unknown): GatewayRouter {
  const dispatcher = new OperationDispatcher();
  dispatcher.register("GET", THROW_PATH, () => {
    throw thrown;
  });
  return new GatewayRouter(
    {
      webAppOrigin: "https://app.closedloop.ai",
      getAllowedDirectories: () => [os.tmpdir()],
      machineName: "iss11282-abort",
      version: "0.1.0-test",
      capabilities: EMPTY_CAPABILITIES,
      getActivePort: () => 0,
      getGatewayId: () => "gw-iss11282",
    },
    dispatcher
  );
}

async function drive(
  router: GatewayRouter,
  options: { url?: string; socketDestroyed: boolean }
): Promise<TestResponse> {
  const request = Readable.from([]) as Readable & {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    socket: { remoteAddress: string; destroyed: boolean };
  };
  request.method = "GET";
  request.url = options.url ?? THROW_PATH;
  request.headers = {};
  request.socket = {
    remoteAddress: "127.0.0.1",
    destroyed: options.socketDestroyed,
  };
  const response = new TestResponse();
  await router.handle(
    request as unknown as http.IncomingMessage,
    response as unknown as http.ServerResponse
  );
  return response;
}

function routerMessages(): string[] {
  return gatewayLog
    .getEntries()
    .filter((entry) => entry.tag === "gateway-router")
    .map((entry) => entry.message);
}

describe("client abort classification", () => {
  it("treats an ECONNABORTED error on a live socket as a client abort", async () => {
    const aborted = Object.assign(new Error("aborted mid-body"), {
      code: "ECONNABORTED",
    });

    const response = await drive(routerThrowing(aborted), {
      socketDestroyed: false,
    });

    expect(response.destroyed).toBe(true);
    expect(response.finished).toBe(false);
    expect(response.text()).toBe("");
    expect(routerMessages()).toEqual([
      `${CLIENT_ABORTED_CODE} method=GET target=${THROW_PATH} error=aborted mid-body`,
    ]);
  });

  it("treats any failure on a destroyed socket as a client abort", async () => {
    const response = await drive(routerThrowing(new Error("plain failure")), {
      socketDestroyed: true,
    });

    expect(response.destroyed).toBe(true);
    expect(response.text()).toBe("");
    expect(routerMessages()).toEqual([
      `${CLIENT_ABORTED_CODE} method=GET target=${THROW_PATH} error=plain failure`,
    ]);
  });

  it("answers 500 for a non-Error value that carries an ECONNRESET code", async () => {
    // Only an Error instance counts as a reset; a bare object with the same
    // code is treated as our own bug.
    const response = await drive(
      routerThrowing({ code: "ECONNRESET", message: "not an Error" }),
      { socketDestroyed: false }
    );

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "internal error" });
    expect(routerMessages()).toEqual([
      `${UNHANDLED_REQUEST_ERROR_CODE} method=GET target=${THROW_PATH} error=[object Object] status=500`,
    ]);
  });
});

describe("log bounds", () => {
  it("truncates the logged target and error detail to 120 characters each", async () => {
    const longUrl = `${THROW_PATH}?q=${"a".repeat(200)}`;
    const longMessage = "m".repeat(200);
    const router = routerThrowing(new Error(longMessage));

    const response = await drive(router, {
      url: longUrl,
      socketDestroyed: false,
    });

    expect(response.statusCode).toBe(500);
    expect(routerMessages()).toEqual([
      `${UNHANDLED_REQUEST_ERROR_CODE} method=GET target=${longUrl.slice(0, LOG_BOUND)} error=${longMessage.slice(0, LOG_BOUND)} status=500`,
    ]);
  });
});
