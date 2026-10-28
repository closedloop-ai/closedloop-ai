/**
 * ISS-11282: branch coverage for `src/server/server.ts`. Pins
 * `getHealthResponse` with and without a gateway id / onboarding callback, and
 * `createDefault`'s defaults: the empty gateway id and no fallback origin when
 * SYMPHONY_GATEWAY_FALLBACK_ORIGIN is unset. No server is started.
 */
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DesktopGatewayServer } from "../src/server/server.js";
import {
  DEFAULT_GATEWAY_PORT,
  EMPTY_CAPABILITIES,
} from "../src/shared/contracts.js";

const FALLBACK_ENV = "SYMPHONY_GATEWAY_FALLBACK_ORIGIN";

let savedFallback: string | undefined;
let hadFallback = false;
const servers: DesktopGatewayServer[] = [];

beforeEach(() => {
  hadFallback = Object.hasOwn(process.env, FALLBACK_ENV);
  savedFallback = process.env[FALLBACK_ENV];
  Reflect.deleteProperty(process.env, FALLBACK_ENV);
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.stop();
  }
  if (hadFallback) {
    process.env[FALLBACK_ENV] = savedFallback;
  } else {
    Reflect.deleteProperty(process.env, FALLBACK_ENV);
  }
});

describe("DesktopGatewayServer health response", () => {
  it("reports the gateway id and onboarding state from the configured callbacks", () => {
    const server = new DesktopGatewayServer({
      host: "127.0.0.1",
      preferredPort: 45_678,
      fallbackPorts: [],
      webAppOrigin: "https://app.closedloop.ai",
      getAllowedDirectories: () => [os.tmpdir()],
      machineName: "iss11282-host",
      version: "9.9.9-test",
      capabilities: EMPTY_CAPABILITIES,
      getGatewayId: () => "gw-configured",
      getOnboardingCompleted: () => true,
    });
    servers.push(server);

    expect(server.getHealthResponse()).toEqual({
      status: "ok",
      machineName: "iss11282-host",
      capabilities: EMPTY_CAPABILITIES,
      gatewayId: "gw-configured",
      onboardingCompleted: true,
      version: "9.9.9-test",
      port: 45_678,
    });
  });

  it("createDefault omits the gateway id, reports onboarding false, and wires no fallback origin", () => {
    const server = DesktopGatewayServer.createDefault(
      "https://app.closedloop.ai",
      () => undefined,
      () => [os.tmpdir()],
      "iss11282-default",
      "1.0.0-test",
      EMPTY_CAPABILITIES
    );
    servers.push(server);

    const health = server.getHealthResponse();
    expect(health).toEqual({
      status: "ok",
      machineName: "iss11282-default",
      capabilities: EMPTY_CAPABILITIES,
      gatewayId: undefined,
      onboardingCompleted: false,
      version: "1.0.0-test",
      port: DEFAULT_GATEWAY_PORT,
    });
    expect(server.getAddress().fallbackGatewayOrigin).toBeUndefined();
    expect(server.getAddress().getGatewayId?.()).toBe("");
  });
});
