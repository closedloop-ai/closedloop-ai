/**
 * Gateway auth-rejection fixtures and assertions, shared by the gateway
 * server/auth suites. Extracted from gateway-server.test.ts (ISS-7591) to keep
 * that grandfathered file shrinking rather than growing — see AGENTS.md
 * "File Size and Organization".
 */

import assert from "node:assert/strict";
import path from "node:path";
import type { AuthReason } from "../../src/server/gateway-auth-reasons.js";
import { DesktopGatewayServer } from "../../src/server/server.js";
import { EMPTY_CAPABILITIES } from "../../src/shared/contracts.js";

/**
 * A gateway wired the way the auth-rejection cases need it: a gateway auth
 * token IS configured, so `isAuthorizedGatewayRequest` never takes its
 * no-token shortcut, and no session store is supplied, so a browser request's
 * only outcome is a rejection.
 */
export async function startAuthRejectionServer(options: {
  tmpDir: string;
  webAppOrigin: string;
  machineName: string;
  serversToClose: DesktopGatewayServer[];
}): Promise<DesktopGatewayServer> {
  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: options.webAppOrigin,
    getGatewayAuthToken: () => "test-gateway-token",
    getAllowedDirectories: () => [options.tmpDir],
    machineName: options.machineName,
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(options.tmpDir, "electron-port"),
  });
  options.serversToClose.push(server);
  await server.start();
  return server;
}

/**
 * Pins WHICH rejection branch answered, not just the 401 class — `reason` is
 * the only thing on the wire that tells the branches apart, so a status-only
 * assertion is satisfied by any unrelated 401.
 */
export async function assertUnauthorized(
  response: Response,
  reason: AuthReason
): Promise<void> {
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized", reason });
}
