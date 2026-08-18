/**
 * Approval-ordering proof for the Desktop gateway (FEA-4113).
 *
 * Lives beside `gateway-server.test.ts` rather than inside it: that file is on
 * the shrink-only grandfather list in `biome.jsonc`, and AGENTS.md's file-size
 * rule says a grandfathered file must never grow. The test it replaces asserted
 * `durationMs >= 25` after a 30 ms sleep — a wall-clock bound that observed only
 * that *a* sleep had happened, not that the server awaited the approval
 * evaluator before dispatching.
 *
 * SECURITY CRITICAL surface: this is the authorization ordering on the Engineer
 * gateway (AGENTS.md → "Engineer Feature").
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { DesktopGatewayServer } from "../src/server/server.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";

const serversToClose: DesktopGatewayServer[] = [];
const tempPathsToClean: string[] = [];

afterEach(async () => {
  for (const server of serversToClose.splice(0)) {
    await server.stop();
  }
  for (const tempPath of tempPathsToClean.splice(0)) {
    await fs.rm(tempPath, { force: true, recursive: true });
  }
});

test("awaits async approval evaluation before dispatch", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-gateway-approval-async-")
  );
  tempPathsToClean.push(tmpDir);

  const events: string[] = [];
  let releaseApproval: () => void = () => {
    // Replaced synchronously by the promise executor below.
  };
  const approvalGate = new Promise<void>((resolve) => {
    releaseApproval = resolve;
  });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "approval-async-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    // Recorded from inside the server's own handling, so the ordering proof does
    // not depend on when a network round trip happens to settle in the test
    // process. Recording it client-side from `fetch().then()` is a race, and a
    // non-awaiting server passes that version.
    getSymphonyDir: () => {
      events.push("dispatch");
      return path.join(tmpDir, "symphony-home");
    },
    evaluateApproval: async () => {
      events.push("approval-start");
      await approvalGate;
      events.push("approval-end");
      return { allow: true };
    },
  });
  serversToClose.push(server);
  await server.start();

  const responsePromise = fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/sessions`
  );

  await waitForEvent(events, "approval-start");
  releaseApproval();
  const response = await responsePromise;

  assert.equal(response.status, 200);
  assert.deepEqual(events, ["approval-start", "approval-end", "dispatch"]);
});

/**
 * Resolve once `name` appears in `events`, or reject on timeout.
 *
 * A bounded wait for an occurrence — not a fixed sleep and not a wall-clock
 * assertion. The explicit timeout is what turns "the event never arrived" into
 * a named failure instead of a hang (AGENTS.md → Test Practices).
 */
async function waitForEvent(
  events: readonly string[],
  name: string,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!events.includes(name)) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for "${name}"; saw [${events.join(", ")}]`
      );
    }
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}
